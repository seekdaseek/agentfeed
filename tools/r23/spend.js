// tools/r23/spend.js: per-call and per-day spend caps for the R23 tools that spend OUR money (x402-test pays a target in USDC, claim-check pays a language model).
// The cap is enforced BEFORE the upstream call: reserve() either returns a reservation or throws the 503 "Not charged" refusal; settle() records what was really spent
// (never more than reserved), release() gives a reservation back when the upstream call was not made. A day is a UTC date. Reservations that were never settled or released
// (a crash between reserve and settle) keep counting for the day: the cap errs on the side of spending less.
// Storage is a small SQLite file (R23_SPEND_DB, default r23-spend.db beside the audit database; ':memory:' in tests). Memory: one open handle, no cache.
'use strict';
const path = require('path');
const Database = require('better-sqlite3');
const { unavailable, envNum } = require('./common');

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function defaultPath(env = process.env) {
  if (env.R23_SPEND_DB) return env.R23_SPEND_DB;
  const audit = env.AGENTFEED_DB;
  return audit && audit !== ':memory:' ? path.join(path.dirname(path.resolve(audit)), 'r23-spend.db') : path.resolve('r23-spend.db');
}

/**
 * @param {object} o
 * @param {string} [o.file]   SQLite path; ':memory:' for tests
 * @param {() => number} [o.now]
 * @param {Record<string,{perCall:number, perDay:number}>} o.caps  USD caps per scope, e.g. { x402test: { perCall: 0.06, perDay: 2 } }; a scope with no entry is refused
 */
function makeSpend({ file = defaultPath(), now = Date.now, caps }) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, scope TEXT NOT NULL, usd_reserved REAL NOT NULL, usd_final REAL, state TEXT NOT NULL, ts INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS spend_day_scope ON spend (day, scope);`);
  const sumDay = db.prepare(`SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN usd_final WHEN state = 'reserved' THEN usd_reserved ELSE 0 END), 0) AS usd FROM spend WHERE day = ? AND scope = ?`);
  const insert = db.prepare(`INSERT INTO spend (day, scope, usd_reserved, state, ts) VALUES (?, ?, ?, 'reserved', ?)`);
  const getRow = db.prepare(`SELECT * FROM spend WHERE id = ?`);
  const setSettled = db.prepare(`UPDATE spend SET state = 'settled', usd_final = ? WHERE id = ? AND state = 'reserved'`);
  const setReleased = db.prepare(`UPDATE spend SET state = 'released', usd_final = 0 WHERE id = ? AND state = 'reserved'`);

  const reserveTx = db.transaction((scope, usd, t) => {
    const cap = caps[scope];
    if (!cap) throw unavailable(`no spend cap is configured for ${scope}`, 3600);
    if (!(usd > 0) || !Number.isFinite(usd)) throw unavailable(`${scope} asked to spend an invalid amount`, 3600);
    if (usd > cap.perCall) throw unavailable(`${scope} would spend ${usd} USD, over its per-call cap of ${cap.perCall} USD`, 3600);
    const spent = sumDay.get(dayOf(t), scope).usd;
    if (spent + usd > cap.perDay + 1e-9) throw unavailable(`${scope} has reached its daily spend cap of ${cap.perDay} USD`, 3600);
    return insert.run(dayOf(t), scope, round6(usd), t).lastInsertRowid;
  });

  return {
    /** -> reservation id; throws the 503 "Not charged" refusal when a cap would be exceeded */
    reserve: (scope, usd) => Number(reserveTx(scope, usd, now())),
    /** record the real amount (clamped to the reservation); a second call changes nothing */
    settle(id, usd) { const r = getRow.get(id); if (!r) return; setSettled.run(round6(Math.min(Math.max(Number(usd) || 0, 0), r.usd_reserved)), id); },
    /** give a reservation back (the upstream call was not made) */
    release(id) { setReleased.run(id); },
    /** USD counted today for a scope (settled amounts plus open reservations) */
    today: (scope) => round6(sumDay.get(dayOf(now()), scope).usd),
    close: () => db.close(),
  };
}

/** caps from the environment: <PREFIX>_PER_CALL_USD and <PREFIX>_PER_DAY_USD (a missing or invalid value falls back to the default given) */
const capsFromEnv = (prefix, dflt, env = process.env) => ({ perCall: envNum(`${prefix}_PER_CALL_USD`, dflt.perCall, env), perDay: envNum(`${prefix}_PER_DAY_USD`, dflt.perDay, env) });

module.exports = { makeSpend, capsFromEnv, dayOf };
