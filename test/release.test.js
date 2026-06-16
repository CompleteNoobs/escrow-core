// escrow-core/test/release.test.js
//
// release.js is near drop-in from ipfs-gate — the spec is ipfs-gate's release-policy
// truth table (owner_only / any_of / all_of) plus v4call's duration_elapsed, and the
// fail-closed Hive-sig primitive. No DB, no clock (elapsed is supplied), no randomness
// (deterministic dhive keys) — sandbox-safe.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const dhive = require('@hiveio/dhive');

const {
  sha256Hex, sha256Bytes, verifyHiveSig,
  RELEASE_TYPES, normalizeReleasePolicy, evaluateRelease,
} = require('../release');

// ── normalizeReleasePolicy ──────────────────────────────────────────────────

test('normalizeReleasePolicy: defaults, validation, address hygiene', () => {
  // default → owner_only, empty addresses
  assert.deepEqual(normalizeReleasePolicy(undefined), { type: 'owner_only', addresses: [] });
  assert.deepEqual(normalizeReleasePolicy({}), { type: 'owner_only', addresses: [] });

  // addresses lower-cased, @-stripped, de-duped, empties dropped
  assert.deepEqual(
    normalizeReleasePolicy({ type: 'any_of', addresses: ['@Alice', 'alice', 'BOB', ''] }),
    { type: 'any_of', addresses: ['alice', 'bob'] }
  );

  // duration_elapsed is a valid type, needs no addresses
  assert.deepEqual(normalizeReleasePolicy({ type: 'duration_elapsed' }), { type: 'duration_elapsed', addresses: [] });
  assert.ok(RELEASE_TYPES.includes('duration_elapsed'));

  // bad type → coded throw
  assert.throws(() => normalizeReleasePolicy({ type: 'whoever' }), e => e.code === 'bad_request');
  // any_of / all_of with no addresses → coded throw
  assert.throws(() => normalizeReleasePolicy({ type: 'any_of', addresses: [] }), e => e.code === 'bad_request');
  assert.throws(() => normalizeReleasePolicy({ type: 'all_of' }), e => e.code === 'bad_request');
});

// ── evaluateRelease truth tables ────────────────────────────────────────────

test('owner_only: only the owner may release', () => {
  const policy = { type: 'owner_only' };
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'alice' }),
    { authorized: true, ends: true, records_consent: false });
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'bob' }),
    { authorized: false, ends: false, records_consent: false });
  // owner match is case/@ insensitive
  assert.deepEqual(evaluateRelease({ policy, owner: 'Alice', releaser: '@alice' }),
    { authorized: true, ends: true, records_consent: false });
});

test('any_of: owner OR any listed recipient ends it immediately', () => {
  const policy = { type: 'any_of', addresses: ['bob', 'carol'] };
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'alice' }),
    { authorized: true, ends: true, records_consent: false });          // owner override
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'bob' }),
    { authorized: true, ends: true, records_consent: false });          // listed recipient
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'dave' }),
    { authorized: false, ends: false, records_consent: false });        // unlisted
});

test('all_of: ends only once EVERY listed recipient has consented', () => {
  const policy = { type: 'all_of', addresses: ['bob', 'carol'] };

  // first recipient: authorized, records consent, but not yet ended
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'bob', consented: [] }),
    { authorized: true, ends: false, records_consent: true });

  // second recipient, first already consented → threshold met → ends
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'carol', consented: ['bob'] }),
    { authorized: true, ends: true, records_consent: true });

  // unlisted account → not authorized
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'dave', consented: ['bob'] }),
    { authorized: false, ends: false, records_consent: false });

  // owner override ends it without waiting for consensus
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'alice', consented: [] }),
    { authorized: true, ends: true, records_consent: false });
});

test('duration_elapsed (v4call): the time/end signal decides, not an account', () => {
  const policy = { type: 'duration_elapsed' };
  // condition fired → authorized + ends, no consent recorded
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'system', elapsed: true }),
    { authorized: true, ends: true, records_consent: false });
  // not yet elapsed → nothing happens
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'system', elapsed: false }),
    { authorized: false, ends: false, records_consent: false });
  // missing elapsed is treated as not-yet
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'system' }),
    { authorized: false, ends: false, records_consent: false });
  // owner can always end early, even before elapse
  assert.deepEqual(evaluateRelease({ policy, owner: 'alice', releaser: 'alice', elapsed: false }),
    { authorized: true, ends: true, records_consent: false });
});

// ── verifyHiveSig (the release-consent sig primitive) ───────────────────────

test('verifyHiveSig: valid sig verifies; tamper + wrong key + malformed fail closed', () => {
  const priv = dhive.PrivateKey.fromSeed('escrow-core-release-test');  // deterministic — no randomness
  const pub = priv.createPublic().toString();                          // STM-prefixed
  const message = 'escrow:release-consent:ref-abc123';
  const msgHash = sha256Bytes(Buffer.from(message, 'utf8'));
  const sigHex = priv.sign(msgHash).toBuffer().toString('hex');        // 130 hex chars

  // happy path
  assert.equal(verifyHiveSig(message, sigHex, pub), true);

  // tampered message → false
  assert.equal(verifyHiveSig(message + 'x', sigHex, pub), false);

  // wrong public key → false
  const otherPub = dhive.PrivateKey.fromSeed('someone-else').createPublic().toString();
  assert.equal(verifyHiveSig(message, sigHex, otherPub), false);

  // malformed sig / pubkey → false, never throws
  assert.equal(verifyHiveSig(message, 'not-a-sig', pub), false);
  assert.equal(verifyHiveSig(message, sigHex, 'not-a-key'), false);
  assert.equal(verifyHiveSig(message, null, pub), false);
});

test('sha256 helpers are stable + agree', () => {
  const b = Buffer.from('hello', 'utf8');
  assert.equal(sha256Hex(b), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(sha256Bytes(b).toString('hex'), sha256Hex(b));
});
