// token-meter MCP stdio server: read-only token usage queries against the local
// MiniMax Code runtime state (sqlite + observability logs). Zero dependencies.
import fs from 'node:fs';
import {
  PLUGIN_NAME,
  resolveDataDir,
  openDb,
  resolveWindow,
  clampInt,
  dayKey,
  loadCatalog,
  loadTurnEnrichment,
  resolveRowIdentity,
  emptyMetrics,
  addRow,
  finalize,
  sortGroups,
  snapshotFile,
} from './lib/common.mjs';

const SERVER_VERSION = '1.0.0';

const TOOL_DEFS = [
  {
    name: 'token_usage_summary',
    description:
      '汇总指定时间窗口内 MiniMax Code 各模型的 token 消耗与缓存命中率，按 提供商/模型 分组（自定义接入模型排在前面）。窗口默认今天，可用 days 或 startDate/endDate 指定。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, description: '统计最近 N 天（含今天），默认 1' },
        startDate: { type: 'string', description: '起始日期 YYYY-MM-DD（本地时区，含当天），提供后忽略 days' },
        endDate: { type: 'string', description: '结束日期 YYYY-MM-DD（含当天），默认与 startDate 相同' },
      },
    },
  },
  {
    name: 'token_usage_daily',
    description: '按天 × 模型 列出 token 用量与缓存命中率，用于观察最近一段时间的每日趋势。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, description: '统计最近 N 天（含今天），默认 7' },
      },
    },
  },
  {
    name: 'token_usage_sessions',
    description: '按会话列出 token 消耗明细（含会话标题与主要模型），默认展示最近 30 天内最活跃的 10 个会话。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 90, description: '统计最近 N 天（含今天），默认 30' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回会话数量上限，默认 10' },
      },
    },
  },
  {
    name: 'token_usage_trend',
    description:
      '按时间桶（分钟/小时/天）返回各模型的 token 用量与缓存命中率序列，用于绘制用量趋势看板。支持分钟精度的自定义窗口（startAt/endAt，本地时间 YYYY-MM-DDTHH:MM），未指定时回退到 days。',
    inputSchema: {
      type: 'object',
      properties: {
        startAt: { type: 'string', description: '窗口起点，本地时间 "YYYY-MM-DDTHH:MM"（分钟精度），提供后忽略 days' },
        endAt: { type: 'string', description: '窗口终点，同格式；缺省为当前时间' },
        days: { type: 'integer', minimum: 1, maximum: 90, description: '统计最近 N 天（含今天），默认 7；仅在没有 startAt 时生效' },
        bucket: { type: 'string', enum: ['auto', 'minute', 'hour', 'day'], description: '时间桶粒度，默认 auto（≤6小时→分钟，≤7天→小时，否则→天）' },
        fillEmpty: { type: 'boolean', description: '是否用零值桶补齐时间轴上的空桶（命中率记 null），默认 true' },
      },
    },
  },
  {
    name: 'token_meter_snapshots',
    description:
      '读取 token-meter 快照 Hook 归档的历史会话用量（snapshots.jsonl），用于 runtime 数据库清理后的长期回顾。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '返回最近 N 条快照，默认 20' },
      },
    },
  },
];

const NOTES = [
  'cacheHitRate = cacheReadTokens / (cacheReadTokens + inputTokens)，表示提示词中命中缓存的比例；cacheWriteTokens 不计入分母。',
  'totalTokens = input + output + reasoning + cacheRead + cacheWrite。',
  'costUsd 为 runtime 记录值；自定义套餐/订阅类提供商通常为 0，不代表实际账单。',
  'model 字段缺失的记录已通过 runtime 日志 llm_response_identifiers 按 turn 补全；仍为 unknown 的记录表示两种来源都未覆盖。',
  '统计范围限于本机 runtime 数据库当前保留的数据；更早的历史见 token_meter_snapshots。',
];

function queryRows(db, startMs, endMs) {
  return db
    .prepare(
      `SELECT session_id, agent_name, turn_id, model, ts,
              input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_write_tokens, cost_usd
         FROM local_runtime_token_usage
        WHERE ts >= ? AND ts <= ?
        ORDER BY ts`,
    )
    .all(startMs, endMs);
}

function buildContext(args) {
  const dataDir = resolveDataDir();
  const { db, error } = openDb(dataDir);
  if (!db) {
    const err = new Error(error || `runtime state database unavailable under ${dataDir}`);
    err.code = 'NO_DB';
    throw err;
  }
  const window = resolveWindow(args);
  const rows = queryRows(db, window.startMs, window.endMs);
  const catalog = loadCatalog(dataDir);
  const { map: enrichment, filesScanned } = loadTurnEnrichment(dataDir, window.startMs);
  const meta = {
    dataDir,
    window: {
      label: window.label,
      start: new Date(window.startMs).toISOString(),
      end: new Date(window.endMs).toISOString(),
    },
    rows: rows.length,
    logFilesScanned: filesScanned,
    turnsEnriched: enrichment.size,
    generatedAt: new Date().toISOString(),
  };
  return { dataDir, db, window, rows, catalog, enrichment, meta };
}

function groupByModel(ctx) {
  const groups = new Map();
  const total = emptyMetrics();
  let unknownRows = 0;
  for (const row of ctx.rows) {
    const id = resolveRowIdentity(row, ctx.enrichment, ctx.catalog);
    if (id.model === '(unknown)') unknownRows += 1;
    const key = `${id.provider}|${id.model}`;
    if (!groups.has(key)) {
      groups.set(key, {
        provider: id.provider,
        providerName: id.providerName,
        model: id.model,
        modelName: id.modelName,
        custom: id.custom,
        metrics: emptyMetrics(),
      });
    }
    const g = groups.get(key);
    addRow(g.metrics, row);
    addRow(total, row);
  }
  const byModel = sortGroups(
    [...groups.values()].map((g) => ({ ...g, metrics: finalize(g.metrics) })),
  );
  return { byModel, total: finalize(total), unknownRows };
}

function toolSummary(args) {
  const ctx = buildContext(args);
  const { byModel, total, unknownRows } = groupByModel(ctx);
  ctx.db.close();
  return {
    window: ctx.meta.window,
    total,
    byModel: byModel.map((g) => ({ ...g, ...g.metrics, metrics: undefined })),
    unknownRows,
    notes: NOTES,
    meta: ctx.meta,
  };
}

function toolDaily(args) {
  const days = clampInt(args?.days, 1, 90, 7);
  const ctx = buildContext({ days });
  const byDay = new Map();
  for (const row of ctx.rows) {
    const id = resolveRowIdentity(row, ctx.enrichment, ctx.catalog);
    const key = dayKey(row.ts);
    if (!byDay.has(key)) byDay.set(key, { total: emptyMetrics(), groups: new Map() });
    const day = byDay.get(key);
    addRow(day.total, row);
    const gk = `${id.provider}|${id.model}`;
    if (!day.groups.has(gk)) {
      day.groups.set(gk, {
        provider: id.provider,
        providerName: id.providerName,
        model: id.model,
        modelName: id.modelName,
        custom: id.custom,
        metrics: emptyMetrics(),
      });
    }
    addRow(day.groups.get(gk).metrics, row);
  }
  ctx.db.close();
  const days_out = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, v]) => ({
      day,
      total: finalize(v.total),
      byModel: sortGroups([...v.groups.values()].map((g) => ({ ...g, ...finalize(g.metrics), metrics: undefined }))),
    }));
  return { window: ctx.meta.window, days: days_out, notes: NOTES, meta: ctx.meta };
}

function toolSessions(args) {
  const days = clampInt(args?.days, 1, 90, 30);
  const limit = clampInt(args?.limit, 1, 50, 10);
  const ctx = buildContext({ days });
  const bySession = new Map();
  for (const row of ctx.rows) {
    if (!bySession.has(row.session_id)) {
      bySession.set(row.session_id, { total: emptyMetrics(), firstTs: row.ts, lastTs: row.ts, groups: new Map(), agentName: row.agent_name || null });
    }
    const s = bySession.get(row.session_id);
    s.firstTs = Math.min(s.firstTs, row.ts);
    s.lastTs = Math.max(s.lastTs, row.ts);
    addRow(s.total, row);
    const id = resolveRowIdentity(row, ctx.enrichment, ctx.catalog);
    const gk = `${id.provider}|${id.model}`;
    if (!s.groups.has(gk)) {
      s.groups.set(gk, { provider: id.provider, providerName: id.providerName, model: id.model, modelName: id.modelName, custom: id.custom, metrics: emptyMetrics() });
    }
    addRow(s.groups.get(gk).metrics, row);
  }
  // session titles
  const titleStmt = ctx.db.prepare('SELECT session_id, title, agent_name, workspace_dir FROM local_runtime_sessions');
  const titles = new Map();
  try {
    for (const r of titleStmt.all()) titles.set(r.session_id, r);
  } catch {
    // titles optional
  }
  ctx.db.close();
  const sessions = [...bySession.entries()]
    .map(([sessionId, s]) => {
      const info = titles.get(sessionId);
      const models = sortGroups([...s.groups.values()].map((g) => ({ ...g, ...finalize(g.metrics), metrics: undefined })));
      return {
        sessionId,
        title: info?.title || null,
        agentName: s.agentName || info?.agent_name || null,
        workspaceDir: info?.workspace_dir || null,
        firstActivity: new Date(s.firstTs).toISOString(),
        lastActivity: new Date(s.lastTs).toISOString(),
        ...finalize(s.total),
        byModel: models,
      };
    })
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))
    .slice(0, limit);
  return { window: ctx.meta.window, sessions, notes: NOTES, meta: ctx.meta };
}

function toolSnapshots(args) {
  const limit = clampInt(args?.limit, 1, 100, 20);
  const dataDir = resolveDataDir();
  const file = snapshotFile(dataDir);
  if (!fs.existsSync(file)) {
    return {
      snapshots: [],
      file,
      hint: '还没有快照。快照由 token-meter 的 SessionEnd Hook 在每次会话结束时写入；本会话结束后将出现第一条。',
    };
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const tail = lines.slice(-limit);
  const snapshots = [];
  for (const line of tail) {
    try {
      snapshots.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return { snapshots, totalArchived: lines.length, file };
}

// --- trend (minute/hour/day buckets) ------------------------------------------

function parseLocalDateTime(value) {
  const m = String(value || '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function resolveTrendWindow(args, now = Date.now()) {
  if (args?.startAt) {
    const startMs = parseLocalDateTime(args.startAt);
    const endRaw = args.endAt ? parseLocalDateTime(args.endAt) : now;
    if (startMs == null || endRaw == null) {
      throw new Error('invalid startAt/endAt; expect local "YYYY-MM-DDTHH:MM"');
    }
    const endMs = Math.min(endRaw, now);
    if (endMs <= startMs) throw new Error('endAt must be after startAt');
    return { startMs, endMs };
  }
  const days = clampInt(args?.days, 1, 90, 7);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return { startMs: todayStart.getTime() - (days - 1) * 86400000, endMs: now };
}

function pickBucket(startMs, endMs, requested) {
  const spanMin = (endMs - startMs) / 60000;
  let bucket = requested && requested !== 'auto' ? requested : spanMin <= 360 ? 'minute' : spanMin <= 7 * 24 * 60 ? 'hour' : 'day';
  // keep bucket count manageable
  const spanMs = Math.max(endMs - startMs, 1);
  const approx = (b) => Math.ceil(spanMs / (b === 'minute' ? 60000 : b === 'hour' ? 3600000 : 86400000));
  if (approx(bucket) > 600) bucket = bucket === 'minute' ? 'hour' : 'day';
  return bucket;
}

function bucketFloor(ts, bucket) {
  const d = new Date(ts);
  if (bucket === 'minute') d.setSeconds(0, 0);
  else if (bucket === 'hour') d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketLabel(ms, bucket, multiDay) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  if (bucket === 'day') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (multiDay) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MAX_TREND_MODELS = 5;

function toolTrend(args) {
  const now = Date.now();
  const { startMs, endMs } = resolveTrendWindow(args, now);
  const bucket = pickBucket(startMs, endMs, args?.bucket);
  const dataDir = resolveDataDir();
  const { db, error } = openDb(dataDir);
  if (!db) {
    const err = new Error(error || `runtime state database unavailable under ${dataDir}`);
    err.code = 'NO_DB';
    throw err;
  }
  const rows = queryRows(db, startMs, endMs);
  const catalog = loadCatalog(dataDir);
  const { map: enrichment, filesScanned } = loadTurnEnrichment(dataDir, startMs);

  // resolve identities and rank models by total tokens
  const resolved = rows.map((row) => ({ row, id: resolveRowIdentity(row, enrichment, catalog) }));
  const byModelTotals = new Map();
  let unknownRows = 0;
  for (const { row, id } of resolved) {
    if (id.model === '(unknown)') unknownRows += 1;
    const key = `${id.provider}|${id.model}`;
    if (!byModelTotals.has(key)) byModelTotals.set(key, { id, tokens: 0 });
    byModelTotals.get(key).tokens +=
      (row.input_tokens || 0) + (row.output_tokens || 0) + (row.reasoning_tokens || 0) + (row.cache_read_tokens || 0) + (row.cache_write_tokens || 0);
  }
  const ranked = [...byModelTotals.entries()].sort((a, b) => {
    if (a[1].id.custom !== b[1].id.custom) return a[1].id.custom ? -1 : 1;
    return b[1].tokens - a[1].tokens;
  });
  const topKeys = ranked.slice(0, MAX_TREND_MODELS).map(([k]) => k);
  const modelList = ranked.slice(0, MAX_TREND_MODELS).map(([key, v]) => ({
    key,
    model: v.id.model,
    modelName: v.id.modelName,
    providerName: v.id.providerName,
    custom: v.id.custom,
    totalTokens: v.tokens,
  }));
  const hasOther = ranked.length > MAX_TREND_MODELS;
  if (hasOther) {
    modelList.push({
      key: '__other__',
      model: '(other)',
      modelName: '其他模型',
      providerName: '',
      custom: false,
      totalTokens: ranked.slice(MAX_TREND_MODELS).reduce((s, [, v]) => s + v.tokens, 0),
    });
  }

  // bucket aggregation
  const multiDay = endMs - startMs > 24 * 3600000;
  const buckets = new Map();
  const kpi = emptyMetrics();
  const seriesKeys = hasOther ? [...topKeys, '__other__'] : topKeys;
  for (const { row, id } of resolved) {
    addRow(kpi, row);
    const bStart = bucketFloor(row.ts, bucket);
    if (!buckets.has(bStart)) {
      buckets.set(bStart, { totals: emptyMetrics(), perModel: new Map() });
    }
    const b = buckets.get(bStart);
    addRow(b.totals, row);
    const modelKey = `${id.provider}|${id.model}`;
    const key = topKeys.includes(modelKey) ? modelKey : '__other__';
    const rowTotal =
      (row.input_tokens || 0) + (row.output_tokens || 0) + (row.reasoning_tokens || 0) + (row.cache_read_tokens || 0) + (row.cache_write_tokens || 0);
    b.perModel.set(key, (b.perModel.get(key) || 0) + rowTotal);
  }
  db.close();

  const dataStarts = new Set(buckets.keys());
  let starts;
  const fillEmpty = args?.fillEmpty !== false;
  if (fillEmpty) {
    const stepMs = bucket === 'minute' ? 60000 : bucket === 'hour' ? 3600000 : 86400000;
    starts = [];
    // Day buckets align to local midnight; stepping from the floored start keeps
    // minute/hour buckets aligned to wall-clock boundaries as well.
    for (let ms = bucketFloor(startMs, bucket), end = bucketFloor(endMs, bucket); ms <= end; ms += stepMs) {
      starts.push(ms);
      if (starts.length > 1000) break; // safety, pickBucket already caps at ~600
    }
  } else {
    starts = [...dataStarts].sort((a, b) => a - b);
  }
  const labels = starts.map((ms) => bucketLabel(ms, bucket, multiDay));
  const tokensByModel = {};
  for (const key of seriesKeys) tokensByModel[key] = [];
  const cacheHitRate = [];
  const calls = [];
  const totalTokens = [];
  for (const ms of starts) {
    const b = buckets.get(ms);
    if (b) finalize(b.totals);
    for (const key of seriesKeys) tokensByModel[key].push(b?.perModel.get(key) || 0);
    cacheHitRate.push(b ? b.totals.cacheHitRate : null);
    calls.push(b ? b.totals.calls : 0);
    totalTokens.push(b ? b.totals.totalTokens : 0);
  }
  finalize(kpi);

  return {
    window: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      bucket,
      bucketCount: starts.length,
      fillEmpty,
    },
    kpis: { ...kpi, activeModels: ranked.length },
    models: modelList,
    series: { labels, bucketStarts: starts, tokensByModel, cacheHitRate, calls, totalTokens },
    unknownRows,
    notes: NOTES,
    meta: {
      dataDir,
      rows: rows.length,
      logFilesScanned: filesScanned,
      turnsEnriched: enrichment.size,
      generatedAt: new Date(now).toISOString(),
    },
  };
}

const TOOLS = {
  token_usage_summary: toolSummary,
  token_usage_daily: toolDaily,
  token_usage_sessions: toolSessions,
  token_usage_trend: toolTrend,
  token_meter_snapshots: toolSnapshots,
};

// --- minimal MCP stdio (newline-delimited JSON-RPC) --------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        sendResult(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: PLUGIN_NAME, version: SERVER_VERSION },
          instructions:
            '查询 MiniMax Code 本机各模型（含自定义接入模型）的 token 消耗明细与缓存命中率。数据来自本机 runtime sqlite 与观测日志，只读。',
        });
        return;
      case 'ping':
        sendResult(id, {});
        return;
      case 'tools/list':
        sendResult(id, { tools: TOOL_DEFS });
        return;
      case 'tools/call': {
        const name = params?.name;
        const handler = TOOLS[name];
        if (!handler) {
          sendError(id, -32602, `unknown tool: ${name}`);
          return;
        }
        try {
          const result = handler(params?.arguments ?? {});
          sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        } catch (err) {
          sendResult(id, {
            content: [{ type: 'text', text: `token-meter error: ${err.message}` }],
            isError: true,
          });
        }
        return;
      }
      default:
        sendError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, err.message || 'internal error');
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).replace(/^[﻿\s]+/, '').replace(/\s+$/, '');
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      sendError(null, -32700, 'parse error');
      continue;
    }
    if (msg && msg.id !== undefined && msg.method) {
      handleRequest(msg);
    }
    // notifications (no id) are ignored
  }
});
process.stdin.on('end', () => process.exit(0));
