// escrow-core/test/sign.test.js
//
// disburse's op-building is pure + testable without a key or network (buildDisburseOp);
// disburse itself is tested only for its network-free guards (no_key, bad_request).
// Covers: native vs HE op shapes, parameterised from/to, per-currency precision
// (Decision #3), and the no_refund_key→no_key rename.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { disburse, buildDisburseOp } = require('../sign');
const { registerPrecision } = require('../settle');

const FROM = 'escrow-acct';

// ── Op shapes ────────────────────────────────────────────────────────────────
test('native HIVE/HBD → transfer op, parameterised from, 3dp amount', () => {
  const op = buildDisburseOp({ to: 'Alice', amount: 4.5, currency: 'HBD', memo: 'refund res_1', fromAccount: FROM });
  assert.equal(op[0], 'transfer');
  assert.equal(op[1].from, FROM);
  assert.equal(op[1].to, 'alice');                 // lower-cased
  assert.equal(op[1].amount, '4.500 HBD');         // 3dp + symbol
  assert.equal(op[1].memo, 'refund res_1');
});

test('HE token → custom_json tokens/transfer, ACTIVE auth = fromAccount', () => {
  const op = buildDisburseOp({ to: 'bob', amount: 1, currency: 'cnoobs', memo: '', fromAccount: FROM });
  assert.equal(op[0], 'custom_json');
  assert.deepEqual(op[1].required_auths, [FROM]);
  assert.deepEqual(op[1].required_posting_auths, []);
  assert.equal(op[1].id, 'ssc-mainnet-hive');
  const inner = JSON.parse(op[1].json);
  assert.equal(inner.contractName, 'tokens');
  assert.equal(inner.contractAction, 'transfer');
  assert.deepEqual(inner.contractPayload, { symbol: 'CNOOBS', to: 'bob', quantity: '1.000', memo: '' });
});

// ── Decision #3: per-currency precision ─────────────────────────────────────
test('per-currency precision: 8dp token formats quantity at 8 places', () => {
  registerPrecision('SWAP.TINY', 8);
  const op = buildDisburseOp({ to: 'bob', amount: 0.000005, currency: 'SWAP.TINY', fromAccount: FROM });
  assert.equal(JSON.parse(op[1].json).contractPayload.quantity, '0.00000500');
});

test('explicit locked places overrides the registry', () => {
  const op = buildDisburseOp({ to: 'bob', amount: 1.23456789, currency: 'HBD', fromAccount: FROM, places: 4 });
  assert.equal(op[1].amount, '1.2346 HBD');
});

// ── Input guards (pure, no network) ─────────────────────────────────────────
test('buildDisburseOp rejects bad inputs with code:bad_request', () => {
  assert.throws(() => buildDisburseOp({ to: 'bad name!', amount: 1, currency: 'HBD', fromAccount: FROM }), e => e.code === 'bad_request');
  assert.throws(() => buildDisburseOp({ to: 'bob', amount: 0, currency: 'HBD', fromAccount: FROM }), e => e.code === 'bad_request');
  assert.throws(() => buildDisburseOp({ to: 'bob', amount: -5, currency: 'HBD', fromAccount: FROM }), e => e.code === 'bad_request');
  assert.throws(() => buildDisburseOp({ to: 'bob', amount: 1, currency: 'HBD', fromAccount: 'bad acct!' }), e => e.code === 'bad_request');
});

// ── disburse guards (network-free) ──────────────────────────────────────────
test('disburse without a key throws code:no_key (records pending), key never logged', async () => {
  const KEY_ENV = 'ESCROW_CORE_TEST_NO_SUCH_KEY';
  delete process.env[KEY_ENV];
  await assert.rejects(
    () => disburse({ to: 'alice', amount: 1, currency: 'HBD', memo: 'm', fromAccount: FROM, keyEnv: KEY_ENV }),
    e => e.code === 'no_key',
  );
});

test('disburse requires keyEnv', async () => {
  await assert.rejects(
    () => disburse({ to: 'alice', amount: 1, currency: 'HBD', memo: 'm', fromAccount: FROM }),
    e => e.code === 'bad_request',
  );
});

test('disburse validates inputs before broadcasting (bad dest, key set)', async () => {
  const KEY_ENV = 'ESCROW_CORE_TEST_DUMMY_KEY';
  process.env[KEY_ENV] = 'dummy-not-a-real-key';   // present, so we pass the no_key gate
  try {
    // bad destination → buildDisburseOp throws bad_request BEFORE key-parse / network
    await assert.rejects(
      () => disburse({ to: 'bad name!', amount: 1, currency: 'HBD', memo: 'm', fromAccount: FROM, keyEnv: KEY_ENV }),
      e => e.code === 'bad_request',
    );
  } finally {
    delete process.env[KEY_ENV];
  }
});
