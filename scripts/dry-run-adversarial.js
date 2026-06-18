#!/usr/bin/env node
// escrow-core/scripts/dry-run-adversarial.js
// ─────────────────────────────────────────────────────────────────────────────
// Adversarial dry-run harness — the two FAILURE-MODE guards the escrow-core
// walkthrough (Step 10) marks MANDATORY before trusting larger real-money flows.
// The happy path (verify → settle → disburse) was already exercised live on the
// deploy; this covers the two adversarial cases that a happy-path call does NOT:
//
//   #1  REPLAY-REJECT
//       The same payment tx can never be counted twice — tx_id UNIQUE makes the
//       second recordPayment throw code:'conflict', so it can never be settled or
//       disbursed twice. (Plus the event-id dedup that drops a redelivered report.)
//
//   #2  CRASH-NO-DOUBLE-DISBURSE
//       Killing the process AFTER atomicClose() but BEFORE the disburse, then
//       restarting, settles EXACTLY ONCE — the durable 'pending' refund row is the
//       single source of truth and a duplicate call-end / re-run can't double-pay.
//
// HOW IT STAYS SAFE (no real money, no key, no network):
//   • It drives the REAL escrow-core primitives against a REAL on-disk SQLite
//     ledger (openLedger / recordPayment / atomicClose / settle / recordRefund /
//     markRefundSettled / disburse) — these are the exact guards that protect
//     production funds, not a re-implementation.
//   • Only the on-chain broadcast is faked: disburse() is handed an injected mock
//     dhive client, so nothing is broadcast. A throwaway, never-funded key is
//     generated purely so disburse()'s key-parse path runs.
//   • The "crash" is a REAL child `node` process that process.exit()s mid-settle,
//     so the kill is a genuine process boundary — the DB on disk is the only thing
//     that survives, exactly like a production SIGKILL.
//
// USAGE (copy-paste):
//   cd /opt/v4call/escrow-core         # wherever escrow-core is cloned
//   node scripts/dry-run-adversarial.js
//
// Exit 0 = all guards held. Non-zero = a guard FAILED — do NOT settle real funds
// until you understand why. Writes only to a throwaway temp dir; safe to re-run.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const escrow = require('..');                 // the real escrow-core engine
const dhive  = require('@hiveio/dhive');
const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

// A deterministic, throwaway, NEVER-FUNDED active key — only so disburse()'s
// PrivateKey.fromString() path runs. The broadcast is mocked, so this key signs
// nothing real. Same seed in every process → same key (handy, not required).
process.env.ESCROW_DRYRUN_KEY ||= dhive.PrivateKey.fromSeed('escrow-core-adversarial-dry-run').toString();

const CURRENCY = 'TEST';                       // a throwaway Hive-Engine-style token
const ESCROW_ACCT = 'dryrun-escrow';
const CALLER = 'dryrun-caller';
escrow.registerPrecision(CURRENCY, 3);         // lock its on-chain precision

// ── tiny arg parser ──────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => { const m = /^--([^=]+)=(.*)$/.exec(a); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true]; })
);

// ── the mocked broadcast: append one line per disburse to a durable log file ──
function makeMockClient(logPath, ref) {
  return { broadcast: { sendOperations: async (ops) => {
    const txId = 'mocktx_' + crypto.randomBytes(6).toString('hex');
    fs.appendFileSync(logPath, JSON.stringify({ ref, op: ops[0][0], txId }) + '\n');
    return { id: txId };
  } } };
}
function disbursements(logPath, ref) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l)).filter(e => !ref || e.ref === ref);
}
// disburse the pending refund via the REAL escrow-core disburse(), mock client injected
async function disburseRefund(ledger, logPath, refundRow) {
  const memo = escrow.buildMemo({ namespace: 'v4call', purpose: 'refund', reservationId: refundRow.ref });
  const { txId } = await escrow.disburse(
    { to: refundRow.to_account, amount: refundRow.amount, currency: refundRow.currency, memo,
      fromAccount: ESCROW_ACCT, keyEnv: 'ESCROW_DRYRUN_KEY', places: escrow.precision(refundRow.currency) },
    { client: makeMockClient(logPath, refundRow.ref) }
  );
  ledger.markRefundSettled(refundRow.refund_id, 'sent', txId);
  return txId;
}
function openTestLedger(dbPath) {
  const adapter = escrow.createV4callAdapter();
  return escrow.openLedger(dbPath, { adapterMigrations: adapter.ledgerMigrations() });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHILD PHASES — run in their own process so the "crash" is a real kill.
// ═══════════════════════════════════════════════════════════════════════════════

// Phase "crash": deposit → win the close → record the pending refund → DIE before
// the disburse. The committed SQLite rows survive; the in-memory state does not.
if (args.phase === 'crash') {
  const ledger = openTestLedger(args.db);
  const ref = args.ref;
  const memo = escrow.buildMemo({ namespace: 'v4call', purpose: 'call', reservationId: ref });
  ledger.recordPayment({ tx_id: 'tx_' + ref, ref, sender: CALLER, currency: CURRENCY, amount: 1.0, memo, rate_per_hour: 1.0, start_ts: 0, callee: 'dryrun-callee' });
  if (ledger.atomicClose(ref) !== true) { console.error('[crash] unexpected: atomicClose lost'); process.exit(2); }
  const usage = 0.5;                                            // 30 min @ 1.0/hr
  const { refund } = escrow.settle({ deposit: 1.0, meteredUsage: usage, currency: CURRENCY, places: escrow.precision(CURRENCY) });
  ledger.recordRefund({ ref, to_account: CALLER, amount: refund, currency: CURRENCY, memo: escrow.buildMemo({ namespace: 'v4call', purpose: 'refund', reservationId: ref }), reason: 'refund' });
  console.error(`[crash] ref=${ref} closed + refund(${refund} ${CURRENCY}) pending — now KILLING before disburse`);
  process.exit(137);                                            // simulate SIGKILL — NO disburse ran
}

// Phase "recover": a fresh process re-opens the SAME db and completes any pending
// refund exactly once. Re-running it must be a no-op (idempotent).
if (args.phase === 'recover') {
  (async () => {
    const ledger = openTestLedger(args.db);
    const pending = ledger.db.prepare("SELECT * FROM refunds WHERE status = 'pending'").all();
    for (const r of pending) await disburseRefund(ledger, args.log, r);
    console.error(`[recover] settled ${pending.length} pending refund(s)`);
    ledger.close();
    process.exit(0);
  })();
  return;   // (top-level return is fine — this file is a CommonJS module)
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARENT / ORCHESTRATOR (no --phase) — runs the checks and prints the verdict.
// ═══════════════════════════════════════════════════════════════════════════════

const { spawnSync } = require('child_process');
const results = [];
const ok   = (m) => { results.push(true);  console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad  = (m) => { results.push(false); console.log('  \x1b[31m✗ FAIL:\x1b[0m ' + m); };
const check = (cond, m) => cond ? ok(m) : bad(m);
function child(extra) {
  return spawnSync(process.execPath, [__filename, ...extra], { stdio: ['ignore', 'inherit', 'inherit'] });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-dryrun-'));
  console.log('escrow-core adversarial dry-run');
  console.log('engine: escrow-core ' + escrow.version + '  ·  currency: ' + CURRENCY + ' (throwaway)  ·  broadcast: MOCKED (no key/funds/network)');
  console.log('workdir: ' + dir + '\n');

  // ── CHECK #1 — REPLAY-REJECT ────────────────────────────────────────────────
  console.log('#1  Replay-reject  (a re-used payment tx must not disburse twice)');
  {
    const dbPath = path.join(dir, 'replay.db');
    const logPath = path.join(dir, 'replay-disburse.log');
    const ledger = openTestLedger(dbPath);
    const ref = 'call_replay';
    const memo = escrow.buildMemo({ namespace: 'v4call', purpose: 'call', reservationId: ref });

    // happy settlement, once: record → close → settle → record refund → disburse
    ledger.recordPayment({ tx_id: 'tx_dup', ref, sender: CALLER, currency: CURRENCY, amount: 1.0, memo, rate_per_hour: 1.0, start_ts: 0, callee: 'dryrun-callee' });
    ledger.atomicClose(ref);
    const { refund } = escrow.settle({ deposit: 1.0, meteredUsage: 0.5, currency: CURRENCY, places: escrow.precision(CURRENCY) });
    const { refund_id } = ledger.recordRefund({ ref, to_account: CALLER, amount: refund, currency: CURRENCY, memo, reason: 'refund' });
    await disburseRefund(ledger, logPath, ledger.getRefund(refund_id));
    check(disbursements(logPath, ref).length === 1, 'first settlement disbursed exactly once');

    // the SAME on-chain tx is replayed (redelivered fed message, double-click, retry…)
    let threw = null;
    try { ledger.recordPayment({ tx_id: 'tx_dup', ref, sender: CALLER, currency: CURRENCY, amount: 1.0, memo }); }
    catch (e) { threw = e; }
    check(threw && threw.code === 'conflict', "replayed tx_id rejected with code:'conflict'");
    check(ledger.getPaymentsByRef(ref).length === 1, 'no second payment row was created');
    check(disbursements(logPath, ref).length === 1, 'still exactly ONE disbursement after the replay (no double-pay)');

    // event-id dedup layer — a redelivered escrow report is dropped before re-dispatch
    const seen = escrow.createSeenIds();
    check(seen.markSeen('evt_1') === true && seen.markSeen('evt_1') === false,
      'redelivered settlement-report event-id dropped by createSeenIds (one-shot)');
    ledger.close();
  }

  // ── CHECK #2 — CRASH-NO-DOUBLE-DISBURSE ─────────────────────────────────────
  console.log('\n#2  Crash-no-double-disburse  (kill between atomicClose and disburse, then restart)');
  {
    const dbPath = path.join(dir, 'crash.db');
    const logPath = path.join(dir, 'crash-disburse.log');
    const ref = 'call_crash';

    // (a) a real child process closes + records the pending refund, then dies pre-disburse
    const crashed = child([`--phase=crash`, `--db=${dbPath}`, `--ref=${ref}`, `--log=${logPath}`]);
    check(crashed.status !== 0, `crash child exited non-zero (status ${crashed.status}) — died mid-settle as intended`);
    check(disbursements(logPath, ref).length === 0, 'nothing was disbursed before the crash');

    // the durable state survived the kill: payment closed, exactly one pending refund
    const after = openTestLedger(dbPath);
    const pendingRows = after.db.prepare("SELECT * FROM refunds WHERE ref = ? AND status = 'pending'").all(ref);
    const closed = after.getPaymentsByRef(ref).every(p => p.settle_state === 'closed');
    check(closed, 'payment row survived the crash as settle_state=closed');
    check(pendingRows.length === 1, 'exactly one pending refund row survived the crash');
    check(after.atomicClose(ref) === false, 'a duplicate (post-crash) call-end loses the atomicClose race → would skip disburse');
    after.close();

    // (b) restart #1 recovers and disburses exactly once
    child([`--phase=recover`, `--db=${dbPath}`, `--log=${logPath}`]);
    check(disbursements(logPath, ref).length === 1, 'restart #1 disbursed the pending refund exactly once');

    // (c) restart #2 (or any re-run of recovery) is a no-op — the refund is now 'sent'
    child([`--phase=recover`, `--db=${dbPath}`, `--log=${logPath}`]);
    check(disbursements(logPath, ref).length === 1, 'restart #2 disbursed nothing more — settled EXACTLY ONCE across restarts');

    const finalLedger = openTestLedger(dbPath);
    const finalRefund = finalLedger.db.prepare("SELECT * FROM refunds WHERE ref = ?").get(ref);
    check(finalRefund.status === 'sent' && !!finalRefund.tx_id, "refund row is terminal: status='sent' with a disburse tx_id");
    finalLedger.close();
  }

  // ── summary ─────────────────────────────────────────────────────────────────
  fs.rmSync(dir, { recursive: true, force: true });
  const passed = results.filter(Boolean).length, total = results.length;
  console.log('\n──────────────────────────────────────────────');
  if (passed === total) {
    console.log(`\x1b[32mALL GUARDS HELD — ${passed}/${total} checks passed.\x1b[0m`);
    console.log('Invariant #1 (replay-reject) and #2 (crash-no-double-disburse) confirmed against the real ledger.');
    console.log('\nNote: a residual window (broadcast SUCCEEDS, process dies before markRefundSettled) is closed at the');
    console.log('chain/transport layer — the disburse memo + the verify-side seenIds dedup — not by the offline ledger.');
    process.exit(0);
  } else {
    console.log(`\x1b[31m${total - passed}/${total} CHECK(S) FAILED — do NOT settle real funds until resolved.\x1b[0m`);
    process.exit(1);
  }
})().catch(e => { console.error('\nharness error:', e); process.exit(1); });
