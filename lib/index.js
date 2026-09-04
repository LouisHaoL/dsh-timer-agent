import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "schemastery";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/core/schedule.ts
/** Inclusive ranges per field, in cron order. */
const FIELD_RANGES = [
	[0, 59],
	[0, 23],
	[1, 31],
	[1, 12],
	[0, 7]
];
/**
* Parse a 5-field cron expression.
* @returns the match sets, or null when the expression is invalid.
*/
function parseCron(expr) {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const sets = [];
	for (let index = 0; index < 5; index++) {
		const [min, max] = FIELD_RANGES[index];
		const set = /* @__PURE__ */ new Set();
		if (!parseField(fields[index], min, max, set)) return null;
		sets.push(set);
	}
	const weekdays = /* @__PURE__ */ new Set();
	for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day);
	return {
		minutes: sets[0],
		hours: sets[1],
		days: sets[2],
		months: sets[3],
		weekdays,
		dayWildcard: fields[2] === "*",
		weekdayWildcard: fields[4] === "*"
	};
}
/** Whether the expression parses. */
function isValidCron(expr) {
	return parseCron(expr) !== null;
}
/**
* Compute the next matching instant after `fromMs` (ms epoch), in local
* time, at minute granularity, strictly greater than `fromMs`.
*/
function nextRunAtMs(expr, fromMs) {
	const schedule = parseCron(expr);
	if (schedule === null) return void 0;
	const from = new Date(fromMs);
	const scan = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1, 0, 0);
	const limitMs = fromMs + 366 * 24 * 60 * 60 * 1e3;
	while (scan.getTime() <= limitMs) {
		if (matches(schedule, scan)) return scan.getTime();
		scan.setMinutes(scan.getMinutes() + 1);
	}
}
/** Parse one comma-list field into the match set. */
function parseField(field, min, max, out) {
	if (field === "*") {
		for (let value = min; value <= max; value++) out.add(value);
		return true;
	}
	for (const part of field.split(",")) {
		if (part === "") return false;
		const [range, stepRaw] = part.split("/");
		let low;
		let high;
		if (range === "*") {
			low = min;
			high = max;
		} else if (range.includes("-")) {
			const [a, b] = range.split("-");
			if (a === "" || b === "" || !isDigits(a) || !isDigits(b)) return false;
			low = Number(a);
			high = Number(b);
		} else if (isDigits(range)) {
			low = Number(range);
			high = Number(range);
		} else return false;
		if (low < min || high > max || low > high) return false;
		const step = stepRaw === void 0 ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN;
		if (!Number.isInteger(step) || step < 1) return false;
		for (let value = low; value <= high; value += step) out.add(value);
	}
	return true;
}
/** Day/weekday OR semantics: a restricted day field alone gates, and vice versa. */
function matches(schedule, date) {
	if (!schedule.minutes.has(date.getMinutes())) return false;
	if (!schedule.hours.has(date.getHours())) return false;
	if (!schedule.months.has(date.getMonth() + 1)) return false;
	const dayMatches = schedule.days.has(date.getDate());
	const weekdayMatches = schedule.weekdays.has(date.getDay());
	if (schedule.dayWildcard) return weekdayMatches;
	if (schedule.weekdayWildcard) return dayMatches;
	return dayMatches || weekdayMatches;
}
function isDigits(value) {
	return /^\d+$/.test(value);
}
//#endregion
//#region src/core/jobs.ts
/** Resolve a job's kind; absent/unknown fields degrade to the 'agent' default. */
function jobKind(job) {
	return job.kind === "command" ? "command" : "agent";
}
/**
* Normalize a timeout input (ms) into the stored shape: positive finite
* numbers pass through (rounded), everything else (0, negative, NaN,
* non-number) clears the limit.
*/
function normalizeTimeoutMs(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return void 0;
	return Math.round(value);
}
/** All valid statuses (closed union guard). */
const ALL_STATUSES = [
	"idle",
	"running",
	"done",
	"failed",
	"archived"
];
/** Brand an unknown string as a status; undefined when it is not one. */
function isJobStatus(value) {
	return typeof value === "string" && ALL_STATUSES.includes(value);
}
/** Create a job from user input. */
function createJob(input, now, id) {
	const kind = jobKind(input);
	return {
		id,
		title: input.title.trim(),
		description: input.description.trim(),
		prompt: input.prompt.trim(),
		...kind === "command" ? {
			kind,
			command: (input.command ?? "").trim(),
			args: (input.args ?? "").trim()
		} : {},
		status: "idle",
		target: { ...input.target },
		...kind === "agent" && input.preset !== void 0 && input.preset.trim() !== "" ? { preset: input.preset.trim() } : {},
		...input.modelSelection === void 0 ? {} : { modelSelection: { ...input.modelSelection } },
		createdAt: now,
		updatedAt: now,
		executions: []
	};
}
/** Clone a job with an updated status and a fresh updatedAt. */
function withStatus(job, status, now) {
	return {
		...job,
		status,
		updatedAt: now
	};
}
/**
* Merge a schedule patch into a job's schedule rule (creating it when
* absent), with a fresh updatedAt. Keys present in the patch overwrite the
* current value — including explicit `undefined`, which clears a field.
*/
function withSchedule(job, patch, now) {
	const current = job.schedule;
	const schedule = {
		enabled: current?.enabled ?? false,
		cron: current?.cron ?? "",
		nextRunAt: current?.nextRunAt,
		lastTriggeredAt: current?.lastTriggeredAt
	};
	if ("enabled" in patch) schedule.enabled = patch.enabled ?? false;
	if ("cron" in patch) schedule.cron = patch.cron ?? "";
	if ("nextRunAt" in patch) schedule.nextRunAt = patch.nextRunAt;
	if ("lastTriggeredAt" in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt;
	return {
		...job,
		updatedAt: now,
		schedule
	};
}
/**
* Open a fresh execution on a job: move it to 'running' and append a running
* execution record. Returns the new job and the new execution.
*/
function startExecution(job, now, executionId, targeting) {
	const execution = {
		id: executionId,
		sessionId: void 0,
		targeting,
		startedAt: now,
		endedAt: void 0,
		result: void 0,
		error: void 0
	};
	return {
		job: {
			...job,
			status: "running",
			updatedAt: now,
			executions: [...job.executions, execution]
		},
		execution
	};
}
/**
* Settle a running execution: record the outcome and move the job into the
* matching column. No-op when the execution is not the job's latest or is
* already settled.
*/
function settleExecution(job, executionId, outcome, now, error, extra) {
	const index = job.executions.findIndex((execution) => execution.id === executionId);
	if (index === -1) return job;
	const execution = job.executions[index];
	if (execution.endedAt !== void 0) return job;
	const settled = {
		...execution,
		endedAt: now,
		result: outcome,
		error,
		...extra?.exitCode !== void 0 ? { exitCode: extra.exitCode } : {},
		...extra?.output !== void 0 ? { output: extra.output } : {}
	};
	const executions = [...job.executions];
	executions[index] = settled;
	const status = outcome === "succeeded" ? "done" : outcome === "failed" ? "failed" : job.status === "running" ? "idle" : job.status;
	return {
		...job,
		status,
		updatedAt: now,
		executions
	};
}
//#endregion
//#region src/core/store.ts
/**
* Job persistence: a small storage seam with a localStorage backend.
* (Same persistence mechanism dsh's own client snapshot stores use; the
* browser has no dsh-writable file channel — the task-board / skin-center
* research conclusion.)
*
* The seam keeps the backend swappable (e.g. an IndexedDB or a host-file
* channel later); validation repairs malformed rows field by field.
*/
/** Structural row check with the status left unvalidated (normalized later). */
function isJobRecordShape(value) {
	if (typeof value !== "object" || value === null) return false;
	const record = value;
	if (typeof record.id !== "string" || record.id === "") return false;
	if (typeof record.title !== "string") return false;
	if (typeof record.description !== "string") return false;
	if (typeof record.prompt !== "string") return false;
	if (record.kind !== void 0 && record.kind !== "agent" && record.kind !== "command") return false;
	if (record.command !== void 0 && typeof record.command !== "string") return false;
	if (record.args !== void 0 && typeof record.args !== "string") return false;
	if (typeof record.createdAt !== "number") return false;
	if (typeof record.updatedAt !== "number") return false;
	const target = record.target;
	if (typeof target !== "object" || target === null) return false;
	const t = target;
	if (typeof t.workdir !== "string" || typeof t.sessionId !== "string") return false;
	if (!Array.isArray(record.executions)) return false;
	for (const execution of record.executions) if (!isExecutionShape(execution)) return false;
	return true;
}
function isExecutionShape(value) {
	if (typeof value !== "object" || value === null) return false;
	const entry = value;
	if (typeof entry.id !== "string") return false;
	if (entry.sessionId !== void 0 && typeof entry.sessionId !== "string") return false;
	if (entry.targeting !== "specified-session" && entry.targeting !== "new-session" && entry.targeting !== "command") return false;
	if (typeof entry.startedAt !== "number") return false;
	if (entry.endedAt !== void 0 && typeof entry.endedAt !== "number") return false;
	if (entry.result !== void 0 && entry.result !== "succeeded" && entry.result !== "failed" && entry.result !== "cancelled") return false;
	if (entry.error !== void 0 && typeof entry.error !== "string") return false;
	if (entry.exitCode !== void 0 && typeof entry.exitCode !== "number") return false;
	if (entry.output !== void 0 && typeof entry.output !== "string") return false;
	return true;
}
/** Normalize an unknown persisted status back into the closed union. */
function normalizeStatus(status) {
	return isJobStatus(status) ? status : "idle";
}
/**
* Repair a persisted schedule rule: drop rules without a usable cron string;
* coerce booleans; leave `nextRunAt`/`lastTriggeredAt` undefined when missing.
*/
function normalizeSchedule(schedule) {
	if (typeof schedule !== "object" || schedule === null) return void 0;
	const rule = schedule;
	if (typeof rule.cron !== "string") return void 0;
	if (rule.cron.trim() === "" || !isValidCron(rule.cron)) return void 0;
	return {
		enabled: rule.enabled === true,
		cron: rule.cron,
		nextRunAt: typeof rule.nextRunAt === "number" ? rule.nextRunAt : void 0,
		lastTriggeredAt: typeof rule.lastTriggeredAt === "number" ? rule.lastTriggeredAt : void 0
	};
}
/** Parse + validate a persisted ledger document; invalid rows are dropped. */
function parseLedger(raw) {
	if (raw === null) return [];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		console.error("[dsh-timer-agent] persisted job ledger is not valid JSON; starting empty", error);
		return [];
	}
	if (!Array.isArray(parsed)) {
		console.error("[dsh-timer-agent] persisted job ledger is not an array; starting empty");
		return [];
	}
	const jobs = [];
	for (const row of parsed) {
		if (!isJobRecordShape(row)) {
			console.warn("[dsh-timer-agent] dropping invalid job row from persisted ledger", row);
			continue;
		}
		const job = {
			...row,
			status: normalizeStatus(row.status)
		};
		if (row.kind !== "command") {
			delete job.kind;
			delete job.command;
			delete job.args;
		}
		job.target = normalizeTarget(row.target);
		job.schedule = normalizeSchedule(row.schedule);
		jobs.push(job);
	}
	return jobs;
}
/** Clamp a persisted target to the known shape (unknown → blank/blank). */
function normalizeTarget(target) {
	return {
		workdir: typeof target.workdir === "string" ? target.workdir : "",
		sessionId: typeof target.sessionId === "string" ? target.sessionId : ""
	};
}
//#endregion
//#region src/host/store.ts
/**
* Host job store: the authoritative file-backed ledger at
* `<dsh home>/timer-agent/jobs.json` (hermes-agent cron keeps its jobs at
* ~/.hermes/cron/jobs.json — same shape of guarantee: the host process can
* read/write it at any time, browser or not).
*
* All mutations serialize through one in-process promise chain; the file is
* written atomically (temp + rename). Validation/repair reuses the pure
* {@link parseLedger} from the shared core so a corrupted file degrades to
* dropping invalid rows, never to a crashed ticker.
*/
/**
* Windows-resilient replace: rename over an existing file fails with
* EPERM/EACCES when the destination is transiently locked (another dsh
* instance holding the ledger open, an AV scan, etc.). Retry with backoff,
* then degrade to copy+unlink — not atomic, but a save must never take down
* the host (newer dsh treats plugin load errors as fatal boot failures).
*/
const RENAME_ATTEMPTS = 5;
async function replaceFile(temp, dest) {
	for (let attempt = 1;; attempt++) try {
		await rename(temp, dest);
		return;
	} catch (err) {
		const code = err.code;
		if (code !== "EPERM" && code !== "EACCES") throw err;
		if (attempt >= RENAME_ATTEMPTS) {
			await copyFile(temp, dest);
			await unlink(temp).catch(() => {});
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** (attempt - 1)));
	}
}
/** Default ledger location: ~/.dsh/timer-agent/jobs.json. */
function defaultJobsFile() {
	return join(homedir(), ".dsh", "timer-agent", "jobs.json");
}
/**
* File-backed job ledger. `load()` re-reads from disk (cheap, small file) so
* concurrent writers (tool, routes, ticker) in this process stay coherent
* through the single mutation chain.
*/
var HostJobStore = class {
	file;
	chain = Promise.resolve();
	/**
	* @param file - absolute ledger path (tests inject a temp file).
	*/
	constructor(file = defaultJobsFile()) {
		this.file = file;
	}
	/** Read the ledger (empty on first run / unreadable file). */
	async load() {
		try {
			return parseLedger(await readFile(this.file, "utf8"));
		} catch {
			return [];
		}
	}
	/**
	* Mutate the ledger under the serialization chain: load → mutate → atomic
	* save. The mutator returns undefined to abort (no write happens).
	* @param mutate - pure transform of the current ledger.
	* @returns the mutator's result (or undefined when it aborted).
	*/
	async mutate(mutate) {
		const run = async () => {
			const outcome = mutate(await this.load());
			if (outcome === void 0) return void 0;
			await this.save(outcome.jobs);
			return outcome.result;
		};
		const next = this.chain.then(run, run);
		this.chain = next.catch(() => void 0);
		return next;
	}
	/** Atomic write: temp file in the same directory, then rename. */
	async save(jobs) {
		await mkdir(join(this.file, ".."), { recursive: true });
		const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
		await writeFile(temp, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
		await replaceFile(temp, this.file);
	}
};
//#endregion
//#region src/host/contracts.ts
/** Narrow a session event to a closed turn boundary. */
function isTurnEndEvent(event) {
	if (event.type !== "turn/end") return false;
	const data = event.data;
	return typeof data === "object" && data !== null && typeof data.reason?.kind === "string";
}
/** Render a failed turn's reason as one operator-readable line. */
function turnErrorDetail(data) {
	if (data.reason.kind !== "error") return "";
	const error = data.reason.error;
	if (error === void 0) return "turn failed";
	return error.message ?? error.code ?? "turn failed";
}
//#endregion
//#region src/core/command.ts
/**
* Command-execution helpers for 'command' jobs (普通任务): quote-aware
* argument splitting and output tail truncation. Framework-free so both the
* host runner and the tests import it directly.
*
* @module dsh-timer-agent/command
*/
/**
* Split an argument string the way a shell roughly would:
* - whitespace separates arguments (repeated whitespace collapses)
* - double quotes group (backslash escapes `\` and `"` inside)
* - single quotes group literally (no escapes inside)
*
* Unlike a full shell there is no variable expansion or redirection — the
* string is pure argv for the spawned executable.
*/
function splitCommandArgs(input) {
	const args = [];
	let current = "";
	let hasCurrent = false;
	let index = 0;
	while (index < input.length) {
		const char = input[index];
		if (char === " " || char === "	" || char === "\n" || char === "\r") {
			if (hasCurrent) {
				args.push(current);
				current = "";
				hasCurrent = false;
			}
			index += 1;
			continue;
		}
		if (char === "\"") {
			hasCurrent = true;
			index += 1;
			let closed = false;
			while (index < input.length) {
				const inner = input[index];
				if (inner === "\\" && index + 1 < input.length && (input[index + 1] === "\"" || input[index + 1] === "\\")) {
					current += input[index + 1];
					index += 2;
					continue;
				}
				if (inner === "\"") {
					closed = true;
					index += 1;
					break;
				}
				current += inner;
				index += 1;
			}
			if (!closed) throw new Error(`unterminated double quote in args: ${input}`);
			continue;
		}
		if (char === "'") {
			hasCurrent = true;
			index += 1;
			const close = input.indexOf("'", index);
			if (close === -1) throw new Error(`unterminated single quote in args: ${input}`);
			current += input.slice(index, close);
			index = close + 1;
			continue;
		}
		hasCurrent = true;
		current += char;
		index += 1;
	}
	if (hasCurrent) args.push(current);
	return args;
}
/** Hard cap on captured output kept in memory per stream (bytes-ish). */
const CAPTURE_CAP = 128 * 1024;
/** What a settled command execution keeps in the ledger. */
const OUTPUT_TAIL_CHARS = 16e3;
/**
* Keep the tail of a captured output blob (the interesting part of a long
* script log is almost always the end), with an elision marker when trimmed.
*/
function truncateOutputTail(text, maxChars = OUTPUT_TAIL_CHARS) {
	if (text.length <= maxChars) return text;
	return `…（前 ${text.length - maxChars} 字符已省略）\n${text.slice(-maxChars)}`;
}
/** Append a chunk to a capped capture buffer (keeps head + tail marker). */
function appendCapped(buffer, chunk) {
	if (buffer.length >= CAPTURE_CAP) return buffer.slice(chunk.length) + chunk;
	const next = buffer + chunk;
	if (next.length <= CAPTURE_CAP) return next;
	return `…（输出超长，仅保留末尾）\n${next.slice(-131072)}`;
}
//#endregion
//#region src/host/runner.ts
/**
* Host runner: the hermes-cron-shaped engine.
*
* - `tick()` (60s interval, the dsh web host process's lifetime): due jobs
*   fire, schedule rolled forward BEFORE execution (at-most-once), skipped
*   when the job is already running.
* - Execution: pinned sessionId → `agents.resume` (context continuity);
*   otherwise `agents.create` in the target workdir (default workspace when
*   blank) — a fresh session per run, attached to the workspace record so
*   the GUI groups it under the right project.
* - Settlement: the queued user message id is correlated through
*   `session/event` (`user/message` consumes it, `turn/end` settles the
*   execution success/failed).
*/
/** Slug a job title into a session-id-safe prefix (hermes names its cron sessions the same way). */
function slug(title) {
	const base = title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
	return base === "" ? "job" : base.slice(0, 32);
}
/** Safely read a selection off the default-model service (undefined on throw). */
function trySelection(defaults) {
	try {
		const selection = defaults.currentSelection();
		if (selection.provider === "" || selection.model === "") return void 0;
		return selection;
	} catch {
		return;
	}
}
/**
* The live agent for a pinned id, wrapped as a non-owning handle (dispose is
* a no-op — the host, e.g. the open GUI session, owns its lifetime). Returns
* undefined when no live agent is registered under the id.
*/
function liveAgentHandle(agents, sessionId) {
	const live = agents.get?.(sessionId);
	if (live === void 0) return void 0;
	return {
		agent: live,
		dispose: async () => void 0
	};
}
/**
* The scheduled-jobs engine. One instance per host plugin apply(); owns the
* ticker interval, the in-flight map, and the session-event subscription.
*/
var TimerRunner = class {
	ctx;
	store;
	now;
	inFlight = /* @__PURE__ */ new Map();
	commandFlights = /* @__PURE__ */ new Map();
	timer;
	requestTimer;
	disposed = false;
	/** Agent handles for pinned sessions, kept alive across runs (lark precedent). */
	pinnedHandles = /* @__PURE__ */ new Map();
	constructor(deps) {
		this.ctx = deps.ctx;
		this.store = deps.store;
		this.now = deps.now ?? (() => Date.now());
	}
	/** Start the ticker + the session-event watcher. */
	start() {
		if (this.disposed) return;
		this.tick();
		this.timer = setInterval(() => {
			this.tick();
		}, 6e4);
		this.requestTimer = setInterval(() => {
			this.pollRequests();
		}, 5e3);
		this.ctx.effect(() => () => {
			this.stop();
		}, "dsh-timer-agent: runner");
		this.ctx.on("session/event", (session, event) => {
			this.onSessionEvent(session, event);
		});
	}
	/** Stop the ticker (idempotent; pinned handles disposed with the plugin). */
	stop() {
		if (this.timer !== void 0) clearInterval(this.timer);
		if (this.requestTimer !== void 0) clearInterval(this.requestTimer);
		this.timer = void 0;
		this.requestTimer = void 0;
	}
	/** Fire pending manual-run requests only (the 5s fast path). */
	async pollRequests() {
		if (this.disposed) return;
		await this.checkTimeouts();
		if (!(await this.store.load()).some((job) => job.runRequestedAt !== void 0)) return;
		await this.tick();
	}
	/**
	* Enforce per-job run timeouts (n8n / cron-job.org parity, and the
	* stuck-run risk hermes #121953-class issues describe): an execution
	* still in flight past its deadline is cancelled and settled failed.
	* At-most-once: the flight is removed BEFORE settle, so a late turn/end
	* cannot double-settle.
	*/
	async checkTimeouts() {
		for (const flight of [...this.inFlight.values()]) {
			if (flight.timeoutAt === void 0 || this.now() < flight.timeoutAt) continue;
			this.inFlight.delete(flight.messageId);
			try {
				flight.agent?.cancel("dsh-timer-agent: run timed out");
			} catch (error) {
				console.warn("[dsh-timer-agent] timeout cancel failed:", error);
			}
			const seconds = flight.timeoutMs === void 0 ? 0 : Math.max(1, Math.round(flight.timeoutMs / 1e3));
			this.settle(flight.jobId, flight.executionId, "failed", `run timed out after ${seconds}s (deadline reached)`);
		}
		for (const [executionId, flight] of [...this.commandFlights.entries()]) {
			if (flight.timeoutAt === void 0 || this.now() < flight.timeoutAt) continue;
			this.commandFlights.delete(executionId);
			try {
				flight.kill();
			} catch (error) {
				console.warn("[dsh-timer-agent] command timeout kill failed:", error);
			}
			const seconds = flight.timeoutMs === void 0 ? 0 : Math.max(1, Math.round(flight.timeoutMs / 1e3));
			this.settle(flight.jobId, executionId, "failed", `command timed out after ${seconds}s (killed)`);
		}
	}
	async dispose() {
		this.disposed = true;
		this.stop();
		for (const flight of this.commandFlights.values()) try {
			flight.kill();
		} catch {}
		this.commandFlights.clear();
		for (const handle of this.pinnedHandles.values()) await handle.dispose().catch(() => void 0);
		this.pinnedHandles.clear();
	}
	/**
	* One scheduler pass: fire due schedules, then manual run requests.
	* (at-most-once: `nextRunAt` rolls forward before the run is accepted.)
	*/
	async tick() {
		if (this.disposed) return 0;
		await this.checkTimeouts();
		const jobs = await this.store.load();
		let fired = 0;
		for (const job of jobs) {
			const schedule = job.schedule;
			if (job.status !== "archived" && schedule !== void 0 && schedule.enabled && schedule.nextRunAt !== void 0 && schedule.nextRunAt <= this.now()) {
				const next = nextRunAtMs(schedule.cron, schedule.nextRunAt);
				if (await this.requestRun(job.id)) {
					fired += 1;
					await this.store.mutate((current) => {
						const row = current.find((candidate) => candidate.id === job.id);
						if (row === void 0 || row.schedule === void 0) return void 0;
						return {
							jobs: current.map((candidate) => candidate.id === job.id ? withSchedule(candidate, {
								nextRunAt: next,
								lastTriggeredAt: this.now()
							}, this.now()) : candidate),
							result: true
						};
					});
				}
			}
			if (job.runRequestedAt !== void 0) {
				await this.store.mutate((current) => {
					const row = current.find((candidate) => candidate.id === job.id);
					if (row === void 0 || row.runRequestedAt === void 0) return void 0;
					return {
						jobs: current.map((candidate) => candidate.id === job.id ? {
							...candidate,
							runRequestedAt: void 0
						} : candidate),
						result: true
					};
				});
				if (await this.requestRun(job.id)) fired += 1;
			}
		}
		return fired;
	}
	/**
	* Fire one job now (used by the tool's action='run' and the web UI's Run
	* button). Rejects while the job is already running (skip-while-running).
	*/
	async requestRun(jobId, extraPrompt) {
		if (this.disposed) return false;
		const outcome = await this.store.mutate((current) => {
			const job = current.find((candidate) => candidate.id === jobId);
			if (job === void 0 || job.status === "running" || job.status === "archived") return void 0;
			const kind = jobKind(job);
			const targeting = kind === "command" ? "command" : job.target.sessionId !== "" ? "specified-session" : "new-session";
			const { job: next, execution } = startExecution(job, this.now(), randomUUID(), targeting);
			if (kind === "agent" && extraPrompt !== void 0 && extraPrompt.trim() !== "") {
				execution.error = void 0;
				next.prompt = `${next.prompt}\n\n## Run Context\n${extraPrompt}`.trim();
			}
			return {
				jobs: current.map((candidate) => candidate.id === jobId ? next : candidate),
				result: {
					job: next,
					execution
				}
			};
		});
		if (outcome === void 0) return false;
		this.execute(outcome.job, outcome.execution);
		return true;
	}
	/** The real execution: command jobs spawn directly; agent jobs connect/create the agent and send the prompt. */
	async execute(job, execution) {
		if (jobKind(job) === "command") {
			this.executeCommand(job, execution);
			return;
		}
		try {
			const agent = (await this.connectAgent(job)).agent;
			await this.recordSessionId(job.id, execution.id, agent.session.id);
			const message = {
				id: randomUUID(),
				role: "user",
				content: [{
					type: "text",
					text: job.prompt.trim() !== "" ? job.prompt : job.title
				}],
				source: { kind: "user" }
			};
			this.inFlight.set(message.id, {
				jobId: job.id,
				executionId: execution.id,
				sessionId: agent.session.id,
				messageId: message.id,
				consumed: false,
				agent,
				timeoutMs: job.timeoutMs,
				timeoutAt: job.timeoutMs !== void 0 && job.timeoutMs > 0 ? this.now() + job.timeoutMs : void 0
			});
			agent.followup(message);
		} catch (error) {
			await this.settle(job.id, execution.id, "failed", error instanceof Error ? error.message : String(error));
		}
	}
	/**
	* Command execution (普通任务): spawn the job's command + args directly —
	* no AI, no session, no API quota. Exit 0 settles succeeded; anything else
	* (nonzero exit, spawn failure, timeout kill) settles failed with the
	* captured stdout/stderr tail attached to the execution record.
	*/
	executeCommand(job, execution) {
		const command = (job.command ?? "").trim();
		if (command === "") {
			this.settle(job.id, execution.id, "failed", "command is empty (edit the job and set a command)");
			return;
		}
		let argv;
		try {
			argv = [command, ...splitCommandArgs(job.args ?? "")];
		} catch (error) {
			this.settle(job.id, execution.id, "failed", error instanceof Error ? error.message : String(error));
			return;
		}
		let stdout = "";
		let stderr = "";
		let child;
		try {
			const spawned = spawn(argv[0], argv.slice(1), {
				cwd: job.target.workdir.trim() !== "" ? job.target.workdir.trim() : void 0,
				env: process.env,
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				]
			});
			child = spawned;
			spawned.stdout?.on("data", (chunk) => {
				stdout = appendCapped(stdout, Buffer.from(chunk).toString("utf8"));
			});
			spawned.stderr?.on("data", (chunk) => {
				stderr = appendCapped(stderr, Buffer.from(chunk).toString("utf8"));
			});
			const timeoutMs = job.timeoutMs !== void 0 && job.timeoutMs > 0 ? job.timeoutMs : void 0;
			this.commandFlights.set(execution.id, {
				jobId: job.id,
				timeoutMs,
				timeoutAt: timeoutMs !== void 0 ? this.now() + timeoutMs : void 0,
				kill: () => {
					try {
						spawned.kill();
					} catch {}
				}
			});
			spawned.on("error", (error) => {
				this.commandFlights.delete(execution.id);
				this.settle(job.id, execution.id, "failed", `failed to start command '${command}': ${error instanceof Error ? error.message : String(error)}`);
			});
			spawned.on("close", (code, signal) => {
				this.commandFlights.delete(execution.id);
				const output = truncateOutputTail(stdout === "" && stderr === "" ? "" : `${stdout}${stderr === "" ? "" : `\n[stderr]\n${stderr}`}`);
				if (signal !== null && signal !== void 0) {
					this.settle(job.id, execution.id, "failed", `command killed by signal ${signal}`, { output });
					return;
				}
				if (code === 0) {
					this.settle(job.id, execution.id, "succeeded", void 0, {
						exitCode: 0,
						output
					});
					return;
				}
				this.settle(job.id, execution.id, "failed", code === null ? "command exited without an exit code" : `command exited with code ${code}`, {
					exitCode: code ?? void 0,
					output
				});
			});
		} catch (error) {
			if (child !== void 0) this.commandFlights.delete(execution.id);
			this.settle(job.id, execution.id, "failed", error instanceof Error ? error.message : String(error));
		}
	}
	/**
	* Pinned session → live agent if one is running, else resume (cached);
	* otherwise a new session in the workdir.
	*/
	async connectAgent(job) {
		const pinnedId = job.target.sessionId;
		if (pinnedId !== "") {
			const agents = this.ctx.agents;
			const live = liveAgentHandle(agents, pinnedId);
			if (live !== void 0) return live;
			const cached = this.pinnedHandles.get(pinnedId);
			if (cached !== void 0) return cached;
			let resumeSetup;
			try {
				resumeSetup = await this.presetSetupFor(pinnedId);
			} catch (error) {
				console.warn("[dsh-timer-agent] preset composition for pinned session failed; resuming bare:", error);
			}
			try {
				const handle = await agents.resume({
					resumeSessionId: pinnedId,
					...job.modelSelection === void 0 ? {} : { agentOptions: { ...job.modelSelection } },
					...resumeSetup === void 0 ? {} : { setup: resumeSetup }
				});
				this.pinnedHandles.set(pinnedId, handle);
				return handle;
			} catch (error) {
				const raced = liveAgentHandle(agents, pinnedId);
				if (raced !== void 0) return raced;
				console.warn("[dsh-timer-agent] resume of pinned session failed; creating a new one:", error);
			}
		}
		const agents = this.ctx.agents;
		const sessionId = `timer-${slug(job.title)}-${new Date(this.now()).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
		const defaults = this.ctx.get("agentDefaultModel");
		let agentOptions;
		const seed = job.modelSelection ?? (defaults === void 0 ? void 0 : trySelection(defaults));
		if (seed !== void 0) agentOptions = {
			provider: seed.provider,
			model: seed.model
		};
		let presetMeta;
		let presetSetup;
		({presetMeta, presetSetup} = await this.composePreset(job.preset));
		const handle = await agents.create({
			sessionId,
			...agentOptions !== void 0 ? { agentOptions } : {},
			...job.target.workdir !== "" ? { meta: {
				cwd: job.target.workdir,
				...presetMeta
			} } : presetMeta === void 0 ? {} : { meta: presetMeta },
			...presetSetup === void 0 ? {} : { setup: presetSetup }
		});
		await this.attachWorkspace(sessionId, job.target.workdir).catch(() => void 0);
		return handle;
	}
	/**
	* Compose a NEW session's preset: resolve the wanted id (or the roster
	* default when blank), record it on the session header, and join the
	* agent's scope to its standing mount inside the factory setup hook
	* (api-proxy composeAgent precedent — the join decides the agent's tools,
	* prompt sections, and skills, so a session created bare resolves them
	* against the empty global layer). Undefined parts when no roster is
	* composed; a broken preset rejects so creation rolls back with the
	* resolver's error — except a job-pinned id the roster no longer knows,
	* which degrades to the default (warned) rather than failing every run.
	*/
	async composePreset(wanted) {
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) return {
			presetMeta: void 0,
			presetSetup: void 0
		};
		let resolvedId;
		if (wanted !== void 0 && wanted.trim() !== "") try {
			resolvedId = (await presets.resolve(wanted)).id;
		} catch (error) {
			console.warn(`[dsh-timer-agent] job preset "${wanted}" is not on the roster; falling back to the default:`, error);
			resolvedId = (await presets.resolve()).id;
		}
		else resolvedId = (await presets.resolve()).id;
		return {
			presetMeta: { agentPreset: resolvedId },
			presetSetup: async (agentCtx) => {
				await presets.mount(agentCtx, resolvedId);
			}
		};
	}
	/**
	* Compose a RESUMED session's recorded preset: the last
	* `agent-preset/selected` event wins over the creation header
	* (`resolveSessionPreset` semantics), read through cold persistence
	* inspection; a session that recorded none falls back to the roster
	* default. Rejection means "compose nothing" — the caller resumes bare
	* rather than abandoning the pinned conversation.
	*/
	async presetSetupFor(sessionId) {
		const presets = this.ctx.get("agentPresets");
		if (presets === void 0) return void 0;
		let recorded;
		try {
			const persistence = this.ctx.get("sessionPersistence");
			const inspected = persistence === void 0 ? void 0 : await persistence.inspect(sessionId);
			if (inspected !== void 0) {
				for (let index = inspected.events.length - 1; index >= 0; index -= 1) {
					const event = inspected.events[index];
					if (event?.type === "agent-preset/selected" && typeof event.data?.agentPreset === "string") {
						recorded = event.data.agentPreset;
						break;
					}
				}
				recorded = recorded ?? inspected.meta.agentPreset;
			}
		} catch {
			recorded = void 0;
		}
		const resolvedId = (await presets.resolve(recorded)).id;
		return async (agentCtx) => {
			await presets.mount(agentCtx, resolvedId);
		};
	}
	/** Best-effort workspace grouping so the run lands under the right project in the GUI. */
	async attachWorkspace(sessionId, workdir) {
		if (workdir === "") return;
		const registry = this.ctx.get("workspaceRegistry");
		if (registry === void 0) return;
		await (await registry.resolveByPath(workdir) ?? await registry.create(workdir).catch(() => void 0))?.attachSession(sessionId);
	}
	/** Fold the session-event stream into execution settlement. */
	onSessionEvent(session, event) {
		for (const flight of this.inFlight.values()) {
			if (flight.sessionId !== session.id) continue;
			if (event.type === "user/message") {
				if (event.data?.id === flight.messageId) flight.consumed = true;
				continue;
			}
			if (isTurnEndEvent(event) && flight.consumed) {
				const detail = turnErrorDetail(event.data);
				this.settle(flight.jobId, flight.executionId, detail === "" ? "succeeded" : "failed", detail === "" ? void 0 : detail);
				this.inFlight.delete(flight.messageId);
			}
		}
	}
	/** Persist a settled (or failed-to-start) execution and job status. */
	async settle(jobId, executionId, outcome, error, extra) {
		await this.store.mutate((current) => {
			if (current.find((candidate) => candidate.id === jobId) === void 0) return void 0;
			return {
				jobs: current.map((candidate) => candidate.id === jobId ? settleExecution(candidate, executionId, outcome, this.now(), error, extra) : candidate),
				result: true
			};
		});
	}
	/** Record which session an execution landed in (the 'started' event). */
	async recordSessionId(jobId, executionId, sessionId) {
		await this.store.mutate((current) => {
			if (current.find((candidate) => candidate.id === jobId) === void 0) return void 0;
			return {
				jobs: current.map((candidate) => candidate.id === jobId ? {
					...candidate,
					updatedAt: this.now(),
					executions: candidate.executions.map((execution) => execution.id === executionId ? {
						...execution,
						sessionId
					} : execution)
				} : candidate),
				result: true
			};
		});
	}
};
//#endregion
//#region src/host/tools.ts
/**
* The `timer_agent` model-facing tool (the hermes `cronjob` tool's shape):
* lets any conversation create/list/update/pause/resume/remove/run the
* scheduled jobs the host ticker owns. Jobs created here are the SAME rows
* the web UI's「定时任务」panel renders and the host ticker fires — one
* ledger, three doorways (tool, WebUI, file).
*
* @module dsh-timer-agent/tools
*/
/** One job row summarized for the model (compact, no execution history dump). */
function summarize(job) {
	const last = job.executions[job.executions.length - 1];
	const result = {
		id: job.id,
		title: job.title,
		status: job.status,
		job_kind: jobKind(job)
	};
	if (jobKind(job) === "command") {
		result.command = job.command ?? "";
		result.args = job.args ?? "";
		if (job.target.workdir !== "") result.workdir = job.target.workdir;
	} else {
		result.target = job.target.sessionId !== "" ? { session: job.target.sessionId } : {
			workdir: job.target.workdir === "" ? "(default workspace)" : job.target.workdir,
			mode: "new-session"
		};
		if (job.target.sessionId === "" && job.preset !== void 0 && job.preset !== "") result.preset = job.preset;
	}
	if (job.schedule?.enabled === true) {
		const schedule = { cron: job.schedule.cron };
		if (job.schedule.nextRunAt !== void 0) schedule.next_run_at = new Date(job.schedule.nextRunAt).toISOString();
		result.schedule = schedule;
	}
	if (job.timeoutMs !== void 0) result.timeout_minutes = Math.round(job.timeoutMs / 6e4);
	if (last !== void 0) {
		const lastExecution = {
			result: last.result ?? "running",
			at: new Date(last.startedAt).toISOString()
		};
		if (jobKind(job) !== "command" && last.sessionId !== void 0) lastExecution.session = last.sessionId;
		if (last.exitCode !== void 0) lastExecution.exit_code = last.exitCode;
		result.last_execution = lastExecution;
	}
	return result;
}
/**
* Register the `timer_agent` tool into the shared tools registry.
* @param tools - the injected `tools` registry.
* @param deps - store/runner/clock faces.
* @returns the disposer.
*/
function registerTimerTool(tools, deps) {
	return tools.register(defineTool({
		name: "timer_agent",
		description: [
			"Manage scheduled timer jobs that fire on a cron schedule (the dsh-timer-agent engine; the same jobs appear in the web GUI「定时任务」panel).",
			"Two job kinds: kind='agent' (default) fires a real agent session from a self-contained prompt; kind='command' (普通任务) directly spawns command+args with no AI — use it for scripts that just need a timer.",
			"action='create' schedules a new job (requires schedule; agent jobs also require prompt — self-contained, scheduled runs get no current-chat context unless session is pinned; command jobs require command instead).",
			"action='list' shows all jobs; action='update' edits prompt/schedule/name/command/args; action='pause'/'resume' arms/disarms the schedule; action='archive' freezes a job (no schedule fires, no manual runs) and action='restart' un-archives it back to idle; action='remove' deletes; action='run' fires immediately in the background (returns at once).",
			"schedule syntax: 5-field cron like '0 9 * * *' (min hour day month weekday).",
			"session targeting (agent jobs only): leave both workdir and session empty → each run starts a NEW conversation in the default workspace; pass session=<existing session id> → every run continues that conversation (continuity); pass workdir=<absolute project path> → new sessions run inside that project. For command jobs, workdir is the process cwd.",
			"preset (agent jobs with new sessions only): the agent-preset id new sessions are composed from (its tools/prompt sections/skills); empty = the deployment default. Ignored when session is pinned.",
			"Scheduled runs execute autonomously with no user present — prompts must not ask questions."
		].join("\n"),
		timeoutMs: 15e3,
		parameters: {
			action: {
				type: "string",
				description: "One of: create, list, update, pause, resume, archive, restart, remove, run. Required."
			},
			job_id: {
				type: "string",
				description: "Job id (required for update/pause/resume/archive/restart/remove/run). Get ids from action=list; never guess."
			},
			prompt: {
				type: "string",
				description: "For create: the full self-contained prompt the scheduled run executes (agent jobs only; required unless kind='command'). For update: replacement prompt. For run: optional transient context appended for this single fire only."
			},
			kind: {
				type: "string",
				description: "For create/update: job kind — 'agent' (default; AI session executes prompt) or 'command' (普通任务; spawns command+args directly, no AI)."
			},
			command: {
				type: "string",
				description: "For create/update (kind='command'): the executable to spawn, e.g. 'pwsh', 'python', 'node', or an absolute path. Required for command jobs."
			},
			args: {
				type: "string",
				description: "For create/update (kind='command'): argument string for the command; whitespace-separated, supports \"double\"/'single' quoted groups. E.g. '-X utf8 temu_yh_yinhua.py' or '-Command \"echo hi\"'."
			},
			schedule: {
				type: "string",
				description: "For create (required) / update: 5-field cron, e.g. '0 9 * * *' daily at 9am, '*/30 * * * *' every 30 minutes."
			},
			name: {
				type: "string",
				description: "For create/update: short human title."
			},
			workdir: {
				type: "string",
				description: "For create/update: absolute project directory the run's session works in (its AGENTS.md loads). Empty = default workspace. Pass empty string on update to clear."
			},
			session: {
				type: "string",
				description: "For create/update: pin an existing session id — every run continues that conversation instead of starting new ones. Pass empty string on update to clear."
			},
			preset: {
				type: "string",
				description: "For create/update (agent jobs, new sessions only): agent-preset id the new sessions are composed from (its tools/prompt sections/skills); empty = the deployment default preset. Ignored when session is pinned. Pass empty string on update to clear."
			},
			timeout_minutes: {
				type: "number",
				description: "For create/update: cancel and fail a run still in flight after this many minutes (0 or negative clears the limit). Absent = unlimited."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true
					},
					job: { type: "json" },
					jobs: { type: "json" },
					error: { type: "string" }
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: typeof value.error === "string" && value.error !== "" ? `timer_agent ${String(value.kind)}: ${value.error}` : `timer_agent ${String(value.kind)} ok${value.job !== void 0 ? `: ${JSON.stringify(value.job)}` : value.jobs !== void 0 ? `: ${String(value.jobs.length)} job(s)` : ""}`
			}]
		},
		async execute(args) {
			const action = (args.action ?? "").trim().toLowerCase();
			const now = deps.now;
			if (action === "list") return {
				kind: "list",
				jobs: (await deps.store.load()).map(summarize)
			};
			if (action === "create") {
				const cron = (args.schedule ?? "").trim();
				const prompt = (args.prompt ?? "").trim();
				const kind = args.kind === "command" ? "command" : "agent";
				const command = (args.command ?? "").trim();
				if (cron === "") return {
					kind: "create",
					error: "schedule is required for create"
				};
				if (!isValidCron(cron)) return {
					kind: "create",
					error: `invalid cron expression: ${cron}`
				};
				if (kind === "command") {
					if (command === "") return {
						kind: "create",
						error: "command is required for create with kind='command'"
					};
				} else if (prompt === "") return {
					kind: "create",
					error: "prompt is required for create (must be self-contained)"
				};
				const fallbackTitle = kind === "command" ? `${command} ${(args.args ?? "").trim()}`.trim().slice(0, 40) : prompt.slice(0, 40);
				const job = createJob({
					title: (args.name ?? "").trim() !== "" ? (args.name ?? "").trim() : fallbackTitle,
					description: "",
					prompt,
					...kind === "command" ? {
						kind: "command",
						command,
						args: (args.args ?? "").trim()
					} : {},
					target: {
						workdir: (args.workdir ?? "").trim(),
						sessionId: (args.session ?? "").trim()
					},
					...kind === "agent" && (args.preset ?? "").trim() !== "" ? { preset: (args.preset ?? "").trim() } : {}
				}, now(), randomUUID());
				const timeoutMs = normalizeTimeoutMs((args.timeout_minutes ?? 0) * 6e4);
				const scheduled = withSchedule(timeoutMs === void 0 ? job : {
					...job,
					timeoutMs
				}, {
					enabled: true,
					cron,
					nextRunAt: nextRunAtMs(cron, now())
				}, now());
				await deps.store.mutate((jobs) => ({
					jobs: [...jobs, scheduled],
					result: true
				}));
				return {
					kind: "create",
					job: summarize(scheduled)
				};
			}
			if (action === "run") {
				const id = (args.job_id ?? "").trim();
				if (id === "") return {
					kind: "run",
					error: "job_id is required for run (use list to find ids)"
				};
				const extra = args.prompt;
				if (!await deps.runner.requestRun(id, extra)) return {
					kind: "run",
					error: `job ${id} not found or already running`
				};
				return {
					kind: "run",
					job: {
						id,
						note: "fired in the background; its session appears in the session list"
					}
				};
			}
			const id = (args.job_id ?? "").trim();
			if (id === "") return {
				kind: action,
				error: "job_id is required (use list to find ids)"
			};
			if (action === "remove") {
				if (await deps.store.mutate((jobs) => {
					if (!jobs.some((job) => job.id === id)) return void 0;
					return {
						jobs: jobs.filter((job) => job.id !== id),
						result: true
					};
				}) === void 0) return {
					kind: "remove",
					error: `job ${id} not found`
				};
				return {
					kind: "remove",
					job: { id }
				};
			}
			if (action === "pause" || action === "resume") {
				const enabled = action === "resume";
				const updated = await deps.store.mutate((jobs) => {
					const job = jobs.find((candidate) => candidate.id === id);
					if (job === void 0 || job.schedule === void 0) return void 0;
					const cron = job.schedule?.cron ?? "";
					if (enabled && !isValidCron(cron)) return void 0;
					const next = withSchedule(job, {
						enabled,
						nextRunAt: enabled ? nextRunAtMs(cron, now()) : void 0
					}, now());
					return {
						jobs: jobs.map((candidate) => candidate.id === id ? next : candidate),
						result: next
					};
				});
				if (updated === void 0) return {
					kind: action,
					error: `job ${id} not found or has no usable schedule`
				};
				return {
					kind: action,
					job: summarize(updated)
				};
			}
			if (action === "update") {
				const updated = await deps.store.mutate((jobs) => {
					const job = jobs.find((candidate) => candidate.id === id);
					if (job === void 0) return void 0;
					let next = {
						...job,
						updatedAt: now()
					};
					if (args.name !== void 0 && args.name.trim() !== "") next = {
						...next,
						title: args.name.trim()
					};
					if (args.prompt !== void 0 && args.prompt.trim() !== "") next = {
						...next,
						prompt: args.prompt.trim()
					};
					if (args.workdir !== void 0) next = {
						...next,
						target: {
							...next.target,
							workdir: args.workdir.trim()
						}
					};
					if (args.session !== void 0) next = {
						...next,
						target: {
							...next.target,
							sessionId: args.session.trim()
						}
					};
					if (args.preset !== void 0) {
						const preset = args.preset.trim();
						next = { ...next };
						if (preset === "" || jobKind(next) === "command") delete next.preset;
						else next.preset = preset;
					}
					if (args.kind !== void 0) {
						const kind = args.kind.trim().toLowerCase();
						if (kind !== "agent" && kind !== "command") return void 0;
						if (kind === "command") {
							const command = (args.command ?? next.command ?? "").trim();
							if (command === "") return void 0;
							next = {
								...next,
								kind: "command",
								command,
								args: (args.args ?? next.args ?? "").trim()
							};
						} else {
							next = { ...next };
							delete next.kind;
							delete next.command;
							delete next.args;
						}
					} else if (args.command !== void 0 || args.args !== void 0) {
						if (jobKind(next) !== "command") return void 0;
						const command = args.command !== void 0 ? args.command.trim() : next.command ?? "";
						if (command === "") return void 0;
						next = {
							...next,
							kind: "command",
							command,
							args: args.args !== void 0 ? args.args.trim() : next.args ?? ""
						};
					}
					if (args.timeout_minutes !== void 0) {
						const timeoutMs = normalizeTimeoutMs(args.timeout_minutes * 6e4);
						if (timeoutMs === void 0) delete next.timeoutMs;
						else next = {
							...next,
							timeoutMs
						};
					}
					if (args.schedule !== void 0) {
						const cron = args.schedule.trim();
						if (cron === "") return void 0;
						if (!isValidCron(cron)) return void 0;
						const wasEnabled = next.schedule?.enabled ?? false;
						next = withSchedule(next, {
							cron,
							...wasEnabled ? {
								enabled: true,
								nextRunAt: nextRunAtMs(cron, now())
							} : {}
						}, now());
					}
					if (next.title === job.title && next.prompt === job.prompt && next.target === job.target && next.schedule === job.schedule) {}
					return {
						jobs: jobs.map((candidate) => candidate.id === id ? next : candidate),
						result: next
					};
				});
				if (updated === void 0) return {
					kind: "update",
					error: `job ${id} not found or invalid fields`
				};
				return {
					kind: "update",
					job: summarize(updated)
				};
			}
			if (action === "reset") {
				const updated = await deps.store.mutate((jobs) => {
					const job = jobs.find((candidate) => candidate.id === id);
					if (job === void 0) return void 0;
					const next = withStatus(job, "idle", now());
					return {
						jobs: jobs.map((candidate) => candidate.id === id ? next : candidate),
						result: next
					};
				});
				if (updated === void 0) return {
					kind: "reset",
					error: `job ${id} not found`
				};
				return {
					kind: "reset",
					job: summarize(updated)
				};
			}
			if (action === "archive" || action === "restart") {
				const updated = await deps.store.mutate((jobs) => {
					const job = jobs.find((candidate) => candidate.id === id);
					if (job === void 0) return void 0;
					if (action === "archive") {
						if (job.status === "running") return void 0;
						const next = withStatus(job, "archived", now());
						return {
							jobs: jobs.map((candidate) => candidate.id === id ? next : candidate),
							result: next
						};
					}
					if (job.status !== "archived") return void 0;
					let next = withStatus(job, "idle", now());
					const cron = next.schedule?.cron ?? "";
					if (next.schedule?.enabled === true && isValidCron(cron)) next = withSchedule(next, {
						enabled: true,
						nextRunAt: nextRunAtMs(cron, now())
					}, now());
					return {
						jobs: jobs.map((candidate) => candidate.id === id ? next : candidate),
						result: next
					};
				});
				if (updated === void 0) return {
					kind: action,
					error: action === "archive" ? `job ${id} not found or currently running` : `job ${id} not found or not archived`
				};
				return {
					kind: action,
					job: summarize(updated)
				};
			}
			return {
				kind: action,
				error: `unknown action: ${action}`
			};
		}
	}));
}
//#endregion
//#region src/host/routes.ts
/**
* The /api/dsh-timer-agent route family: the browser half's read/write
* window onto the host-authoritative ledger. Every route carries the same
* loopback-only trust fence dsh-ssh uses (these endpoints can fire real
* agent sessions, so LAN-exposed dsh web deployments must not serve them).
*
* - GET    /api/dsh-timer-agent/jobs          → the full ledger
* - POST   /api/dsh-timer-agent/jobs          → create a job
* - PATCH  /api/dsh-timer-agent/jobs?id=…     → update fields / arm cron
* - DELETE /api/dsh-timer-agent/jobs?id=…     → remove
* - POST   /api/dsh-timer-agent/jobs/run?id=… → fire now (background)
* - GET    /api/dsh-timer-agent/workspaces    → host workspace registry {id,path}
* - GET    /api/dsh-timer-agent/model-options → default model + provider/model catalog
* - GET    /api/dsh-timer-agent/preset-options→ default preset id + preset roster
*
* @module dsh-timer-agent/routes
*/
/** Cap on JSON bodies (job rows are small). */
const MAX_JSON_BODY_BYTES = 256 * 1024;
/** Loopback literal check plus browser same-origin markers (dsh-ssh fence). */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const originHeader = request.headers.origin;
	const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.byteLength;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(chunk);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** First query param value from the request url. */
function queryParam(req, key) {
	const raw = req.url ?? "/";
	const index = raw.indexOf("?");
	if (index === -1) return void 0;
	for (const pair of raw.slice(index + 1).split("&")) {
		const eq = pair.indexOf("=");
		if (eq === -1) continue;
		if (decodeURIComponent(pair.slice(0, eq)) === key) return decodeURIComponent(pair.slice(eq + 1));
	}
}
/** Validate an unknown body value as a model selection; undefined = follow default. */
function readModelSelection(value) {
	if (value === null || value === void 0) return void 0;
	if (typeof value !== "object") return "invalid";
	const record = value;
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const model = typeof record.model === "string" ? record.model.trim() : "";
	if (provider === "" || model === "") return "invalid";
	return {
		provider,
		model
	};
}
/**
* Build the route family.
* @param deps - store/runner/context/clock faces.
* @returns the routes to register on the webserver.
*/
function makeRoutes(deps) {
	return [
		{
			kind: "exact",
			path: "/api/dsh-timer-agent/jobs",
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				const method = req.method ?? "GET";
				if (method === "GET") {
					writeJson(res, 200, { jobs: await deps.store.load() });
					return;
				}
				if (method === "POST") {
					const body = await readJsonBody(req);
					if (body === void 0) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const title = typeof body.title === "string" ? body.title.trim() : "";
					if (title === "") {
						writeJson(res, 400, { error: "title is required" });
						return;
					}
					const cron = typeof body.cron === "string" ? body.cron.trim() : "";
					const armCron = cron !== "";
					if (armCron && !isValidCron(cron)) {
						writeJson(res, 400, { error: `invalid cron expression: ${cron}` });
						return;
					}
					const kind = body.kind === "command" ? "command" : "agent";
					const command = typeof body.command === "string" ? body.command.trim() : "";
					const args = typeof body.args === "string" ? body.args : "";
					if (kind === "command" && command === "") {
						writeJson(res, 400, { error: "command is required for command jobs" });
						return;
					}
					const target = typeof body.target === "object" && body.target !== null ? body.target : {};
					const modelSelection = readModelSelection(body.modelSelection);
					if (modelSelection === "invalid") {
						writeJson(res, 400, { error: "modelSelection must be { provider, model }" });
						return;
					}
					const preset = kind === "agent" && typeof body.preset === "string" ? body.preset.trim() : "";
					let job = createJob({
						title,
						description: typeof body.description === "string" ? body.description : "",
						prompt: typeof body.prompt === "string" ? body.prompt : "",
						...kind === "command" ? {
							kind: "command",
							command,
							args
						} : {},
						target: {
							workdir: typeof target.workdir === "string" ? target.workdir.trim() : "",
							sessionId: typeof target.sessionId === "string" ? target.sessionId.trim() : ""
						},
						...preset === "" ? {} : { preset },
						...modelSelection === void 0 ? {} : { modelSelection }
					}, deps.now(), randomUUID());
					if (typeof body.timeoutMinutes === "number") {
						const timeoutMs = normalizeTimeoutMs(body.timeoutMinutes * 6e4);
						if (timeoutMs === void 0) delete job.timeoutMs;
						else job = {
							...job,
							timeoutMs
						};
					}
					if (armCron) job = withSchedule(job, {
						enabled: true,
						cron,
						nextRunAt: nextRunAtMs(cron, deps.now())
					}, deps.now());
					await deps.store.mutate((jobs) => ({
						jobs: [...jobs, job],
						result: true
					}));
					writeJson(res, 201, { job });
					return;
				}
				if (method === "PATCH") {
					const id = queryParam(req, "id");
					if (id === void 0 || id === "") {
						writeJson(res, 400, { error: "id query parameter is required" });
						return;
					}
					const body = await readJsonBody(req);
					if (body === void 0) {
						writeJson(res, 400, { error: "invalid JSON body" });
						return;
					}
					const updated = await deps.store.mutate((jobs) => {
						const job = jobs.find((candidate) => candidate.id === id);
						if (job === void 0) return void 0;
						let next = {
							...job,
							updatedAt: deps.now()
						};
						if (typeof body.title === "string" && body.title.trim() !== "") next = {
							...next,
							title: body.title.trim()
						};
						if (typeof body.description === "string") next = {
							...next,
							description: body.description
						};
						if (typeof body.prompt === "string") next = {
							...next,
							prompt: body.prompt
						};
						if (body.kind === "command") {
							const command = typeof body.command === "string" ? body.command.trim() : next.command ?? "";
							if (command === "") return void 0;
							next = {
								...next,
								kind: "command",
								command,
								args: typeof body.args === "string" ? body.args : next.args ?? ""
							};
						} else if (body.kind === "agent") {
							next = { ...next };
							delete next.kind;
							delete next.command;
							delete next.args;
						} else if (body.command !== void 0 || body.args !== void 0) {
							if (next.kind !== "command") return void 0;
							const command = typeof body.command === "string" ? body.command.trim() : next.command ?? "";
							if (command === "") return void 0;
							next = {
								...next,
								kind: "command",
								command,
								args: typeof body.args === "string" ? body.args : next.args ?? ""
							};
						}
						if ("timeoutMinutes" in body && typeof body.timeoutMinutes === "number") {
							const timeoutMs = normalizeTimeoutMs(body.timeoutMinutes * 6e4);
							if (timeoutMs === void 0) delete next.timeoutMs;
							else next = {
								...next,
								timeoutMs
							};
						}
						if ("modelSelection" in body) {
							const modelSelection = readModelSelection(body.modelSelection);
							if (modelSelection === "invalid") return void 0;
							if (modelSelection === void 0) next = { ...next };
							else next = {
								...next,
								modelSelection
							};
							if (modelSelection === void 0) delete next.modelSelection;
						}
						if (typeof body.preset === "string") {
							const preset = body.preset.trim();
							next = { ...next };
							if (preset === "" || next.kind === "command") delete next.preset;
							else next.preset = preset;
						}
						if (typeof body.target === "object" && body.target !== null) {
							const target = body.target;
							next = {
								...next,
								target: {
									workdir: typeof target.workdir === "string" ? target.workdir.trim() : next.target.workdir,
									sessionId: typeof target.sessionId === "string" ? target.sessionId.trim() : next.target.sessionId
								}
							};
						}
						if (typeof body.cron === "string" && body.cron.trim() !== "") {
							const cron = body.cron.trim();
							if (!isValidCron(cron)) return void 0;
							next = withSchedule(next, { cron }, deps.now());
							if (next.schedule?.enabled === true) next = withSchedule(next, {
								enabled: true,
								nextRunAt: nextRunAtMs(cron, deps.now())
							}, deps.now());
						}
						if (body.scheduleEnabled === true) {
							const cron = next.schedule?.cron ?? "";
							if (!isValidCron(cron)) return void 0;
							next = withSchedule(next, {
								enabled: true,
								nextRunAt: nextRunAtMs(cron, deps.now())
							}, deps.now());
						}
						if (body.scheduleEnabled === false) next = withSchedule(next, {
							enabled: false,
							nextRunAt: void 0
						}, deps.now());
						if (body.resetStatus === true) next = withStatus(next, "idle", deps.now());
						if (body.archived === true && next.status !== "running") next = withStatus(next, "archived", deps.now());
						if (body.restart === true && next.status === "archived") {
							next = withStatus(next, "idle", deps.now());
							const cron = next.schedule?.cron ?? "";
							if (next.schedule?.enabled === true && isValidCron(cron)) next = withSchedule(next, {
								enabled: true,
								nextRunAt: nextRunAtMs(cron, deps.now())
							}, deps.now());
						}
						if (body.skipNext === true) {
							const cron = next.schedule?.cron ?? "";
							if (next.schedule?.enabled !== true || !isValidCron(cron)) return void 0;
							const skipped = nextRunAtMs(cron, Math.max(next.schedule.nextRunAt ?? deps.now(), deps.now()));
							if (skipped === void 0) return void 0;
							next = withSchedule(next, {
								enabled: true,
								nextRunAt: skipped
							}, deps.now());
						}
						return {
							jobs: jobs.map((candidate) => candidate.id === id ? next : candidate),
							result: next
						};
					});
					if (updated === void 0) {
						writeJson(res, 400, { error: "job not found or invalid fields" });
						return;
					}
					writeJson(res, 200, { job: updated });
					return;
				}
				if (method === "DELETE") {
					const id = queryParam(req, "id");
					if (id === void 0 || id === "") {
						writeJson(res, 400, { error: "id query parameter is required" });
						return;
					}
					if (await deps.store.mutate((jobs) => {
						if (!jobs.some((job) => job.id === id)) return void 0;
						return {
							jobs: jobs.filter((job) => job.id !== id),
							result: true
						};
					}) === void 0) {
						writeJson(res, 404, { error: "job not found" });
						return;
					}
					writeJson(res, 200, { ok: true });
					return;
				}
				writeJson(res, 405, { error: `method not allowed: ${method}` });
			}
		},
		{
			kind: "exact",
			path: "/api/dsh-timer-agent/jobs/run",
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "POST") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const id = queryParam(req, "id");
				if (id === void 0 || id === "") {
					writeJson(res, 400, { error: "id query parameter is required" });
					return;
				}
				if (!await deps.runner.requestRun(id)) {
					writeJson(res, 409, { error: "job not found or already running" });
					return;
				}
				writeJson(res, 202, {
					ok: true,
					note: "fired in the background"
				});
			}
		},
		{
			kind: "exact",
			path: "/api/dsh-timer-agent/workspaces",
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				writeJson(res, 200, { workspaces: (deps.ctx.get("workspaceRegistry")?.list?.() ?? []).map((item) => ({
					id: item.id,
					path: item.path
				})) });
			}
		},
		{
			kind: "exact",
			path: "/api/dsh-timer-agent/model-options",
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				let fallback;
				try {
					fallback = deps.ctx.get("agentDefaultModel")?.currentSelection();
				} catch {
					fallback = void 0;
				}
				const llm = deps.ctx.get("llm");
				const groups = [];
				const failures = [];
				if (llm !== void 0) await Promise.all(llm.listProviders().map(async (provider) => {
					try {
						const entries = (await llm.listModels(provider.id)).map((model) => ({
							id: model.id,
							name: model.name
						}));
						if (entries.length > 0) groups.push({
							id: provider.id,
							name: provider.name,
							models: entries
						});
					} catch (error) {
						failures.push({
							id: provider.id,
							name: provider.name,
							message: error instanceof Error ? error.message : String(error)
						});
					}
				}));
				writeJson(res, 200, {
					default: fallback,
					groups,
					failures
				});
			}
		},
		{
			kind: "exact",
			path: "/api/dsh-timer-agent/preset-options",
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const presets = deps.ctx.get("agentPresets");
				if (presets === void 0) {
					writeJson(res, 200, { presets: [] });
					return;
				}
				let rows;
				try {
					rows = await presets.list();
				} catch (error) {
					writeJson(res, 500, { error: `preset roster failed: ${error instanceof Error ? error.message : String(error)}` });
					return;
				}
				let defaultId;
				try {
					defaultId = presets.defaultId;
				} catch {
					defaultId = void 0;
				}
				writeJson(res, 200, {
					...defaultId === void 0 ? {} : { default: defaultId },
					presets: rows.map((row) => ({
						id: row.id,
						trust: row.trust,
						...row.name === void 0 ? {} : { name: row.name },
						...row.description === void 0 ? {} : { description: row.description },
						...row.broken === void 0 ? {} : { broken: row.broken }
					}))
				});
			}
		}
	];
}
//#endregion
//#region src/index.ts
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 201;
/** Plugin name: used for logs, diagnostics, and Fiber identity. */
const name = "dsh-timer-agent";
const inject = [
	"webServer",
	"tools",
	"systemPrompt",
	"agents"
];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const TIMER_AGENT_GUIDANCE = "本机已安装 dsh-timer-agent 插件（DSH 定时任务引擎，host 常驻，参考 hermes-agent cron）：60 秒 ticker 在 dsh web 服务进程内常驻运行，dsh web 服务启动即生效（GUI 页面关闭也照常触发）。任务台账存于 ~/.dsh/timer-agent/jobs.json。任务分两类：kind=agent（默认，AI Agent 任务）到点通过真实 agent 会话执行 prompt；kind=command（普通任务）不经过 AI，直接 spawn command+args 执行脚本，不消耗 API 额度。任务支持 5 段 cron（如 0 9 * * *）；agent 任务可指定项目 workdir（任务会话在该目录运行并加载其 AGENTS.md）、可指定已有会话 session（每次触发继续该对话，具备上下文连续性）；两者都留空则每次触发在默认工作空间新建会话发起新对话；command 任务只需标题、命令、参数与定时器（workdir 作为进程工作目录，超时同样生效，退出码非 0 记为失败并保留输出尾部）。对话中可用 timer_agent 工具直接 create/list/update/pause/resume/remove/run 定时任务（create/update 支持 kind/command/args 参数）；Web GUI 侧边栏「定时任务」面板管理同一批任务。定时执行无人在场，agent 任务的 prompt 必须自包含、不可提问。用户提到「定时任务 / 定时器 / cron」时即指本插件，请据此协作。";
/** Settings namespace of the plugin's capability. */
const TIMER_AGENT_SETTINGS_NAMESPACE = settingsNamespace("timer-agent");
const Config = z.object({
	announceToAgent: z.boolean().default(true),
	enabled: z.boolean().default(true)
});
/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = true;
/**
* Mount the engine: ticker + runner, tool, routes, announcement.
* @param ctx - host plugin context (webServer/tools/systemPrompt/agents).
* @param config - resolved plugin config.
*/
function apply(ctx, config) {
	const host = ctx;
	let current = () => config ?? {};
	let disposeEngine;
	let disposeTool;
	let disposeSection;
	const sync = () => {
		for (const dispose of [
			disposeEngine,
			disposeTool,
			disposeSection
		]) dispose?.();
		disposeEngine = void 0;
		disposeTool = void 0;
		disposeSection = void 0;
		if ((current().enabled ?? true) === false) return;
		const store = new HostJobStore();
		const runner = new TimerRunner({
			ctx: host,
			store
		});
		runner.start();
		disposeTool = ctx.effect(() => registerTimerTool(ctx.tools, {
			store,
			runner,
			now: () => Date.now()
		}), "dsh-timer-agent: tool");
		const routes = makeRoutes({
			store,
			runner,
			ctx: host,
			now: () => Date.now()
		});
		disposeEngine = () => {
			runner.dispose();
			for (const route of routes);
		};
		const disposeRoutes = ctx.effect(() => {
			const disposers = routes.map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-timer-agent: routes");
		const engineTeardown = disposeEngine;
		disposeEngine = () => {
			engineTeardown();
			disposeRoutes();
		};
		if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === true) disposeSection = ctx.systemPrompt.section({
			name: "plugin:timer-agent",
			order: SECTION_ORDER,
			text: TIMER_AGENT_GUIDANCE
		});
	};
	installSettingsSection(ctx, TIMER_AGENT_SETTINGS_NAMESPACE, Config, config ?? {}, {
		setSource: (source) => {
			current = source;
		},
		onChange: sync
	});
	sync();
}
//#endregion
export { Config, TIMER_AGENT_GUIDANCE, TIMER_AGENT_SETTINGS_NAMESPACE, apply, inject, name };
