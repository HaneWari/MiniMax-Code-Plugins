# Token Meter

Track per-model **token usage** and **prompt-cache hit rate** in MiniMax Code — including custom
BYOK providers such as Kimi or StepFun — with minute-precision trend queries, per-session reports,
an optional visual dashboard, and automatic per-session usage snapshots.

All data comes from the **local** MiniMax Code runtime state. The plugin is read-only against the
runtime database, makes **no network calls**, and uploads nothing.

## Example prompts

```text
Summarize today's token usage by model with cache hit rates.
```

Expected result: a table like the one below (custom providers listed first), followed by a total
row and one or two observations.

```text
| Provider                  | Model          | Calls | Input  | Output | Cache read | Cache hit | Total tokens |
| ------------------------- | -------------- | ----- | ------ | ------ | ---------- | --------- | ------------ |
| Kimi For Coding (kimi.com)| K3             | 68    | 86,715 | 36,646 | 3,886,592  | 97.8%     | 4,009,953    |
| StepFun Step Plan (Global)| step-5-preview | 15    | 81,229 | 6,473  | 445,184    | 84.6%     | 532,886      |
```

```text
Draw the token usage trend dashboard from 14:00 to 16:30 today.
```

Expected result: an interactive dashboard (KPI cards, per-model stacked bars, cache-hit-rate line)
with a **minute-precision time-window selector**; applying a new window re-queries and re-renders.

```text
Which recent sessions consumed the most tokens?
```

## Capabilities

- **MCP server `token-meter`** (stdio, read-only):
  | Tool | Purpose | Key arguments |
  | --- | --- | --- |
  | `token_usage_summary` | Per provider/model totals for a window, custom models first | `days` (default 1) or `startDate`/`endDate` |
  | `token_usage_daily` | Day × model breakdown | `days` (default 7) |
  | `token_usage_sessions` | Per-session totals with titles and model mix | `days` (default 30), `limit` (default 10) |
  | `token_usage_trend` | Minute/hour/day bucketed series for charts; empty buckets are zero-filled (`fillEmpty`, default true) | `startAt`/`endAt` (`YYYY-MM-DDTHH:MM`, minute precision), `days`, `bucket` (`auto`/`minute`/`hour`/`day`) |
  | `token_meter_snapshots` | Archived per-session snapshots written by the hook | `limit` (default 20) |
- **Skill `token-meter`**: when and how to answer usage questions in text, including the metric
  formulas below.
- **Skill `token-meter-visualizer`**: renders `token_usage_trend` results as a `mavis.widget.v1`
  dashboard on hosts that support MiniMax Code widgets (minute-precision window selector, presets,
  theme-aware charts). Text reporting remains fully functional without it.
- **`SessionEnd` hook** (where the runtime supports hooks): appends a per-session snapshot
  (totals + per-model breakdown) to `snapshots.jsonl` under the plugin's data directory, so
  long-term history survives runtime database cleanup. Side-effect only, no stdout, always exits 0.

## How it works

1. Reads `local_runtime_token_usage` from the runtime state database
   (`<data-dir>/v2/sqlite/runtime-state.sqlite`) **read-only**.
2. When a row lacks `model`, enriches it from `llm_response_identifiers` lines in the local
   observability logs (per-turn provider/model mapping).
3. Resolves provider/model display names from the local `config.yaml`
   (`custom_provider` section); rows that stay unresolved are reported as `unknown`
   (`unknownRows`), never silently dropped.

## Metrics

- `cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)` — the share of prompt tokens
  served from cache. `cacheWriteTokens` is not part of the denominator.
- `totalTokens = input + output + reasoning + cacheRead + cacheWrite`.
- `costUsd` is reported as recorded by the runtime. Subscription/flat-plan providers usually record
  `0`; it is **not** a bill and the plugin never estimates prices.

## Requirements

- MiniMax Code with recorded usage (Desktop local runtime v2, or mcode CLI 0.3.x / 0.4.0+).
- **Node.js 23.4 or newer (Node.js 24 LTS recommended)** on `PATH` — the plugin uses the built-in
  `node:sqlite` module. On older runtimes the MCP tools return a clear error message instead of
  crashing; the snapshot hook fails open silently by design.
- Windows, macOS, or Linux.

## Network access

**None.** The plugin makes no network requests and has no remote MCP endpoints.

## Data use

- Reads, from the local data directory only: the runtime state database (token usage rows),
  observability logs (provider/model per turn), and `config.yaml` (provider/model display names).
- `config.yaml` may contain user-configured provider endpoints or credentials. The plugin extracts
  **only display names**; it never prints, embeds, or transmits endpoint URLs or secrets.
- The hook writes snapshot files only under the per-plugin data directory (`PLUGIN_DATA`), using a
  staging-file rename when rotating an oversized log.
- No telemetry, no uploads, no hidden background activity.

## Package layout

This plugin ships parallel manifests so each runtime picks its preferred shape:

| Path | Consumer |
| --- | --- |
| `plugin.json` + `mcp.json` | Portable Agent Plugins 1.0 (validator, mcode 0.3.x) |
| `.claude-plugin/plugin.json` | mcode 0.4.0+ (skills, MCP, inline `SessionEnd` hook) |
| `.minimax-plugin/plugin.json` + `token-meter.mcp.json` + `hooks/hooks.json` | MiniMax Code Desktop local plugin format (icons, hook document) |
| `io.minimax.mcode/hooks/hooks.json` | Portable v0.3.x hook document |
| `io.minimax.mcode/hooks/scripts/session-snapshot.mjs` | Shared hook script (same content as `scripts/session-snapshot.mjs`) |

Where a runtime ignores hooks, every other capability still works; `token_meter_snapshots` simply
reports that no snapshots exist yet.

## Limitations

- Statistics cover only what the local runtime database currently retains; older history lives in
  the hook snapshots.
- Session titles are displayed as stored by the runtime.
- The dashboard widget requires a MiniMax Code host with `mavis.widget.v1` rendering and
  `sendPrompt`; other hosts keep the complete text reports.

## License

Apache-2.0, see [LICENSE](LICENSE).
