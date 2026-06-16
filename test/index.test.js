// escrow-core/test/index.test.js
//
// Proves index.js exposes the parent §3 public surface AND that the pieces compose:
// a full escrow lifecycle (deposit → single-winner close → metered settle → durable
// refund → signed settlement-receipt) stitched ONLY through the public API.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const escrow = require('..');

test('public surface exposes the parent §3 API', () => {
  for (const name of [
    'verifyPayment', 'verifySidechain', 'disburse',
    'settle', 'roundCoins', 'precision', 'registerPrecision',
    'openLedger',
    'verifyHiveSig', 'evaluateRelease', 'normalizeReleasePolicy',
    'buildEventReport', 'buildSettlementReceipt', 'signReport', 'verifyReport',
    'buildMemo', 'parseMemo', 'createSeenIds', 'getReportingPubkey',
    'validateAdapter', 'createV4callAdapter',
  ]) {
    assert.equal(typeof escrow[name], 'function', `missing export: ${name}`);
  }
  assert.equal(escrow.PROTO, 'escrow-protocol/0.1');
  assert.equal(escrow.version, '0.1.0');
});

test('end-to-end escrow lifecycle through the public surface', () => {
  const adapter = escrow.validateAdapter(escrow.createV4callAdapter());
  const T0 = 1_700_000_000_000;
  const SK = '1'.repeat(64);

  // 1. open a ledger with the adapter's per-service columns
  const L = escrow.openLedger(':memory:', { adapterMigrations: adapter.ledgerMigrations() });

  // 2. a caller deposits 2 HBD for a call at 2 HBD/hr; memo binds the ref
  const ref = 'call_42';
  const memo = escrow.buildMemo({ namespace: adapter.memoNamespace, purpose: 'call', reservationId: ref });
  assert.deepEqual(escrow.parseMemo(memo), { namespace: 'v4call', purpose: 'call', reservationId: ref });
  L.recordPayment({ tx_id: 'tx_42', ref, sender: 'caller', currency: 'HBD', amount: 2.0, memo, rate_per_hour: 2.0, start_ts: T0, callee: 'callee' });

  // replay of the same tx is rejected
  assert.throws(() => L.recordPayment({ tx_id: 'tx_42', ref, sender: 'caller', currency: 'HBD', amount: 2.0, memo }), e => e.code === 'conflict');

  // 3. call ends at 30 min → single-winner close (only the first wins)
  assert.equal(L.atomicClose(ref), true);
  assert.equal(L.atomicClose(ref), false);

  // 4. settle: metered usage from the durable row, capped by the deposit
  const row = L.getPaymentByTxId('tx_42');
  const usage = adapter.meteredUsage(row, T0 + 30 * 60 * 1000);          // 2 * 0.5h = 1.0
  const { settlement, refund } = escrow.settle({ deposit: row.amount, meteredUsage: usage, places: adapter.precision('HBD') });
  assert.equal(settlement, 1.0);   // duration cost to callee
  assert.equal(refund, 1.0);       // unused deposit back to caller
  assert.ok(settlement <= row.amount, 'cap holds — cannot mint money');

  // 5. durable refund row
  const { refund_id } = L.recordRefund({ ref, to_account: 'caller', amount: refund, currency: 'HBD', memo: escrow.buildMemo({ namespace: 'v4call', purpose: 'refund', reservationId: ref }) });
  assert.equal(L.getRefund(refund_id).status, 'pending');

  // 6. signed settlement-receipt (escrow-protocol/0.1) the node can verify
  const receipt = escrow.buildSettlementReceipt({ ref, settlement, refund, dust: 0, currency: 'HBD', disburseTx: null, status: 'pending', createdAt: T0 });
  const signed = escrow.signReport(receipt, SK);
  const pub = escrow.getReportingPubkey(SK);
  assert.equal(escrow.verifyReport(signed, pub), true);
  assert.equal(escrow.verifyReport({ ...signed, refund: 999 }), false);   // tamper rejected

  L.close();
});
