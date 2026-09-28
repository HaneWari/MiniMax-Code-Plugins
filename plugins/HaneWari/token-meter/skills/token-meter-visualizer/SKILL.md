---
name: token-meter-visualizer
description: 将 token-meter 的 token 用量统计结果渲染为 mavis-widget 可视化看板——按分钟/小时/天桶的用量趋势（堆叠柱 + 缓存命中率折线）与 KPI 卡片，内置分钟精度的时间窗口选择器。当用户要求把 token 消耗画成图、生成用量看板/趋势图/曲线、查看某个时间段（可精确到分钟）的用量走势时使用。纯文本表格统计仍由 token-meter 业务 Skill 完成，本 Skill 只做可视化渲染。
---

# Token Meter Visualizer

把 `token-meter` 业务 Skill 已经得到的结构化用量结果渲染成一个 `kind="dashboard"` 的 mavis-widget。
本 Skill 不重新取数、不编造数据，只转换业务流已产出的结果。

## 渲染时机

- 用户明确要求：趋势图、看板、曲线、可视化、"画出来"，或指定了一个需要图形呈现的时间段（尤其是分钟级窗口）。
- 用户只问数字/表格时，保持在 `token-meter` 文本报告，不渲染 Widget。
- 数据过小（窗口内 ≤2 个非零桶且总量很低）时，直接用文本回答更有用，不渲染。

## 工作流程

1. 调用 MCP 工具 `token_usage_trend` 取得趋势数据（数据契约见 `references/data-schema.json`）：
   - 用户给出明确时间段 → 传 `startAt`/`endAt`（本地时间 `YYYY-MM-DDTHH:MM`，分钟精度）。
   - 只有"最近 N 天" → 传 `days`。
   - `bucket` 默认 `auto`；用户指定粒度时照传。
2. 需要模型占比等补充口径时可再调 `token_usage_summary`，但 Widget 的主数据必须来自 `token_usage_trend`。
3. 阅读本 Skill 自带的 `references/genui-widget/SKILL.md` 及其 `references/` 下的基础契约（主题令牌、安全约束、Chart.js 规则），按 `references/components.md` 中的 `token-trend-dashboard` 配方渲染。
4. 在最终回复中输出**恰好一个**完整 `<mavis-widget>`（`kind="dashboard"`，`capabilities="resize,sendPrompt"`），参考 `references/examples.md` 的完整示例；输出 Widget 后不再调用任何工具。

## 窗口选择器（分钟精度）

Widget 必须包含时间窗口选择栏：

- 两个 `datetime-local` 输入（`step="60"`，分钟精度）：开始、结束。
- 预设按钮：近 1 小时、今天、近 7 天（仅修改输入框的值，属于本地交互）。
- "应用"按钮：读取输入值，本地校验（非空、结束晚于开始）后通过 `window.mavis.sendPrompt` 发起一次追问，让 Agent 用新窗口重新调用 `token_usage_trend` 并重渲染。**Widget 内不重新取数、不本地重算窗口数据**。
- `sendPrompt` 的 `text` 与 `metadata.userIntent` 必须使用中文，并带上 `{ startAt, endAt, bucket }` 作为 `selectedData`。

## 数据与口径

- 序列：`series.tokensByModel`（各模型每桶总 tokens，堆叠柱）、`series.cacheHitRate`（每桶命中率 0-1，折线；`null` 表示该桶无有效分母，不描点）、`series.labels`（桶标签）。
- 模型顺序即 `models` 数组顺序（自定义模型在前，`__other__` 固定最后），图表颜色按 `--mw-chart-1..6` 顺序取值。
- KPI：`kpis.totalTokens`、`kpis.calls`、`kpis.cacheHitRate`（0-1，展示为百分比，保留 1 位小数）、`kpis.activeModels`。
- token 数字用 `Intl.NumberFormat` 千分位；大数值可用 K/M 缩写（如 10.6M），并在 tooltip 保留精确值。
- 数据来源与口径说明写进 `<mavis-meta>.dataSource` 和 Widget 底部一行小字（本机 runtime sqlite + 日志补全；命中率口径见 notes）。

## 状态

- **空数据**：`meta.rows === 0` 或所有桶总量为 0 时，保留布局，在图表区显示一行"该时间窗口内没有用量记录"，不要渲染空图表，改用文本说明。
- **错误**：工具返回 `isError` 时，不渲染 Widget，直接用文本转述错误（如窗口不合法、数据库不可用）。
- **加载/流式**：`<mavis-html>` 必须先出现完整结构（KPI 卡片、图表容器带显式高度、选择栏），数据经 `<mavis-data>` 注入。
- **主题**：只使用 `--mw-*` 令牌；Chart.js 颜色读 `window.mavisTheme.tokens`，并监听 `mavis:theme-change` 更新。

## 交互边界

- 本地交互：预设按钮回填输入框、图例开关系列、tooltip。
- sendPrompt 仅用于：应用新时间窗口、"分析这个窗口"之类的推理追问。每个 Widget 2-4 个 sendPrompt 目标即可。
- 禁止在 Widget 内 fetch、读取存储、或重放任何业务调用。
