# 组件配方：token-trend-dashboard

## 业务问题与选择规则

- 业务问题：某个时间窗口内 token 消耗随时间如何分布？哪个模型占主导？缓存命中率是否稳定？
- 选择规则：用户要求趋势图/看板/曲线，或给出需要图形化的时间段（含分钟级）。数据点 ≤2 个非零桶时改用文本。

## 输入字段（来自 `token_usage_trend`，详见 data-schema.json）

| 字段 | 单位/格式 | null 策略 | 来源 |
| --- | --- | --- | --- |
| `window.start/end` | ISO 时间 | 必有 | runtime 查询窗口 |
| `window.bucket` | minute/hour/day | 必有 | 服务端按窗口自动或用户指定 |
| `window.fillEmpty` | boolean | 必有 | true 时空桶已补零（命中率 null），时间轴连续 |
| `kpis.totalTokens/calls/activeModels` | 整数 | 必有 | sqlite 聚合 |
| `kpis.cacheHitRate` | 0-1 | 整窗无分母时 null → 显示 `--` | cacheRead/(cacheRead+input) |
| `models[].key/modelName/providerName/custom/totalTokens` | - | 必有（可为空数组） | 分组排序，自定义在前 |
| `series.labels` | 桶标签 | 必有 | 本地时区格式化 |
| `series.tokensByModel[key]` | 整数数组 | 缺桶为 0 | 每桶模型 tokens |
| `series.cacheHitRate` | 0-1 数组 | 单桶 null → 折线断点不描点 | 每桶命中率 |
| `series.calls / totalTokens` | 整数数组 | 必有 | tooltip 用 |
| `unknownRows` | 整数 | 必有 | 未识别记录数，>0 时在脚注注明 |

## Widget 形态

- `kind="dashboard"`，`capabilities="resize,sendPrompt"`，主题 `app`，令牌集 `mavis.semantic.v1`。
- 设计语言（避免模板化廉价感）：单一 KPI 带（内部分隔线，非四个孤盒）、分段式预设按钮（segmented control）、模型占比分段条、图例附 compact 数值与"自定义"徽记、数字 `tabular-nums`、8px 间距节奏、无阴影无渐变。
- 语义层级：
  1. 标题行：左标题，右 quiet meta（窗口 + 桶粒度 + 记录数）；
  2. 窗口选择栏（单表面）：开始/结束 `datetime-local`（`step="60"`）→ 分段预设（近 1 小时/今天/近 7 天）→ accent 主按钮"应用"；
  3. KPI 带（4 格）：总 tokens、调用次数（副行：峰值/桶）、缓存命中率（副行：口径）、活跃模型（副行：模型名）；
  4. 模型占比条：8px 圆角分段条 + 份额百分比行；
  5. 主图卡：Chart.js combo——各模型 tokens 堆叠柱（左轴，`borderRadius:5`，无轴线）+ 缓存命中率折线（右轴 0-100%）；图例带数值；
  6. 脚注行：左侧来源与口径（含 unknownRows>0 提示），右侧"分析这个窗口"按钮。
- 图表容器显式高度（主图 300px）；>6 个桶用 Chart.js，≤5 个桶退化为 CSS bench bars。

## 本地交互

- 预设按钮：把对应窗口填入两个 `datetime-local`（不触发网络）。
- 输入校验：应用前检查非空且 end > start，不合法则内联提示（不发 sendPrompt）。
- Chart.js 图例点击开关系列、tooltip 展示精确值（含 calls 与命中率）。

## 推理追问（sendPrompt，中文 text + userIntent）

1. 应用窗口：`(应用) → sendPrompt`，text 如"用 token-meter 渲染 2026-09-28 16:00 到 17:45 的用量趋势"，selectedData `{ startAt, endAt, bucket }`。
2. 分析窗口：按钮"分析这个窗口"，追问当前窗口的消耗特征与异常点，selectedData 带窗口与 KPI 摘要。
3. 两者之外不加多余目标。

## 状态呈现

- loading/流式：HTML 结构先行，KPI 显示 `--` 前已由 data 注入；无需额外骨架。
- empty：图表区一行"该时间窗口内没有用量记录"，保留选择栏可重选窗口。
- error：不渲染 Widget，文本转述工具错误。
- auth/permission：本工具只读本机数据，无认证态。
- 文本回退（`<mavis-fallback>`）：窗口与口径一句话 + KPI 表 + 峰值桶 Top 3（标签 + 总量 + 命中率）。
