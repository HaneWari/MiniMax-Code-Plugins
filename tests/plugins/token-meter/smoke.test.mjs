import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  // Node.js < 23.4 without --experimental-sqlite: skip the suite.
}
const skipReason = DatabaseSync ? false : 'node:sqlite is unavailable on this Node.js runtime';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'plugins', 'HaneWari', 'token-meter');

function pad(n) {
  return String(n).padStart(2, '0');
}

function localInput(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A fully synthetic MiniMax Code data directory: sqlite usage rows, one
// observability log for provider/model enrichment, and a minimal config.yaml.
function buildFixtureDataDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'token-meter-fixture-'));
  const sqliteDir = path.join(dir, 'v2', 'sqlite');
  const logsDir = path.join(dir, 'v2', 'observability', 'logs');
  mkdirSync(sqliteDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const db = new DatabaseSync(path.join(sqliteDir, 'runtime-state.sqlite'));
  db.exec(`CREATE TABLE local_runtime_token_usage (
    id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, framework_type TEXT, turn_id TEXT,
    model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL, raw TEXT)`);
  db.exec('CREATE TABLE local_runtime_sessions (session_id TEXT, title TEXT, agent_name TEXT, workspace_dir TEXT)');

  const now = Date.now();
  const t0 = now - 60 * 60000; // anchor: one hour ago, safe for "recent window" queries
  const insert = db.prepare(`INSERT INTO local_runtime_token_usage
    (session_id, agent_name, framework_type, turn_id, model, ts, input_tokens, output_tokens,
     reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const rows = [
    ['s1', 'mavis', 'pi-agent', 't1', null, t0 + 0 * 60000, 100, 20, 0, 4000, 0, 0, '{}'],
    ['s1', 'mavis', 'pi-agent', 't1', null, t0 + 1 * 60000, 200, 40, 0, 8000, 0, 0, '{}'],
    ['s1', 'mavis', 'pi-agent', 't2', null, t0 + 30 * 60000, 300, 60, 0, 0, 0, 0, '{}'],
    ['s2', 'mavis', 'pi-agent', 't3', 'MiniMax-M3', t0 + 55 * 60000, 500, 100, 0, 10000, 0, 0, '{}'],
  ];
  for (const r of rows) insert.run(...r);
  db.prepare('INSERT INTO local_runtime_sessions (session_id, title, agent_name, workspace_dir) VALUES (?,?,?,?)').run(
    's1',
    'Fixture session',
    'mavis',
    path.join(os.tmpdir(), 'ws'),
  );
  db.close();

  const logLines = [
    `[10:00:01.000] INFO: [proto.js:1] llm_response_identifiers {"session_id":"s1","turn_id":"t1","provider":"custom_provider:provider-a","model":"k3","response_status":200}`,
    `[10:30:01.000] INFO: [proto.js:1] llm_response_identifiers {"session_id":"s1","turn_id":"t2","provider":"custom_provider:provider-a","model":"k3","response_status":200}`,
    `[11:00:01.000] INFO: [proto.js:1] llm_response_identifiers {"session_id":"s2","turn_id":"t3","provider":"minimax","model":"MiniMax-M3","response_status":200}`,
  ].join('\n');
  const d = new Date(t0);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}`;
  writeFileSync(path.join(logsDir, `runtime-${stamp}.log`), `${logLines}\n`);

  writeFileSync(
    path.join(dir, 'config.yaml'),
    ['provider:', '  minimax:', '    name: MiniMax', 'custom_provider:', '  provider-a:', '    name: Kimi For Coding', '    models:', '      k3:', '        name: K3', ''].join('\n'),
  );
  return { dir, t0, now };
}

function startServer(env) {
  const proc = spawn(process.execPath, [path.join(pluginRoot, 'server.mjs')], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const pending = new Map();
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { proc, call };
}

async function withServer(env, fn) {
  const { proc, call } = startServer(env);
  try {
    const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'token-meter');
    await fn(call);
  } finally {
    proc.kill();
  }
}

function toolJson(msg) {
  assert.notEqual(msg.result.isError, true, msg.result.content?.[0]?.text || 'tool error');
  return JSON.parse(msg.result.content[0].text);
}

test('tools/list exposes five read-only usage tools', { skip: skipReason }, async () => {
  const { dir } = buildFixtureDataDir();
  try {
    await withServer({ MINIMAX_DATA_DIR: dir }, async (call) => {
      const list = await call('tools/list', {});
      const names = list.result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        'token_meter_snapshots',
        'token_usage_daily',
        'token_usage_sessions',
        'token_usage_summary',
        'token_usage_trend',
      ]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary groups custom providers first and computes cache hit rate', { skip: skipReason }, async () => {
  const { dir, t0, now } = buildFixtureDataDir();
  try {
    await withServer({ MINIMAX_DATA_DIR: dir }, async (call) => {
      const msg = await call('tools/call', {
        name: 'token_usage_summary',
        arguments: { startDate: dayKey(t0), endDate: dayKey(now) },
      });
      const r = toolJson(msg);
      assert.equal(r.total.calls, 4);
      assert.equal(r.byModel.length, 2);
      const [first, second] = r.byModel;
      assert.equal(first.custom, true);
      assert.equal(first.model, 'k3');
      assert.equal(first.providerName, 'Kimi For Coding');
      assert.equal(first.calls, 3);
      assert.equal(first.totalTokens, 600 + 120 + 12000);
      assert.equal(first.cacheHitRate, 0.9524); // 12000 / (12000 + 600)
      assert.equal(second.custom, false);
      assert.equal(second.model, 'MiniMax-M3');
      assert.equal(r.unknownRows, 0); // all rows enriched from the fixture log
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trend fills empty minute buckets with zero rows and null hit rate', { skip: skipReason }, async () => {
  const { dir, t0 } = buildFixtureDataDir();
  try {
    await withServer({ MINIMAX_DATA_DIR: dir }, async (call) => {
      const msg = await call('tools/call', {
        name: 'token_usage_trend',
        arguments: { startAt: localInput(t0), endAt: localInput(t0 + 10 * 60000), bucket: 'minute' },
      });
      const r = toolJson(msg);
      assert.equal(r.window.bucket, 'minute');
      assert.equal(r.window.bucketCount, 11);
      assert.deepEqual(r.series.calls, [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      assert.equal(r.series.cacheHitRate[0], 0.9756); // 4000 / 4100
      assert.equal(r.series.cacheHitRate[1], 0.9756); // 8000 / 8200
      assert.equal(r.series.cacheHitRate[2], null);
      const k3Key = r.models[0].key;
      assert.deepEqual(r.series.tokensByModel[k3Key].slice(0, 3), [4120, 8240, 0]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionEnd hook archives one snapshot line for the ended session', { skip: skipReason }, async () => {
  const { dir } = buildFixtureDataDir();
  const pluginData = mkdtempSync(path.join(os.tmpdir(), 'token-meter-hook-data-'));
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [path.join(pluginRoot, 'io.minimax.mcode', 'hooks', 'scripts', 'session-snapshot.mjs')], {
        env: { ...process.env, MINIMAX_DATA_DIR: dir, PLUGIN_DATA: pluginData, PLUGIN_ROOT: pluginRoot },
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      proc.stderr.on('data', (chunk) => reject(new Error(`hook wrote stderr: ${chunk}`)));
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))));
      proc.stdin.end(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' }));
    });
    const file = path.join(pluginData, 'snapshots.jsonl');
    assert.ok(existsSync(file), 'snapshots.jsonl should exist');
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const snap = JSON.parse(lines[0]);
    assert.equal(snap.sessionId, 's1');
    assert.equal(snap.calls, 3);
    assert.equal(snap.totalTokens, 600 + 120 + 12000);
    assert.equal(snap.byModel[0].model, 'k3');
    assert.equal(snap.byModel[0].custom, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(pluginData, { recursive: true, force: true });
  }
});

test('snapshots tool reports the empty state before any archived snapshot', { skip: skipReason }, async () => {
  const { dir } = buildFixtureDataDir();
  try {
    await withServer({ MINIMAX_DATA_DIR: dir }, async (call) => {
      const msg = await call('tools/call', { name: 'token_meter_snapshots', arguments: {} });
      const r = toolJson(msg);
      assert.deepEqual(r.snapshots, []);
      assert.ok(r.hint.length > 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
