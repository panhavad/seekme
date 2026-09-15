#!/usr/bin/env node
/**
 * SeekMe server.
 *
 * Deliberately dependency-free: it serves the built client and keeps a tiny
 * JSON-backed leaderboard. The game itself never needs this process - players
 * can go offline mid-session and sync their scores later.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './ws.mjs';
import { RoomHub } from './rooms.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? join(__dirname, '..', 'dist'));
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(__dirname, '..', 'data'));
const SCORES_FILE = join(DATA_DIR, 'scores.json');
const MAX_BODY_BYTES = 256 * 1024;
const MAX_SCORES = 20000;
const ROLES = new Set(['hider', 'seeker']);
const DIFFICULTIES = new Set(['easy', 'normal', 'hard']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------- score store
/** @type {{ scores: Array<object>, ids: Set<string> } | null} */
let store = null;
let writeQueue = Promise.resolve();

async function loadStore() {
  if (store) return store;
  await mkdir(DATA_DIR, { recursive: true });
  let scores = [];
  try {
    const raw = await readFile(SCORES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.scores)) scores = parsed.scores;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[seekme] could not read ${SCORES_FILE}: ${error.message}`);
    }
  }
  store = { scores, ids: new Set(scores.map((entry) => entry.id)) };
  return store;
}

/** Atomic write so a crash mid-save cannot corrupt the leaderboard. */
function persist() {
  writeQueue = writeQueue.then(async () => {
    const snapshot = JSON.stringify({ version: 1, scores: store.scores });
    const temp = `${SCORES_FILE}.${process.pid}.tmp`;
    await writeFile(temp, snapshot, 'utf8');
    await rename(temp, SCORES_FILE);
  }).catch((error) => {
    console.error(`[seekme] failed to persist scores: ${error.message}`);
  });
  return writeQueue;
}

function sanitizeName(value) {
  if (typeof value !== 'string') return 'Anonymous ghost';
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Anonymous ghost';
}

function validateScore(input) {
  if (!input || typeof input !== 'object') return null;
  const { id, clientId, role, difficulty, win, timeMs, seed, pondsMelted, playedAt, version } = input;

  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 64) return null;
  if (!ROLES.has(role)) return null;
  if (!DIFFICULTIES.has(difficulty)) return null;
  if (typeof win !== 'boolean') return null;
  if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 3_600_000) return null;

  return {
    id: id.slice(0, 64),
    clientId: clientId.slice(0, 64),
    name: sanitizeName(input.name),
    role,
    difficulty,
    win,
    timeMs: Math.round(timeMs),
    seed: Number.isFinite(seed) ? Math.trunc(seed) : 0,
    pondsMelted: Number.isFinite(pondsMelted) ? Math.max(0, Math.trunc(pondsMelted)) : 0,
    playedAt: Number.isFinite(playedAt) ? Math.trunc(playedAt) : Date.now(),
    receivedAt: Date.now(),
    version: typeof version === 'string' ? version.slice(0, 16) : 'unknown',
  };
}

/**
 * Seekers rank by fastest catch (wins only); hiders rank by longest survival.
 * Only a player's personal best is listed, so nobody can flood the board.
 */
function buildBoard(role, limit) {
  const best = new Map();
  for (const score of store.scores) {
    if (score.role !== role) continue;
    if (role === 'seeker' && !score.win) continue;

    const current = best.get(score.clientId);
    if (!current) {
      best.set(score.clientId, score);
      continue;
    }
    const better = role === 'seeker' ? score.timeMs < current.timeMs : score.timeMs > current.timeMs;
    if (better) best.set(score.clientId, score);
  }

  const rows = [...best.values()].sort((a, b) =>
    role === 'seeker' ? a.timeMs - b.timeMs : b.timeMs - a.timeMs
  );

  return rows.slice(0, limit).map((score) => ({
    id: score.id,
    name: score.name,
    role: score.role,
    difficulty: score.difficulty,
    timeMs: score.timeMs,
    win: score.win,
    playedAt: score.playedAt,
  }));
}

// ------------------------------------------------------------------- helpers
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectPromise);
  });
}

async function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative.endsWith('/')) relative += 'index.html';

  const target = normalize(join(PUBLIC_DIR, relative));
  if (!target.startsWith(PUBLIC_DIR + sep) && target !== PUBLIC_DIR) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  let filePath = target;
  let info = await stat(filePath).catch(() => null);

  // Single-page fallback: unknown routes load the game shell.
  if (!info || info.isDirectory()) {
    filePath = join(PUBLIC_DIR, 'index.html');
    info = await stat(filePath).catch(() => null);
    if (!info) {
      sendJson(res, 404, { ok: false, error: 'Client build not found. Run `npm run build`.' });
      return;
    }
  }

  const ext = extname(filePath).toLowerCase();
  const isHashedAsset = /\/assets\//.test(filePath.replace(/\\/g, '/'));
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  };
  if (ext === '.js' && filePath.endsWith('sw.js')) headers['service-worker-allowed'] = '/';

  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

// -------------------------------------------------------------------- routes
async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'seekme',
      scores: store.scores.length,
      rooms: hub.size,
      time: Date.now(),
    });
    return true;
  }

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const role = ROLES.has(url.searchParams.get('role')) ? url.searchParams.get('role') : 'seeker';
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 25) || 25));
    sendJson(res, 200, { ok: true, role, rows: buildBoard(role, limit) });
    return true;
  }

  if (url.pathname === '/api/scores' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
      return true;
    }

    const incoming = Array.isArray(payload?.scores)
      ? payload.scores
      : payload && typeof payload === 'object'
        ? [payload]
        : [];

    if (incoming.length === 0 || incoming.length > 200) {
      sendJson(res, 400, { ok: false, error: 'Expected 1-200 scores' });
      return true;
    }

    const accepted = [];
    const rejected = [];
    let added = 0;

    for (const raw of incoming) {
      const score = validateScore(raw);
      if (!score) {
        rejected.push(typeof raw?.id === 'string' ? raw.id : 'unknown');
        continue;
      }
      // Re-sending a score the server already has is a success, not a duplicate.
      if (!store.ids.has(score.id)) {
        store.scores.push(score);
        store.ids.add(score.id);
        added++;
      }
      accepted.push(score.id);
    }

    if (store.scores.length > MAX_SCORES) {
      const removed = store.scores.splice(0, store.scores.length - MAX_SCORES);
      for (const entry of removed) store.ids.delete(entry.id);
    }

    if (added > 0) await persist();
    sendJson(res, rejected.length > 0 && accepted.length === 0 ? 400 : 200, {
      ok: accepted.length > 0,
      accepted,
      rejected,
      stored: store.scores.length,
    });
    return true;
  }

  sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
  return true;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'no-referrer');

  const run = async () => {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' });
        return;
      }
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    await serveStatic(req, res, url.pathname);
  };

  run().catch((error) => {
    console.error('[seekme] request failed', error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal error' });
    else res.end();
  });
});

await loadStore();

// Private online matches ride on the same port over a hand-rolled WebSocket.
const hub = new RoomHub();
attachWebSocketServer(server, '/ws', (connection) => hub.attach(connection));

server.listen(PORT, HOST, () => {
  console.log(`[seekme] serving ${PUBLIC_DIR}`);
  console.log(`[seekme] data directory ${DATA_DIR}`);
  console.log(`[seekme] listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[seekme] ${signal} received, shutting down`);
    server.close(() => {
      writeQueue.finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
