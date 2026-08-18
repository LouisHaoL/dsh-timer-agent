# dsh-timer-agent — Scheduled-jobs × AI Agent engine for DSH

English | [中文](./README.md)

A [DeepSeek Harness (DSH)](https://github.com/) Web GUI plugin: a **host-resident scheduled-jobs engine** built after studying the cron system of [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) and following its "timer ↔ agent coordination" design. It is live the moment the `dsh web` service starts — **it keeps firing with the GUI page closed**.

![New-job modal: collapsible project/session tree + cron presets](docs/screenshot.png)

## What it does

At each cron due point (5-field cron) it executes your prompt through a **real agent session**:

- **Pin an existing session** → every run continues that conversation with full context (hermes-cron continuity semantics)
- **Set a project workdir** → every run starts a fresh session inside that project (its AGENTS.md loads automatically)
- **Leave both blank** → every run starts a new conversation in the default workspace

Manage jobs right from any conversation with the `timer_agent` tool (create / list / update / pause / resume / remove / run); the web GUI sidebar「定时任务」panel manages the same jobs — **one ledger, three doorways** (tool / WebUI / file).

## Architecture (isomorphic to hermes-agent cron)

```
┌─ dsh web host process ────────────────────────────┐
│  60s ticker (resident; runs with GUI closed)      │
│   ├─ HostJobStore   ~/.dsh/timer-agent/jobs.json  │
│   │                 (atomic writes, degrades safe)│
│   ├─ TimerRunner    at-most-once: roll nextRunAt  │
│   │                 forward BEFORE firing; skip    │
│   │                 while running; missed = skipped│
│   │   ├─ agents.resume (pinned session)           │
│   │   └─ agents.create + workspaceRegistry        │
│   │       (fresh session attached to project)     │
│   ├─ timer_agent tool (model-facing)              │
│   └─ /api/dsh-timer-agent/* routes (loopback-only)│
└────────────────────────┬──────────────────────────┘
                         │ HTTP polling mirror (5s)
┌─ Browser half (thin)───┴──────────────────────────┐
│  Sidebar entry + jobs board (React)               │
│  Collapsible project/session tree · cron presets  │
│  · execution history                              │
└───────────────────────────────────────────────────┘
```

Run settlement rides `session/event` (`turn/end`'s `reason.kind`); failure reasons land verbatim in the ledger.

## Features

- **Scheduling**: 5-field cron (min hour day month weekday; `*`, `*/n`, `a-b`, comma lists) + preset dropdown (daily 09:00 / hourly / every 10 min / Mondays 09:00) on both create and edit surfaces
- **Target tree picker**: collapsible per-project groups, each with a "new session" leaf plus the project's existing sessions (most recent first); picking a session pins that conversation
- **Jobs board**: list (title/status/next-run/run count), search, detail view (cron editor, execution history, jump to session transcript, run now, reset, delete)
- **Model tool**: `timer_agent` in any conversation creates and manages the same jobs
- **System-prompt injection**: the host half registers a `plugin:timer-agent` announcement section so agents know the capability
- **Safety**: API routes are loopback + same-origin only (same fence as dsh-ssh)

## Install

```sh
dsh plugin --profile web add link:<absolute path to this directory>
```

Then **restart `dsh web`**; the sidebar「定时任务」entry confirms it is live (browser-side changes need a `Ctrl+F5` force refresh).

## Build

```sh
pnpm install
pnpm run build      # lib/index.js (host) + lib/client.js (browser, CSS inlined)
pnpm run typecheck
pnpm test           # 49 behavioral E2E checks (fake host faces, no dsh runtime)
pnpm run smoke-test # static structure smoke (23 checks)
```

The E2E suite covers: cron parsing and next-run computation (local-time semantics), ledger atomic writes and corrupted-file degradation, at-most-once due firing, pinned-session resume, `turn/end` success/failure settlement (failure reason lands verbatim), skip-while-running, disabled schedules never firing, the manual-run fast path, workdir propagation, every `timer_agent` tool action (incl. invalid-argument rejection), and HTTP route CRUD + run + loopback/same-origin fencing + 400s on bad input.

## Mapping to hermes-agent cron

| hermes-agent | this plugin |
|---|---|
| in-process 60s ticker in gateway | 60s ticker in the `dsh web` host process |
| fire → new AIAgent(platform=cron) session | `agents.create`/`resume` real dsh sessions |
| ~/.hermes/cron/jobs.json ledger | ~/.dsh/timer-agent/jobs.json (atomic writes) |
| at-most-once (advance next_run_at first) | roll nextRunAt forward before firing |
| claim dedup + heartbeat | skip-while-running + 5s manual-run fast path |
| deliver backfill / platform pinning | pinned session / workdir new session / default space |
| cron_hint → notepad → script prompt assembly | self-contained prompt (no human present) |
| turn/end reason.kind=error settlement | same-shape session/event settlement |

## Known limits

- Firing depends on the `dsh web` service process being alive (a stopped service fires nothing; after restart only already-rolled-forward due jobs run — missed means missed)
- A job that is mid-run at its due point skips that slot and waits for the next cron match
- Executions consume API quota; scheduled runs have no human present — prompts must be self-contained and must not ask questions

## Credits

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — the cron architecture blueprint
- The [dsh-web-ui collection](https://github.com/linxin666) (dsh-ssh / dsh-client-ui-task-board) — engineering precedents for host services, route registration, sidebar injection, and the preset dropdown

## License

Apache-2.0
