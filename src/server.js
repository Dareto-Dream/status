import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { checkStatus, rollupStatus, statusData } from './checks.js';

// status.deltavdevs.com: a public page saying whether each DeltaVDevs site is
// up. No sign-in, no cookies, nothing about visitors. It runs on its own so it
// keeps working when other services (Analytics included) are down.
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8', 60],
  '/status.css': ['status.css', 'text/css; charset=utf-8', 3600],
  '/status-app.js': ['status-app.js', 'application/javascript; charset=utf-8', 3600],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml', 86400],
};

export async function buildApp(options = {}) {
  const app = Fastify({ logger: options.logger ?? { level: 'info' }, trustProxy: true });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'none'"],
      },
    },
  });

  const files = {};
  for (const [path, [file]] of Object.entries(FILES)) files[path] = await readFile(new URL(`../public/${file}`, import.meta.url));
  for (const [path, [, type, maxAge]] of Object.entries(FILES)) {
    app.get(path, async (_request, reply) => reply.type(type).header('Cache-Control', `public, max-age=${maxAge}`).send(files[path]));
  }

  // Cached briefly so a busy page can't hammer the database.
  let cached = { at: 0, body: null };
  app.get('/status.json', async (_request, reply) => {
    if (!cached.body || Date.now() - cached.at > 20_000) cached = { at: Date.now(), body: JSON.stringify(await statusData()) };
    return reply.type('application/json; charset=utf-8').header('Cache-Control', 'public, max-age=20').header('Access-Control-Allow-Origin', '*').send(cached.body);
  });
  app.get('/health', async () => ({ ok: true }));
  app.get('/robots.txt', async (_r, reply) => reply.type('text/plain').send('User-agent: *\nAllow: /\n'));
  app.setNotFoundHandler((_request, reply) => reply.code(404).type('text/plain').send('Not found'));
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    return reply.code(error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500).send({ error: 'Something broke.' });
  });
  app.addHook('onClose', async () => { await pool.end().catch(() => {}); });
  return app;
}

function every(ms, name, job, log) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await job(); } catch (err) { log.warn({ err: err.message, job: name }, `${name} failed`); } finally { running = false; }
  };
  setTimeout(tick, 5_000).unref();
  return setInterval(tick, ms);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!config.databaseUrl) throw new Error('status refuses to start: DATABASE_URL is required');
  const app = await buildApp();
  await migrate();
  const timers = config.jobs ? [every(60_000, 'checks', () => checkStatus(), app.log), every(60 * 60_000, 'rollup', () => rollupStatus(), app.log)] : [];
  await app.listen({ port: config.port, host: '0.0.0.0' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { timers.forEach(clearInterval); await app.close(); process.exit(0); });
}
