// escrow-core/test/v4call-adapter.test.js
//
// The v4call adapter is correct iff core settle() + adapter.meteredUsage() reproduce
// v4call's processCallEnd numbers (server.js:2658-2659):
//   durationCost = min(ratePerHour * durationHr, depositPaid)   ← settlement (cap)
//   refundAmount = max(0, depositPaid - durationCost)           ← refund
// Plus: the adapter satisfies the EscrowAdapter contract, releasePolicy is
// duration_elapsed, and its ledgerSchema integrates with the core ledger.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { validateAdapter } = require('../adapter');
const { createV4callAdapter } = require('../adapters/v4call');
const { settle, registerPrecision } = require('../settle');
const { openLedger } = require('../ledger');
const { evaluateRelease } = require('../release');

const adapter = createV4callAdapter();
const HOUR_MS = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

// ── Contract ─────────────────────────────────────────────────────────────────
test('v4call adapter satisfies the EscrowAdapter contract', () => {
  assert.doesNotThrow(() => validateAdapter(adapter));
  assert.equal(adapter.memoNamespace, 'v4call');
  assert.equal(adapter.keyEnv, 'V4CALL_ESCROW_KEY');
  assert.equal(adapter.account, 'v4call-escrow');     // default
  assert.equal(adapter.currency, 'HBD');
});

test('validateAdapter rejects a malformed adapter (missing method / bad namespace)', () => {
  assert.throws(() => validateAdapter({ ...adapter, meteredUsage: undefined }), e => e.code === 'bad_request');
  assert.throws(() => validateAdapter({ ...adapter, memoNamespace: 'Bad Namespace' }), e => e.code === 'bad_request');
  assert.throws(() => validateAdapter({ ...adapter, account: '' }), e => e.code === 'bad_request');
});

test('factory overrides apply (hermetic config)', () => {
  const a = createV4callAdapter({ account: 'test-escrow', currency: 'HIVE', keyEnv: 'TEST_KEY' });
  assert.equal(a.account, 'test-escrow');
  assert.equal(a.currency, 'HIVE');
  assert.equal(a.keyEnv, 'TEST_KEY');
});

// ── Precision (Decision #3) ──────────────────────────────────────────────────
test('precision: HBD/HIVE = 3; a registered HE token uses its own places', () => {
  assert.equal(adapter.precision('HBD'), 3);
  assert.equal(adapter.precision('HIVE'), 3);
  registerPrecision('SWAP.V4T', 6);
  assert.equal(adapter.precision('SWAP.V4T'), 6);
});

// ── Metering → settle() reconciliation vs v4call processCallEnd ──────────────
// v4call's exact formulas, parameterised over a matrix of calls.
function v4callSettle({ ratePerHour, depositPaid, durationHr, prec }) {
  const durationCost = parseFloat(Math.min(ratePerHour * durationHr, depositPaid).toFixed(prec));
  const refundAmount = parseFloat(Math.max(0, depositPaid - durationCost).toFixed(prec));
  return { durationCost, refundAmount };
}

const CALLS = [
  { label: 'half-used',        ratePerHour: 2,  depositPaid: 2.0, minutes: 30 },
  { label: 'mostly-used',      ratePerHour: 1,  depositPaid: 1.0, minutes: 54 },
  { label: 'over-used→capped', ratePerHour: 10, depositPaid: 2.0, minutes: 30 },
  { label: 'just-started',     ratePerHour: 6,  depositPaid: 3.0, minutes: 1 },
  { label: 'fractional rate',  ratePerHour: 0.5, depositPaid: 0.25, minutes: 20 },
];

test('settle() + adapter.meteredUsage() reproduce v4call durationCost/refund exactly', () => {
  for (const c of CALLS) {
    const prec = adapter.precision('HBD');           // 3
    const now = T0 + c.minutes * 60 * 1000;
    const record = { ratePerHour: c.ratePerHour, startTime: T0, currency: 'HBD' };

    const usage = adapter.meteredUsage(record, now); // = ratePerHour * (minutes/60)
    assert.ok(Math.abs(usage - c.ratePerHour * (c.minutes / 60)) < 1e-12, `${c.label}: usage formula`);

    const got = settle({ deposit: c.depositPaid, meteredUsage: usage, places: prec }); // dustFloor 0 — match pre-gate split
    const exp = v4callSettle({ ratePerHour: c.ratePerHour, depositPaid: c.depositPaid, durationHr: c.minutes / 60, prec });

    assert.equal(got.settlement, exp.durationCost, `${c.label}: settlement (durationCost)`);
    assert.equal(got.refund, exp.refundAmount, `${c.label}: refund`);
    // money-safety: an over-used call can never refund negative or settle past deposit
    assert.ok(got.settlement <= c.depositPaid + 1e-9);
    assert.ok(got.refund >= 0);
  }
});

test('meteredUsage returns 0 for a free/un-started call; clamps to maxDurationMin', () => {
  assert.equal(adapter.meteredUsage({ ratePerHour: 0, startTime: T0 }, T0 + HOUR_MS), 0);   // free
  assert.equal(adapter.meteredUsage({ ratePerHour: 5, startTime: 0 }, T0), 0);              // not started
  // clamp: 5/hr, 2h elapsed but capped at 60 min → usage = 5 * 1h = 5
  assert.equal(adapter.meteredUsage({ ratePerHour: 5, startTime: T0, maxDurationMin: 60 }, T0 + 2 * HOUR_MS), 5);
});

// ── Settlement split (payout/refund/fee) vs v4call processCallEnd ────────────
test('settlementSplit reproduces processCallEnd payout/refund/fee numbers', () => {
  const prec = adapter.precision('HBD');                       // 3
  // 30-min call @ 2/hr, deposit 2.0 → durationCost 1.0, refund 1.0
  const settled = settle({ deposit: 2.0, meteredUsage: 2 * 0.5, places: prec });
  const { outflows, calleeGross, platformOnCall, calleeNet, platformTotal } = adapter.settlementSplit(
    { connect_paid: 0.05, ring_paid: 0.01, platform_fee: 0.10, callee: 'callee', caller: 'caller', currency: 'HBD' },
    settled,
    { ref: 'call_1', feeAccount: 'platform', durationMin: 30, places: prec }
  );
  assert.equal(calleeGross, 1.05);                              // connect + durationCost
  assert.equal(platformOnCall, 0.105);                         // calleeGross * fee
  assert.equal(calleeNet, 0.945);                              // calleeGross - platformOnCall
  assert.equal(platformTotal, 0.115);                          // ring + platformOnCall
  const byKind = Object.fromEntries(outflows.map(o => [o.kind, o]));
  assert.equal(byKind.payout.to_account, 'callee');
  assert.equal(byKind.payout.amount, 0.945);
  assert.equal(byKind.payout.memo, 'v4call:payout:call_1:30.0min');
  assert.equal(byKind.refund.to_account, 'caller');
  assert.equal(byKind.refund.amount, 1.0);
  assert.equal(byKind.refund.memo, 'v4call:refund:call_1:unused-credit');
  assert.equal(byKind.platform_fee.to_account, 'platform');
  assert.equal(byKind.platform_fee.amount, 0.115);
  assert.equal(byKind.platform_fee.memo, 'v4call:fee:call_1:ring+cut');
});

test('settlementSplit CONSERVES the envelope: payout + refund + fee == ring + connect + deposit − dust', () => {
  const prec = adapter.precision('HBD');
  const floor = Math.pow(10, -prec);
  for (const c of CALLS) {
    for (const fee of [0, 0.10, 0.30]) {
      const ring = 0.02, connect = 0.07;
      const settled = settle({ deposit: c.depositPaid, meteredUsage: c.ratePerHour * (c.minutes / 60), places: prec, dustFloor: floor });
      const { outflows } = adapter.settlementSplit(
        { connect_paid: connect, ring_paid: ring, platform_fee: fee, callee: 'callee', caller: 'caller', currency: 'HBD' },
        settled, { ref: 'r', feeAccount: 'platform', places: prec }
      );
      const out = outflows.reduce((s, o) => s + o.amount, 0);
      const totalIn = ring + connect + c.depositPaid;
      const dust = settled.dust || 0;
      // total out never exceeds total in (never mint/drain), and matches in − dust within rounding
      assert.ok(out <= totalIn + 1e-9, `${c.label} fee=${fee}: out ${out} must not exceed in ${totalIn}`);
      assert.ok(Math.abs(out - (totalIn - dust)) < 3 * floor, `${c.label} fee=${fee}: out ${out} ≈ in−dust ${totalIn - dust}`);
    }
  }
});

test('settlementSplit drops sub-floor outflows and missing recipients', () => {
  const prec = adapter.precision('HBD');
  // tiny everything → all below floor, plus no feeAccount
  const settled = settle({ deposit: 0.0, meteredUsage: 0, places: prec });
  const { outflows } = adapter.settlementSplit(
    { connect_paid: 0, ring_paid: 0, platform_fee: 0.1, callee: 'callee', caller: 'caller', currency: 'HBD' },
    settled, { ref: 'r', places: prec }   // no feeAccount
  );
  assert.equal(outflows.length, 0);
});

// ── Report envelope (node↔box contract) ──────────────────────────────────────
test('buildCallEndReportFacts builds the box envelope from durable rows', () => {
  const rows = [
    { tx_id: 't_ring',    sender: 'caller', currency: 'HBD', amount: 0.01, memo: 'v4call:ring:c1' },
    { tx_id: 't_connect', sender: 'caller', currency: 'HBD', amount: 0.05, memo: 'v4call:connect:c1' },
    { tx_id: 't_dep',     sender: 'caller', currency: 'HBD', amount: 2.00, memo: 'v4call:call:c1',
      rate_per_hour: 2, start_ts: T0, platform_fee: 0.10, callee: 'callee' },
  ];
  const facts = adapter.buildCallEndReportFacts({ payRows: rows, endReason: 'hangup', now: T0 + 30 * 60 * 1000, maxDurationMin: 120 });
  assert.equal(facts.kind, 'call-end');
  assert.equal(facts.currency, 'HBD');
  assert.equal(facts.payments.length, 3);
  assert.equal(facts.payments.find(p => p.txId === 't_ring').purpose, 'ring');
  assert.equal(facts.payments.find(p => p.txId === 't_dep').purpose, 'call');     // deposit-bucket purpose from memo
  assert.equal(facts.callFacts.ratePerHour, 2);
  assert.equal(facts.callFacts.callee, 'callee');
  assert.equal(facts.callFacts.startTs, T0);
  assert.equal(facts.durationMs, 30 * 60 * 1000);
  // separate-transfer (A) shape: ring/connect are their own payments → NOT folded into callFacts
  assert.equal(facts.callFacts.connectPaid, undefined);
  assert.equal(facts.callFacts.ringPaid, undefined);
});

test('buildCallEndReportFacts surfaces combined-transfer ring/connect columns into callFacts', () => {
  // The live node funds ring+connect+deposit as ONE transfer → a SINGLE deposit row with the
  // non-refundable portions as columns. buildCallEndReportFacts must surface them so the box
  // can re-split the verified envelope (Option B).
  const rows = [
    { tx_id: 't_combined', sender: 'caller', currency: 'HBD', amount: 2.00, memo: 'v4call:call:c2',
      rate_per_hour: 2, start_ts: T0, platform_fee: 0.10, callee: 'callee',
      connect_paid: 0.05, ring_paid: 0.01 },
  ];
  const facts = adapter.buildCallEndReportFacts({ payRows: rows, endReason: 'hangup', now: T0 + 30 * 60 * 1000, maxDurationMin: 120 });
  assert.equal(facts.payments.length, 1);
  assert.equal(facts.payments[0].purpose, 'call');          // single deposit-bucket payment
  assert.equal(facts.payments[0].amount, 2.00);             // node's stored refundable cap (box re-derives the real total on-chain)
  assert.equal(facts.callFacts.connectPaid, 0.05);          // ← carried for the box re-split
  assert.equal(facts.callFacts.ringPaid, 0.01);
});

// ── Single-payment settlement (DMs/attachments/invites/ring-fee refunds) ─────
test('buildSinglePaymentReportFacts builds the box envelope for a one-shot payment', () => {
  const facts = adapter.buildSinglePaymentReportFacts({
    txId: 't_dm', sender: 'cnoobz', amount: 3, currency: 'TEST', memo: 'v4call:text:msg_1',
    payoutTo: 'completenoober', platformFee: 0.10,
  });
  assert.equal(facts.kind, 'single-payment');
  assert.equal(facts.currency, 'TEST');
  assert.equal(facts.payoutTo, 'completenoober');
  assert.equal(facts.platformFee, 0.10);
  assert.equal(facts.payments.length, 1);
  assert.equal(facts.payments[0].txId, 't_dm');
  assert.equal(facts.payments[0].sender, 'cnoobz');
  assert.equal(facts.payments[0].amount, 3);
});

test('singlePaymentSplit reproduces the dm-attachment net/fee numbers', () => {
  const { outflows, gross, fee, net } = adapter.singlePaymentSplit(
    3, { currency: 'TEST', payoutTo: 'completenoober', platformFee: 0.10 },
    { ref: 'msg_1', feeAccount: 'v4call' }
  );
  assert.equal(gross, 3);
  assert.equal(fee, 0.3);
  assert.equal(net, 2.7);
  const byKind = Object.fromEntries(outflows.map(o => [o.kind, o]));
  assert.equal(byKind.payout.to_account, 'completenoober');
  assert.equal(byKind.payout.amount, 2.7);
  assert.equal(byKind.platform_fee.to_account, 'v4call');
  assert.equal(byKind.platform_fee.amount, 0.3);
});

test('singlePaymentSplit with platformFee 0 is a pure refund — entire amount to payoutTo, no fee line', () => {
  const { outflows, net, fee } = adapter.singlePaymentSplit(
    0.5, { currency: 'HBD', payoutTo: 'caller', platformFee: 0 },
    { ref: 'ring_1', feeAccount: 'v4call' }
  );
  assert.equal(net, 0.5);
  assert.equal(fee, 0);
  assert.equal(outflows.length, 1);
  assert.equal(outflows[0].kind, 'payout');
  assert.equal(outflows[0].to_account, 'caller');
  assert.equal(outflows[0].amount, 0.5);
});

test('singlePaymentSplit drops sub-floor outflows and a missing feeAccount', () => {
  const { outflows } = adapter.singlePaymentSplit(
    0.0001, { currency: 'HBD', payoutTo: 'callee', platformFee: 0.10 },
    { ref: 'r' }   // no feeAccount, and amount rounds to 0 at 3dp
  );
  assert.equal(outflows.length, 0);
});

// ── Release ──────────────────────────────────────────────────────────────────
test('releasePolicy is duration_elapsed; evaluateRelease honours the elapsed signal', () => {
  const policy = adapter.releasePolicy({});
  assert.deepEqual(policy, { type: 'duration_elapsed' });
  assert.equal(evaluateRelease({ policy, owner: 'caller', releaser: 'system', elapsed: true }).ends, true);
  assert.equal(evaluateRelease({ policy, owner: 'caller', releaser: 'system', elapsed: false }).ends, false);
});

// ── Ledger integration: adapter columns appended to the core tables ──────────
test('ledgerSchema migrates into the core ledger; recordPayment persists locked facts', () => {
  const dbPath = path.join(os.tmpdir(), `escrow-core-v4call-adapter-${process.pid}.db`);
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch {} }
  try {
    const L = openLedger(dbPath, { adapterMigrations: adapter.ledgerMigrations() });

    // adapter columns now exist on payments
    const cols = new Set(L.db.prepare('PRAGMA table_info(payments)').all().map(c => c.name));
    for (const c of ['rate_per_hour', 'start_ts', 'connect_paid', 'ring_paid', 'platform_fee', 'callee']) {
      assert.ok(cols.has(c), `missing adapter column ${c}`);
    }

    // a payment row carrying v4call's locked metering facts (durable activePayments)
    L.recordPayment({
      tx_id: 'tx_call_1', ref: 'call_1', sender: 'caller', currency: 'HBD', amount: 2.0,
      memo: 'v4call:call:call_1', rate_per_hour: 2.0, start_ts: T0, connect_paid: 0.05,
      ring_paid: 0.01, platform_fee: 0.1, callee: 'callee',
    });
    const p = L.getPaymentByTxId('tx_call_1');
    assert.equal(p.rate_per_hour, 2.0);
    assert.equal(p.start_ts, T0);
    assert.equal(p.callee, 'callee');

    // the durable row drives meteredUsage directly (post-migration shape)
    const usage = adapter.meteredUsage(p, T0 + 30 * 60 * 1000);
    assert.ok(Math.abs(usage - 1.0) < 1e-12);

    // schema_version reflects the adapter migration (≥ 100)
    assert.equal(L.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, adapter.schemaVersion);
    L.close();
  } finally {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch {} }
  }
});
