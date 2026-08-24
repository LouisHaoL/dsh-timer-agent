/**
 * Host loader entry for the dsh-timer-agent plugin — the host-authoritative
 * engine (hermes-agent cron shape): a 60s in-process ticker that fires due
 * jobs through the real agent registry (GUI open or not), a file-backed
 * ledger at ~/.dsh/timer-agent/jobs.json, the `timer_agent` model tool so
 * any conversation can create/manage jobs, and /api/dsh-timer-agent routes
 * the web UI reads and writes through.
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { HostPluginContext } from './host/contracts.ts'
import { HostJobStore } from './host/store.ts'
import { TimerRunner } from './host/runner.ts'
import { registerTimerTool } from './host/tools.ts'
import { makeRoutes } from './host/routes.ts'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 201

/** Plugin name: used for logs, diagnostics, and Fiber identity. */
export const name = 'dsh-timer-agent'

export const inject = ['webServer', 'tools', 'systemPrompt', 'agents']

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TIMER_AGENT_GUIDANCE = '本机已安装 dsh-timer-agent 插件（DSH 定时任务引擎，host 常驻，参考 hermes-agent cron）：60 秒 ticker 在 dsh web 服务进程内常驻运行，dsh web 服务启动即生效（GUI 页面关闭也照常触发）。任务台账存于 ~/.dsh/timer-agent/jobs.json。能力：任务支持 5 段 cron（如 0 9 * * *）；可指定项目 workdir（任务会话在该目录运行并加载其 AGENTS.md）、可指定已有会话 session（每次触发继续该对话，具备上下文连续性）；两者都留空则每次触发在默认工作空间新建会话发起新对话。到点通过真实 agent 会话执行 prompt。对话中可用 timer_agent 工具直接 create/list/update/pause/resume/remove/run 定时任务；Web GUI 侧边栏「定时任务」面板管理同一批任务。执行消耗 API 额度；定时执行无人在场，prompt 必须自包含、不可提问。用户提到「定时任务 / 定时器 / cron」时即指本插件，请据此协作。'

/** Settings namespace of the plugin's capability. */
export const TIMER_AGENT_SETTINGS_NAMESPACE = settingsNamespace('timer-agent')

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (ticker + tool + routes). */
  enabled?: boolean
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = true

/**
 * Mount the engine: ticker + runner, tool, routes, announcement.
 * @param ctx - host plugin context (webServer/tools/systemPrompt/agents).
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  const host = ctx as unknown as HostPluginContext
  let current: () => Config = () => config ?? {}
  let disposeEngine: (() => void) | undefined
  let disposeTool: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    for (const dispose of [disposeEngine, disposeTool, disposeSection]) dispose?.()
    disposeEngine = undefined
    disposeTool = undefined
    disposeSection = undefined
    if ((current().enabled ?? true) === false) return

    const store = new HostJobStore()
    const runner = new TimerRunner({ ctx: host, store })
    runner.start()

    disposeTool = ctx.effect(() => registerTimerTool(ctx.tools!, {
      store,
      runner,
      now: () => Date.now(),
    }), 'dsh-timer-agent: tool')

    const routes = makeRoutes({ store, runner, ctx: host, now: () => Date.now() })
    disposeEngine = () => {
      void runner.dispose()
      for (const route of routes) void route
    }
    const disposeRoutes = ctx.effect(() => {
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-timer-agent: routes')
    // Routes unregister with the engine (single teardown path).
    const engineTeardown = disposeEngine
    disposeEngine = () => {
      engineTeardown()
      disposeRoutes()
    }

    if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === true) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:timer-agent',
        order: SECTION_ORDER,
        text: TIMER_AGENT_GUIDANCE,
      })
    }
  }

  installSettingsSection(ctx, TIMER_AGENT_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: sync,
  })

  sync()
}
