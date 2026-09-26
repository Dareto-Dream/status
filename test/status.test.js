import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

// Runs against a real Postgres (TEST_PG_URL points at a server; we use its
// status_test database). The checked sites are stand-ins.
const skip = process.env.TEST_PG_URL ? false : 'set TEST_PG_URL to run';
if (process.env.TEST_PG_URL) {
  const admin = new pg.Client({ connectionString: process.env.TEST_PG_URL });
  await admin.connect();
  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = 'status_test'")).rowCount) await admin.query('CREATE DATABASE status_test');
  await admin.end();
  const url = new URL(process.env.TEST_PG_URL); url.pathname = '/status_test';
  process.env.DATABASE_URL = url.toString();
}
Object.assign(process.env, { NODE_ENV: 'test', STATUS_JOBS: 'off' });

let app, db, mod;
before(async () => {
  if (skip) return;
  mod = { server: await import('../src/server.js'), dbm: await import('../src/db.js'), checks: await import('../src/checks.js') };
  await mod.dbm.migrate();
  db = mod.dbm.pool;
  await db.query('TRUNCATE status_checks, status_daily RESTART IDENTITY');
  app = await mod.server.buildApp({ logger: false });
});
after(async () => { if (app) await app.close(); });
const count = async sql => Number((await db.query(sql)).rows[0].n);

test('public page, assets and json; nothing else', { skip }, async () => {
  const get = url => app.inject({ method: 'GET', url });
  const page = await get('/');
  assert.equal(page.statusCode, 200); assert.match(page.body, /DeltaVDevs status/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(page.headers['set-cookie'], undefined, 'no cookies');
  for (const url of ['/status.css', '/status-app.js', '/favicon.svg', '/health', '/robots.txt']) assert.equal((await get(url)).statusCode, 200, url);
  for (const url of ['/index.html', '/api/me', '/../src/config.js', '/%2e%2e/package.json']) assert.equal((await get(url)).statusCode, 404, url);
  assert.equal((await app.inject({ method: 'POST', url: '/status.json' })).statusCode, 404);
});

test('checks: below 500 is up, errors and timeouts are down; rollups and outages', { skip }, async () => {
  const targets = [
    { id: 'a.test', host: 'a.test', name: 'A', group: 'G', url: 'https://a.test/' },
    { id: 'b.test', host: 'b.test', name: 'B', group: 'G', url: 'https://b.test/' },
    { id: 'c.test', host: 'c.test', name: 'C', group: 'G', url: 'https://c.test/' },
    { id: 'd.test', host: 'd.test', name: 'D', group: 'G', url: 'https://d.test/' },
  ];
  const fetcher = async url => {
    if (url.includes('c.test')) throw Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } });
    if (url.includes('d.test')) throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    return new Response('', { status: url.includes('a.test') ? 404 : 502 });
  };
  await mod.checks.checkStatus({ fetcher, targets });
  await db.query("INSERT INTO status_checks (target, at, ok, status) VALUES ('a.test', now() - interval '20 days', true, 200)");
  const rows = Object.fromEntries((await db.query("SELECT target, ok, status, error FROM status_checks WHERE at > now() - interval '1 hour'")).rows.map(r => [r.target, r]));
  assert.equal(rows['a.test'].ok, true, 'a 404 at / still means the server is up');
  assert.equal(rows['b.test'].ok, false); assert.equal(rows['b.test'].status, 502);
  assert.equal(rows['c.test'].ok, false); assert.equal(rows['c.test'].error, 'domain not found');
  assert.equal(rows['d.test'].error, 'timed out after 10s');
  await mod.checks.rollupStatus();
  assert.equal(await count("SELECT count(*) AS n FROM status_checks WHERE at < now() - interval '14 days'"), 0, 'old raw checks dropped');
  assert.equal(await count("SELECT count(*) AS n FROM status_daily WHERE target = 'b.test' AND up = 0"), 1);
  const data = await mod.checks.statusData();
  assert.ok(data.outages.find(o => o.host === 'b.test')?.ongoing);
  const json = await app.inject({ method: 'GET', url: '/status.json' });
  assert.equal(json.statusCode, 200); assert.equal(json.headers['access-control-allow-origin'], '*');
  assert.ok(json.json().sites.length >= 30, 'every configured hostname is listed');
});
