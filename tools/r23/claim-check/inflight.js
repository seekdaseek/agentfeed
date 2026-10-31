// tools/r23/claim-check/inflight.js: how many claim-check calls may be in flight in this process (R23 T4, follow-up of 31 Oct 2026). A call that reads an SEC filing holds a
// multi-megabyte document while it converts it, and the box has little memory to spare, so there are two pools: calls that read an SEC filing (default 1 at once) and every other
// call (default 2 at once). A call that cannot get a slot within `waitMs` (2 s) is refused with the 503 "Not charged" before anything is fetched or spent. A slot is released by the
// function acquire() returns, exactly once, whatever the call did.
//   R23_CLAIMCHECK_MAX_INFLIGHT      every call but those reading an SEC filing (default 2)
//   R23_CLAIMCHECK_MAX_INFLIGHT_SEC  calls reading an SEC filing (default 1)
'use strict';
const { unavailable, envNum } = require('../common');

const int = (name, dflt, env) => Math.max(1, Math.floor(envNum(name, dflt, env)));
/** limits from the environment: { other, sec } */
function limitsFromEnv(env = process.env) {
  return { other: int('R23_CLAIMCHECK_MAX_INFLIGHT', 2, env), sec: int('R23_CLAIMCHECK_MAX_INFLIGHT_SEC', 1, env) };
}

function makeGate({ other = 2, sec = 1, waitMs = 2000 } = {}) {
  let activeOther = 0; let activeSec = 0; const queue = [];
  const fits = (heavy) => (heavy ? activeSec < sec : activeOther < other);
  const take = (heavy) => {
    if (heavy) activeSec++; else activeOther++;
    let done = false;
    return () => { if (done) return; done = true; if (heavy) activeSec--; else activeOther--; drain(); };
  };
  function drain() {
    for (let i = 0; i < queue.length;) {
      const w = queue[i];
      if (fits(w.heavy)) { queue.splice(i, 1); clearTimeout(w.timer); w.resolve(take(w.heavy)); } else i++;
    }
  }
  return {
    /** -> a release function; rejects with unavailable('claim-check is busy', 5) when no slot of its pool frees up within waitMs */
    acquire(heavy = false) {
      if (fits(heavy)) return Promise.resolve(take(heavy));
      return new Promise((resolve, reject) => {
        const w = { heavy, resolve, timer: null };
        w.timer = setTimeout(() => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); reject(unavailable('claim-check is busy', 5)); }, waitMs);
        queue.push(w);
      });
    },
    stats: () => ({ activeOther, activeSec, waiting: queue.length, other, sec }),
  };
}

let SHARED = null;
/** the process-wide gate, made from the environment on first use */
function sharedGate(env = process.env) { return SHARED || (SHARED = makeGate(limitsFromEnv(env))); }

module.exports = { makeGate, sharedGate, limitsFromEnv, _resetShared: () => { SHARED = null; } };
