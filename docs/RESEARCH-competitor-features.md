# dsh-timer-agent 竞品特性调研（分支开发依据）

> 调研时间：2026-08-25 深夜自动执行。取证来源：`gh` CLI（issue 列表 / 搜索 / README）。
> 结论先行：选出 3 个特性各自开分支开发，未合并，等早上人工 review。

## 一、调研对象

| 竞品 | 形态 | 与本插件的关系 |
|---|---|---|
| NousResearch/hermes-agent（cron 组件） | 个人 agent + cron 定时会话 | 本插件的直接灵感来源（235k stars） |
| openclaw/openclaw | 个人 AI 助手（cron 子系统） | 最活跃的同类 cron-issue 金矿 |
| plosson/ClaudeCron | macOS launchd 版 Claude 定时任务 GUI | 独立定时器 GUI 功能全集参照 |
| cron-job.org / n8n scheduled workflow（常识参照） | 传统 cron SaaS / 自动化平台 | 超时、重试、webhook、通知的行业标准 |

## 二、来自 issue 的一手证据

### hermes-agent（comp/cron 标签）
- **#93820 (P1)**「Cron runs marked complete without any persisted final assistant message — silent failures invisible in run history」→ 定时执行的**静默失败可见性**是最高优先级痛点。
- **#93955**「Expose read-only cron job status in messaging gateways」→ 从外部/聊天侧**查询任务状态**的需求。
- **#94010 (P2)**「trigger_job() is a silent no-op …」→ 手动触发链路的可靠性。
- **#121953 系（OpenClaw）**「Cron agent turns stall …」→ **执行卡死**无人处理是共性风险。

### openclaw/openclaw
- **#96190 (RFC)**「opt-in cron.jobs[].notifyOnCompletion for parent wake after isolated cron run」→ **执行完成通知**是社区 RFC 级需求。
- **#127334**「Cron runs have no accessible status lifecycle」→ 状态生命周期可观测性。
- **#120607**「Quality-gate cron mode for autonomous job runs」→ 用 LLM 给运行结果打分（远期候选）。
- **#128267**「Conditioning and cooldown for the cron announce delivery path」→ 通知限流/冷却。
- **#12736**「tools.cron.tools.deny config option」→ 每任务工具限制（远期候选）。

### ClaudeCron（README 功能表）
- **Notifications: optional alerts on task start and completion**（再次印证通知是标配）
- Run history（输出 / 原始流 / 错误）、session new/resume/fork、每任务模型与权限模式。

## 三、特性决策（每个一条分支）

| 分支 | 特性 | 依据 | 形态 |
|---|---|---|---|
| `feat/run-timeout` | 执行超时自动取消 | n8n/cron-job.org 标配；卡死风险（OpenClaw #121953） | JobRecord.timeoutMs；runner 5s 巡检 in-flight，超时 agent.cancel + settle failed；工具/路由/编辑 UI 可配 |
| `feat/execution-notifications` | 执行结束通知 | OpenClaw #96190 RFC；ClaudeCron 标配；hermes #93820 静默失败 | 客户端轮询差分（纯函数 detectSettlements）→ Web Notification，点击跳转对应会话 |
| `feat/webhook-trigger` | 外部 webhook 手动触发 | n8n webhook trigger；hermes #93955/#94010 | 每任务可选 webhookToken；POST /api/dsh-timer-agent/hooks/run?id&token（token 即鉴权，放开回环围栏） |

### 落选但记录在案（未来候选）
- 失败自动重试（backoff）——与超时/通知组合后才安全，避免风暴。
- LLM 质量门禁模式（OpenClaw #120607）。
- 每任务工具白/黑名单（OpenClaw #12736）。
- cron 人类可读描述 + 未来 N 次运行预览（cron-job.org 标配，纯 UI）。
- 时区显式声明（当前跟随本机时区）。
