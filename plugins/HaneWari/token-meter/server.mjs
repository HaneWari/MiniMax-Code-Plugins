// token-meter MCP stdio server: read-only token usage queries against the local
// MiniMax Code runtime state (sqlite + observability logs). Zero dependencies.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLUGIN_NAME,
  resolveDataDir,
  openDb,
  resolveWindow,
  clampInt,
  dayKey,
  queryUsageRows,
  loadCatalog,
  loadTurnEnrichment,
  resolveRowIdentity,
  emptyMetrics,
  addRow,
  finalize,
  sortGroups,
  snapshotFile,
} from './lib/common.mjs';
import { resolveTrendWindow, buildTrendResult } from './lib/trend.mjs';

const SERVER_VERSION = '1.1.0';

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
    name: 'token_meter_live_board',
    description:
      '启动/查询/关闭本地回环实时看板：绑定 127.0.0.1 端口并返回 URL，页面在本机浏览器中实时查询用量趋势（与 token_usage_trend 同一查询引擎，分钟精度窗口选择器、自动刷新、明暗主题）。仅本机可访问，无任何远程请求；服务随 MCP 进程退出自动释放。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'status', 'stop'], description: '操作，默认 start' },
        port: { type: 'integer', minimum: 0, maximum: 65535, description: '指定端口；默认 0 = 随机空闲端口' },
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

function buildContext(args) {
  const dataDir = resolveDataDir();
  const { db, error } = openDb(dataDir);
  if (!db) {
    const err = new Error(error || `runtime state database unavailable under ${dataDir}`);
    err.code = 'NO_DB';
    throw err;
  }
  const window = resolveWindow(args);
  const rows = queryUsageRows(db, window.startMs, window.endMs);
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
// The pipeline lives in lib/trend.mjs so the local preview server reuses it.

function toolTrend(args) {
  const now = Date.now();
  const { startMs, endMs } = resolveTrendWindow(args, now);
  const result = buildTrendResult({ startMs, endMs, bucket: args?.bucket, fillEmpty: args?.fillEmpty, now });
  return { ...result, notes: NOTES };
}

// --- live board (loopback-only HTTP dashboard) --------------------------------
// The HTTP handler must never write to stdout: stdout is the JSON-RPC channel.

let liveBoard = null; // { server, url, port }

function liveBoardPagePath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'live-board-page.html');
}

function liveBoardHandler(page) {
  return (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/trend') {
        try {
          const now = Date.now();
          const { startMs, endMs } = resolveTrendWindow(
            {
              startAt: url.searchParams.get('startAt') || undefined,
              endAt: url.searchParams.get('endAt') || undefined,
              days: url.searchParams.get('days') || undefined,
            },
            now,
          );
          const result = buildTrendResult({
            startMs,
            endMs,
            bucket: url.searchParams.get('bucket') || 'auto',
            fillEmpty: url.searchParams.get('fillEmpty') !== 'false',
            now,
          });
          const body = JSON.stringify(result);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(body);
        } catch (err) {
          res.writeHead(err.code === 'NO_DB' ? 503 : 400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      if (url.pathname === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, now: Date.now() }));
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(page);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (err) {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      } catch {
        // socket already gone
      }
    }
  };
}

async function toolLiveBoard(args) {
  const action = args?.action || 'start';
  if (action === 'stop') {
    if (liveBoard) {
      await new Promise((resolve) => liveBoard.server.close(resolve));
      liveBoard = null;
    }
    return { running: false };
  }
  if (action === 'status') {
    return {
      running: liveBoard !== null,
      url: liveBoard?.url ?? null,
      hint: liveBoard ? null : '看板未运行；用 action=start 启动。',
    };
  }
  // start (idempotent)
  if (liveBoard) {
    return {
      running: true,
      alreadyRunning: true,
      url: liveBoard.url,
      note: '回环地址，仅本机浏览器可访问；页面实时读取本机用量数据。',
    };
  }
  let page;
  try {
    page = fs.readFileSync(liveBoardPagePath(), 'utf8');
  } catch (err) {
    throw new Error(`live board page missing from package: ${err.message}`);
  }
  const requestedPort = args?.port == null ? 0 : clampInt(args.port, 0, 65535, 0);
  const server = http.createServer(liveBoardHandler(page));
  server.unref?.();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  liveBoard = { server, url, port };
  return {
    running: true,
    alreadyRunning: false,
    url,
    note: '回环地址，仅本机浏览器可访问；页面实时读取本机用量数据（与 token_usage_trend 同一引擎）。宿主若有内置浏览器工具，可直接为用户打开该 URL；否则把链接交给用户。服务随 MCP 进程退出自动释放，也可 action=stop 关闭。',
  };
}

const TOOLS = {
  token_usage_summary: toolSummary,
  token_usage_daily: toolDaily,
  token_usage_sessions: toolSessions,
  token_usage_trend: toolTrend,
  token_meter_live_board: toolLiveBoard,
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
        Promise.resolve()
          .then(() => handler(params?.arguments ?? {}))
          .then(
            (result) => {
              sendResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
            },
            (err) => {
              sendResult(id, {
                content: [{ type: 'text', text: `token-meter error: ${err.message}` }],
                isError: true,
              });
            },
          );
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
