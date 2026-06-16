// escrow-core/test/verify.test.js
//
// Spec (handover §7): mock the chain (no live Hive). memo-mismatch / wrong-account /
// underpaid / wrong-currency all throw coded errors; BOTH the native and the HE
// custom_json paths validate. The tx fetcher is injected — zero network.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  verifyPayment, isNativeCurrency,
  extractTokenTransferOp, validateTransferPayload,
  extractNativeTransferOp, validateNativeTransfer,
} = require('../verify');

const ACCOUNT = 'escrow-acct';
const MEMO = 'v4call:call:res_1';

// ── Synthetic transactions (the shapes the chain returns) ───────────────────
function heTx({ from = 'alice', to = ACCOUNT, symbol = 'CNOOBS', quantity = '5', memo = MEMO } = {}) {
  return {
    block_num: 1234,
    operations: [
      ['custom_json', {
        id: 'ssc-mainnet-hive',
        required_auths: [from],
        required_posting_auths: [],
        json: JSON.stringify({ contractName: 'tokens', contractAction: 'transfer', contractPayload: { symbol, to, quantity, memo } }),
      }],
    ],
  };
}
function nativeTx({ from = 'alice', to = ACCOUNT, amount = '5.000 HBD', memo = MEMO } = {}) {
  return { block_num: 5678, operations: [['transfer', { from, to, amount, memo }]] };
}
const inject = (tx) => ({ getTransaction: async () => tx });

// ── Currency branching ──────────────────────────────────────────────────────
test('isNativeCurrency: HIVE/HBD native, HE tokens not', () => {
  assert.equal(isNativeCurrency('HBD'), true);
  assert.equal(isNativeCurrency('hive'), true);
  assert.equal(isNativeCurrency('CNOOBS'), false);
});

// ── Happy paths: both op shapes validate via verifyPayment ──────────────────
test('verifyPayment validates the Hive-Engine custom_json path', async () => {
  const r = await verifyPayment(
    { txId: 'tx1', sender: 'alice', account: ACCOUNT, currency: 'CNOOBS', expectedMemo: MEMO, expectedAmount: 5 },
    inject(heTx({ quantity: '5' })),
  );
  assert.equal(r.paid, 5);
  assert.equal(r.currency, 'CNOOBS');
  assert.equal(r.sender, 'alice');
  assert.equal(r.blockNum, 1234);
  assert.equal(r.confirmed, true);
});

test('verifyPayment validates the NATIVE HBD path', async () => {
  const r = await verifyPayment(
    { txId: 'tx2', sender: 'alice', account: ACCOUNT, currency: 'HBD', expectedMemo: MEMO, expectedAmount: 5 },
    inject(nativeTx({ amount: '5.000 HBD' })),
  );
  assert.equal(r.paid, 5);
  assert.equal(r.currency, 'HBD');
  assert.equal(r.blockNum, 5678);
  assert.equal(r.confirmed, true);
});

test('overpayment is accepted (paid ≥ expected)', async () => {
  const r = await verifyPayment(
    { txId: 'tx3', sender: 'alice', account: ACCOUNT, currency: 'HBD', expectedMemo: MEMO, expectedAmount: 5 },
    inject(nativeTx({ amount: '7.500 HBD' })),
  );
  assert.equal(r.paid, 7.5);
});

// ── Coded-error matrix (both paths) ─────────────────────────────────────────
const cases = [
  ['HE  memo mismatch',   'CNOOBS', heTx({ memo: 'wrong:memo:x' })],
  ['HE  wrong account',   'CNOOBS', heTx({ to: 'attacker' })],
  ['HE  underpaid',       'CNOOBS', heTx({ quantity: '4.999' })],
  ['HE  wrong currency',  'CNOOBS', heTx({ symbol: 'OTHER' })],
  ['nat memo mismatch',   'HBD',    nativeTx({ memo: 'wrong:memo:x' })],
  ['nat wrong account',   'HBD',    nativeTx({ to: 'attacker' })],
  ['nat underpaid',       'HBD',    nativeTx({ amount: '4.999 HBD' })],
  ['nat wrong currency',  'HBD',    nativeTx({ amount: '5.000 HIVE' })],
];
for (const [label, currency, tx] of cases) {
  test(`verifyPayment rejects: ${label} (coded error)`, async () => {
    await assert.rejects(
      () => verifyPayment({ txId: 'tx', sender: 'alice', account: ACCOUNT, currency, expectedMemo: MEMO, expectedAmount: 5 }, inject(tx)),
      e => e.code === 'unprocessable_entity',
    );
  });
}

test('wrong sender: op not attributed to claimed payer → not found', async () => {
  // HE op authorised by 'mallory', but we claim sender 'alice'
  await assert.rejects(
    () => verifyPayment({ txId: 'tx', sender: 'alice', account: ACCOUNT, currency: 'CNOOBS', expectedMemo: MEMO, expectedAmount: 5 }, inject(heTx({ from: 'mallory' }))),
    e => e.code === 'unprocessable_entity',
  );
});

test('missing required params → bad_request; missing expectedAmount → bad_request', async () => {
  await assert.rejects(() => verifyPayment({ txId: 'tx', sender: 'alice', account: ACCOUNT, currency: 'HBD' }, inject(nativeTx())), e => e.code === 'bad_request');
  await assert.rejects(
    () => verifyPayment({ txId: 'tx', sender: 'alice', account: ACCOUNT, currency: 'HBD', expectedMemo: MEMO /* no expectedAmount */ }, inject(nativeTx())),
    e => e.code === 'bad_request',
  );
});

// ── Account match is case-insensitive (chain casing varies) ─────────────────
test('account + sender match case-insensitively', async () => {
  const r = await verifyPayment(
    { txId: 'tx', sender: 'Alice', account: 'Escrow-Acct', currency: 'HBD', expectedMemo: MEMO, expectedAmount: 5 },
    inject(nativeTx({ from: 'alice', to: 'escrow-acct' })),
  );
  assert.equal(r.sender, 'alice');
});

// ── The pure extract+validate units (direct) ────────────────────────────────
test('extract/validate units work standalone for both shapes', () => {
  const hePayload = extractTokenTransferOp(heTx(), 'alice');
  assert.deepEqual(validateTransferPayload(hePayload, { account: ACCOUNT, currency: 'CNOOBS', expectedMemo: MEMO, minAmount: 5 }), { paid: 5, currency: 'CNOOBS' });

  const t = extractNativeTransferOp(nativeTx(), 'alice');
  assert.deepEqual(validateNativeTransfer(t, { account: ACCOUNT, currency: 'HBD', expectedMemo: MEMO, minAmount: 5 }), { paid: 5, currency: 'HBD' });
});
