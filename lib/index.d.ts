import z from "schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/** Plugin name: used for logs, diagnostics, and Fiber identity. */
declare const name = "dsh-timer-agent";
declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
declare const TIMER_AGENT_GUIDANCE = "\u672C\u673A\u5DF2\u5B89\u88C5 dsh-timer-agent \u63D2\u4EF6\uFF08DSH \u5B9A\u65F6\u4EFB\u52A1\u5F15\u64CE\uFF0Chost \u5E38\u9A7B\uFF0C\u53C2\u8003 hermes-agent cron\uFF09\uFF1A60 \u79D2 ticker \u5728 dsh web \u670D\u52A1\u8FDB\u7A0B\u5185\u5E38\u9A7B\u8FD0\u884C\uFF0Cdsh web \u670D\u52A1\u542F\u52A8\u5373\u751F\u6548\uFF08GUI \u9875\u9762\u5173\u95ED\u4E5F\u7167\u5E38\u89E6\u53D1\uFF09\u3002\u4EFB\u52A1\u53F0\u8D26\u5B58\u4E8E ~/.dsh/timer-agent/jobs.json\u3002\u4EFB\u52A1\u5206\u4E24\u7C7B\uFF1Akind=agent\uFF08\u9ED8\u8BA4\uFF0CAI Agent \u4EFB\u52A1\uFF09\u5230\u70B9\u901A\u8FC7\u771F\u5B9E agent \u4F1A\u8BDD\u6267\u884C prompt\uFF1Bkind=command\uFF08\u666E\u901A\u4EFB\u52A1\uFF09\u4E0D\u7ECF\u8FC7 AI\uFF0C\u76F4\u63A5 spawn command+args \u6267\u884C\u811A\u672C\uFF0C\u4E0D\u6D88\u8017 API \u989D\u5EA6\u3002\u4EFB\u52A1\u652F\u6301 5 \u6BB5 cron\uFF08\u5982 0 9 * * *\uFF09\uFF1Bagent \u4EFB\u52A1\u53EF\u6307\u5B9A\u9879\u76EE workdir\uFF08\u4EFB\u52A1\u4F1A\u8BDD\u5728\u8BE5\u76EE\u5F55\u8FD0\u884C\u5E76\u52A0\u8F7D\u5176 AGENTS.md\uFF09\u3001\u53EF\u6307\u5B9A\u5DF2\u6709\u4F1A\u8BDD session\uFF08\u6BCF\u6B21\u89E6\u53D1\u7EE7\u7EED\u8BE5\u5BF9\u8BDD\uFF0C\u5177\u5907\u4E0A\u4E0B\u6587\u8FDE\u7EED\u6027\uFF09\uFF1B\u4E24\u8005\u90FD\u7559\u7A7A\u5219\u6BCF\u6B21\u89E6\u53D1\u5728\u9ED8\u8BA4\u5DE5\u4F5C\u7A7A\u95F4\u65B0\u5EFA\u4F1A\u8BDD\u53D1\u8D77\u65B0\u5BF9\u8BDD\uFF1Bcommand \u4EFB\u52A1\u53EA\u9700\u6807\u9898\u3001\u547D\u4EE4\u3001\u53C2\u6570\u4E0E\u5B9A\u65F6\u5668\uFF08workdir \u4F5C\u4E3A\u8FDB\u7A0B\u5DE5\u4F5C\u76EE\u5F55\uFF0C\u8D85\u65F6\u540C\u6837\u751F\u6548\uFF0C\u9000\u51FA\u7801\u975E 0 \u8BB0\u4E3A\u5931\u8D25\u5E76\u4FDD\u7559\u8F93\u51FA\u5C3E\u90E8\uFF09\u3002\u5BF9\u8BDD\u4E2D\u53EF\u7528 timer_agent \u5DE5\u5177\u76F4\u63A5 create/list/update/pause/resume/remove/run \u5B9A\u65F6\u4EFB\u52A1\uFF08create/update \u652F\u6301 kind/command/args \u53C2\u6570\uFF09\uFF1BWeb GUI \u4FA7\u8FB9\u680F\u300C\u5B9A\u65F6\u4EFB\u52A1\u300D\u9762\u677F\u7BA1\u7406\u540C\u4E00\u6279\u4EFB\u52A1\u3002\u5B9A\u65F6\u6267\u884C\u65E0\u4EBA\u5728\u573A\uFF0Cagent \u4EFB\u52A1\u7684 prompt \u5FC5\u987B\u81EA\u5305\u542B\u3001\u4E0D\u53EF\u63D0\u95EE\u3002\u7528\u6237\u63D0\u5230\u300C\u5B9A\u65F6\u4EFB\u52A1 / \u5B9A\u65F6\u5668 / cron\u300D\u65F6\u5373\u6307\u672C\u63D2\u4EF6\uFF0C\u8BF7\u636E\u6B64\u534F\u4F5C\u3002";
/** Settings namespace of the plugin's capability. */
declare const TIMER_AGENT_SETTINGS_NAMESPACE: import("@deepseek-ai/dsh-settings").SettingsNamespace;
/** Plugin config, validated by the same-named schemastery schema. */
interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean;
  /** Master switch for the plugin (ticker + tool + routes). */
  enabled?: boolean;
}
declare const Config: z<Config>;
/**
 * Mount the engine: ticker + runner, tool, routes, announcement.
 * @param ctx - host plugin context (webServer/tools/systemPrompt/agents).
 * @param config - resolved plugin config.
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, TIMER_AGENT_GUIDANCE, TIMER_AGENT_SETTINGS_NAMESPACE, apply, inject, name };