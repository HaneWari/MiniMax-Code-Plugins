---
name: token-meter
description: 统计 MiniMax Code 本机各模型（含自定义接入模型，如 Kimi、StepFun 等 BYOK 提供商）的 token 消耗明细、缓存命中率与会话用量快照。当用户询问 token 消耗、用量统计、缓存命中率、各模型用量对比、每日/每周用量趋势、某个会话的 token 开销、历史用量回顾，或提到 token-meter 时使用。
---

# Token Meter

查询本机 MiniMax Code runtime 记录的模型 token 用量，输出消耗明细与缓存命中率报告。

## 能力

本插件提供一个 MCP 服务器 `token-meter`（6 个工具，全部只读）和一个 SessionEnd 快照 Hook（自动归档，无需手动触发）。

### MCP 工具

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `token_usage_summary` | 时间窗口内按 提供商/模型 分组的用量汇总（自定义模型排在前面） | `days`（默认 1）或 `startDate`/`endDate`（YYYY-MM-DD） |
| `token_usage_daily` | 按天 × 模型 的每日趋势 | `days`（默认 7） |
| `token_usage_sessions` | 按会话的消耗明细，含会话标题与分模型构成 | `days`（默认 30）、`limit`（默认 10） |
| `token_usage_trend` | 按分钟/小时/天桶的用量与命中率序列，分钟精度自定义窗口；`fillEmpty`（默认 true）用零值桶补齐时间轴 | `startAt`/`endAt`（YYYY-MM-DDTHH:MM）、`days`、`bucket`（auto/minute/hour/day） |
| `token_meter_live_board` | 启动/查询/关闭本地回环实时看板，返回 `http://127.0.0.1:<port>/` | `action`（start/status/stop）、`port`（默认 0=随机） |
| `token_meter_snapshots` | Hook 归档的历史会话快照（runtime 数据库清理后仍可回顾） | `limit`（默认 20） |

### 实时看板（live board）

当用户想"查看用量趋势/实时看板"，或文本与静态图表都不够用时：

1. 调用 `token_meter_live_board`（`action=start`）拿到回环 URL；重复调用幂等返回同一地址。
2. **宿主若提供内置浏览器工具（如 `mcp_browser` 的 `open_tab`），直接为用户打开该 URL**——用户无需任何手动操作即可看到实时看板；否则把链接发给用户自行点击。
3. 页面能力：分钟精度窗口选择器 + 近 1 小时/今天/近 7 天预设、30 秒自动刷新、跟随系统/手动切换明暗主题，数据与 `token_usage_trend` 同一引擎。
4. 只绑定 127.0.0.1，无远程请求；服务随 MCP 进程退出自动释放，用户要求关闭时调 `action=stop`。

### 快照 Hook

每次会话结束时自动把该会话的用量汇总（总量 + 分模型）追加到
`<数据目录>/v2/plugin-data/hooks/token-meter/snapshots.jsonl`。
查询长期历史时优先用 `token_meter_snapshots`；需要逐条分析时也可直接读该文件。

## 指标口径（汇报时遵守）

- **cacheHitRate** = `cacheReadTokens / (cacheReadTokens + inputTokens)`，即提示词中命中缓存的比例；cacheWrite 不计入分母。
- **totalTokens** = input + output + reasoning + cacheRead + cacheWrite。
- **costUsd** 是 runtime 原样记录值；订阅/套餐类自定义提供商通常为 0，不要把它当作实际账单，也不要自行估算费用。
- 分组中 `custom: true` 表示自定义接入模型（`custom_provider:*`），报告里先列自定义模型，再列内置模型。
- 记录可能带 `provider/model = unknown`：sqlite 未记录 model 时会用 runtime 日志按 turn 补全，仍缺省时保留 unknown 并在报告中注明条数（`unknownRows`）。

## 汇报模板

默认用 Markdown 表格汇报，例如汇总场景：

```
| 提供商 | 模型 | 调用次数 | 输入 | 输出 | 缓存读取 | 缓存命中率 | 总 tokens |
```

末尾补一行合计，并按需给出 1-3 句观察（如缓存命中率是否健康、哪个模型消耗最高）。
数据窗口、记录条数见工具返回的 `meta`；当窗口内无数据时直接说明，不要编造数字。

## 可视化组合

本 Skill 始终先产出上面的文本结果。呈现方式按场景选择：

- **mavis-widget 看板**：用户明确要求会话内嵌图表/看板且宿主支持 widget 时，拿到文本结果后转交 `token-meter:token-meter-visualizer` 渲染一个 dashboard Widget（趋势数据用 `token_usage_trend`）。
- **实时看板页**：用户要求实时交互、分钟级窗口自由探索，或宿主不支持 widget 时，走上面的"实时看板（live board）"流程。

纯统计问答不渲染 Widget、不启动看板。

## 注意

- 数据范围限于本机 runtime 数据库当前保留的内容；`meta.dataDir` 指向实际读取的数据目录。
- 所有工具为只读查询，不会修改 runtime 状态。
