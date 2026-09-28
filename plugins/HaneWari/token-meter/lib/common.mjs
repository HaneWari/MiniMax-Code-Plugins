// token-meter shared helpers: data-dir resolution, catalog parsing, log enrichment, metrics.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

export const PLUGIN_NAME = 'token-meter';

export const SQLITE_REQUIREMENT =
  'token-meter requires Node.js 23.4+ (24 LTS recommended) so that the built-in node:sqlite module is available without flags.';

// node:sqlite is unflagged only on Node.js >= 23.4. Load it lazily so that an
// unsupported runtime gets a clear tool error instead of a process crash.
let sqliteModule;
let sqliteError;
function loadSqlite() {
  if (sqliteModule === undefined && sqliteError === undefined) {
    try {
      sqliteModule = createRequire(import.meta.url)('node:sqlite');
    } catch (err) {
      sqliteModule = null;
      sqliteError = err;
    }
  }
  return { sqlite: sqliteModule, error: sqliteError ?? null };
}

export function sqliteAvailable() {
  return loadSqlite().sqlite !== null;
}

export function resolveDataDir(env = process.env) {
  if (env.MINIMAX_DATA_DIR && fs.existsSync(env.MINIMAX_DATA_DIR)) {
    return path.resolve(env.MINIMAX_DATA_DIR);
  }
  if (env.PLUGIN_DATA) {
    // <dataDir>/v2/plugin-data/<kind>/<name> -> dataDir is four levels up.
    const candidate = path.resolve(env.PLUGIN_DATA, '..', '..', '..', '..');
    if (fs.existsSync(path.join(candidate, 'v2'))) return candidate;
  }
  return path.join(os.homedir(), '.minimax');
}

export function dbPath(dataDir) {
  return path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
}

export function hookDataDir(dataDir) {
  return path.join(dataDir, 'v2', 'plugin-data', 'hooks', PLUGIN_NAME);
}

export function snapshotFile(dataDir) {
  return path.join(hookDataDir(dataDir), 'snapshots.jsonl');
}

// Open the runtime state database read-only.
// Returns { db, error }: exactly one of the two is non-null.
export function openDb(dataDir) {
  const { sqlite, error: sqliteErr } = loadSqlite();
  if (!sqlite) {
    return { db: null, error: `${SQLITE_REQUIREMENT} (${sqliteErr?.code || sqliteErr?.message || 'node:sqlite unavailable'})` };
  }
  const file = dbPath(dataDir);
  if (!fs.existsSync(file)) {
    return { db: null, error: `runtime state database not found at ${file} — is this a MiniMax Code data directory with recorded usage?` };
  }
  try {
    return { db: new sqlite.DatabaseSync(file, { readOnly: true }), error: null };
  } catch (err) {
    return { db: null, error: `failed to open runtime state database read-only: ${err.message}` };
  }
}

export function dayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Resolve a query window. Either explicit startDate/endDate (YYYY-MM-DD, inclusive,
// local time) or `days` = trailing N days including today.
export function resolveWindow({ days, startDate, endDate } = {}, now = Date.now()) {
  if (startDate) {
    const start = new Date(`${startDate}T00:00:00`);
    const endBase = endDate ? new Date(`${endDate}T23:59:59.999`) : new Date(start.getTime() + 86400000 - 1);
    if (Number.isNaN(start.getTime()) || Number.isNaN(endBase.getTime())) {
      throw new Error(`invalid startDate/endDate: ${startDate} ${endDate || ''}`.trim());
    }
    const startMs = start.getTime();
    const endMs = Math.min(endBase.getTime(), now);
    if (endMs < startMs) throw new Error('window end is before start');
    return { startMs, endMs, label: `${dayKey(startMs)}..${dayKey(endMs)}` };
  }
  const n = clampInt(days ?? 1, 1, 90, 1);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const startMs = todayStart.getTime() - (n - 1) * 86400000;
  return { startMs, endMs: now, label: n === 1 ? dayKey(startMs) : `${dayKey(startMs)}..${dayKey(now)}` };
}

// --- config.yaml catalog (provider/model display names) ----------------------

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// Minimal line-based YAML reader targeting only the provider sections we need.
// Returns { providers: Map<id, {name, kind}>, modelNames: Map<'providerId/modelId', name>,
//           modelToProvider: Map<modelId, providerId> }.
export function loadCatalog(dataDir) {
  const providers = new Map();
  const modelNames = new Map();
  const modelToProvider = new Map();
  const file = path.join(dataDir, 'config.yaml');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { providers, modelNames, modelToProvider };
  }
  try {
    // ctx: null | { section: 'custom'|'builtin', providerId, providerIndent, inModels, modelId, modelIndent }
    let ctx = null;
    for (const rawLine of text.split('\n')) {
      if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
      const indent = rawLine.length - rawLine.trimStart().length;
      const line = rawLine.trim();

      if (indent === 0) {
        if (line === 'custom_provider:') {
          ctx = { section: 'custom', providerId: null, providerIndent: -1, inModels: false, modelId: null };
        } else if (line === 'provider:') {
          ctx = { section: 'builtin', providerId: null, providerIndent: -1, inModels: false, modelId: null };
        } else if (!line.startsWith('-')) {
          ctx = null; // left the provider sections
        }
        continue;
      }
      if (!ctx) continue;

      // Provider entry: "  provider-c582e6:" or "  minimax:"
      if (ctx.providerId === null || indent <= ctx.providerIndent) {
        const m = line.match(/^([A-Za-z0-9._-]+):\s*$/);
        if (m && indent >= 2) {
          ctx.providerId = m[1];
          ctx.providerIndent = indent;
          ctx.inModels = false;
          ctx.modelId = null;
          if (!providers.has(ctx.providerId)) {
            providers.set(ctx.providerId, { name: ctx.providerId, kind: ctx.section });
          }
          continue;
        }
      }
      if (!ctx.providerId) continue;

      const kv = line.match(/^([A-Za-z0-9._-]+):\s*(.*)$/);
      if (!kv) continue;
      const [, key, rest] = kv;

      if (key === 'models' && rest === '') {
        ctx.inModels = true;
        ctx.modelId = null;
        ctx.modelIndent = -1;
        continue;
      }
      if (!ctx.inModels && key === 'name' && rest) {
        providers.get(ctx.providerId).name = unquote(rest);
        continue;
      }
      if (ctx.inModels) {
        if (ctx.modelId === null || indent <= ctx.modelIndent) {
          const mm = line.match(/^([A-Za-z0-9._-]+):\s*$/);
          if (mm) {
            ctx.modelId = mm[1];
            ctx.modelIndent = indent;
            modelToProvider.set(ctx.modelId, ctx.providerId);
            continue;
          }
        }
        if (ctx.modelId && key === 'name' && rest) {
          modelNames.set(`${ctx.providerId}/${ctx.modelId}`, unquote(rest));
        }
      }
    }
  } catch {
    // tolerate partial catalog
  }
  return { providers, modelNames, modelToProvider };
}

// --- runtime log enrichment (turn_id -> provider/model) ----------------------

export function loadTurnEnrichment(dataDir, windowStartMs, options = {}) {
  const maxFiles = options.maxFiles ?? 6;
  const maxBytesPerFile = options.maxBytesPerFile ?? 6 * 1024 * 1024;
  const map = new Map();
  const dir = path.join(dataDir, 'v2', 'observability', 'logs');
  let names;
  try {
    names = fs.readdirSync(dir).filter((f) => /^runtime-\d+\.log$/.test(f));
  } catch {
    return { map, filesScanned: 0 };
  }
  const files = [];
  for (const name of names) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      files.push({ p, mtime: st.mtimeMs, size: st.size });
    } catch {
      // skip unreadable
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  let filesScanned = 0;
  for (const f of files) {
    if (filesScanned >= maxFiles) break;
    if (f.mtime < windowStartMs - 15 * 60 * 1000) break; // rotated logs: nothing newer inside
    filesScanned += 1;
    let text;
    try {
      const fd = fs.openSync(f.p, 'r');
      try {
        const start = Math.max(0, f.size - maxBytesPerFile);
        const buf = Buffer.alloc(f.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const i = line.indexOf('llm_response_identifiers ');
      if (i < 0) continue;
      const j = line.indexOf('{', i);
      if (j < 0) continue;
      try {
        const obj = JSON.parse(line.slice(j));
        if (obj && obj.turn_id) {
          map.set(obj.turn_id, { provider: obj.provider ?? null, model: obj.model ?? null });
        }
      } catch {
        // partial tail line or unexpected shape
      }
    }
  }
  return { map, filesScanned };
}

// --- row identity + metrics ---------------------------------------------------

export function resolveRowIdentity(row, enrichment, catalog) {
  let model = row.model || null;
  let provider = null;
  const hit = row.turn_id ? enrichment.get(row.turn_id) : null;
  if (hit) {
    provider = hit.provider || null;
    model = model || hit.model || null;
  }
  let providerId = null;
  let custom = false;
  if (provider && provider.startsWith('custom_provider:')) {
    providerId = provider.slice('custom_provider:'.length);
    custom = true;
  } else if (provider) {
    providerId = provider;
    custom = catalog.providers.get(providerId)?.kind === 'custom';
  }
  if (!providerId && model && catalog.modelToProvider.has(model)) {
    providerId = catalog.modelToProvider.get(model);
    custom = catalog.providers.get(providerId)?.kind === 'custom';
    provider = custom ? `custom_provider:${providerId}` : providerId;
  }
  const modelKey = providerId && model ? `${providerId}/${model}` : null;
  return {
    provider: provider || 'unknown',
    providerId: providerId || 'unknown',
    model: model || '(unknown)',
    custom,
    providerName: (providerId && catalog.providers.get(providerId)?.name) || provider || 'unknown',
    modelName: (modelKey && catalog.modelNames.get(modelKey)) || model || '(unknown)',
  };
}

export function emptyMetrics() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cacheHitRate: null,
    costUsd: 0,
  };
}

export function addRow(m, r) {
  m.calls += 1;
  m.inputTokens += r.input_tokens || 0;
  m.outputTokens += r.output_tokens || 0;
  m.reasoningTokens += r.reasoning_tokens || 0;
  m.cacheReadTokens += r.cache_read_tokens || 0;
  m.cacheWriteTokens += r.cache_write_tokens || 0;
  m.costUsd += r.cost_usd || 0;
}

export function finalize(m) {
  m.totalTokens = m.inputTokens + m.outputTokens + m.reasoningTokens + m.cacheReadTokens + m.cacheWriteTokens;
  const denom = m.inputTokens + m.cacheReadTokens;
  m.cacheHitRate = denom > 0 ? Math.round((m.cacheReadTokens / denom) * 10000) / 10000 : null;
  m.costUsd = Math.round(m.costUsd * 1e6) / 1e6;
  return m;
}

export function sortGroups(groups) {
  return groups.sort((a, b) => {
    if (a.custom !== b.custom) return a.custom ? -1 : 1;
    return b.totalTokens - a.totalTokens;
  });
}
