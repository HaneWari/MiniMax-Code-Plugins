# Token Meter

统计 MiniMax Code 中各模型（含 Kimi、StepFun 等自定义 BYOK 接入模型）的 **token 消耗明细**与**提示缓存命中率**：分钟精度趋势查询、会话级报告、可视化看板，以及会话结束时自动归档的用量快照。

数据全部来自**本机** MiniMax Code runtime 状态。插件对 runtime 数据库只读，**不发起任何网络请求**，不上传任何数据。

## 示例提问

```text
统计今天各模型的 token 消耗明细和缓存命中率
```

预期结果：按提供商/模型分组的表格（自定义接入模型排在前面），附合计行与 1-2 句观察。

```text
画出今天下午 2 点到 4 点半的 token 用量趋势看板
```

预期结果：交互式看板（KPI 卡片 + 各模型堆叠柱 + 命中率折线），带**分钟精度时间窗口选择器**，应用新窗口后重新取数渲染。

```text
打开 token 用量实时看板
```

预期结果：Agent 通过 `token_meter_live_board` 启动回环实时看板并返回（或在有内置浏览器工具的宿主上直接打开）`http://127.0.0.1:<port>/` 链接——分钟精度窗口选择、30 秒自动刷新、明暗主题的交互看板，数据与 `token_usage_trend` 同一引擎。

```text
最近哪些会话消耗的 token 最多？
```

## 能力

- **MCP 服务器 `token-meter`**（stdio，只读）：`token_usage_summary`（窗口汇总）、`token_usage_daily`（按天）、`token_usage_sessions`（按会话）、`token_usage_trend`（分钟/小时/天桶序列，分钟精度窗口，`fillEmpty` 默认补零空桶）、`token_meter_live_board`（启动/查询/关闭回环实时看板）、`token_meter_snapshots`（快照历史）。
- **Skill `token-meter`**：文本统计报告与指标口径。
- **Skill `token-meter-visualizer`**：在支持 mavis-widget 的宿主上把趋势结果渲染为 dashboard Widget（分钟精度窗口选择器、预设、主题自适应）。没有该宿主时文本报告完整可用。
- **`SessionEnd` 快照 Hook**（在支持 Hook 的运行时上）：会话结束时把该会话的用量汇总（总量 + 分模型）追加写入插件数据目录的 `snapshots.jsonl`，长期历史不依赖 runtime 数据库的保留策略。只产生副作用、无 stdout、始终退出码 0。

## 工作原理

1. 只读查询 runtime 状态库（`<数据目录>/v2/sqlite/runtime-state.sqlite`）中的 `local_runtime_token_usage`。
2. 记录缺少 `model` 时，用本机观测日志里的 `llm_response_identifiers` 按 turn 补全提供商与模型。
3. 提供商/模型显示名来自本机 `config.yaml` 的 `custom_provider` 段；仍无法识别的记录标记为 `unknown` 并计数（`unknownRows`），不会静默丢弃。

## 指标口径

- `cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)`，cacheWrite 不计入分母。
- `totalTokens = input + output + reasoning + cacheRead + cacheWrite`。
- `costUsd` 为 runtime 原样记录值；订阅/套餐类提供商通常为 0，**不代表实际账单**，插件不做价格估算。

## 环境要求

- 有用量记录的 MiniMax Code（Desktop 本地 runtime v2，或 mcode CLI 0.3.x / 0.4.0+）。
- **Node.js 23.4 及以上（推荐 24 LTS）**且在 `PATH` 中——插件使用内置 `node:sqlite` 模块。运行时过旧时 MCP 工具返回明确错误信息而不是崩溃；快照 Hook 按设计静默失败（fail-open）。
- Windows / macOS / Linux。

## 网络访问

**无任何远程请求。** 插件不向任何外部地址发起网络调用，也没有远程 MCP 端点。可选的 `token_meter_live_board` 工具仅绑定**回环地址**（`127.0.0.1`，默认随机空闲端口）向用户本机浏览器提供看板页面；只响应回环接口，用量数据不离开本机，监听器随 MCP 进程退出或 `action=stop` 自动释放。看板使用的 Chart.js 已随包内置（`lib/vendor/chart.umd.min.js`，Chart.js 贡献者以 MIT 协议发布），打开页面同样不产生任何外部请求。

## 数据使用

- 仅读取本机数据目录中的：runtime 状态库（token 用量记录）、观测日志（按 turn 的提供商/模型）、`config.yaml`（显示名）。
- `config.yaml` 可能包含用户配置的提供商端点或凭证。插件**只提取显示名**，绝不打印、内嵌或传输端点 URL 与密钥。
- Hook 仅在插件数据目录（`PLUGIN_DATA`）下写快照文件，日志过大时通过 staging 文件重命名轮换。
- 无遥测、无上传、无隐藏后台行为。

## 包布局

插件附带多份并列 manifest，各运行时选择自己的首选形态：根 `plugin.json` + `mcp.json`（Agent Plugins 1.0 便携基线）、`.claude-plugin/plugin.json`（mcode 0.4.0+，含内联 Hook）、`.minimax-plugin/plugin.json`（MiniMax Code Desktop 本地格式，含图标）、`io.minimax.mcode/hooks/hooks.json`（v0.3.x 便携 Hook 文档）。Hook 脚本在 `io.minimax.mcode/hooks/scripts/` 与 `scripts/` 各有一份相同副本。运行时忽略 Hook 时其余能力不受影响，`token_meter_snapshots` 只会提示暂无快照。

## 限制

- 统计范围限于 runtime 数据库当前保留的数据；更早历史见 Hook 快照。
- 会话标题按 runtime 存储原样展示。
- 看板 Widget 需要支持 `mavis.widget.v1` 与 `sendPrompt` 的 MiniMax Code 宿主；其他宿主保留完整文本报告。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
