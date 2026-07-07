// escrow-core/test/sign.test.js
//
// disburse's op-building is pure + testable without a key or network (buildDisburseOp);
// disburse itself is tested only for its network-free guards (no_key, bad_request).
// Covers: native vs HE op shapes, parameterised from/to, per-currency precision
// (Decision #3), and the no_refund_key→no_key rename.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { disburse, buildDisburseOp, classifyBroadcastError } = require('../sign');
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

// ── Transient vs permanent broadcast classification (retry safety) ──────────
test('classifyBroadcastError: network signatures → transient; on-chain rejections → permanent', () => {
  for (const m of ['Invalid response body while trying to fetch https://api.hive.blog/: Premature close',
                   'connect ETIMEDOUT 91.121.216.162:443', 'fetch failed', 'The operation was aborted due to timeout',
                   'socket hang up', 'HTTP 503 from node', 'ECONNRESET']) {
    assert.equal(classifyBroadcastError(new Error(m)), 'transient', m);
  }
  for (const m of ['missing required active authority', 'Account does not have enough tokens to transfer',
                   'insufficient resource credits (RC)', 'invalid signature', 'transaction expired (tapos)',
                   'duplicate transaction']) {
    assert.equal(classifyBroadcastError(new Error(m)), 'permanent', m);
  }
  // unknown shapes fail closed to permanent (never blind-retry-broadcast the unknown)
  assert.equal(classifyBroadcastError(new Error('something weird happened')), 'permanent');
  assert.equal(classifyBroadcastError(Object.assign(new Error('x'), { code: 'no_key' })), 'permanent');
});

test('disburse maps a TRANSIENT broadcast error to code:transient (retryable), keeps permanent as-is', async () => {
  const KEY_ENV = 'ESCROW_CORE_TEST_XIENT_KEY';
  process.env[KEY_ENV] = require('@hiveio/dhive').PrivateKey.fromSeed('sign-transient-test').toString();
  const base = { to: 'alice', amount: 1, currency: 'HBD', memo: 'v4call:payout:r1', fromAccount: FROM, keyEnv: KEY_ENV };
  try {
    const transientClient = { broadcast: { sendOperations: async () => { throw new Error('api.hive.blog: Premature close'); } } };
    await assert.rejects(() => disburse(base, { client: transientClient }), e => e.code === 'transient');

    const permanentClient = { broadcast: { sendOperations: async () => { throw new Error('Account does not have enough tokens'); } } };
    await assert.rejects(() => disburse(base, { client: permanentClient }), e => e.code !== 'transient' && /enough tokens/.test(e.message));
  } finally { delete process.env[KEY_ENV]; }
});
