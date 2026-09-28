// token-meter trend pipeline: window parsing, bucket picking, and bucketed
// per-model usage series. Shared by the MCP server (stdio tool) and any local
// preview tooling, so both produce identical numbers.
import {
  resolveDataDir,
  openDb,
  clampInt,
  queryUsageRows,
  loadCatalog,
  loadTurnEnrichment,
  resolveRowIdentity,
  emptyMetrics,
  addRow,
  finalize,
} from './common.mjs';

export function parseLocalDateTime(value) {
  const m = String(value || '')
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function resolveTrendWindow(args, now = Date.now()) {
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

export function pickBucket(startMs, endMs, requested) {
  const spanMin = (endMs - startMs) / 60000;
  let bucket = requested && requested !== 'auto' ? requested : spanMin <= 360 ? 'minute' : spanMin <= 7 * 24 * 60 ? 'hour' : 'day';
  // keep bucket count manageable
  const spanMs = Math.max(endMs - startMs, 1);
  const approx = (b) => Math.ceil(spanMs / (b === 'minute' ? 60000 : b === 'hour' ? 3600000 : 86400000));
  if (approx(bucket) > 600) bucket = bucket === 'minute' ? 'hour' : 'day';
  return bucket;
}

export function bucketFloor(ts, bucket) {
  const d = new Date(ts);
  if (bucket === 'minute') d.setSeconds(0, 0);
  else if (bucket === 'hour') d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function bucketLabel(ms, bucket, multiDay) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  if (bucket === 'day') return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  if (multiDay) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MAX_TREND_MODELS = 5;

// Full trend query: window resolution is the caller's job; this function opens
// the database, aggregates, and returns the serializable result.
export function buildTrendResult({ dataDir, startMs, endMs, bucket: requestedBucket, fillEmpty: fillArg, now = Date.now() }) {
  const bucket = pickBucket(startMs, endMs, requestedBucket);
  const dir = dataDir || resolveDataDir();
  const { db, error } = openDb(dir);
  if (!db) {
    const err = new Error(error || `runtime state database unavailable under ${dir}`);
    err.code = 'NO_DB';
    throw err;
  }
  const rows = queryUsageRows(db, startMs, endMs);
  const catalog = loadCatalog(dir);
  const { map: enrichment, filesScanned } = loadTurnEnrichment(dir, startMs);

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

  const fillEmpty = fillArg !== false;
  let starts;
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
    starts = [...buckets.keys()].sort((a, b) => a - b);
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
    meta: {
      dataDir: dir,
      rows: rows.length,
      logFilesScanned: filesScanned,
      turnsEnriched: enrichment.size,
      generatedAt: new Date(now).toISOString(),
    },
  };
}
