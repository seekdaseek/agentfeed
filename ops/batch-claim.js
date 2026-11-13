#!/usr/bin/env node
// ops/batch-claim.js — claim and settle batch-settlement vouchers (R5 A1; settle step and minimums R8).
//
// The server verifies each voucher off-chain and records what it charged (agentfeed.db
// batch_channels, lib/batch-storage.js). This job redeems that charged total on-chain, per network,
// through the CDP facilitator, in two steps:
//   1. claim   every channel's latest voucher in one transaction: channel balance -> the receiver's
//              claimed-but-unsettled bucket. The receiverAuthorizer key signs the claim authorization;
//              it holds no funds.
//   2. settle  that bucket -> the receiver (PAY_TO_EVM). The bucket is read from the chain
//              (BATCH_SETTLEMENT_ADDRESS.receivers), not from the local store, so a settle the
//              facilitator refused is retried on the next run instead of being forgotten once the
//              claim had landed (the local store marks a voucher claimed as soon as step 1 succeeds).
//
// cron (root), every 30 min, under flock with a deadline, no PM2 process:
//   */30 * * * * cd /opt/agentfeed && /usr/bin/flock -n /var/lock/batch-claim.lock /usr/bin/timeout 600 /usr/bin/node ops/batch-claim.js >> /opt/agentfeed/batch-claim.log 2>&1
// withdrawDelay is 86400 s (lib/hf.js), so a payer's timed withdrawal cannot finalize before
// 48 claim runs have passed.
//
// amount_too_low is the facilitator saying a step is below the minimum it will process; CDP's error
// table gives the sentence but not the number. It is not a failure: nothing is lost (a claimed
// bucket is the receiver's; unclaimed vouchers stay valid until a withdrawal finalizes), so the run
// logs kind "below_minimum" and goes on. The only live case so far (13 Oct 2026, Base, 5 vouchers =
// 0.0025 USDC) was a race, not a size: the settle went out 0.15 s before the claim's block, and the
// same 0.0025 settled 20 minutes later (tx 0x7450...5fd6), so no size minimum has been observed.
// The largest amount each step has refused is kept per network in batch-claim-state.json
// (`networks`, lib/batch-claim-core.js), which is what the watchdog reads: value above everything
// refused so far that is still sitting there after 6 h is a real problem.
//
// Every claim, settle and refusal is appended to batch-claims.jsonl. Two failed runs in a row send
// one Telegram alert (liqbot bot, TG_ALERT_CHAT; values never printed). A refusal is not a failure.
//   --dry   list per network what is unclaimed and claimed-but-unsettled; send nothing, write nothing
'use strict';
const fs = require('fs');
const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch { /* env from the shell */ }
const Database = require('better-sqlite3');
const { HTTPFacilitatorClient } = require('@x402/core/server');
const { BATCH_SETTLEMENT_ADDRESS } = require('@x402/evm');
const { createPublicClient, http, parseAbi } = require('viem');
const viemChains = require('viem/chains');
const { hfConfig, batchSchemes, NAMES } = require('../lib/hf');
const { isBelowMinimum, isNothingToSettle, nextNetworkState } = require('../lib/batch-claim-core');

const DRY = process.argv.includes('--dry');
const ROOT = path.join(__dirname, '..');
const LOG = process.env.BATCH_CLAIM_LOG || path.join(ROOT, 'batch-claims.jsonl');
const STATE = process.env.BATCH_CLAIM_STATE || path.join(ROOT, 'batch-claim-state.json');
const ENV_TG = process.env.BATCH_CLAIM_ENV_TG || '/opt/liqbot/.env';
// the waits after a claim: how often the chain is polled for the claimed value, and the pause before a settle retry
const POLL_MS = Number(process.env.BATCH_CLAIM_POLL_MS) || 3000;
const RETRY_MS = Number(process.env.BATCH_CLAIM_RETRY_MS) || 5000;
const now = () => new Date().toISOString();
const usd = (atomic) => Number(atomic) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHAIN = { 'eip155:8453': 'base', 'eip155:137': 'polygon', 'eip155:42161': 'arbitrum' };
const RECEIVERS_ABI = parseAbi(['function receivers(address receiver, address token) view returns (uint128 totalClaimed, uint128 totalSettled)']);
const WITHDRAWALS_ABI = parseAbi(['function pendingWithdrawals(bytes32 channelId) view returns (uint128 amount, uint40 initiatedAt)']);
const MAX_WITHDRAWAL_CHECKS = 50; // per network per run: only channels still holding unclaimed value are looked at
const FALLBACK_MAX = 20;          // channels claimed one by one after a refused batch, per network per run
const REPROBE_MS = Number(process.env.BATCH_CLAIM_REPROBE_MS) || 6 * 3600e3;

async function telegram(text) {
  try {
    const env = Object.fromEntries(fs.readFileSync(ENV_TG, 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
    if (!env.TG_BOT_TOKEN || !env.TG_ALERT_CHAT) return false;
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TG_ALERT_CHAT, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(20000) });
    return (await r.json().catch(() => ({}))).ok === true;
  } catch { return false; }
}

function chainClient(network) {
  const chain = viemChains[CHAIN[network]];
  return createPublicClient({ chain, transport: http(process.env[`BATCH_RPC_${chain.id}`] || undefined, { timeout: 15000, retryCount: 1 }) });
}

/** Claimed-but-unsettled atomic USDC for the receiver on one network, read from the contract; null when the read failed. */
async function readUnsettled(network, receiver, token) {
  try {
    if (!receiver || !token) return null;
    const [claimed, settled] = await chainClient(network).readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi: RECEIVERS_ABI, functionName: 'receivers', args: [receiver, token] });
    return BigInt(claimed) - BigInt(settled);
  } catch { return null; }
}

/** A payer's timed withdrawal on one channel ({ amount, initiatedAt (epoch s, 0 = none) }); null when the read failed. The local
 *  channel record only learns of a withdrawal when the payer calls again, so the chain is asked. */
async function readWithdrawal(network, channelId) {
  try {
    const [amount, initiatedAt] = await chainClient(network).readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi: WITHDRAWALS_ABI, functionName: 'pendingWithdrawals', args: [channelId] });
    return { amount: BigInt(amount), initiatedAt: Number(initiatedAt) };
  } catch { return null; }
}

(async () => {
  const cfg = hfConfig();
  if (!cfg.batch) { console.log(`${now()} batch-claim: batch-settlement is off (no authorizer key or X402_HF=off)`); return; }
  const db = new Database(process.env.AGENTFEED_DB || path.join(ROOT, 'agentfeed.db'));
  const facilitator = new HTTPFacilitatorClient(require('../lib/cdp-facilitator').facilitator);
  const state = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { failures: 0 }; } })();
  state.networks = state.networks || {};
  let failed = 0;
  for (const { network, scheme } of batchSchemes(cfg.batch, db)) {
    const name = NAMES[network] || network;
    const prev = state.networks[network] || {};
    const obs = { unclaimed: 0n, unsettled: null, claimRefused: null, claimBatchRefused: null, claimAccepted: null, settleRefused: null, settledOk: null, atRisk: [] };
    const log = (rec) => fs.appendFileSync(LOG, JSON.stringify({ at: now(), network, ...rec }) + '\n');
    const refusal = (step, e, extra) => log({ kind: 'below_minimum', step, ...extra, ...(e.statusCode ? { status: e.statusCode } : {}), ...(e.errorMessage ? { detail: String(e.errorMessage).slice(0, 200) } : {}) });
    const unclaimedNow = async () => {
      const claimable = (await scheme.getStorage().list()).filter((c) => BigInt(c.chargedCumulativeAmount) > BigInt(c.totalClaimed));
      return { n: claimable.length, owed: claimable.reduce((a, c) => a + BigInt(c.chargedCumulativeAmount) - BigInt(c.totalClaimed), 0n) };
    };
    try {
      const mgr = scheme.createChannelManager(facilitator, network);
      let u = await unclaimedNow();
      obs.unclaimed = u.owed;
      let unsettled = await readUnsettled(network, mgr.receiver, mgr.token);
      if (DRY) {
        console.log(`${now()} ${name}: ${u.n} claimable channel(s), unclaimed ${usd(u.owed)} USDC, claimed-but-unsettled ${unsettled == null ? 'UNREADABLE' : usd(unsettled)} USDC; refused so far: claim ${usd(prev.claim_refused_atomic || 0)}${prev.claim_accepted_min_atomic == null ? '' : ` (smallest accepted ${usd(prev.claim_accepted_min_atomic)})`}, settle ${usd(prev.settle_refused_atomic || 0)} USDC`);
        continue;
      }

      // 1. claim. CDP refuses a claim below a minimum it does not publish (13 Oct 2026: 0.0005 refused three times, 0.0010 accepted twice,
      // so it lies in (0.0005, 0.0010]). Whether that is measured per claim transaction, per channel entry or on the batch total is not
      // known, so the job learns it per channel instead of guessing: a refused batch of one channel is a refusal of that amount; a
      // refused batch of several is retried channel by channel, and only those single-channel answers are recorded. An amount at or
      // below the largest recorded refusal is not asked for again until the record is REPROBE_MS old (the minimum may have changed).
      let claimedAny = false;
      const refusedKnown = BigInt(prev.claim_refused_atomic || 0);
      const batchRefusedKnown = BigInt(prev.claim_batch_refused_atomic || 0); // gates the question only; never read by the watchdog
      const refusedAt = Date.parse(prev.claim_refused_at);
      const reprobeDue = !Number.isFinite(refusedAt) || Date.now() - refusedAt > REPROBE_MS; // no record, or an unreadable one: ask
      const owedOf = (c) => BigInt(c.chargedCumulativeAmount) - BigInt(c.totalClaimed);
      const openChannels = async () => (await scheme.getStorage().list()).filter((c) => owedOf(c) > 0n).sort((x, y) => (owedOf(y) > owedOf(x) ? 1 : -1));
      const claimOnly = (id) => mgr.claim({ maxClaimsPerBatch: 100, ...(id ? { selectClaimChannels: (chs) => chs.filter((c) => c.channelId === id) } : {}) });
      const logClaims = (claims) => { for (const c of claims) log({ kind: 'claim', vouchers: c.vouchers, tx: c.transaction }); };
      if (u.n && (u.owed > refusedKnown && u.owed > batchRefusedKnown || reprobeDue)) {
        const open = await openChannels();
        const oneAccepted = (owed) => { obs.claimAccepted = obs.claimAccepted == null || owed < obs.claimAccepted ? owed : obs.claimAccepted; };
        try {
          const claims = await claimOnly();
          logClaims(claims);
          claimedAny = claims.length > 0;
          if (open.length === 1 && claimedAny) oneAccepted(owedOf(open[0]));
          console.log(`${now()} ${name}: claimed ${claims.reduce((a, c) => a + c.vouchers, 0)} vouchers in ${claims.length} tx (${usd(u.owed)} USDC)`);
        } catch (e) {
          if (!isBelowMinimum(e)) {
            failed++;
            console.log(`${now()} ${name}: claim FAILED: ${String((e && e.message) || e).split('\n')[0].slice(0, 200)}`);
            log({ kind: 'error', step: 'claim', error: String((e && e.message) || e).slice(0, 300) });
          } else if (open.length === 1) {
            obs.claimRefused = owedOf(open[0]);
            refusal('claim', e, { owed_usdc: usd(obs.claimRefused), channels: 1 });
            console.log(`${now()} ${name}: ${usd(obs.claimRefused)} USDC of vouchers is below the CDP claim minimum; skipped, not a failure`);
          } else {
            obs.claimBatchRefused = u.owed;
            refusal('claim', e, { scope: 'batch', owed_usdc: usd(u.owed), channels: open.length });
            let refusedMax = 0n, okN = 0, refN = 0;
            for (const ch of open.slice(0, FALLBACK_MAX)) {
              try {
                const claims = await claimOnly(ch.channelId);
                logClaims(claims);
                if (claims.length) { claimedAny = true; okN++; oneAccepted(owedOf(ch)); }
              } catch (e2) {
                if (isBelowMinimum(e2)) { refN++; if (owedOf(ch) > refusedMax) refusedMax = owedOf(ch); refusal('claim', e2, { owed_usdc: usd(owedOf(ch)), channels: 1 }); }
                else { failed++; console.log(`${now()} ${name}: claim FAILED: ${String((e2 && e2.message) || e2).split('\n')[0].slice(0, 200)}`); log({ kind: 'error', step: 'claim', error: String((e2 && e2.message) || e2).slice(0, 300) }); break; }
              }
            }
            if (refusedMax > 0n) obs.claimRefused = refusedMax;
            console.log(`${now()} ${name}: the batch of ${open.length} channels was refused as below the CDP claim minimum; claimed ${okN} channel(s) one by one, ${refN} refused as below it (not a failure)`);
          }
        }
        u = await unclaimedNow();
        obs.unclaimed = u.owed;
      }

      // value still unclaimed after the claim step (refused, or failed): has a payer started the timed withdrawal that would end it?
      if (u.n) {
        const refusedNow = obs.claimRefused != null && obs.claimRefused > refusedKnown ? obs.claimRefused : refusedKnown;
        // a channel owing no more than CDP has refused to claim is accepted exposure (one voucher), so only the rest is looked at
        const open = (await scheme.getStorage().list()).filter((c) => owedOf(c) > refusedNow).slice(0, MAX_WITHDRAWAL_CHECKS);
        for (const c of open) {
          const w = await readWithdrawal(network, c.channelId);
          if (w && w.initiatedAt > 0) obs.atRisk.push({ owed: owedOf(c), initiatedAt: w.initiatedAt });
        }
        if (obs.atRisk.length) log({ kind: 'withdrawal_pending', channels: obs.atRisk.length, owed_usdc: usd(obs.atRisk.reduce((a, r) => a + r.owed, 0n)), first_initiated_at: Math.min(...obs.atRisk.map((r) => r.initiatedAt)) });
      }

      // 2. settle: the chain says what is claimed and not yet swept to the receiver. CDP answers a claim
      // when it submits the transaction; the chain shows it a block later, and a settle sent before that is
      // refused as amount_too_low (13 Oct 2026: the first live claim's settle was refused 0.15 s before the
      // claim's block, and the same 0.0025 USDC settled 20 minutes later). So after a claim, wait for the
      // chain to show the claimed value, and retry a refusal a few times before recording it.
      if (claimedAny) {
        const before = unsettled == null ? 0n : unsettled; // a bucket left from an earlier run does not count as the new claim showing
        for (let i = 0; i < 15 && !(unsettled > before); i++) { await sleep(POLL_MS); unsettled = await readUnsettled(network, mgr.receiver, mgr.token); }
      }
      obs.unsettled = unsettled;
      const attempt = unsettled == null ? (claimedAny || Number(prev.unsettled_atomic) > 0) : unsettled > 0n;
      for (let tries = 0; attempt; tries++) {
        try {
          const r = await mgr.settle();
          log({ kind: 'settle', tx: r.transaction, ...(unsettled == null ? {} : { unsettled_usdc: usd(unsettled) }) });
          obs.settledOk = unsettled;
          const left = await readUnsettled(network, mgr.receiver, mgr.token); // a claim that landed meanwhile stays for the next run
          obs.unsettled = left == null ? 0n : left;
          console.log(`${now()} ${name}: settled ${unsettled == null ? '' : usd(unsettled) + ' USDC '}to the receiver, tx ${r.transaction}`);
          break;
        } catch (e) {
          if (isNothingToSettle(e)) { // already swept (settle is permissionless): nothing to do, nothing wrong
            obs.unsettled = 0n;
            log({ kind: 'nothing_to_settle', ...(e.statusCode ? { status: e.statusCode } : {}) });
            console.log(`${now()} ${name}: nothing left to settle`);
            break;
          }
          if (isBelowMinimum(e) && claimedAny && tries < 3) { await sleep(RETRY_MS); continue; } // the facilitator's view can trail the chain
          if (isBelowMinimum(e)) {
            obs.settleRefused = unsettled;
            refusal('settle', e, unsettled == null ? {} : { unsettled_usdc: usd(unsettled) });
            console.log(`${now()} ${name}: claimed ${unsettled == null ? '?' : usd(unsettled)} USDC refused as below the CDP settle minimum; it stays in the contract credited to the receiver and is retried next run, not a failure`);
          } else {
            failed++;
            console.log(`${now()} ${name}: settle FAILED: ${String((e && e.message) || e).split('\n')[0].slice(0, 200)}`);
            log({ kind: 'error', step: 'settle', error: String((e && e.message) || e).slice(0, 300) });
          }
          break;
        }
      }
    } catch (e) {
      failed++;
      console.log(`${now()} ${name}: run FAILED: ${String((e && e.message) || e).split('\n')[0].slice(0, 200)}`);
      log({ kind: 'error', step: 'run', error: String((e && e.message) || e).slice(0, 300) });
    }
    if (!DRY) state.networks[network] = nextNetworkState(prev, obs, now());
  }
  if (DRY) return;
  state.failures = failed ? (state.failures || 0) + 1 : 0;
  if (state.failures >= 2 && !state.alerted) {
    if (await telegram(`AgentFeed: batch-settlement claims failed ${state.failures} runs in a row; see /opt/agentfeed/batch-claim.log`)) state.alerted = true;
  }
  if (!state.failures) state.alerted = false;
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(state)); fs.renameSync(STATE + '.tmp', STATE);
})().catch((e) => { console.log(`${now()} batch-claim crashed: ${String(e && e.message).slice(0, 200)}`); process.exitCode = 1; });
