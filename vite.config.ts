import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/** Every file under public/ ends up in dist/ untouched, so precache those too. */
function listPublicAssets(root: string): string[] {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else entries.push(`/${relative(root, full).split('\\').join('/')}`);
    }
  };
  try {
    walk(root);
  } catch {
    /* no public directory - nothing to precache */
  }
  return entries;
}

/**
 * Emits a service worker that precaches every build artifact so the game is
 * fully playable offline after the first load.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'seekme-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle)
        .map((name) => `/${name}`)
        .filter((name) => !name.endsWith('.map'));
      const precache = [
        '/',
        '/index.html',
        ...listPublicAssets(resolve(process.cwd(), 'public')),
        ...assets,
      ];
      const unique = Array.from(new Set(precache));
      const version = Date.now().toString(36);

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: swSource(unique, version),
      });
    },
  };
}

function swSource(precache: string[], version: string): string {
  return `// Generated at build time - do not edit.
const CACHE = 'seekme-v${version}';
const PRECACHE = ${JSON.stringify(precache, null, 2)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Leaderboard traffic must never be served from cache.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response(JSON.stringify({ ok: false, offline: true }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('/index.html').then((fallback) => fallback ?? Response.error()));
    })
  );
});
`;
}

export default defineConfig({
  plugins: [serviceWorkerPlugin()],
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
