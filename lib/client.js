window.__ModuleLoader__.load({
	id: "dsh-timer-agent",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_dom_client = require("react-dom/client");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/remote-controller.ts
		/** Poll cadence for the ledger mirror. */
		const POLL_MS = 5e3;
		/**
		* Browser controller over the host routes.
		*/
		var RemoteBoardController = class {
			sessions;
			jobs = [];
			boardOpen = false;
			selectedJobId;
			listeners = /* @__PURE__ */ new Set();
			pollTimer;
			refreshInFlight = false;
			/**
			* @param sessions - navigation face (open a session transcript).
			*/
			constructor(sessions) {
				this.sessions = sessions;
			}
			/** Start the polling mirror. */
			start() {
				this.refresh();
				this.pollTimer = setInterval(() => {
					this.refresh();
				}, POLL_MS);
			}
			/** Stop polling and drop listeners (idempotent). */
			dispose() {
				if (this.pollTimer !== void 0) clearInterval(this.pollTimer);
				this.pollTimer = void 0;
				this.listeners.clear();
			}
			getSnapshot() {
				return {
					jobs: this.jobs,
					boardOpen: this.boardOpen,
					selectedJobId: this.selectedJobId
				};
			}
			subscribe(fn) {
				this.listeners.add(fn);
				return () => {
					this.listeners.delete(fn);
				};
			}
			openBoard() {
				if (this.boardOpen) return;
				this.boardOpen = true;
				this.notify();
				this.refresh();
			}
			closeBoard() {
				if (!this.boardOpen) return;
				this.boardOpen = false;
				this.notify();
			}
			toggleBoard() {
				if (this.boardOpen) this.closeBoard();
				else this.openBoard();
			}
			openJob(id) {
				if (this.jobs.some((job) => job.id === id)) {
					this.selectedJobId = id;
					this.notify();
				}
			}
			closeJob() {
				if (this.selectedJobId === void 0) return;
				this.selectedJobId = void 0;
				this.notify();
			}
			async createJob(input) {
				const title = input.title.trim();
				if (title === "") return void 0;
				const schedule = this.pendingCreateSchedule;
				const response = await this.fetchJson("POST", "/api/dsh-timer-agent/jobs", {
					title,
					description: input.description,
					prompt: input.prompt,
					target: input.target,
					...input.kind !== "command" && input.preset !== void 0 && input.preset.trim() !== "" ? { preset: input.preset } : {},
					...input.modelSelection === void 0 ? {} : { modelSelection: input.modelSelection },
					...schedule?.cron !== void 0 ? { cron: schedule.cron } : {},
					...schedule?.intervalMinutes !== void 0 ? { intervalMinutes: schedule.intervalMinutes } : {},
					...input.kind === "command" ? {
						kind: "command",
						command: input.command ?? "",
						args: input.args ?? ""
					} : {}
				});
				if (response === void 0 || response.error !== void 0) return void 0;
				await this.refresh();
				const created = response.job ?? this.jobs[this.jobs.length - 1];
				this.pendingCreateSchedule = void 0;
				return created;
			}
			/** Schedule to arm on the next create (the modal stages it; the API takes it at create). */
			pendingCreateSchedule;
			/** Stage a cron/fixed-interval schedule for the next createJob call (NewJobModal's schedule field). */
			stageCreateSchedule(schedule) {
				this.pendingCreateSchedule = schedule;
			}
			async updateJob(id, patch) {
				const body = { ...patch };
				if (patch.timeoutMinutes !== void 0) body.timeoutMinutes = patch.timeoutMinutes;
				if (patch.modelSelection === void 0) delete body.modelSelection;
				await this.fetchJson("PATCH", `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, body);
				await this.refresh();
			}
			async deleteJob(id) {
				await this.fetchJson("DELETE", `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`);
				if (this.selectedJobId === id) this.selectedJobId = void 0;
				await this.refresh();
			}
			async resetJob(id) {
				await this.fetchJson("PATCH", `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, { resetStatus: true });
				await this.refresh();
			}
			async archiveJob(id) {
				await this.fetchJson("PATCH", `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, { archived: true });
				await this.refresh();
			}
			async restartJob(id) {
				await this.fetchJson("PATCH", `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, { restart: true });
				await this.refresh();
			}
			async setSchedule(id, patch) {
				const body = {};
				if (patch.cron !== void 0) body.cron = patch.cron;
				if (patch.intervalMinutes !== void 0) body.intervalMinutes = patch.intervalMinutes;
				if (patch.enabled !== void 0) body.scheduleEnabled = patch.enabled;
				const response = await this.fetchJson("PATCH", `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, body);
				await this.refresh();
				return response !== void 0 && response.error === void 0;
			}
			/** Skip the next scheduled fire (host rolls nextRunAt one occurrence). */
			async skipNextRun(id) {
				const response = await this.fetchJson("PATCH", `/api/dsh-timer-agent/jobs?id=${encodeURIComponent(id)}`, { skipNext: true });
				await this.refresh();
				return response !== void 0 && response.error === void 0;
			}
			/** Host-owned now; kept for interface parity. */
			async applyScheduleNextRun() {}
			/** Jump to an execution's session transcript. */
			openSession(sessionId) {
				this.closeJob();
				this.closeBoard();
				const open = () => {
					try {
						this.sessions.open(sessionId);
					} catch (error) {
						console.warn("[dsh-timer-agent] open session failed:", sessionId, error);
					}
				};
				const refresh = this.sessions.refresh;
				if (refresh === void 0) {
					open();
					return;
				}
				try {
					Promise.resolve(refresh()).then(open, open);
				} catch {
					open();
				}
			}
			/** Fire now (host runs it in the background). */
			async runJob(id) {
				const response = await this.fetchJson("POST", `/api/dsh-timer-agent/jobs/run?id=${encodeURIComponent(id)}`);
				await this.refresh();
				return response !== void 0 && response.ok === true;
			}
			/** Re-run a settled job (same as runJob — status guard is host-side). */
			async rerunJob(id) {
				await this.runJob(id);
			}
			async refresh() {
				if (this.refreshInFlight) return;
				this.refreshInFlight = true;
				try {
					const response = await this.fetchJson("GET", "/api/dsh-timer-agent/jobs");
					if (response !== void 0 && Array.isArray(response.jobs)) {
						this.jobs = response.jobs;
						this.notify();
					}
				} finally {
					this.refreshInFlight = false;
				}
			}
			async fetchJson(method, url, body) {
				try {
					const response = await fetch(url, {
						method,
						...body !== void 0 ? {
							body: JSON.stringify(body),
							headers: { "content-type": "application/json" }
						} : {}
					});
					if (response.status === 204) return {};
					return await response.json();
				} catch (error) {
					console.warn("[dsh-timer-agent] host route call failed:", method, url, error);
					return;
				}
			}
			notify() {
				for (const fn of [...this.listeners]) fn();
			}
		};
		//#endregion
		//#region src/client/sessions-face.ts
		/**
		* Adapt the resolved sessions service to SessionsControllerFace.
		* @param service - the plain service object behind `ctx.sessions`.
		* @returns the navigation face for RemoteBoardController.
		*/
		function sessionsFaceOf(service) {
			const serviceRefresh = typeof service.refresh === "function" ? service.refresh.bind(service) : void 0;
			return {
				list: {
					getSnapshot: () => {
						return { current: service.list.getSnapshot().current };
					},
					subscribe: (fn) => {
						return service.list.subscribe(fn);
					}
				},
				open: (id) => {
					service.open(id);
				},
				...serviceRefresh !== void 0 ? { refresh: () => serviceRefresh() } : {}
			};
		}
		//#endregion
		//#region src/client/target-options.ts
		/** Cap per group so the tree stays usable. */
		const SESSIONS_PER_GROUP = 20;
		/** Fetch the host workspace registry (empty when the route is unreachable). */
		async function hostWorkspaces() {
			try {
				const response = await fetch("/api/dsh-timer-agent/workspaces");
				if (!response.ok) return [];
				return (await response.json()).workspaces ?? [];
			} catch {
				return [];
			}
		}
		/** Project the client sessions store into flat rows (blank/subagent rows dropped). */
		function sessionRows(ctx) {
			try {
				const sessions = ctx.sessions;
				if (!sessions?.list?.getSnapshot) return [];
				const snapshot = sessions.list.getSnapshot();
				const rows = [];
				for (const summary of Object.values(snapshot?.byId ?? {})) {
					if (summary?.id === void 0) continue;
					if (summary.blank === true) continue;
					if (summary.origin === "subagent") continue;
					rows.push({
						id: summary.id,
						title: summary.displayTitle ?? summary.title ?? summary.id,
						cwd: summary.cwd ?? "",
						updatedAt: summary.updatedAt ?? 0
					});
				}
				rows.sort((a, b) => b.updatedAt - a.updatedAt);
				return rows;
			} catch (error) {
				console.warn("[dsh-timer-agent] sessionRows failed:", error);
				return [];
			}
		}
		/** Fetch host model options (empty groups when the route is unreachable). */
		async function listModelOptions() {
			try {
				const response = await fetch("/api/dsh-timer-agent/model-options");
				if (!response.ok) return { groups: [] };
				const body = await response.json();
				return {
					...body.default === void 0 ? {} : { default: body.default },
					groups: Array.isArray(body.groups) ? body.groups : []
				};
			} catch {
				return { groups: [] };
			}
		}
		/** Fetch host preset options (empty roster when the route is unreachable). */
		async function listPresetOptions() {
			try {
				const response = await fetch("/api/dsh-timer-agent/preset-options");
				if (!response.ok) return { presets: [] };
				const body = await response.json();
				return {
					...body.default === void 0 ? {} : { default: body.default },
					presets: Array.isArray(body.presets) ? body.presets : []
				};
			} catch {
				return { presets: [] };
			}
		}
		/** Last non-empty path segment (both separators), for short labels. */
		function pathBasename(path) {
			return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
		}
		/** Normalize a path for matching (case/fold, forward slashes, no trailing). */
		function normPath$1(path) {
			let p = path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
			if (p.length >= 2 && p[1] === ":") p = p[0].toUpperCase() + p.slice(1);
			return p;
		}
		/**
		* Build the target tree. Always leads with the default-workspace group.
		* @param ctx - client root context (sessions face for pinning).
		* @returns ordered groups.
		*/
		async function listTargetOptions(ctx) {
			const [workspaces, sessions] = await Promise.all([hostWorkspaces(), Promise.resolve(sessionRows(ctx))]);
			const byBucket = /* @__PURE__ */ new Map();
			for (const session of sessions) {
				const key = session.cwd === "" ? "" : normPath$1(session.cwd);
				const bucket = byBucket.get(key) ?? [];
				if (bucket.length < SESSIONS_PER_GROUP) bucket.push(session);
				byBucket.set(key, bucket);
			}
			const toGroup = (key, name, workdir) => ({
				key,
				name,
				workdir,
				sessions: (byBucket.get(normPath$1(workdir)) ?? []).map((session) => ({
					id: session.id,
					title: session.title
				}))
			});
			const groups = [toGroup("default", "默认工作空间", "")];
			const seen = /* @__PURE__ */ new Set([""]);
			for (const workspace of workspaces) {
				const key = normPath$1(workspace.path);
				if (seen.has(key)) continue;
				seen.add(key);
				groups.push(toGroup(`ws:${workspace.id}`, pathBasename(workspace.path), workspace.path));
			}
			for (const [key, bucket] of byBucket) {
				if (key === "" || seen.has(key)) continue;
				const path = bucket[0]?.cwd ?? key;
				seen.add(key);
				groups.push(toGroup(`cwd:${key.replaceAll(":", "_")}`, pathBasename(path), path));
			}
			return groups;
		}
		//#endregion
		//#region src/core/controller.ts
		/** The selected job (resolved from the ledger), or undefined. */
		function selectedJobOf(snapshot) {
			if (snapshot.selectedJobId === void 0) return void 0;
			return snapshot.jobs.find((job) => job.id === snapshot.selectedJobId);
		}
		//#endregion
		//#region src/core/jobs.ts
		/** Resolve a job's kind; absent/unknown fields degrade to the 'agent' default. */
		function jobKind(job) {
			return job.kind === "command" ? "command" : "agent";
		}
		/** Human timeout label for detail surfaces ('—' when unlimited). */
		function timeoutLabel(job) {
			if (job.timeoutMs === void 0) return "—";
			if (job.timeoutMs < 6e4) return `${job.timeoutMs / 1e3}s`;
			const minutes = job.timeoutMs / 6e4;
			return Number.isInteger(minutes) ? `${minutes}m` : `${minutes.toFixed(1)}m`;
		}
		/** A command job's display/exec line: `command args` (agent jobs → ''). */
		function commandLine(job) {
			if (jobKind(job) !== "command") return "";
			return `${job.command ?? ""} ${job.args ?? ""}`.trim();
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Timer-agent copy: zh-first dictionaries with an English fallback, selected
		* by the document language. Kept dependency-free so the DOM-injected entry
		* row and the standalone board tree share one tiny lookup.
		*/
		/** zh dictionary (key-set source of truth). */
		const zh = {
			"entry.label": "定时任务",
			"board.title": "定时任务 × Agent",
			"board.close": "返回对话",
			"board.new": "新建任务",
			"board.search": "筛选任务…",
			"board.empty": "这里还没有任务",
			"board.runs": "次执行",
			"board.updated": "更新于",
			"board.created": "创建于",
			"board.hint": "到点自动驱动真实 agent 会话执行；灵感来自 hermes-agent cron",
			"board.tabs": "任务状态分类",
			"board.tab.all": "全部",
			"board.tab.idle": "待机",
			"board.tab.running": "进行中",
			"board.tab.done": "成功",
			"board.tab.failed": "失败",
			"board.tab.archived": "已归档",
			"board.emptyTab": "该分类下没有任务",
			"new.title": "标题",
			"new.titlePlaceholder": "一句话描述要定时做什么",
			"new.description": "描述",
			"new.descriptionPlaceholder": "补充背景、范围与验收（可选）",
			"new.kind": "任务类型",
			"new.kind.agent": "AI Agent 任务",
			"new.kind.agentHint": "到点驱动真实 agent 会话执行 Prompt",
			"new.kind.command": "普通任务（命令）",
			"new.kind.commandHint": "直接运行命令，不经过 AI，不消耗额度",
			"new.command": "命令",
			"new.commandPlaceholder": "可执行程序，如 pwsh / python / node 或绝对路径",
			"new.args": "参数",
			"new.argsPlaceholder": "传给命令的参数，空格分隔，支持 \"引号\" 包裹",
			"new.workdir": "工作目录（可选）",
			"new.workdirPlaceholder": "命令执行的目录，留空为默认",
			"new.commandRequired": "普通任务必须填写命令",
			"new.prompt": "执行 Prompt",
			"new.promptPlaceholder": "发给 agent 的完整指令（留空则使用标题）",
			"new.target": "目标会话",
			"new.target.workspace": "项目（工作区）",
			"new.target.workspaceAny": "默认工作区",
			"new.target.session": "会话",
			"new.target.sessionNew": "每次执行新建会话",
			"new.target.hint": "项目和会话都留空时，在默认工作空间发起新对话",
			"new.preset": "预设",
			"new.preset.followDefault": "默认预设",
			"new.model": "模型",
			"new.model.followSession": "跟随原会话模型",
			"new.model.followDefault": "默认模型",
			"new.schedule": "定时（可选）",
			"new.schedule.enable": "启用定时执行",
			"new.schedule.cron": "Cron 表达式",
			"new.submit": "创建",
			"new.cancel": "取消",
			"new.required": "标题不能为空",
			"detail.title": "任务详情",
			"detail.close": "关闭",
			"detail.prompt": "执行 Prompt",
			"detail.command": "执行命令",
			"detail.kind.agent": "Agent",
			"detail.kind.command": "命令",
			"detail.execution.command": "命令",
			"detail.execution.exitCode": "退出码",
			"detail.output": "执行输出",
			"detail.description": "描述",
			"detail.execution": "执行记录",
			"detail.noExecution": "尚未执行",
			"detail.run": "立即执行",
			"detail.rerun": "再次执行",
			"detail.delete": "删除",
			"detail.reset": "重置为待机",
			"detail.archive": "归档",
			"detail.restart": "重启任务",
			"detail.archivedHint": "已归档：定时与手动执行均暂停，重启任务后恢复",
			"detail.status.archived": "已归档",
			"detail.status.idle": "待机",
			"detail.viewSession": "查看会话",
			"detail.edit": "编辑",
			"detail.save": "保存",
			"detail.editCancel": "取消",
			"detail.executionStarted": "已启动",
			"detail.executionEnded": "已结束",
			"detail.result.succeeded": "成功",
			"detail.result.failed": "失败",
			"detail.result.cancelled": "已取消",
			"detail.result.running": "进行中",
			"detail.target.session": "指定会话",
			"detail.target.new": "新建会话",
			"detail.target.default": "默认工作空间 · 新会话",
			"detail.target.preset": "预设",
			"detail.execution.showAll": "显示全部（共 {count} 条）",
			"detail.execution.collapse": "收起",
			"detail.prompt.view": "查看全部",
			"detail.prompt.collapse": "收起",
			"detail.target.workspace": "项目",
			"delete.title": "删除任务",
			"delete.confirm": "确定删除「{name}」吗？删除后不可恢复。",
			"delete.ok": "删除",
			"delete.cancel": "取消",
			"detail.schedule": "定时运行",
			"detail.schedule.enable": "启用定时执行",
			"detail.schedule.cron": "Cron 表达式",
			"detail.schedule.modeInterval": "固定间隔",
			"detail.schedule.interval": "间隔",
			"detail.schedule.unit": "时间单位",
			"detail.schedule.unit.hours": "小时",
			"detail.schedule.unit.days": "天",
			"detail.schedule.intervalHint": "从上次触发时刻起每隔一段时间执行一次；重启 / 暂停不会让周期漂移",
			"detail.schedule.interval.invalid": "间隔必须为大于 0 的整数",
			"detail.schedule.every": "每 {n} {unit}",
			"detail.schedule.presets": "预设",
			"detail.schedule.preset.daily9": "每天 09:00",
			"detail.schedule.preset.hourly": "每小时",
			"detail.schedule.preset.tenMin": "每 10 分钟",
			"detail.schedule.preset.weeklyMon9": "每周一 09:00",
			"detail.schedule.nextRun": "下次运行",
			"detail.schedule.lastTriggered": "上次触发",
			"detail.schedule.invalid": "Cron 表达式无效",
			"detail.schedule.notScheduled": "尚未排程",
			"detail.schedule.dueSoon": "即将运行",
			"detail.schedule.skip": "跳过一次",
			"detail.schedule.skipHint": "跳过这一次，下次运行将改为 {time}",
			"detail.timeout": "执行超时",
			"detail.timeout.hint": "超过该时长仍未结束的执行会被自动取消并记为失败；留空或 0 表示不限时",
			"detail.timeout.unlimited": "不限时",
			"detail.timeout.minutes": "分钟",
			"card.scheduled": "定时",
			"card.kind.command": "命令",
			"time.justNow": "刚刚"
		};
		/** en dictionary, complete against the zh key set. */
		const en = {
			"entry.label": "Timed Jobs",
			"board.title": "Timed Jobs × Agent",
			"board.close": "Back to chat",
			"board.new": "New Job",
			"board.search": "Filter jobs…",
			"board.empty": "No jobs here yet",
			"board.runs": "runs",
			"board.updated": "Updated",
			"board.created": "Created",
			"board.hint": "Fires real agent sessions on schedule; inspired by hermes-agent cron",
			"board.tabs": "Job status tabs",
			"board.tab.all": "All",
			"board.tab.idle": "Idle",
			"board.tab.running": "Running",
			"board.tab.done": "Succeeded",
			"board.tab.failed": "Failed",
			"board.tab.archived": "Archived",
			"board.emptyTab": "No jobs in this tab",
			"new.title": "Title",
			"new.titlePlaceholder": "What should run, in one line",
			"new.description": "Description",
			"new.descriptionPlaceholder": "Background, scope, acceptance criteria (optional)",
			"new.kind": "Job Kind",
			"new.kind.agent": "AI Agent job",
			"new.kind.agentHint": "Fires a real agent session with the prompt",
			"new.kind.command": "Plain job (command)",
			"new.kind.commandHint": "Runs the command directly — no AI, no quota",
			"new.command": "Command",
			"new.commandPlaceholder": "Executable, e.g. pwsh / python / node or an absolute path",
			"new.args": "Arguments",
			"new.argsPlaceholder": "Arguments for the command; whitespace-separated, \"quotes\" supported",
			"new.workdir": "Working directory (optional)",
			"new.workdirPlaceholder": "Directory the command runs in; blank = default",
			"new.commandRequired": "A plain job needs a command",
			"new.prompt": "Run Prompt",
			"new.promptPlaceholder": "The full instruction sent to the agent (title is used when blank)",
			"new.target": "Session Target",
			"new.target.workspace": "Project (workspace)",
			"new.target.workspaceAny": "Default workspace",
			"new.target.session": "Session",
			"new.target.sessionNew": "New session per run",
			"new.target.hint": "With both blank, each run starts a new conversation in the default workspace",
			"new.preset": "Preset",
			"new.preset.followDefault": "Default preset",
			"new.model": "Model",
			"new.model.followSession": "Follow the pinned session's model",
			"new.model.followDefault": "Default model",
			"new.schedule": "Schedule (optional)",
			"new.schedule.enable": "Enable scheduled runs",
			"new.schedule.cron": "Cron expression",
			"new.submit": "Create",
			"new.cancel": "Cancel",
			"new.required": "Title is required",
			"detail.title": "Job Detail",
			"detail.close": "Close",
			"detail.prompt": "Run Prompt",
			"detail.command": "Command",
			"detail.kind.agent": "Agent",
			"detail.kind.command": "Command",
			"detail.execution.command": "command",
			"detail.execution.exitCode": "exit code",
			"detail.output": "Run Output",
			"detail.description": "Description",
			"detail.execution": "Execution History",
			"detail.noExecution": "Not executed yet",
			"detail.run": "Run Now",
			"detail.rerun": "Run Again",
			"detail.delete": "Delete",
			"detail.reset": "Reset to Idle",
			"detail.archive": "Archive",
			"detail.restart": "Restart Job",
			"detail.archivedHint": "Archived: scheduled and manual runs are paused until restarted",
			"detail.status.archived": "Archived",
			"detail.status.idle": "Idle",
			"detail.viewSession": "View Session",
			"detail.edit": "Edit",
			"detail.save": "Save",
			"detail.editCancel": "Cancel",
			"detail.executionStarted": "Started",
			"detail.executionEnded": "Ended",
			"detail.result.succeeded": "Succeeded",
			"detail.result.failed": "Failed",
			"detail.result.cancelled": "Cancelled",
			"detail.result.running": "Running",
			"detail.target.session": "Pinned session",
			"detail.target.new": "New session",
			"detail.target.default": "Default workspace · new session",
			"detail.target.preset": "Preset",
			"detail.execution.showAll": "Show all ({count} runs)",
			"detail.execution.collapse": "Collapse",
			"detail.prompt.view": "Show all",
			"detail.prompt.collapse": "Collapse",
			"detail.target.workspace": "Project",
			"delete.title": "Delete Job",
			"delete.confirm": "Delete \"{name}\"? This cannot be undone.",
			"delete.ok": "Delete",
			"delete.cancel": "Cancel",
			"detail.schedule": "Scheduled Runs",
			"detail.schedule.enable": "Enable scheduled runs",
			"detail.schedule.cron": "Cron expression",
			"detail.schedule.modeInterval": "Fixed interval",
			"detail.schedule.interval": "Interval",
			"detail.schedule.unit": "Time unit",
			"detail.schedule.unit.hours": "hours",
			"detail.schedule.unit.days": "days",
			"detail.schedule.intervalHint": "Fires every interval measured from the last trigger; restarts and pauses never shift the grid",
			"detail.schedule.interval.invalid": "Interval must be a whole number greater than 0",
			"detail.schedule.every": "Every {n} {unit}",
			"detail.schedule.presets": "Presets",
			"detail.schedule.preset.daily9": "Every day 09:00",
			"detail.schedule.preset.hourly": "Every hour",
			"detail.schedule.preset.tenMin": "Every 10 minutes",
			"detail.schedule.preset.weeklyMon9": "Every Monday 09:00",
			"detail.schedule.nextRun": "Next run",
			"detail.schedule.lastTriggered": "Last triggered",
			"detail.schedule.invalid": "Invalid cron expression",
			"detail.schedule.notScheduled": "Not scheduled yet",
			"detail.schedule.dueSoon": "Due soon",
			"detail.schedule.skip": "Skip once",
			"detail.schedule.skipHint": "Skip this run; the next run becomes {time}",
			"detail.timeout": "Run Timeout",
			"detail.timeout.hint": "A run still in flight past this limit is cancelled and marked failed; blank or 0 means unlimited",
			"detail.timeout.unlimited": "Unlimited",
			"detail.timeout.minutes": "minutes",
			"card.scheduled": "scheduled",
			"card.kind.command": "command",
			"time.justNow": "just now"
		};
		/** Active dictionary, picked by the document language at call time. */
		function dictionary() {
			return (typeof document !== "undefined" ? document.documentElement.lang : "zh").toLowerCase().startsWith("en") ? en : zh;
		}
		/** Translate a key with optional {name} template params. */
		function t(key, params) {
			let text = dictionary()[key];
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value);
			return text;
		}
		//#endregion
		//#region src/client/board.module.css
		var board_module_default = {
			"board": "_9kwRNq_board",
			"boardHeader": "_9kwRNq_boardHeader",
			"boardHint": "_9kwRNq_boardHint",
			"boardTitle": "_9kwRNq_boardTitle",
			"cardExcerpt": "_9kwRNq_cardExcerpt",
			"cardGrid": "_9kwRNq_cardGrid",
			"cardMeta": "_9kwRNq_cardMeta",
			"cardSpinner": "_9kwRNq_cardSpinner",
			"cardTitle": "_9kwRNq_cardTitle",
			"cardTop": "_9kwRNq_cardTop",
			"confirmText": "_9kwRNq_confirmText",
			"dangerButton": "_9kwRNq_dangerButton",
			"detail": "_9kwRNq_detail",
			"detailBody": "_9kwRNq_detailBody",
			"detailFooter": "_9kwRNq_detailFooter",
			"detailHeader": "_9kwRNq_detailHeader",
			"detailMeta": "_9kwRNq_detailMeta",
			"detailSection": "_9kwRNq_detailSection",
			"detailText": "_9kwRNq_detailText",
			"detailTitle": "_9kwRNq_detailTitle",
			"dsh-timeragent-spin": "_9kwRNq_dsh-timeragent-spin",
			"entry": "_9kwRNq_entry",
			"entryIcon": "_9kwRNq_entryIcon",
			"entryLabel": "_9kwRNq_entryLabel",
			"executionBadge": "_9kwRNq_executionBadge",
			"executionError": "_9kwRNq_executionError",
			"executionList": "_9kwRNq_executionList",
			"executionOutput": "_9kwRNq_executionOutput",
			"executionRow": "_9kwRNq_executionRow",
			"executionTimes": "_9kwRNq_executionTimes",
			"field": "_9kwRNq_field",
			"fieldHint": "_9kwRNq_fieldHint",
			"fieldLabel": "_9kwRNq_fieldLabel",
			"formError": "_9kwRNq_formError",
			"ghostButton": "_9kwRNq_ghostButton",
			"iconButton": "_9kwRNq_iconButton",
			"input": "_9kwRNq_input",
			"jobCard": "_9kwRNq_jobCard",
			"kindBadge": "_9kwRNq_kindBadge",
			"kindOption": "_9kwRNq_kindOption",
			"kindOptionActive": "_9kwRNq_kindOptionActive",
			"kindOptionHint": "_9kwRNq_kindOptionHint",
			"kindToggle": "_9kwRNq_kindToggle",
			"linkButton": "_9kwRNq_linkButton",
			"listEmpty": "_9kwRNq_listEmpty",
			"modal": "_9kwRNq_modal",
			"modalBackdrop": "_9kwRNq_modalBackdrop",
			"modalFooter": "_9kwRNq_modalFooter",
			"modalTitle": "_9kwRNq_modalTitle",
			"outputBlock": "_9kwRNq_outputBlock",
			"presetSelect": "_9kwRNq_presetSelect",
			"primaryButton": "_9kwRNq_primaryButton",
			"promptBlock": "_9kwRNq_promptBlock",
			"promptBlockClamped": "_9kwRNq_promptBlockClamped",
			"scheduleInput": "_9kwRNq_scheduleInput",
			"scheduleInputInvalid": "_9kwRNq_scheduleInputInvalid",
			"scheduleMeta": "_9kwRNq_scheduleMeta",
			"schedulePreset": "_9kwRNq_schedulePreset",
			"scheduleRow": "_9kwRNq_scheduleRow",
			"scheduleToggle": "_9kwRNq_scheduleToggle",
			"search": "_9kwRNq_search",
			"statusBadge": "_9kwRNq_statusBadge",
			"statusDot": "_9kwRNq_statusDot",
			"tabBar": "_9kwRNq_tabBar",
			"tabButton": "_9kwRNq_tabButton",
			"tabCount": "_9kwRNq_tabCount",
			"tabLabel": "_9kwRNq_tabLabel",
			"targetCaret": "_9kwRNq_targetCaret",
			"targetCaretOpen": "_9kwRNq_targetCaretOpen",
			"targetGroup": "_9kwRNq_targetGroup",
			"targetGroupBody": "_9kwRNq_targetGroupBody",
			"targetGroupCount": "_9kwRNq_targetGroupCount",
			"targetGroupHeader": "_9kwRNq_targetGroupHeader",
			"targetGroupName": "_9kwRNq_targetGroupName",
			"targetRow": "_9kwRNq_targetRow",
			"targetRowDot": "_9kwRNq_targetRowDot",
			"targetRowLabel": "_9kwRNq_targetRowLabel",
			"targetRowSelected": "_9kwRNq_targetRowSelected",
			"targetTree": "_9kwRNq_targetTree"
		};
		//#endregion
		//#region src/client/board/tabs.ts
		/** Tab order as rendered (全部 first, 已归档 last). */
		const BOARD_TABS = [
			"all",
			"idle",
			"running",
			"done",
			"failed",
			"archived"
		];
		/** Tab → label locale key ('all' + one per status). */
		const TAB_LABEL_KEY = {
			all: "board.tab.all",
			idle: "board.tab.idle",
			running: "board.tab.running",
			done: "board.tab.done",
			failed: "board.tab.failed",
			archived: "board.tab.archived"
		};
		/**
		* Count jobs per tab over the whole ledger. "全部" excludes archived
		* jobs (they have their own tab); unknown statuses (forward
		* compatibility) land only in 'all'.
		*/
		function tabCounts(jobs) {
			const counts = {};
			for (const tab of BOARD_TABS) counts[tab] = 0;
			counts.all = jobs.filter((job) => job.status !== "archived").length;
			for (const job of jobs) if (job.status in counts) counts[job.status] += 1;
			return counts;
		}
		/** The jobs one tab shows, in ledger order; "全部" hides archived. */
		function jobsOfTab(jobs, tab) {
			if (tab === "all") return jobs.filter((job) => job.status !== "archived");
			return jobs.filter((job) => job.status === tab);
		}
		//#endregion
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
		* Whether the rule runs on a fixed interval ("every N minutes from the last
		* trigger") instead of a cron grid — cron cannot express e.g. every 302
		* minutes, and manual runs need to re-anchor a live grid.
		*/
		function isIntervalRule(rule) {
			return rule !== null && rule !== void 0 && typeof rule.intervalMinutes === "number" && rule.intervalMinutes > 0;
		}
		/** Whether an enabled rule can fire at all (needs a cron expression or an interval). */
		function isSchedulable(rule) {
			return rule !== void 0 && ((rule.cron ?? "") !== "" || isIntervalRule(rule));
		}
		/** Next run for the rule: interval → `fromMs + N minutes`; cron → next grid match. */
		function scheduleNextMs(rule, fromMs) {
			if (isIntervalRule(rule)) return fromMs + rule.intervalMinutes * 6e4;
			return nextRunAtMs(rule.cron, fromMs);
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
		//#region src/client/board/NewJobModal.tsx
		/**
		* New-job modal: title + description + prompt + session targeting
		* (collapsible workspace tree) + optional cron schedule.
		*
		* The targeting tree is this plugin's headline feature: per workspace
		* (project) group a "new session each run" leaf plus that project's
		* existing sessions (pinned continuation); the leading default group
		* covers the default workspace. Selecting a session pins the job to that
		* conversation (hermes context_from semantics).
		*/
		/** Common scheduled-run presets (cron → locale label), task-board parity. */
		const SCHEDULE_PRESETS$1 = [
			{
				cron: "0 9 * * *",
				label: "detail.schedule.preset.daily9"
			},
			{
				cron: "0 * * * *",
				label: "detail.schedule.preset.hourly"
			},
			{
				cron: "*/10 * * * *",
				label: "detail.schedule.preset.tenMin"
			},
			{
				cron: "0 9 * * 1",
				label: "detail.schedule.preset.weeklyMon9"
			}
		];
		/** The default-workspace placeholder group (used before options load). */
		const DEFAULT_TARGET_GROUPS = [{
			key: "default",
			name: "默认工作空间",
			workdir: "",
			sessions: []
		}];
		/**
		* Parse a fixed-interval draft (value + unit minutes) into total minutes.
		* Undefined unless the value is a whole number > 0.
		*/
		function intervalDraftMinutes(value, unit) {
			const count = Number(value);
			const unitMinutes = Number(unit);
			if (!Number.isInteger(count) || count <= 0) return void 0;
			if (!Number.isInteger(unitMinutes) || unitMinutes <= 0) return void 0;
			return count * unitMinutes;
		}
		/** Flatten a group into its selectable leaves: new-session first, sessions after. */
		function leavesOf(group) {
			return [{
				key: `${group.key}:new`,
				label: "新增会话",
				workdir: group.workdir,
				sessionId: ""
			}, ...group.sessions.map((session) => ({
				key: `${group.key}:ss:${session.id}`,
				label: session.title,
				workdir: group.workdir,
				sessionId: session.id
			}))];
		}
		/** Option label for one preset row (name + id when they differ). */
		function presetOptionLabel(preset) {
			const name = preset.name ?? "";
			const label = name !== "" && name !== preset.id ? `${name} (${preset.id})` : preset.id;
			return preset.broken !== void 0 ? `⚠ ${label}` : label;
		}
		/**
		* The collapsible session-target tree (shared by the new-job modal and the
		* job-detail editor). Pure presentational: callers own groups/selection.
		*
		* When `presetOptions` is supplied and a "new session" leaf is the SELECTED
		* row, that row also carries the agent-preset dropdown (a pinned session
		* keeps the preset its history was produced under, so session rows never
		* show one).
		*/
		function TargetTree({ groups, expanded, selectedKey, onToggle, onSelect, presetOptions, presetDefault, presetId, onPresetChange }) {
			const stop = (event) => {
				event.stopPropagation();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: board_module_default.targetTree,
				role: "tree",
				"aria-label": t("new.target"),
				children: groups.map((group) => {
					const open = expanded.has(group.key);
					const leaves = leavesOf(group);
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_default.targetGroup,
						role: "group",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: board_module_default.targetGroupHeader,
							"aria-expanded": open,
							onClick: () => {
								onToggle(group.key);
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: `${board_module_default.targetCaret} ${open ? board_module_default.targetCaretOpen : ""}`,
									"aria-hidden": "true",
									children: "▸"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.targetGroupName,
									children: group.name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.targetGroupCount,
									children: group.sessions.length > 0 ? `${group.sessions.length}` : ""
								})
							]
						}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: board_module_default.targetGroupBody,
							children: leaves.map((leaf) => {
								const selected = leaf.key === selectedKey;
								if (leaf.sessionId === "" && presetOptions !== void 0 && selected) {
									const known = presetId === "" || presetOptions.some((preset) => preset.id === presetId);
									const defaultLabel = presetDefault !== void 0 ? `${t("new.preset.followDefault")}（${presetDefault}）` : t("new.preset.followDefault");
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										role: "treeitem",
										"aria-selected": selected,
										className: `${board_module_default.targetRow} ${board_module_default.targetRowSelected}`,
										onClick: () => {
											onSelect(leaf.key);
										},
										title: `${group.name} · ${leaf.label}`,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: board_module_default.targetRowDot,
												"aria-hidden": "true"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: board_module_default.targetRowLabel,
												children: leaf.label
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												className: board_module_default.presetSelect,
												value: presetId ?? "",
												"aria-label": t("new.preset"),
												onClick: stop,
												onMouseDown: stop,
												onChange: (event) => {
													onPresetChange?.(event.target.value);
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "",
														children: defaultLabel
													}),
													!known && presetId !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: presetId,
														children: presetId
													}),
													presetOptions.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: preset.id,
														title: preset.broken ?? preset.description ?? preset.id,
														disabled: preset.broken !== void 0,
														children: presetOptionLabel(preset)
													}, preset.id))
												]
											})
										]
									}, leaf.key);
								}
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "treeitem",
									"aria-selected": selected,
									className: `${board_module_default.targetRow} ${selected ? board_module_default.targetRowSelected : ""}`,
									onClick: () => {
										onSelect(leaf.key);
									},
									title: leaf.sessionId === "" ? `${group.name} · ${leaf.label}` : leaf.label,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.targetRowDot,
										"aria-hidden": "true"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.targetRowLabel,
										children: leaf.label
									})]
								}, leaf.key);
							})
						})]
					}, group.key);
				})
			});
		}
		/** Flatten provider groups into selectable model leaves. */
		function modelLeavesOf(options) {
			const leaves = [];
			for (const group of options.groups) for (const model of group.models) leaves.push({
				key: `${group.id}\u0000${model.id}`,
				label: `${group.name} · ${model.name}`,
				provider: group.id,
				model: model.id
			});
			return leaves;
		}
		/** New-job form overlay. */
		function NewJobModal({ controller, targetOptions, modelOptions, presetOptions, onClose }) {
			const [title, setTitle] = (0, react.useState)("");
			const [description, setDescription] = (0, react.useState)("");
			const [prompt, setPrompt] = (0, react.useState)("");
			const [kind, setKind] = (0, react.useState)("agent");
			const [command, setCommand] = (0, react.useState)("");
			const [args, setArgs] = (0, react.useState)("");
			const [commandWorkdir, setCommandWorkdir] = (0, react.useState)("");
			const [groups, setGroups] = (0, react.useState)(DEFAULT_TARGET_GROUPS);
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [selectedKey, setSelectedKey] = (0, react.useState)("default:new");
			const [modelOptionsState, setModelOptionsState] = (0, react.useState)({ groups: [] });
			const [modelKey, setModelKey] = (0, react.useState)("");
			const [presetOptionsState, setPresetOptionsState] = (0, react.useState)({ presets: [] });
			const [presetId, setPresetId] = (0, react.useState)("");
			const [scheduleOn, setScheduleOn] = (0, react.useState)(false);
			const [scheduleMode, setScheduleMode] = (0, react.useState)("cron");
			const [cron, setCron] = (0, react.useState)("0 9 * * *");
			const [intervalValue, setIntervalValue] = (0, react.useState)("");
			const [intervalUnit, setIntervalUnit] = (0, react.useState)("1");
			const [error, setError] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				let alive = true;
				targetOptions().then((next) => {
					if (alive && next.length > 0) setGroups(next);
				}).catch(() => void 0);
				modelOptions().then((next) => {
					if (alive) setModelOptionsState(next);
				}).catch(() => void 0);
				presetOptions().then((next) => {
					if (alive) setPresetOptionsState(next);
				}).catch(() => void 0);
				return () => {
					alive = false;
				};
			}, [
				targetOptions,
				modelOptions,
				presetOptions
			]);
			const selected = (0, react.useMemo)(() => {
				const map = /* @__PURE__ */ new Map();
				for (const group of groups) for (const leaf of leavesOf(group)) map.set(leaf.key, leaf);
				return map;
			}, [groups]).get(selectedKey) ?? {
				key: "default:new",
				label: "",
				workdir: "",
				sessionId: ""
			};
			/** Flattened model picker options; key '' = follow the default resolution. */
			const modelLeaves = (0, react.useMemo)(() => modelLeavesOf(modelOptionsState), [modelOptionsState]);
			const modelDefaultLabel = selected.sessionId !== "" ? t("new.model.followSession") : modelOptionsState.default !== void 0 ? `${modelOptionsState.default.provider} · ${modelOptionsState.default.model}（${t("new.model.followDefault")}）` : t("new.model.followDefault");
			const toggleGroup = (key) => {
				setExpanded((prev) => {
					const next = new Set(prev);
					if (next.has(key)) next.delete(key);
					else next.add(key);
					return next;
				});
			};
			const submit = () => {
				if (kind === "command" && command.trim() === "") {
					setError(t("new.commandRequired"));
					return;
				}
				controller.stageCreateSchedule?.(scheduleOn ? scheduleMode === "interval" ? (() => {
					const minutes = intervalDraftMinutes(intervalValue, intervalUnit);
					return minutes !== void 0 ? { intervalMinutes: minutes } : void 0;
				})() : isValidCron(cron.trim()) ? { cron: cron.trim() } : void 0 : void 0);
				if (kind === "command") {
					const created = controller.createJob({
						title,
						description,
						prompt: "",
						kind: "command",
						command,
						args,
						target: {
							workdir: commandWorkdir.trim(),
							sessionId: ""
						}
					});
					Promise.resolve(created).then((job) => {
						if (job === void 0) {
							setError(t("new.required"));
							return;
						}
						onClose();
					});
					return;
				}
				const model = modelLeaves.find((leaf) => leaf.key === modelKey);
				const created = controller.createJob({
					title,
					description,
					prompt,
					target: {
						workdir: selected.workdir,
						sessionId: selected.sessionId
					},
					...selected.sessionId === "" && presetId.trim() !== "" ? { preset: presetId.trim() } : {},
					...model === void 0 ? {} : { modelSelection: {
						provider: model.provider,
						model: model.model
					} }
				});
				Promise.resolve(created).then((job) => {
					if (job === void 0) {
						setError(t("new.required"));
						return;
					}
					onClose();
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: board_module_default.modalBackdrop,
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
					className: board_module_default.modal,
					role: "dialog",
					"aria-label": t("board.new"),
					onSubmit: (event) => {
						event.preventDefault();
						submit();
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							className: board_module_default.modalTitle,
							children: t("board.new")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: board_module_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_default.fieldLabel,
								children: t("new.kind")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_default.kindToggle,
								role: "radiogroup",
								"aria-label": t("new.kind"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "radio",
									"aria-checked": kind === "agent",
									className: `${board_module_default.kindOption} ${kind === "agent" ? board_module_default.kindOptionActive : ""}`,
									"data-kind": "agent",
									onClick: () => {
										setKind("agent");
										setError(void 0);
									},
									children: [t("new.kind.agent"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.kindOptionHint,
										children: t("new.kind.agentHint")
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									role: "radio",
									"aria-checked": kind === "command",
									className: `${board_module_default.kindOption} ${kind === "command" ? board_module_default.kindOptionActive : ""}`,
									"data-kind": "command",
									onClick: () => {
										setKind("command");
										setError(void 0);
									},
									children: [t("new.kind.command"), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.kindOptionHint,
										children: t("new.kind.commandHint")
									})]
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: board_module_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_default.fieldLabel,
								children: t("new.title")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: board_module_default.input,
								value: title,
								autoFocus: true,
								placeholder: t("new.titlePlaceholder"),
								onChange: (event) => {
									setTitle(event.target.value);
									setError(void 0);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: board_module_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_default.fieldLabel,
								children: t("new.description")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								className: board_module_default.input,
								rows: 1,
								value: description,
								placeholder: t("new.descriptionPlaceholder"),
								onChange: (event) => {
									setDescription(event.target.value);
								}
							})]
						}),
						kind === "command" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.fieldLabel,
									children: t("new.command")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: board_module_default.input,
									value: command,
									placeholder: t("new.commandPlaceholder"),
									"aria-label": t("new.command"),
									spellCheck: false,
									onChange: (event) => {
										setCommand(event.target.value);
										setError(void 0);
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.fieldLabel,
									children: t("new.args")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: board_module_default.input,
									value: args,
									placeholder: t("new.argsPlaceholder"),
									"aria-label": t("new.args"),
									spellCheck: false,
									onChange: (event) => {
										setArgs(event.target.value);
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.fieldLabel,
									children: t("new.workdir")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: board_module_default.input,
									value: commandWorkdir,
									placeholder: t("new.workdirPlaceholder"),
									"aria-label": t("new.workdir"),
									spellCheck: false,
									onChange: (event) => {
										setCommandWorkdir(event.target.value);
									}
								})]
							})
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.fieldLabel,
									children: t("new.prompt")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: board_module_default.input,
									rows: 3,
									value: prompt,
									placeholder: t("new.promptPlaceholder"),
									onChange: (event) => {
										setPrompt(event.target.value);
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_default.field,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.fieldLabel,
										children: t("new.target")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetTree, {
										groups,
										expanded,
										selectedKey,
										onToggle: toggleGroup,
										onSelect: setSelectedKey,
										presetOptions: presetOptionsState.presets,
										presetDefault: presetOptionsState.default,
										presetId,
										onPresetChange: setPresetId
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.fieldHint,
										children: t("new.target.hint")
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.fieldLabel,
									children: t("new.model")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: board_module_default.input,
									value: modelKey,
									"aria-label": t("new.model"),
									onChange: (event) => {
										setModelKey(event.target.value);
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: modelDefaultLabel
									}), modelLeaves.map((leaf) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: leaf.key,
										children: leaf.label
									}, leaf.key))]
								})]
							})
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: board_module_default.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: board_module_default.scheduleToggle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: scheduleOn,
									onChange: (event) => {
										setScheduleOn(event.target.checked);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("new.schedule.enable") })]
							}), scheduleOn && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_default.kindToggle,
								role: "radiogroup",
								"aria-label": t("new.schedule"),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "radio",
									"aria-checked": scheduleMode === "cron",
									className: `${board_module_default.kindOption} ${scheduleMode === "cron" ? board_module_default.kindOptionActive : ""}`,
									onClick: () => {
										setScheduleMode("cron");
										setError(void 0);
									},
									children: t("detail.schedule.cron")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									role: "radio",
									"aria-checked": scheduleMode === "interval",
									className: `${board_module_default.kindOption} ${scheduleMode === "interval" ? board_module_default.kindOptionActive : ""}`,
									onClick: () => {
										setScheduleMode("interval");
										setError(void 0);
									},
									children: t("detail.schedule.modeInterval")
								})]
							}), scheduleMode === "cron" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_default.scheduleRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: `${board_module_default.input} ${board_module_default.scheduleInput}`,
									value: cron,
									placeholder: "0 9 * * *",
									spellCheck: false,
									"aria-label": t("new.schedule.cron"),
									onChange: (event) => {
										setCron(event.target.value);
										setError(void 0);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: `${board_module_default.input} ${board_module_default.schedulePreset}`,
									value: "",
									"aria-label": t("detail.schedule.presets"),
									onChange: (event) => {
										const preset = event.target.value;
										if (preset !== "") {
											setCron(preset);
											setError(void 0);
										}
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
										value: "",
										children: [t("detail.schedule.presets"), "…"]
									}), SCHEDULE_PRESETS$1.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
										value: preset.cron,
										children: t(preset.label)
									}, preset.cron))]
								})]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: board_module_default.scheduleRow,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: board_module_default.input,
									style: { width: "120px" },
									type: "number",
									min: 1,
									value: intervalValue,
									placeholder: "如 302",
									"aria-label": t("detail.schedule.interval"),
									onChange: (event) => {
										setIntervalValue(event.target.value);
										setError(void 0);
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									className: board_module_default.input,
									value: intervalUnit,
									"aria-label": t("detail.schedule.unit"),
									onChange: (event) => {
										setIntervalUnit(event.target.value);
										setError(void 0);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "1",
											children: t("detail.timeout.minutes")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "60",
											children: t("detail.schedule.unit.hours")
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "1440",
											children: t("detail.schedule.unit.days")
										})
									]
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_default.fieldHint,
								children: t("detail.schedule.intervalHint")
							})] })] })]
						}),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: board_module_default.formError,
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
							className: board_module_default.modalFooter,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_default.ghostButton,
								onClick: onClose,
								children: t("new.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: board_module_default.primaryButton,
								children: t("new.submit")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/board/JobDetail.tsx
		/**
		* Job detail: the full view of one job — content, prompt, session target,
		* execution history — and the only place execution can be triggered. Also
		* offers delete (with confirmation) and a jump to the execution's session
		* transcript.
		*
		* Editing is job-level and manual: one 编辑 button puts the WHOLE job
		* (prompt + session target + cron schedule) into a draft state, and a single
		* 保存 in the footer persists everything in one PATCH. No field saves on
		* its own while editing.
		*/
		/** How many execution rows show before the 全部/收起 toggle. */
		const EXECUTION_PREVIEW_COUNT = 3;
		/** Collapsed prompt height, in text lines (line-clamp). */
		const PROMPT_PREVIEW_LINES = 4;
		/** Execution outcome → locale key. */
		const RESULT_KEY = {
			succeeded: "detail.result.succeeded",
			failed: "detail.result.failed",
			cancelled: "detail.result.cancelled"
		};
		/** One execution-history row. */
		function ExecutionRow({ execution, onOpen }) {
			const result = execution.result;
			const isCommand = execution.targeting === "command";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				className: board_module_default.executionRow,
				"data-result": result,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_default.executionBadge,
						"data-result": result,
						children: result === void 0 ? t("detail.result.running") : t(RESULT_KEY[result])
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: board_module_default.executionTimes,
						children: [
							isCommand ? `(${t("detail.execution.command")})` : execution.targeting === "specified-session" ? `(${t("detail.target.session")})` : `(${t("detail.target.new")})`,
							" ",
							t("detail.executionStarted"),
							" ",
							formatTime(execution.startedAt),
							execution.endedAt !== void 0 && ` · ${t("detail.executionEnded")} ${formatTime(execution.endedAt)}`,
							isCommand && execution.exitCode !== void 0 && ` · ${t("detail.execution.exitCode")} ${execution.exitCode}`
						]
					}),
					execution.sessionId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						className: board_module_default.linkButton,
						onClick: () => {
							onOpen(execution.sessionId);
						},
						title: execution.sessionId,
						children: [t("detail.viewSession"), " ⌁"]
					}),
					execution.error !== void 0 && execution.error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: board_module_default.executionError,
						children: execution.error
					}),
					isCommand && execution.output !== void 0 && execution.output !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: board_module_default.executionOutput,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: t("detail.output") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: board_module_default.outputBlock,
							children: execution.output
						})]
					})
				]
			});
		}
		/** Common scheduled-run presets (cron → locale label). */
		const SCHEDULE_PRESETS = [
			{
				cron: "0 9 * * *",
				label: "detail.schedule.preset.daily9"
			},
			{
				cron: "0 * * * *",
				label: "detail.schedule.preset.hourly"
			},
			{
				cron: "*/10 * * * *",
				label: "detail.schedule.preset.tenMin"
			},
			{
				cron: "0 9 * * 1",
				label: "detail.schedule.preset.weeklyMon9"
			}
		];
		/** Human label for a fixed-interval rule: 每 N 分钟 / 小时 / 天. */
		function intervalLabel(minutes) {
			if (minutes % 1440 === 0) return t("detail.schedule.every", {
				n: String(minutes / 1440),
				unit: t("detail.schedule.unit.days")
			});
			if (minutes % 60 === 0) return t("detail.schedule.every", {
				n: String(minutes / 60),
				unit: t("detail.schedule.unit.hours")
			});
			return t("detail.schedule.every", {
				n: String(minutes),
				unit: t("detail.timeout.minutes")
			});
		}
		/** Read-mode label for a schedule rule: the cron expression or a prettified interval. */
		function scheduleLabel(schedule) {
			if (schedule === void 0) return t("detail.schedule.notScheduled");
			return isIntervalRule(schedule) ? intervalLabel(schedule.intervalMinutes) : schedule.cron;
		}
		/** Split stored interval minutes into the value/unit draft fields. */
		function intervalDraftOf(minutes) {
			const unit = minutes % 1440 === 0 ? "1440" : minutes % 60 === 0 ? "60" : "1";
			return {
				value: String(minutes / Number(unit)),
				unit
			};
		}
		/** Human label for a job's session target. */
		function targetLabel(job) {
			if (job.target.sessionId !== "") return `${t("detail.target.session")} (${job.target.sessionId})`;
			const base = job.target.workdir !== "" ? `${job.target.workdir} · ${t("detail.target.new")}` : t("detail.target.default");
			if (job.preset !== void 0 && job.preset !== "") return `${base} · ${t("detail.target.preset")}: ${job.preset}`;
			return base;
		}
		/** Normalize a path for matching (case-fold, forward slashes, no trailing). */
		function normPath(path) {
			let p = path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
			if (p.length >= 2 && p[1] === ":") p = p[0].toUpperCase() + p.slice(1);
			return p;
		}
		/** Resolve the tree-leaf key matching a job's current target (undefined = none). */
		function keyForTarget(groups, job) {
			for (const group of groups) {
				if (normPath(group.workdir) !== normPath(job.target.workdir)) continue;
				if (job.target.sessionId === "") return `${group.key}:new`;
				if (group.sessions.some((session) => session.id === job.target.sessionId)) return `${group.key}:ss:${job.target.sessionId}`;
			}
		}
		/** Confirm-dialog shape (inline; the board owns no shared dialog). */
		function Confirm({ message, confirmLabel, onConfirm, onCancel }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: board_module_default.modalBackdrop,
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onCancel();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: board_module_default.modal,
					role: "alertdialog",
					style: { width: "min(380px, 100%)" },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: board_module_default.confirmText,
						children: message
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
						className: board_module_default.modalFooter,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: board_module_default.ghostButton,
							onClick: onCancel,
							children: t("delete.cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: board_module_default.dangerButton,
							onClick: onConfirm,
							children: confirmLabel
						})]
					})]
				})
			});
		}
		/** Human label for a job's current model resolution. */
		function modelLabel(job) {
			if (job.modelSelection !== void 0) return `${job.modelSelection.provider} · ${job.modelSelection.model}`;
			return job.target.sessionId !== "" ? t("new.model.followSession") : t("new.model.followDefault");
		}
		/** Job detail overlay. */
		function JobDetail({ controller, job, targetOptions, modelOptions, presetOptions }) {
			const [confirmDelete, setConfirmDelete] = (0, react.useState)(false);
			const running = job.status === "running";
			const archived = job.status === "archived";
			const [latest, setLatest] = (0, react.useState)(job);
			(0, react.useEffect)(() => {
				setLatest(job);
			}, [job]);
			const current = latest;
			const [showAllExecutions, setShowAllExecutions] = (0, react.useState)(false);
			const [promptExpanded, setPromptExpanded] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				setShowAllExecutions(false);
				setPromptExpanded(false);
			}, [job.id]);
			const canEdit = !running && !archived;
			const isCommand = jobKind(current) === "command";
			const [editing, setEditing] = (0, react.useState)(false);
			const [saving, setSaving] = (0, react.useState)(false);
			const [promptDraft, setPromptDraft] = (0, react.useState)(current.prompt);
			const [commandDraft, setCommandDraft] = (0, react.useState)(current.command ?? "");
			const [argsDraft, setArgsDraft] = (0, react.useState)(current.args ?? "");
			const [workdirDraft, setWorkdirDraft] = (0, react.useState)(current.target.workdir);
			const [groups, setGroups] = (0, react.useState)(DEFAULT_TARGET_GROUPS);
			const [expanded, setExpanded] = (0, react.useState)(/* @__PURE__ */ new Set());
			const [selectedKey, setSelectedKey] = (0, react.useState)("");
			const [cronDraft, setCronDraft] = (0, react.useState)(current.schedule?.cron ?? "0 9 * * *");
			const [scheduleModeDraft, setScheduleModeDraft] = (0, react.useState)(isIntervalRule(current.schedule) ? "interval" : "cron");
			const [intervalValueDraft, setIntervalValueDraft] = (0, react.useState)(current.schedule !== void 0 && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes).value : "");
			const [intervalUnitDraft, setIntervalUnitDraft] = (0, react.useState)(current.schedule !== void 0 && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes).unit : "1");
			const [scheduleEnabledDraft, setScheduleEnabledDraft] = (0, react.useState)(current.schedule?.enabled ?? false);
			const [timeoutDraft, setTimeoutDraft] = (0, react.useState)(current.timeoutMs !== void 0 ? String(Math.round(current.timeoutMs / 6e4)) : "");
			const [modelOptionsState, setModelOptionsState] = (0, react.useState)({ groups: [] });
			const [modelKey, setModelKey] = (0, react.useState)("");
			const [presetOptionsState, setPresetOptionsState] = (0, react.useState)({ presets: [] });
			const [presetDraft, setPresetDraft] = (0, react.useState)(current.preset ?? "");
			const [error, setError] = (0, react.useState)(void 0);
			/** All leaves across groups, for resolving the current selection. */
			const leafMap = (0, react.useMemo)(() => {
				const map = /* @__PURE__ */ new Map();
				for (const group of groups) map.set(group.key, leavesOf(group));
				return map;
			}, [groups]);
			/** The leaf the selection resolves to (falls back to the job's target). */
			const selectedTarget = (0, react.useMemo)(() => {
				for (const leaves of leafMap.values()) {
					const hit = leaves.find((leaf) => leaf.key === selectedKey);
					if (hit !== void 0) return {
						workdir: hit.workdir,
						sessionId: hit.sessionId
					};
				}
				return {
					workdir: current.target.workdir,
					sessionId: current.target.sessionId
				};
			}, [
				leafMap,
				selectedKey,
				current.target.workdir,
				current.target.sessionId
			]);
			/** Enter edit mode: stage drafts from the current record + load the tree. */
			const startEdit = () => {
				setPromptDraft(current.prompt);
				setCommandDraft(current.command ?? "");
				setArgsDraft(current.args ?? "");
				setWorkdirDraft(current.target.workdir);
				setPresetDraft(current.preset ?? "");
				setCronDraft(current.schedule?.cron ?? "0 9 * * *");
				setScheduleModeDraft(current.schedule !== void 0 && isIntervalRule(current.schedule) ? "interval" : "cron");
				setIntervalValueDraft(current.schedule !== void 0 && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes).value : "");
				setIntervalUnitDraft(current.schedule !== void 0 && isIntervalRule(current.schedule) ? intervalDraftOf(current.schedule.intervalMinutes).unit : "1");
				setScheduleEnabledDraft(current.schedule?.enabled ?? false);
				setTimeoutDraft(current.timeoutMs !== void 0 ? String(Math.round(current.timeoutMs / 6e4)) : "");
				setError(void 0);
				setSaving(false);
				const sel = current.modelSelection;
				setModelKey(sel === void 0 ? "" : `${sel.provider}\u0000${sel.model}`);
				modelOptions().then((next) => {
					setModelOptionsState(next);
				}).catch(() => void 0);
				presetOptions().then((next) => {
					setPresetOptionsState(next);
				}).catch(() => void 0);
				targetOptions().then((next) => {
					const loaded = next.length > 0 ? next : DEFAULT_TARGET_GROUPS;
					setGroups(loaded);
					const key = keyForTarget(loaded, current);
					if (key !== void 0) {
						setSelectedKey(key);
						const group = loaded.find((g) => key === `${g.key}:new` || key.startsWith(`${g.key}:ss:`));
						setExpanded(new Set(group !== void 0 ? [group.key] : []));
					} else setSelectedKey("");
				}).catch(() => void 0);
				setEditing(true);
			};
			const cancelEdit = () => {
				setEditing(false);
				setSaving(false);
				setError(void 0);
			};
			/** One PATCH: prompt + target + schedule (cron or interval) + armed state, all at once. */
			const saveEdit = () => {
				const cron = cronDraft.trim();
				const draftInterval = scheduleModeDraft === "interval" ? intervalDraftMinutes(intervalValueDraft, intervalUnitDraft) : void 0;
				const schedulePatch = scheduleModeDraft === "interval" ? draftInterval !== void 0 ? { intervalMinutes: draftInterval } : {} : {
					cron,
					intervalMinutes: 0
				};
				if (scheduleModeDraft === "interval" ? scheduleEnabledDraft && draftInterval === void 0 : cron === "" ? scheduleEnabledDraft : !isValidCron(cron)) {
					setError(scheduleModeDraft === "interval" ? t("detail.schedule.interval.invalid") : t("detail.schedule.invalid"));
					return;
				}
				if (isCommand && commandDraft.trim() === "") {
					setError(t("new.commandRequired"));
					return;
				}
				setError(void 0);
				setSaving(true);
				if (isCommand) {
					Promise.resolve(controller.updateJob(current.id, {
						command: commandDraft,
						args: argsDraft,
						target: {
							workdir: workdirDraft.trim(),
							sessionId: ""
						},
						...schedulePatch,
						scheduleEnabled: scheduleEnabledDraft,
						...(() => {
							const timeoutMinutes = timeoutDraft.trim() === "" ? 0 : Number(timeoutDraft);
							return Number.isFinite(timeoutMinutes) ? { timeoutMinutes } : {};
						})()
					})).then(() => {
						setEditing(false);
						setSaving(false);
					}).catch(() => {
						setSaving(false);
					});
					return;
				}
				const timeoutMinutes = timeoutDraft.trim() === "" ? 0 : Number(timeoutDraft);
				const initialKey = current.modelSelection === void 0 ? "" : `${current.modelSelection.provider}\u0000${current.modelSelection.model}`;
				const leaf = modelLeavesOf(modelOptionsState).find((item) => item.key === modelKey);
				const modelSelection = modelKey === initialKey ? void 0 : modelKey === "" ? null : leaf === void 0 ? void 0 : {
					provider: leaf.provider,
					model: leaf.model
				};
				Promise.resolve(controller.updateJob(current.id, {
					prompt: promptDraft,
					target: {
						workdir: selectedTarget.workdir,
						sessionId: selectedTarget.sessionId
					},
					preset: selectedTarget.sessionId === "" ? presetDraft.trim() : "",
					...schedulePatch,
					scheduleEnabled: scheduleEnabledDraft,
					...Number.isFinite(timeoutMinutes) ? { timeoutMinutes } : {},
					...modelSelection !== void 0 ? { modelSelection } : {}
				})).then(() => {
					setEditing(false);
					setSaving(false);
				}).catch(() => {
					setSaving(false);
				});
			};
			const toggleGroup = (key) => {
				setExpanded((prev) => {
					const next = new Set(prev);
					if (next.has(key)) next.delete(key);
					else next.add(key);
					return next;
				});
			};
			const enabled = current.schedule?.enabled ?? false;
			const nextRunAt = current.schedule?.nextRunAt;
			const nextLabel = !enabled || nextRunAt === void 0 ? t("detail.schedule.notScheduled") : nextRunAt <= Date.now() ? t("detail.schedule.dueSoon") : new Date(nextRunAt).toLocaleString();
			const lastLabel = current.schedule?.lastTriggeredAt === void 0 ? "—" : new Date(current.schedule.lastTriggeredAt).toLocaleString();
			const draftCronValid = cronDraft.trim() !== "" && isValidCron(cronDraft.trim());
			const draftNextRun = !scheduleEnabledDraft ? void 0 : scheduleModeDraft === "interval" ? (() => {
				const minutes = intervalDraftMinutes(intervalValueDraft, intervalUnitDraft);
				return minutes !== void 0 ? Date.now() + minutes * 6e4 : void 0;
			})() : draftCronValid ? nextRunAtMs(cronDraft.trim(), Date.now()) : void 0;
			const liveSchedule = current.schedule;
			const skipTarget = enabled && nextRunAt !== void 0 && liveSchedule !== void 0 && isSchedulable(liveSchedule) ? isIntervalRule(liveSchedule) ? scheduleNextMs(liveSchedule, Math.max(nextRunAt, Date.now())) : nextRunAtMs(liveSchedule.cron, Math.max(nextRunAt, Date.now())) : void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: board_module_default.modalBackdrop,
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) controller.closeJob();
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: board_module_default.detail,
					role: "dialog",
					"aria-label": t("detail.title"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
							className: board_module_default.detailHeader,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
									className: board_module_default.detailTitle,
									children: current.title
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.kindBadge,
									"data-kind": isCommand ? "command" : "agent",
									children: isCommand ? `⌘ ${t("detail.kind.command")}` : t("detail.kind.agent")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: board_module_default.statusBadge,
									"data-status": current.status,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.statusDot,
										"aria-hidden": "true"
									}), t(STATUS_LABEL_KEY[current.status])]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_default.iconButton,
									"aria-label": t("detail.close"),
									onClick: () => {
										controller.closeJob();
									},
									children: "×"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: board_module_default.detailBody,
							children: [
								!editing && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.description") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: board_module_default.detailText,
										children: current.description !== "" ? current.description : "—"
									})]
								}),
								isCommand ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.command") }), editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: board_module_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: board_module_default.fieldLabel,
												children: t("new.command")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: board_module_default.input,
												style: { width: "100%" },
												value: commandDraft,
												placeholder: t("new.commandPlaceholder"),
												"aria-label": t("new.command"),
												spellCheck: false,
												onChange: (event) => {
													setCommandDraft(event.target.value);
													setError(void 0);
												}
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: board_module_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: board_module_default.fieldLabel,
												children: t("new.args")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: board_module_default.input,
												style: { width: "100%" },
												value: argsDraft,
												placeholder: t("new.argsPlaceholder"),
												"aria-label": t("new.args"),
												spellCheck: false,
												onChange: (event) => {
													setArgsDraft(event.target.value);
												}
											})]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: board_module_default.field,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: board_module_default.fieldLabel,
												children: t("new.workdir")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: board_module_default.input,
												style: { width: "100%" },
												value: workdirDraft,
												placeholder: t("new.workdirPlaceholder"),
												"aria-label": t("new.workdir"),
												spellCheck: false,
												onChange: (event) => {
													setWorkdirDraft(event.target.value);
												}
											})]
										})
									] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
										className: board_module_default.promptBlock,
										children: commandLine(current)
									})]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.prompt") }), editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
										className: board_module_default.input,
										style: {
											width: "100%",
											minHeight: "96px",
											resize: "vertical",
											fontFamily: "inherit",
											lineHeight: "1.5",
											boxSizing: "border-box"
										},
										value: promptDraft,
										placeholder: t("new.promptPlaceholder"),
										"aria-label": t("detail.prompt"),
										onChange: (event) => {
											setPromptDraft(event.target.value);
										}
									}) : (() => {
										const text = current.prompt !== "" ? current.prompt : current.title;
										const foldable = text.split("\n").length > PROMPT_PREVIEW_LINES;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
											className: `${board_module_default.promptBlock}${promptExpanded || !foldable ? "" : ` ${board_module_default.promptBlockClamped}`}`,
											children: text
										}), foldable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: board_module_default.linkButton,
											onClick: () => {
												setPromptExpanded((prev) => !prev);
											},
											children: promptExpanded ? t("detail.prompt.collapse") : t("detail.prompt.view")
										})] });
									})()]
								}),
								!isCommand && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("new.target") }), editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TargetTree, {
										groups,
										expanded,
										selectedKey,
										onToggle: toggleGroup,
										onSelect: setSelectedKey,
										presetOptions: presetOptionsState.presets,
										presetDefault: presetOptionsState.default,
										presetId: presetDraft,
										onPresetChange: setPresetDraft
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.fieldHint,
										children: t("new.target.hint")
									})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: board_module_default.detailText,
										children: targetLabel(current)
									})]
								}),
								!isCommand && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("new.model") }), editing ? (() => {
										const leaves = modelLeavesOf(modelOptionsState);
										const modelDefaultLabel = selectedTarget.sessionId !== "" ? t("new.model.followSession") : modelOptionsState.default !== void 0 ? `${modelOptionsState.default.provider} · ${modelOptionsState.default.model}（${t("new.model.followDefault")}）` : t("new.model.followDefault");
										const known = modelKey === "" || leaves.some((item) => item.key === modelKey);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											className: board_module_default.input,
											style: { width: "100%" },
											value: modelKey,
											"aria-label": t("new.model"),
											onChange: (event) => {
												setModelKey(event.target.value);
											},
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "",
													children: modelDefaultLabel
												}),
												!known && current.modelSelection !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: modelKey,
													children: [
														current.modelSelection.provider,
														" · ",
														current.modelSelection.model
													]
												}),
												leaves.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: item.key,
													children: item.label
												}, item.key))
											]
										});
									})() : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: board_module_default.detailText,
										children: modelLabel(current)
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.schedule") }), editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											className: board_module_default.scheduleToggle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												type: "checkbox",
												checked: scheduleEnabledDraft,
												onChange: (event) => {
													setScheduleEnabledDraft(event.target.checked);
													setError(void 0);
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("detail.schedule.enable") })]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: board_module_default.kindToggle,
											role: "radiogroup",
											"aria-label": t("detail.schedule"),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												role: "radio",
												"aria-checked": scheduleModeDraft === "cron",
												className: `${board_module_default.kindOption} ${scheduleModeDraft === "cron" ? board_module_default.kindOptionActive : ""}`,
												onClick: () => {
													setScheduleModeDraft("cron");
													setError(void 0);
												},
												children: t("detail.schedule.cron")
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												role: "radio",
												"aria-checked": scheduleModeDraft === "interval",
												className: `${board_module_default.kindOption} ${scheduleModeDraft === "interval" ? board_module_default.kindOptionActive : ""}`,
												onClick: () => {
													setScheduleModeDraft("interval");
													setError(void 0);
												},
												children: t("detail.schedule.modeInterval")
											})]
										}),
										scheduleModeDraft === "cron" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: board_module_default.scheduleRow,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: `${board_module_default.input} ${board_module_default.scheduleInput}${!draftCronValid ? ` ${board_module_default.scheduleInputInvalid}` : ""}`,
												value: cronDraft,
												placeholder: "0 9 * * *",
												spellCheck: false,
												"aria-label": t("detail.schedule.cron"),
												onChange: (event) => {
													setCronDraft(event.target.value);
													setError(void 0);
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												className: `${board_module_default.input} ${board_module_default.schedulePreset}`,
												value: "",
												"aria-label": t("detail.schedule.presets"),
												onChange: (event) => {
													const preset = event.target.value;
													if (preset !== "") {
														setCronDraft(preset);
														setError(void 0);
													}
												},
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
													value: "",
													children: [t("detail.schedule.presets"), "…"]
												}), SCHEDULE_PRESETS.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: preset.cron,
													children: t(preset.label)
												}, preset.cron))]
											})]
										}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: board_module_default.scheduleRow,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: board_module_default.input,
												style: { width: "120px" },
												type: "number",
												min: 1,
												value: intervalValueDraft,
												placeholder: "如 302",
												"aria-label": t("detail.schedule.interval"),
												onChange: (event) => {
													setIntervalValueDraft(event.target.value);
													setError(void 0);
												}
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
												className: board_module_default.input,
												value: intervalUnitDraft,
												"aria-label": t("detail.schedule.unit"),
												onChange: (event) => {
													setIntervalUnitDraft(event.target.value);
													setError(void 0);
												},
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "1",
														children: t("detail.timeout.minutes")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "60",
														children: t("detail.schedule.unit.hours")
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "1440",
														children: t("detail.schedule.unit.days")
													})
												]
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: board_module_default.fieldHint,
											children: t("detail.schedule.intervalHint")
										})] }),
										scheduleEnabledDraft && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
											className: board_module_default.scheduleMeta,
											children: [
												t("detail.schedule.nextRun"),
												" ",
												draftNextRun === void 0 ? t("detail.schedule.notScheduled") : new Date(draftNextRun).toLocaleString()
											]
										})
									] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: board_module_default.detailText,
										children: enabled ? scheduleLabel(current.schedule) : t("detail.schedule.notScheduled")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
										className: board_module_default.scheduleMeta,
										children: [
											t("detail.schedule.lastTriggered"),
											" ",
											lastLabel,
											" · ",
											t("detail.schedule.nextRun"),
											" ",
											nextLabel,
											skipTarget !== void 0 && !archived && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
												type: "button",
												className: board_module_default.linkButton,
												title: t("detail.schedule.skipHint", { time: new Date(skipTarget).toLocaleString() }),
												onClick: () => {
													controller.skipNextRun(current.id);
												},
												children: [t("detail.schedule.skip"), " ⏭"]
											})
										]
									})] })]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.timeout") }), editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: board_module_default.scheduleRow,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											className: board_module_default.input,
											style: { width: "120px" },
											type: "number",
											min: 0,
											value: timeoutDraft,
											placeholder: "∞",
											"aria-label": t("detail.timeout"),
											onChange: (event) => {
												setTimeoutDraft(event.target.value);
												setError(void 0);
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: board_module_default.fieldHint,
											children: t("detail.timeout.minutes")
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: board_module_default.fieldHint,
										children: t("detail.timeout.hint")
									})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: board_module_default.detailText,
										children: current.timeoutMs !== void 0 && current.timeoutMs > 0 ? `${timeoutLabel(current)} · ${t("detail.timeout.minutes")}` : t("detail.timeout.unlimited")
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
									className: board_module_default.detailSection,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("detail.execution") }), current.executions.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
										className: board_module_default.detailText,
										children: t("detail.noExecution")
									}) : (() => {
										const all = [...current.executions].reverse();
										const shown = showAllExecutions ? all : all.slice(0, EXECUTION_PREVIEW_COUNT);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
											className: board_module_default.executionList,
											children: shown.map((execution) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionRow, {
												execution,
												onOpen: (sessionId) => {
													controller.openSession(sessionId);
												}
											}, execution.id))
										}), all.length > EXECUTION_PREVIEW_COUNT && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: board_module_default.linkButton,
											onClick: () => {
												setShowAllExecutions((prev) => !prev);
											},
											children: showAllExecutions ? t("detail.execution.collapse") : t("detail.execution.showAll", { count: String(all.length) })
										})] });
									})()]
								})
							]
						}),
						editing && error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: board_module_default.formError,
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("footer", {
							className: board_module_default.detailFooter,
							children: [editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_default.ghostButton,
								disabled: saving,
								onClick: cancelEdit,
								children: t("detail.editCancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_default.primaryButton,
								disabled: saving,
								onClick: saveEdit,
								children: t("detail.save")
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								archived && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.detailText,
									children: t("detail.archivedHint")
								}),
								canEdit && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_default.ghostButton,
									onClick: startEdit,
									children: t("detail.edit")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_default.primaryButton,
									disabled: running || archived,
									onClick: () => {
										controller.closeJob();
										controller.rerunJob(current.id);
									},
									children: current.executions.length === 0 ? t("detail.run") : t("detail.rerun")
								}),
								archived ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_default.primaryButton,
									onClick: () => {
										controller.restartJob(current.id);
									},
									children: t("detail.restart")
								}) : !running && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_default.ghostButton,
									onClick: () => {
										controller.archiveJob(current.id);
									},
									children: t("detail.archive")
								}),
								!running && !archived && current.status !== "idle" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_default.ghostButton,
									onClick: () => {
										controller.resetJob(current.id);
									},
									children: t("detail.reset")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: board_module_default.dangerButton,
									onClick: () => {
										setConfirmDelete(true);
									},
									children: t("detail.delete")
								})
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: board_module_default.detailMeta,
								children: [
									t("board.created"),
									" ",
									formatTime(current.createdAt)
								]
							})]
						})
					]
				}), confirmDelete && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Confirm, {
					message: t("delete.confirm", { name: current.title }),
					confirmLabel: t("delete.ok"),
					onCancel: () => {
						setConfirmDelete(false);
					},
					onConfirm: () => {
						setConfirmDelete(false);
						controller.deleteJob(current.id);
						controller.closeJob();
					}
				})]
			});
		}
		//#endregion
		//#region src/client/board/TimerBoard.tsx
		/**
		* Board view: the job list that replaces the middle column while active.
		* A status-tab bar (全部/待机/进行中/成功/失败/已归档, each with a live
		* count over the whole ledger) narrows the list; jobs render as compact
		* cards in a responsive grid. Cards open the job detail (never execute
		* directly); the header keeps the search filter, new-job, and a
		* back-to-chat escape.
		*/
		/** Status → display label key (shared with JobDetail). */
		const STATUS_LABEL_KEY = {
			idle: "detail.status.idle",
			running: "detail.result.running",
			done: "detail.result.succeeded",
			failed: "detail.result.failed",
			archived: "detail.status.archived"
		};
		/** Case-insensitive title/description/prompt/command match. */
		function matchesFilter(job, filter) {
			if (filter.trim() === "") return true;
			const needle = filter.trim().toLowerCase();
			return job.title.toLowerCase().includes(needle) || job.description.toLowerCase().includes(needle) || job.prompt.toLowerCase().includes(needle) || (job.command ?? "").toLowerCase().includes(needle) || (job.args ?? "").toLowerCase().includes(needle);
		}
		/** Board component; subscribes to the controller snapshot. */
		function TimerBoard({ controller, targetOptions, modelOptions, presetOptions }) {
			const [snapshot, setSnapshot] = (0, react.useState)(controller.getSnapshot());
			(0, react.useEffect)(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
			const [filter, setFilter] = (0, react.useState)("");
			const [tab, setTab] = (0, react.useState)("all");
			const [showNew, setShowNew] = (0, react.useState)(false);
			const selected = selectedJobOf(snapshot);
			const counts = tabCounts(snapshot.jobs);
			const visible = jobsOfTab(snapshot.jobs, tab).filter((job) => matchesFilter(job, filter));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: board_module_default.board,
				"data-dsh-timeragent-board": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: board_module_default.boardHeader,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								className: board_module_default.boardTitle,
								children: t("board.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_default.boardHint,
								children: t("board.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: board_module_default.search,
								type: "search",
								placeholder: t("board.search"),
								value: filter,
								onChange: (event) => {
									setFilter(event.target.value);
								},
								"aria-label": t("board.search")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: board_module_default.primaryButton,
								onClick: () => {
									setShowNew(true);
								},
								children: ["+ ", t("board.new")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: board_module_default.ghostButton,
								onClick: () => {
									controller.closeBoard();
								},
								children: t("board.close")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("nav", {
						className: board_module_default.tabBar,
						role: "tablist",
						"aria-label": t("board.tabs"),
						children: BOARD_TABS.map((key) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							role: "tab",
							className: board_module_default.tabButton,
							"data-tab": key,
							"data-active": tab === key ? "" : void 0,
							"aria-selected": tab === key,
							onClick: () => {
								setTab(key);
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_default.tabLabel,
								children: t(TAB_LABEL_KEY[key])
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: board_module_default.tabCount,
								"data-tab": key,
								children: counts[key]
							})]
						}, key))
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: board_module_default.cardGrid,
						children: [visible.map((job) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							className: board_module_default.jobCard,
							"data-status": job.status,
							onClick: () => {
								controller.openJob(job.id);
							},
							title: job.description !== "" ? job.description : job.title,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: board_module_default.cardTop,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: board_module_default.statusBadge,
											"data-status": job.status,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: board_module_default.statusDot,
												"aria-hidden": "true"
											}), t(STATUS_LABEL_KEY[job.status])]
										}),
										jobKind(job) === "command" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: board_module_default.kindBadge,
											"data-kind": "command",
											title: job.command ?? "",
											children: ["⌘ ", t("card.kind.command")]
										}),
										job.status === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: board_module_default.cardSpinner,
											"aria-hidden": "true"
										})
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.cardTitle,
									children: job.title
								}),
								job.description !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: board_module_default.cardExcerpt,
									children: job.description
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: board_module_default.cardMeta,
									children: [
										job.schedule?.enabled === true && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											title: job.schedule.nextRunAt !== void 0 ? `${t("card.scheduled")} · ${new Date(job.schedule.nextRunAt).toLocaleString()}` : t("card.scheduled"),
											children: ["⏰ ", job.schedule.nextRunAt !== void 0 ? formatTime(job.schedule.nextRunAt) : t("card.scheduled")]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											t("board.updated"),
											" ",
											formatTime(job.updatedAt)
										] }),
										job.executions.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											job.executions.length,
											" ",
											t("board.runs")
										] })
									]
								})
							]
						}, job.id)), visible.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: board_module_default.listEmpty,
							children: snapshot.jobs.length === 0 ? t("board.empty") : t("board.emptyTab")
						})]
					}),
					selected !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobDetail, {
						controller,
						job: selected,
						targetOptions,
						modelOptions,
						presetOptions
					}),
					showNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NewJobModal, {
						controller,
						targetOptions,
						modelOptions,
						presetOptions,
						onClose: () => {
							setShowNew(false);
						}
					})
				]
			});
		}
		/** Compact relative/absolute time label (future instants count forward). */
		function formatTime(ms) {
			const date = new Date(ms);
			const now = Date.now();
			if (ms > now) {
				const ahead = Math.ceil((ms - now) / 6e4);
				if (ahead < 1) return t("time.justNow");
				if (ahead < 60) return `+${ahead}m`;
				if (ahead < 1440) return `+${Math.floor(ahead / 60)}h`;
				return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
			}
			const minutes = Math.floor((now - ms) / 6e4);
			if (minutes < 1) return t("time.justNow");
			if (minutes < 60) return `${minutes}m`;
			if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
			return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
		}
		//#endregion
		//#region src/client/board-mount.tsx
		/**
		* Board view mounting (task-board precedent): the `conversation` slot is
		* single-occupant, so the board takes over the center column at the DOM
		* level — a container appended inside the `[data-pane="conversation"]` grid
		* item, hidden unless this panel is active. Toggling is a data attribute on
		* <html>; sibling panels (task board / ssh) evict each other through the
		* shared `dsh-panel-activate` event.
		*/
		const ACTIVE_ATTR = "data-dsh-timeragent-active";
		/** Sibling panels' activation attributes, removed when this panel opens. */
		const OTHER_ACTIVE_ATTRS = ["data-dsh-ssh-active", "data-dsh-taskboard-active"];
		/** Cross-plugin activation event; detail is the activating panel name. */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "timeragent";
		/** Find the center column, or undefined while the frame is not mounted. */
		function conversationColumn() {
			for (const sel of [
				"[data-pane=\"conversation\"]",
				"[class*=\"centerCol\"]",
				"[class*=\"conversation\"]:not([class*=\"sidebar\"])"
			]) {
				const el = document.querySelector(sel);
				if (el) return el;
			}
		}
		/**
		* Mount the board React tree into the center column and bind its visibility
		* to the controller's boardOpen state.
		* @param controller - the board controller driving the view.
		* @param targetOptions - session-target dropdown data source (rebuilt on
		*   each modal open; see target-options.ts).
		* @returns disposer unmounting the tree and restoring the column.
		*/
		function mountBoard(controller, targetOptions) {
			let root;
			let container;
			const modelOptions = () => listModelOptions();
			const presetOptions = () => listPresetOptions();
			const ensure = () => {
				if (container !== void 0) return;
				const column = conversationColumn();
				if (column === void 0) return;
				container = document.createElement("div");
				container.dataset.dshTimeragentView = "";
				container.className = board_module_default.boardView;
				column.appendChild(container);
				root = (0, react_dom_client.createRoot)(container);
				root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TimerBoard, {
					controller,
					targetOptions,
					modelOptions,
					presetOptions
				}));
			};
			const waitObserver = new MutationObserver(() => {
				ensure();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			const applyActive = () => {
				if (controller.getSnapshot().boardOpen) {
					for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr);
					document.documentElement.setAttribute(ACTIVE_ATTR, "");
					document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }));
				} else document.documentElement.removeAttribute(ACTIVE_ATTR);
			};
			const onOtherActivate = (event) => {
				if (event.detail !== PANEL_NAME && controller.getSnapshot().boardOpen) controller.closeBoard();
			};
			const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
			const onClickSidebarRow = (event) => {
				if (!controller.getSnapshot().boardOpen) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.closeBoard();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			const unsubscribe = controller.subscribe(applyActive);
			applyActive();
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				waitObserver.disconnect();
				unsubscribe();
				document.documentElement.removeAttribute(ACTIVE_ATTR);
				root?.unmount();
				root = void 0;
				container?.remove();
				container = void 0;
			};
		}
		/** Inline icon (matches the shell's 16px nav-icon look) 鈥?a clock. */
		const ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M5.5 1.5h5M8 1.5v1.5"/></svg>`;
		/** Find the sidebar shell root element, or undefined while not yet mounted. */
		function sidebarRoot() {
			const column = document.querySelector("[data-pane=\"sidebar\"], [class*=\"sidebarCol\"]");
			if (column === null) return void 0;
			return column.querySelector("[class*=\"logoRow\"]")?.parentElement ?? column.firstElementChild;
		}
		/** The New Session button: nested in the logo row on current shells, a direct child on legacy shells. */
		function newSessionButton(root) {
			const nested = root.querySelector("button[class*=\"newSession\"]");
			if (nested !== null) return nested;
			for (const child of root.children) if (child.tagName === "BUTTON") return child;
		}
		/** Build the entry row (a detached button; insert once the shell is up). */
		function createEntry(controller) {
			const entry = document.createElement("button");
			entry.type = "button";
			entry.dataset.dshTimeragentEntry = "";
			entry.className = board_module_default.entry;
			entry.setAttribute("aria-label", t("entry.label"));
			entry.innerHTML = `<span class="${board_module_default.entryIcon}">${ICON}</span><span class="${board_module_default.entryLabel}">${t("entry.label")}</span>`;
			entry.addEventListener("click", () => {
				controller.toggleBoard();
			});
			return entry;
		}
		/** Re-insert the entry into the family block after the New Session row. */
		function placeEntry(root, entry) {
			const button = newSessionButton(root);
			if (button === void 0) return false;
			if (entry.parentElement !== root) {
				const row = button.closest("[class*=\"logoRow\"]");
				const base = row !== null && row.parentElement === root ? row : button;
				const family = Array.from(root.children).filter((el) => el instanceof HTMLElement && el.matches("[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-timeragent-entry]"));
				const anchor = family.find((el) => el.matches("[data-dsh-timeragent-entry]")) !== void 0 ? base.nextElementSibling : family.length > 0 ? family[family.length - 1].nextElementSibling : base.nextElementSibling;
				root.insertBefore(entry, anchor);
			}
			return true;
		}
		/**
		* Mount the sidebar entry, waiting for the shell to render and self-healing
		* on later React re-renders.
		* @param controller - the board controller the entry toggles.
		* @returns disposer removing the entry and its observers.
		*/
		function mountSidebarEntry(controller) {
			const entry = createEntry(controller);
			let root;
			let placed = false;
			const tryPlace = () => {
				if (root !== void 0 && !root.isConnected) {
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				if (placed) {
					if (document.body.contains(entry)) return;
					rootObserver.disconnect();
					root = void 0;
					placed = false;
				}
				root ??= sidebarRoot();
				if (root === void 0) return;
				placed = placeEntry(root, entry);
				if (placed) rootObserver.observe(root, {
					childList: true,
					subtree: true
				});
			};
			const waitObserver = new MutationObserver(() => {
				tryPlace();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			const rootObserver = new MutationObserver(() => {
				if (root === void 0 || !root.isConnected) {
					placed = false;
					tryPlace();
					return;
				}
				if (!root.contains(entry)) placed = placeEntry(root, entry);
			});
			const syncActive = () => {
				if (controller.getSnapshot().boardOpen) entry.dataset.active = "true";
				else delete entry.dataset.active;
			};
			const unsubscribe = controller.subscribe(syncActive);
			syncActive();
			tryPlace();
			return () => {
				waitObserver.disconnect();
				rootObserver.disconnect();
				unsubscribe();
				entry.remove();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Timer-agent client plugin (host-authoritative edition): mounts the two
		* DOM surfaces over the REMOTE controller — the sidebar entry row and the
		* board view in the center column. All state lives in the host engine
		* (~/.dsh/timer-agent/jobs.json); this half is a polled mirror + HTTP
		* command sender. The scheduler/execution core the browser used to own is
		* retired: the dsh web host process ticks and fires jobs with or without
		* this page open.
		*
		* Failure policy: DOM mounting problems are logged, never thrown — the web
		* shell fails the whole boot when a plugin apply throws, and an external
		* plugin must not take the GUI down.
		*/
		/** Required services (fiber inject waiting — the runtime must be up first). */
		const inject = ["slots", "sessions"];
		/**
		* Mount the timer-agent board.
		* @param ctx - client root context (services: sessions).
		*/
		function apply(ctx) {
			const ctxTyped = ctx;
			const sessions = ctxTyped.sessions;
			const controller = new RemoteBoardController(sessions !== void 0 ? sessionsFaceOf(sessions) : {
				list: {
					getSnapshot: () => ({ current: void 0 }),
					subscribe: () => () => {}
				},
				open: (_id) => {
					console.warn("[dsh-timer-agent] sessions.open called but sessions service is unavailable");
				}
			});
			controller.start();
			const disposers = [];
			try {
				const targetOptions = () => {
					try {
						return listTargetOptions(ctx);
					} catch (error) {
						console.warn("[dsh-timer-agent] target-options failed, returning empty:", error);
						return Promise.resolve([]);
					}
				};
				disposers.push(mountSidebarEntry(controller));
				disposers.push(mountBoard(controller, targetOptions));
			} catch (error) {
				console.error("[dsh-timer-agent] mount failed:", error);
			}
			const effectFn = ctxTyped.effect;
			if (typeof effectFn === "function") effectFn(() => {
				return () => {
					for (const dispose of disposers.splice(0)) dispose();
					controller.dispose();
				};
			}, "dsh-timer-agent: unmount");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;

// #region inlined stylesheet (post-build: scripts/inline-css.mjs)
(function injectTimerAgentStyle() {
  if (typeof document === 'undefined') return;
  var tagId = 'dsh-timer-agent/board.module.css';
  if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return;
  var style = document.createElement('style');
  style.setAttribute('data-plugin', 'dsh-timer-agent');
  style.setAttribute('data-plugin-css', tagId);
  style.textContent = "[data-pane=\"conversation\"], [class*=\"centerCol\"] {\n  position: relative;\n}\n\n[data-dsh-timeragent-view] {\n  z-index: 60;\n  background: var(--dsw-alias-bg-base);\n  display: none;\n  position: absolute;\n  inset: 0;\n}\n\nhtml[data-dsh-timeragent-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-dsh-timeragent-view] {\n  display: block;\n}\n\nhtml[data-dsh-timeragent-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-pane=\"conversation\"] > :not([data-dsh-timeragent-view]), html[data-dsh-timeragent-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [class*=\"centerCol\"] > :not([data-dsh-timeragent-view]) {\n  display: none !important;\n}\n\n._9kwRNq_entry {\n  width: 100%;\n  height: 32px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  white-space: nowrap;\n  background: none;\n  border: none;\n  border-radius: 8px;\n  align-items: center;\n  gap: 8px;\n  padding: 0 12px;\n  font-size: 13px;\n  display: flex;\n}\n\n._9kwRNq_entry:hover {\n  background: var(--dsw-specific-sidebar-nav-item-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n._9kwRNq_entry[data-active] {\n  background: var(--dsw-specific-sidebar-nav-item-active);\n  color: var(--dsw-alias-label-primary);\n  font-weight: 600;\n}\n\n._9kwRNq_entryIcon {\n  flex: none;\n  justify-content: center;\n  align-items: center;\n  display: inline-flex;\n}\n\n._9kwRNq_entryLabel {\n  text-overflow: ellipsis;\n  overflow: hidden;\n}\n\n[data-dsh-frame][data-sidebar-collapsed] ._9kwRNq_entry {\n  justify-content: center;\n  width: 100%;\n  padding: 0;\n}\n\n[data-dsh-frame][data-sidebar-collapsed] ._9kwRNq_entryLabel {\n  display: none;\n}\n\n._9kwRNq_board {\n  background: var(--dsw-alias-bg-base);\n  min-width: 0;\n  height: 100%;\n  min-height: 0;\n  color: var(--dsw-alias-label-primary);\n  font-family: var(--dsw-font-family);\n  flex-direction: column;\n  gap: 12px;\n  padding: 14px 16px 16px;\n  display: flex;\n}\n\n._9kwRNq_boardHeader {\n  flex: none;\n  align-items: center;\n  gap: 10px;\n  display: flex;\n}\n\n._9kwRNq_boardTitle {\n  color: var(--dsw-alias-label-primary);\n  white-space: nowrap;\n  margin: 0;\n  font-size: 16px;\n  font-weight: 700;\n}\n\n._9kwRNq_boardHint {\n  color: var(--dsw-alias-label-tertiary);\n  white-space: nowrap;\n  text-overflow: ellipsis;\n  font-size: 12px;\n  overflow: hidden;\n}\n\n._9kwRNq_search {\n  min-width: 120px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsh-specific-input-major, var(--dsw-specific-input-major));\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  outline: none;\n  flex: 0 260px;\n  margin-left: auto;\n  padding: 6px 10px;\n  font-size: 13px;\n}\n\n._9kwRNq_search::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n._9kwRNq_tabBar {\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-inset, #8080800f);\n  scrollbar-width: none;\n  border-radius: 10px;\n  flex: none;\n  align-items: center;\n  gap: 4px;\n  padding: 3px;\n  display: flex;\n  overflow-x: auto;\n}\n\n._9kwRNq_tabBar::-webkit-scrollbar {\n  display: none;\n}\n\n._9kwRNq_tabButton {\n  white-space: nowrap;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  background: none;\n  border: none;\n  border-radius: 8px;\n  flex: auto;\n  justify-content: center;\n  align-items: center;\n  gap: 6px;\n  padding: 5px 12px;\n  font-size: 12.5px;\n  display: inline-flex;\n}\n\n._9kwRNq_tabButton:hover {\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-fill-minor, #8080801f);\n}\n\n._9kwRNq_tabButton[data-active] {\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base));\n  box-shadow: 0 1px 4px #00000024;\n}\n\n._9kwRNq_tabLabel {\n  font-weight: 500;\n}\n\n._9kwRNq_tabCount {\n  text-align: center;\n  min-width: 18px;\n  color: var(--dsw-alias-label-tertiary);\n  background: var(--dsw-alias-fill-minor, #80808024);\n  border-radius: 999px;\n  padding: 0 5px;\n  font-size: 11px;\n  line-height: 16px;\n}\n\n._9kwRNq_tabButton[data-active] ._9kwRNq_tabCount {\n  color: #fff;\n  background: var(--dsw-specific-button-primary, #4c8bf5);\n}\n\n._9kwRNq_tabCount[data-tab=\"running\"] {\n  color: #4c8bf5;\n}\n\n._9kwRNq_tabCount[data-tab=\"done\"] {\n  color: #3aa675;\n}\n\n._9kwRNq_tabCount[data-tab=\"failed\"] {\n  color: #d4574e;\n}\n\n._9kwRNq_tabButton[data-active] ._9kwRNq_tabCount[data-tab=\"running\"], ._9kwRNq_tabButton[data-active] ._9kwRNq_tabCount[data-tab=\"done\"], ._9kwRNq_tabButton[data-active] ._9kwRNq_tabCount[data-tab=\"failed\"] {\n  color: #fff;\n  background: var(--dsw-specific-button-primary, #4c8bf5);\n}\n\n._9kwRNq_cardGrid {\n  flex: 1;\n  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));\n  grid-auto-rows: min-content;\n  align-content: start;\n  gap: 10px;\n  min-height: 0;\n  padding-right: 2px;\n  display: grid;\n  overflow-y: auto;\n}\n\n._9kwRNq_jobCard {\n  text-align: left;\n  border: 1px solid var(--dsw-alias-border-l2);\n  background: var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base));\n  cursor: pointer;\n  border-radius: 12px;\n  flex-direction: column;\n  gap: 6px;\n  min-width: 0;\n  min-height: 128px;\n  padding: 10px 12px;\n  transition: border-color .12s, transform .12s;\n  display: flex;\n}\n\n._9kwRNq_jobCard:hover {\n  border-color: var(--dsw-alias-border-l1, var(--dsw-alias-border-l2));\n  transform: translateY(-1px);\n}\n\n._9kwRNq_jobCard[data-status=\"running\"] {\n  border-color: var(--dsw-alias-border-highlight, #4c8bf5);\n}\n\n._9kwRNq_jobCard[data-status=\"archived\"] {\n  opacity: .72;\n}\n\n._9kwRNq_cardTop {\n  justify-content: space-between;\n  align-items: center;\n  gap: 6px;\n  display: flex;\n}\n\n._9kwRNq_cardTitle {\n  color: var(--dsw-alias-label-primary);\n  -webkit-line-clamp: 2;\n  overflow-wrap: break-word;\n  word-break: break-word;\n  -webkit-box-orient: vertical;\n  font-size: 13px;\n  font-weight: 600;\n  line-height: 1.4;\n  display: -webkit-box;\n  overflow: hidden;\n}\n\n._9kwRNq_cardExcerpt {\n  color: var(--dsw-alias-label-secondary);\n  -webkit-line-clamp: 3;\n  overflow-wrap: break-word;\n  word-break: break-word;\n  -webkit-box-orient: vertical;\n  font-size: 12px;\n  line-height: 1.45;\n  display: -webkit-box;\n  overflow: hidden;\n}\n\n._9kwRNq_cardMeta {\n  color: var(--dsw-alias-label-tertiary);\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 6px;\n  font-size: 11px;\n  display: flex;\n}\n\n._9kwRNq_statusBadge {\n  border: 1px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n  border-radius: 999px;\n  align-items: center;\n  gap: 5px;\n  padding: 1px 8px;\n  font-size: 11px;\n  display: inline-flex;\n}\n\n._9kwRNq_statusBadge[data-status=\"running\"] {\n  color: #4c8bf5;\n  border-color: #4c8bf580;\n}\n\n._9kwRNq_statusBadge[data-status=\"done\"] {\n  color: #3aa675;\n  border-color: #3aa67580;\n}\n\n._9kwRNq_statusBadge[data-status=\"failed\"] {\n  color: #d4574e;\n  border-color: #d4574e80;\n}\n\n._9kwRNq_statusBadge[data-status=\"archived\"] {\n  color: var(--dsw-alias-label-tertiary);\n  border-color: var(--dsw-alias-border-l2);\n  opacity: .75;\n}\n\n._9kwRNq_kindBadge {\n  color: #9c6ade;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  border: 1px solid #9c6ade80;\n  border-radius: 999px;\n  align-items: center;\n  gap: 4px;\n  max-width: 220px;\n  padding: 1px 8px;\n  font-size: 11px;\n  display: inline-flex;\n  overflow: hidden;\n}\n\n._9kwRNq_kindBadge[data-kind=\"agent\"] {\n  border-color: var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n}\n\n._9kwRNq_kindToggle {\n  grid-template-columns: 1fr 1fr;\n  gap: 8px;\n  display: grid;\n}\n\n._9kwRNq_kindOption {\n  border: 1px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  text-align: left;\n  background: none;\n  border-radius: 8px;\n  flex-direction: column;\n  gap: 2px;\n  padding: 8px 10px;\n  font-size: 12px;\n  display: flex;\n}\n\n._9kwRNq_kindOption:hover {\n  border-color: var(--dsw-alias-border-l1);\n}\n\n._9kwRNq_kindOptionActive {\n  color: #4c8bf5;\n  border-color: #4c8bf5;\n}\n\n._9kwRNq_kindOptionHint {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 11px;\n  font-weight: normal;\n}\n\n._9kwRNq_jobCard[data-status=\"archived\"] ._9kwRNq_cardTitle {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n._9kwRNq_statusDot {\n  background: currentColor;\n  border-radius: 50%;\n  width: 6px;\n  height: 6px;\n}\n\n._9kwRNq_listEmpty {\n  text-align: center;\n  color: var(--dsw-alias-label-tertiary);\n  padding: 40px 0;\n  font-size: 13px;\n}\n\n._9kwRNq_primaryButton {\n  background: var(--dsw-specific-button-primary, #4c8bf5);\n  color: #fff;\n  cursor: pointer;\n  border: none;\n  border-radius: 8px;\n  flex: none;\n  padding: 6px 14px;\n  font-size: 13px;\n}\n\n._9kwRNq_primaryButton:hover {\n  filter: brightness(1.05);\n}\n\n._9kwRNq_primaryButton:disabled {\n  opacity: .55;\n  cursor: default;\n}\n\n._9kwRNq_ghostButton {\n  border: 1px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  background: none;\n  border-radius: 8px;\n  flex: none;\n  padding: 6px 14px;\n  font-size: 13px;\n}\n\n._9kwRNq_ghostButton:hover {\n  color: var(--dsw-alias-label-primary);\n}\n\n._9kwRNq_ghostButton:disabled {\n  opacity: .55;\n  cursor: default;\n}\n\n._9kwRNq_dangerButton {\n  color: #d4574e;\n  cursor: pointer;\n  background: none;\n  border: 1px solid #d4574e80;\n  border-radius: 8px;\n  flex: none;\n  padding: 6px 14px;\n  font-size: 13px;\n}\n\n._9kwRNq_dangerButton:hover {\n  background: #d4574e14;\n}\n\n._9kwRNq_iconButton {\n  width: 28px;\n  height: 28px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  background: none;\n  border: none;\n  border-radius: 8px;\n  flex: none;\n  justify-content: center;\n  align-items: center;\n  font-size: 18px;\n  display: inline-flex;\n}\n\n._9kwRNq_iconButton:hover {\n  background: var(--dsw-alias-bg-elevated, #8080801f);\n}\n\n._9kwRNq_linkButton {\n  color: var(--dsw-alias-border-highlight, #4c8bf5);\n  cursor: pointer;\n  background: none;\n  border: none;\n  flex: none;\n  padding: 0;\n  font-size: 12px;\n}\n\n._9kwRNq_linkButton:hover {\n  text-decoration: underline;\n}\n\n._9kwRNq_modalBackdrop {\n  z-index: 1200;\n  background: #00000073;\n  justify-content: center;\n  align-items: center;\n  padding: 20px;\n  display: flex;\n  position: fixed;\n  inset: 0;\n}\n\n._9kwRNq_modal, ._9kwRNq_detail {\n  background: var(--dsw-alias-bg-base);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 14px;\n  flex-direction: column;\n  gap: 12px;\n  width: min(600px, 100%);\n  max-height: calc(100vh - 40px);\n  padding: 18px 20px;\n  display: flex;\n  overflow-y: auto;\n  box-shadow: 0 18px 48px #00000047;\n}\n\n._9kwRNq_modalTitle, ._9kwRNq_detailTitle {\n  color: var(--dsw-alias-label-primary);\n  margin: 0;\n  font-size: 16px;\n  font-weight: 700;\n}\n\n._9kwRNq_detailHeader {\n  align-items: center;\n  gap: 10px;\n  display: flex;\n}\n\n._9kwRNq_detailHeader ._9kwRNq_detailTitle {\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  flex: 1;\n  min-width: 0;\n  overflow: hidden;\n}\n\n._9kwRNq_detailBody {\n  flex-direction: column;\n  gap: 14px;\n  display: flex;\n}\n\n._9kwRNq_detailSection h4 {\n  color: var(--dsw-alias-label-tertiary);\n  text-transform: uppercase;\n  letter-spacing: .04em;\n  margin: 0 0 6px;\n  font-size: 12px;\n  font-weight: 600;\n}\n\n._9kwRNq_detailText {\n  color: var(--dsw-alias-label-secondary);\n  white-space: pre-wrap;\n  word-break: break-word;\n  margin: 0;\n  font-size: 13px;\n}\n\n._9kwRNq_promptBlock {\n  font-family: var(--dsw-font-family-mono, monospace);\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-alias-bg-inset, #80808014);\n  white-space: pre-wrap;\n  word-break: break-word;\n  border-radius: 8px;\n  margin: 0;\n  padding: 10px;\n  font-size: 12px;\n}\n\n._9kwRNq_detailFooter {\n  border-top: 1px solid var(--dsw-alias-border-l2);\n  align-items: center;\n  gap: 8px;\n  padding-top: 4px;\n  display: flex;\n}\n\n._9kwRNq_detailMeta {\n  color: var(--dsw-alias-label-tertiary);\n  margin-left: auto;\n  font-size: 11px;\n}\n\n._9kwRNq_field {\n  flex-direction: column;\n  gap: 5px;\n  display: flex;\n}\n\n._9kwRNq_fieldLabel {\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n}\n\n._9kwRNq_input {\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-specific-input-major, transparent);\n  border: 1px solid var(--dsw-alias-border-l2);\n  resize: vertical;\n  border-radius: 8px;\n  outline: none;\n  padding: 7px 10px;\n  font-family: inherit;\n  font-size: 13px;\n}\n\n._9kwRNq_input:focus {\n  border-color: var(--dsw-alias-border-highlight, #4c8bf5);\n}\n\n._9kwRNq_input::placeholder {\n  color: var(--dsw-alias-label-tertiary);\n}\n\nselect._9kwRNq_input {\n  cursor: pointer;\n}\n\n._9kwRNq_fieldHint {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 11px;\n}\n\n._9kwRNq_targetTree {\n  resize: vertical;\n  height: 140px;\n  min-height: 84px;\n  max-height: 420px;\n  color: var(--dsw-alias-label-primary);\n  background: var(--dsw-specific-input-major, transparent);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 8px;\n  flex: auto;\n  padding: 4px;\n  font-size: 13px;\n  overflow-y: auto;\n}\n\n._9kwRNq_targetGroup {\n  margin-bottom: 2px;\n}\n\n._9kwRNq_targetGroupHeader {\n  width: 100%;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  text-align: left;\n  background: none;\n  border: none;\n  border-radius: 6px;\n  align-items: center;\n  gap: 6px;\n  padding: 5px 6px;\n  font-size: 12px;\n  font-weight: 600;\n  display: flex;\n}\n\n._9kwRNq_targetGroupHeader:hover {\n  background: var(--dsw-alias-fill-minor, #7f7f7f1f);\n}\n\n._9kwRNq_targetCaret {\n  width: 12px;\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 10px;\n  transition: transform .12s;\n  display: inline-block;\n}\n\n._9kwRNq_targetCaretOpen {\n  transform: rotate(90deg);\n}\n\n._9kwRNq_targetGroupName {\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  flex: 1;\n  overflow: hidden;\n}\n\n._9kwRNq_targetGroupCount {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 11px;\n  font-weight: 400;\n}\n\n._9kwRNq_targetGroupBody {\n  padding-left: 10px;\n}\n\n._9kwRNq_targetRow {\n  width: 100%;\n  color: var(--dsw-alias-label-primary);\n  cursor: pointer;\n  text-align: left;\n  background: none;\n  border: none;\n  border-radius: 6px;\n  align-items: center;\n  gap: 7px;\n  padding: 4px 6px 4px 8px;\n  font-size: 12.5px;\n  display: flex;\n}\n\n._9kwRNq_targetRow:hover {\n  background: var(--dsw-alias-fill-minor, #7f7f7f1f);\n}\n\n._9kwRNq_targetRowDot {\n  border: 1.5px solid var(--dsw-alias-label-tertiary);\n  border-radius: 50%;\n  flex: none;\n  width: 7px;\n  height: 7px;\n}\n\n._9kwRNq_targetRowSelected {\n  background: var(--dsw-alias-fill-selected, #4c8bf529);\n}\n\n._9kwRNq_targetRowSelected ._9kwRNq_targetRowDot {\n  border-color: var(--dsw-alias-accent-major, #4c8bf5);\n  background: var(--dsw-alias-accent-major, #4c8bf5);\n}\n\n._9kwRNq_targetRowLabel {\n  text-overflow: ellipsis;\n  white-space: nowrap;\n  overflow: hidden;\n}\n\n._9kwRNq_presetSelect {\n  max-width: 55%;\n  color: var(--dsw-alias-label-secondary);\n  background: var(--dsw-specific-input-major, var(--dsw-alias-bg-elevated, transparent));\n  border: 1px solid var(--dsw-alias-border-l2);\n  cursor: pointer;\n  border-radius: 6px;\n  outline: none;\n  flex: none;\n  margin-left: auto;\n  padding: 2px 6px;\n  font-size: 11.5px;\n}\n\n._9kwRNq_presetSelect:focus {\n  border-color: var(--dsw-alias-border-highlight, #4c8bf5);\n}\n\n._9kwRNq_promptBlockClamped {\n  -webkit-line-clamp: 4;\n  -webkit-box-orient: vertical;\n  display: -webkit-box;\n  overflow: hidden;\n}\n\n._9kwRNq_formError {\n  color: #d4574e;\n  margin: 0;\n  font-size: 12px;\n}\n\n._9kwRNq_modalFooter {\n  justify-content: flex-end;\n  gap: 8px;\n  display: flex;\n}\n\n._9kwRNq_scheduleToggle {\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  align-items: center;\n  gap: 8px;\n  margin-bottom: 6px;\n  font-size: 13px;\n  display: inline-flex;\n}\n\n._9kwRNq_scheduleRow {\n  align-items: center;\n  gap: 8px;\n  display: flex;\n}\n\n._9kwRNq_scheduleInput {\n  font-family: var(--dsw-font-family-mono, monospace);\n  flex: 1;\n}\n\n._9kwRNq_scheduleInputInvalid {\n  border-color: #d4574e !important;\n}\n\n._9kwRNq_schedulePreset {\n  flex: none;\n  width: auto;\n}\n\n._9kwRNq_scheduleMeta {\n  color: var(--dsw-alias-label-tertiary);\n  margin: 6px 0 0;\n  font-size: 11px;\n}\n\n._9kwRNq_executionList {\n  flex-direction: column;\n  gap: 6px;\n  margin: 0;\n  padding: 0;\n  list-style: none;\n  display: flex;\n}\n\n._9kwRNq_executionRow {\n  color: var(--dsw-alias-label-secondary);\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 8px;\n  font-size: 12px;\n  display: flex;\n}\n\n._9kwRNq_executionBadge {\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 999px;\n  flex: none;\n  padding: 1px 8px;\n  font-size: 11px;\n}\n\n._9kwRNq_executionBadge[data-result=\"succeeded\"] {\n  color: #3aa675;\n  border-color: #3aa67580;\n}\n\n._9kwRNq_executionBadge[data-result=\"failed\"] {\n  color: #d4574e;\n  border-color: #d4574e80;\n}\n\n._9kwRNq_executionBadge[data-result=\"cancelled\"] {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n._9kwRNq_executionTimes {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 11px;\n}\n\n._9kwRNq_executionError {\n  color: #d4574e;\n  word-break: break-all;\n  flex-basis: 100%;\n  font-size: 11px;\n}\n\n._9kwRNq_executionOutput {\n  color: var(--dsw-alias-label-secondary);\n  flex-basis: 100%;\n  font-size: 11px;\n}\n\n._9kwRNq_executionOutput summary {\n  cursor: pointer;\n  color: var(--dsw-alias-label-tertiary);\n  user-select: none;\n}\n\n._9kwRNq_outputBlock {\n  background: var(--dsw-alias-bg-l2, #80808014);\n  border: 1px solid var(--dsw-alias-border-l2);\n  white-space: pre-wrap;\n  word-break: break-all;\n  max-height: 220px;\n  color: var(--dsw-alias-label-secondary);\n  border-radius: 6px;\n  margin: 6px 0 0;\n  padding: 8px 10px;\n  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;\n  font-size: 11px;\n  overflow: auto;\n}\n\n._9kwRNq_cardSpinner {\n  border: 2px solid #80808059;\n  border-top-color: #4c8bf5;\n  border-radius: 50%;\n  width: 10px;\n  height: 10px;\n  animation: .9s linear infinite _9kwRNq_dsh-timeragent-spin;\n}\n\n@keyframes _9kwRNq_dsh-timeragent-spin {\n  to {\n    transform: rotate(360deg);\n  }\n}\n\n._9kwRNq_confirmText {\n  color: var(--dsw-alias-label-secondary);\n  margin: 0 0 4px;\n  font-size: 13px;\n}\n";
  document.head.appendChild(style);
})();
// #endregion
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map