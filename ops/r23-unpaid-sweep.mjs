// ops/r23-unpaid-sweep.mjs <origin> <route> [<route> ...] [--control /api/fear-greed]   (R23, rule 4)
// For each route: 24 spellings x GET and HEAD, sent UNPAID. Pass = no spelling is served (2xx or 3xx), the four canonical spellings are a 402, and no body carries an answer
// (a JSON `data` member). --control names a FREE route: the sweep must report it as served, which proves the sweep can see a served answer. Nothing is paid.
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
const require = createRequire(import.meta.url);
const { variants, CHALLENGE_INDEXES } = require('./r23-spellings.cjs');

/** one request with the path sent AS WRITTEN (fetch would fold `..`, `./` and `#x` before sending): -> { status, body } */
function rawRequest(origin, path, method) {
  const u = new URL(origin); const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const r = lib.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), method, path, headers: { 'user-agent': 'r23-unpaid-sweep', accept: '*/*' }, timeout: 15000 }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject); r.end();
  });
}

export async function sweepRoute(origin, route, { request = rawRequest, pace = 40 } = {}) {
  const vs = variants(route);
  const out = { route, requests: 0, served: [], notChallenge: [], answers: [], statuses: {} };
  for (const [i, v] of vs.entries()) for (const method of ['GET', 'HEAD']) {
    let res;
    try { res = await request(origin, v, method); } catch (e) { out.statuses.error = (out.statuses.error || 0) + 1; continue; }
    const text = method === 'GET' ? res.text : '';
    out.requests++; out.statuses[res.status] = (out.statuses[res.status] || 0) + 1;
    if (res.status >= 200 && res.status < 400) out.served.push(`${method} ${v} -> ${res.status}`);
    if (CHALLENGE_INDEXES.includes(i) && res.status !== 402) out.notChallenge.push(`${method} ${v} -> ${res.status}`);
    if (method === 'GET' && /"data"\s*:/.test(text) && res.status !== 402) out.answers.push(`${method} ${v}`);
    if (pace) await new Promise((r) => setTimeout(r, pace));
  }
  out.ok = out.served.length === 0 && out.notChallenge.length === 0 && out.answers.length === 0 && out.requests === 48;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const ci = args.indexOf('--control'); const control = ci >= 0 ? args.splice(ci, 2)[1] : null;
  const [origin, ...routes] = args;
  if (!origin || (!routes.length && !control)) { console.error('usage: r23-unpaid-sweep.mjs <origin> <route>... [--control /api/fear-greed]'); process.exit(2); }
  let bad = 0;
  for (const r of routes) {
    const o = await sweepRoute(origin, r);
    console.log(`${o.ok ? 'PASS' : 'FAIL'}  ${r}  ${o.requests}/48 requests, statuses ${JSON.stringify(o.statuses)}`);
    for (const x of [...o.served, ...o.notChallenge, ...o.answers]) console.log('   ' + x);
    if (!o.ok) bad++;
  }
  if (control) {
    const o = await sweepRoute(origin, control);
    const seen = o.served.length > 0;
    console.log(`${seen ? 'CONTROL OK' : 'CONTROL FAILED'}  ${control} is free, so ${o.served.length} spellings are served: the sweep ${seen ? 'can' : 'CANNOT'} see a served answer`);
    if (!seen) bad++;
  }
  process.exit(bad ? 1 : 0);
}
