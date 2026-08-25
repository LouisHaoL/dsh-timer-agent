# 早间 Review 指南 — dsh-timer-agent 夜间产出

> 生成于 2026-08-25 自动执行会话。main 已更新并重新构建（页面刷新即生效）；三个新特性各自在独立分支上，均未合并，等你决定。

## 一、已进 main（刷新页面即可验证）

commit `2979341` — **fix + UI 改版**，测试 56+29 全绿：

1. **修复「查看会话」不跳转**：根因是任务面板以不透明浮层占据中栏（CSS 里 `data-dsh-timeragent-active` 时对话被 `display:none`），点「查看会话」其实已经 `sessions.open` 了，只是被面板挡住。现在 `openSession` 先关闭详情与面板再导航，并先 `sessions.refresh()` 兜底（定时任务是无头创建会话，列表镜像可能还没见过它），导航异常也不外抛。
2. **状态标签页**：全部 / 待机 / 进行中 / 成功 / 失败 / 已归档，每 tab 实时统计数量（统计基于全量台账，搜索框在 tab 内二次过滤）。比你列的多加了一个「失败」tab，避免失败任务只能去「全部」里翻 —— 不要可以摘掉（`src/client/board/tabs.ts` 一行）。
3. **小卡片列表**：`auto-fill minmax(230px)` 响应式网格卡片；下次运行时间正向显示（+5m/+2h）。

## 二、特性分支状态（2026-08-25 早上更新：`feat/run-timeout` 已合并进 main，commit `e7c007d`，75+29 全绿，已重建）

调研依据见 `docs/RESEARCH-competitor-features.md`（gh CLI 一手取证：hermes-agent / openclaw 的 cron issue + ClaudeCron README）。

| 分支 | commit | 特性 | 竞品依据 | 状态 |
|---|---|---|---|---|
| `feat/run-timeout` | `b9b124c` | 每任务执行超时：到点 `agent.cancel()` + 记失败；工具 `timeout_minutes` / 路由 `timeoutMinutes` / 详情编辑三入口 | n8n、cron-job.org 标配；openclaw #121953 卡死风险 | **✅ 已合并（`e7c007d`）** |
| `feat/execution-notifications` | `f553edc` | 执行结束桌面通知（成功/失败标题+任务名），点击跳转对应会话；面板打开时不打扰 | openclaw RFC #96190 `notifyOnCompletion`；ClaudeCron「alerts on completion」；hermes #93820 静默失败不可见 | ⏳ 待定（56+46 checks） |
| `feat/webhook-trigger` | `0880066` | 每任务外部 webhook 令牌：`POST /hooks/run?id&token` 手动触发，token 即鉴权、**有意**放开回环围栏（CI/手机/局域网脚本可触发） | n8n webhook trigger；hermes #93955/#94010 | ⏳ 待定（69+29 checks） |

### 合并剩余分支
```powershell
cd D:\workspace\dsh\hermes-agent-research\dsh-timer-agent
git checkout main
git merge feat/execution-notifications
git merge feat/webhook-trigger
pnpm test && pnpm run build           # 合完回归 + 重建，刷新页面生效
```
注意：两条待定分支都改了 `remote-controller.ts` / `controller-face.ts` / `locales.ts` / `tests/e2e.mts`，第二条起会有相邻行小冲突（语义不冲突：通知/webhook 字段互相独立，也与已合并的超时无关）。合并后记得 `pnpm test`。

### 落选但值得一看的候选（见调研文档）
失败自动重试（backoff）、LLM 质量门禁（openclaw #120607）、cron 人类可读 + 未来 N 次预览（cron-job.org 标配，纯 UI）、每任务工具黑白名单（openclaw #12736）、显式时区。

## 三、测试口径说明
- 宿主侧行为（cron/存储/触发/结算/超时/webhook/工具/路由）：fake host 全行为测试 `tests/e2e.mts`。
- UI 逻辑（tab 模型、语言包完整性、控制器跳转修复、settlement 差分、通知联动）：`tests/ui.mts`（stub fetch / stub Notification）。
- `.tsx` 组件本体无法被 Node type-stripping 执行（不支持 JSX），靠 `pnpm typecheck` 覆盖类型与接线 —— 这层是薄映射，逻辑都抽在可测模块里。
