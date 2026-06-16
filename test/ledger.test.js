// escrow-core/test/ledger.test.js
//
// The ledger spine's spec is ipfs-gate's proven semantics (handover §7):
//   - replay:    recordPayment with a duplicate tx_id throws code:'conflict'.
//   - atomicity: atomicClose(ref) flips once; a second call returns false
//                ("lost the race") → no double-disburse.
//   - idempotent consent: recordConsent re-insert is a no-op.
//   - durable refund lifecycle: pending → sent, retrievable.
//   - openLedger() runs migrations clean on a fresh DB and is idempotent on reopen.
//
// A fixed injected clock keeps timestamps deterministic; :memory: DBs isolate
// behaviour tests; one real temp-file test proves on-disk migration + durability.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { openLedger } = require('../ledger');

let CLOCK = 1_700_000_000_000;
const tick = () => ++CLOCK;                 // deterministic, monotonic
const mem = () => openLedger(':memory:', { now: tick });

function basePayment(over = {}) {
  return { tx_id: 'tx_aaa', ref: 'res_1', sender: 'alice', currency: 'HBD', amount: 10.0, memo: 'v4call:call:res_1', block_num: 42, ...over };
}

// ── Payments + replay guard ─────────────────────────────────────────────────

test('recordPayment persists a confirmed deposit, readable by tx_id / id / ref', () => {
  const L = mem();
  const { id } = L.recordPayment(basePayment());
  const byTx = L.getPaymentByTxId('tx_aaa');
  assert.equal(byTx.amount, 10.0);
  assert.equal(byTx.ref, 'res_1');
  assert.equal(byTx.sender, 'alice');
  assert.equal(byTx.status, 'confirmed');
  assert.equal(byTx.settle_state, 'open');         // open for settlement
  assert.equal(L.getPaymentById(id).tx_id, 'tx_aaa');
  assert.equal(L.getPaymentsByRef('res_1').length, 1);
  L.close();
});

test('replay: a duplicate tx_id throws code:conflict (the UNIQUE guard)', () => {
  const L = mem();
  L.recordPayment(basePayment());
  assert.throws(() => L.recordPayment(basePayment({ ref: 'res_2' })), e => e.code === 'conflict');
  // a different tx_id is fine
  assert.doesNotThrow(() => L.recordPayment(basePayment({ tx_id: 'tx_bbb', ref: 'res_2' })));
  assert.equal(L.getPaymentsByRef('res_2').length, 1);
  L.close();
});

test('recordPayment rejects missing required fields + unknown columns', () => {
  const L = mem();
  assert.throws(() => L.recordPayment({ tx_id: 'x', ref: 'r' }), e => e.code === 'bad_request');
  // no adapter columns exist on the core schema → unknown key is rejected (injection guard)
  assert.throws(() => L.recordPayment(basePayment({ tx_id: 'tx_c', evil_col: 1 })), e => e.code === 'bad_request');
  L.close();
});

// ── The single-winner settle flip ───────────────────────────────────────────

test('atomicClose flips exactly once; the second caller loses the race', () => {
  const L = mem();
  L.recordPayment(basePayment());

  assert.equal(L.atomicClose('res_1'), true,  'first close wins');
  assert.equal(L.atomicClose('res_1'), false, 'second close lost the race (already closed)');
  assert.equal(L.getPaymentByTxId('tx_aaa').settle_state, 'closed');

  // unknown ref → nothing to flip → false
  assert.equal(L.atomicClose('res_nope'), false);
  L.close();
});

test('atomicClose is per-ref isolated (closing one escrow does not close another)', () => {
  const L = mem();
  L.recordPayment(basePayment({ tx_id: 'tx_1', ref: 'res_a' }));
  L.recordPayment(basePayment({ tx_id: 'tx_2', ref: 'res_b' }));
  assert.equal(L.atomicClose('res_a'), true);
  assert.equal(L.getPaymentByTxId('tx_2').settle_state, 'open', 'res_b untouched');
  assert.equal(L.atomicClose('res_b'), true);
  L.close();
});

// ── Durable refund lifecycle ────────────────────────────────────────────────

test('refund lifecycle: pending → sent, durable + retrievable', () => {
  const L = mem();
  const { refund_id } = L.recordRefund({ ref: 'res_1', to_account: 'alice', amount: 4.5, currency: 'HBD', memo: 'refund res_1' });
  let r = L.getRefund(refund_id);
  assert.equal(r.status, 'pending');
  assert.equal(r.settled_ts, null);                 // pending isn't settled yet
  assert.equal(r.amount, 4.5);

  L.markRefundSettled(refund_id, 'sent', 'refund_tx_xyz');
  r = L.getRefund(refund_id);
  assert.equal(r.status, 'sent');
  assert.equal(r.tx_id, 'refund_tx_xyz');
  assert.ok(r.settled_ts > 0);
  L.close();
});

test('a refund recorded already-terminal stamps settled_ts immediately', () => {
  const L = mem();
  const { refund_id } = L.recordRefund({ ref: 'res_1', to_account: 'alice', amount: 0, currency: 'HBD', memo: 'dust', status: 'skipped', reason: 'dust' });
  const r = L.getRefund(refund_id);
  assert.equal(r.status, 'skipped');
  assert.ok(r.settled_ts > 0);
  L.close();
});

test('markPaymentRefunded stamps the payment row', () => {
  const L = mem();
  const { id } = L.recordPayment(basePayment());
  L.markPaymentRefunded(id, 'refund_tx_zzz');
  const p = L.getPaymentById(id);
  assert.equal(p.status, 'refunded');
  assert.equal(p.refund_tx_id, 'refund_tx_zzz');
  assert.ok(p.refund_at > 0);
  L.close();
});

// ── Idempotent consent / receipts ───────────────────────────────────────────

test('recordConsent is idempotent per (ref, releaser); case-folded', () => {
  const L = mem();
  assert.equal(L.recordConsent('res_1', 'Bob').inserted, true,  'first consent inserts');
  assert.equal(L.recordConsent('res_1', 'bob').inserted, false, 're-consent is a no-op (idempotent)');
  assert.deepEqual(L.getConsents('res_1'), ['bob']);

  L.recordConsent('res_1', 'carol');
  assert.deepEqual(L.getConsents('res_1').sort(), ['bob', 'carol']);
  L.close();
});

test('recordReceipt is idempotent per (ref, recipient)', () => {
  const L = mem();
  assert.equal(L.recordReceipt('res_1', 'Dave', 'hash123').inserted, true);
  assert.equal(L.recordReceipt('res_1', 'dave', 'hash123').inserted, false);
  const got = L.getReceipts('res_1');
  assert.equal(got.length, 1);
  assert.equal(got[0].recipient, 'dave');
  assert.equal(got[0].proof_hash, 'hash123');
  L.close();
});

// ── Migrations on a fresh DB file + durability across reopen ─────────────────

test('openLedger runs migrations clean on a fresh file, idempotent on reopen, data durable', () => {
  const dbPath = path.join(os.tmpdir(), `escrow-core-ledger-${process.pid}.db`);
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch {} }

  try {
    const L1 = openLedger(dbPath, { now: tick });
    // all four core tables + schema_version present
    const tables = new Set(L1.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of ['payments', 'refunds', 'release_consents', 'receipts', 'schema_version']) {
      assert.ok(tables.has(t), `missing table ${t}`);
    }
    assert.equal(L1.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 1);
    L1.recordPayment(basePayment({ tx_id: 'tx_durable', ref: 'res_dur' }));
    L1.close();

    // reopen: migration runner must NOT re-run (idempotent), data persists
    const L2 = openLedger(dbPath, { now: tick });
    assert.equal(L2.db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 1);
    assert.equal(L2.getPaymentByTxId('tx_durable').ref, 'res_dur');
    L2.close();
  } finally {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch {} }
  }
});
