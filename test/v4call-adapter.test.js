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
