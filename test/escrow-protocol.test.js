// escrow-core/test/escrow-protocol.test.js
//
// Spec (handover §7): round-trip a report through sign→verify with a Nostr keypair;
// a tampered field fails; parseMemo(buildMemo(x)) === x. Plus receipt round-trip,
// the pubkey-binding check, canonical-form stability, and the seenIds one-shot guard.
//
// Deterministic 32-byte secret keys (no randomness needed for keys) keep it stable.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROTO, canonicalize,
  buildEventReport, buildSettlementReceipt,
  signReport, verifyReport, getReportingPubkey,
  buildMemo, parseMemo, createSeenIds,
} = require('../escrow-protocol');

const SK = '1'.repeat(64);                 // fixed reporting key (x-only schnorr)
const OTHER_SK = '2'.repeat(64);
const PUB = getReportingPubkey(SK);

// ── Canonical payloads ───────────────────────────────────────────────────────
test('buildEventReport shapes the parent §9 #1 field set', () => {
  const r = buildEventReport({ service: 'v4call', ref: 'res_1', subject: 'call_9', facts: { seconds: 120, ratePerHour: 2 }, nonce: 'n1', createdAt: 1700, reporter: 'alice' });
  assert.equal(r.proto, PROTO);
  assert.equal(r.type, 'event-report');
  assert.equal(r.ref, 'res_1');
  assert.equal(r.subject, 'call_9');
  assert.deepEqual(r.facts, { seconds: 120, ratePerHour: 2 });
  assert.equal(r.reporter, 'alice');
  assert.throws(() => buildEventReport({ ref: 'r', nonce: 'n', reporter: 'a' }), e => e.code === 'bad_request'); // missing service
});

test('buildSettlementReceipt shapes the parent §9 #1 field set + validates status', () => {
  const r = buildSettlementReceipt({ ref: 'res_1', settlement: 6, refund: 4, dust: 0, currency: 'HBD', disburseTx: 'tx_1', status: 'settled', createdAt: 1700 });
  assert.equal(r.proto, PROTO);
  assert.equal(r.type, 'settlement-receipt');
  assert.equal(r.disburse_tx, 'tx_1');
  assert.equal(r.status, 'settled');
  assert.throws(() => buildSettlementReceipt({ ref: 'r', currency: 'HBD', status: 'bogus' }), e => e.code === 'bad_request');
});

// ── Sign → verify round-trip + tamper ────────────────────────────────────────
test('event-report round-trips sign → verify; a tampered field fails', () => {
  const report = buildEventReport({ service: 'v4call', ref: 'res_1', subject: 'call_9', facts: { seconds: 120 }, nonce: 'n1', createdAt: 1700, reporter: 'alice' });
  const signed = signReport(report, SK);

  assert.equal(signed.pubkey, PUB);
  assert.equal(typeof signed.sig, 'string');
  assert.equal(verifyReport(signed), true, 'valid sig verifies');

  // tamper a money-relevant fact → fails
  assert.equal(verifyReport({ ...signed, facts: { seconds: 999999 } }), false);
  // tamper the ref → fails
  assert.equal(verifyReport({ ...signed, ref: 'res_evil' }), false);
  // tamper the sig → fails
  assert.equal(verifyReport({ ...signed, sig: '0'.repeat(128) }), false);
  // strip the sig → fails closed (no throw)
  assert.equal(verifyReport(report), false);
});

test('settlement-receipt round-trips sign → verify', () => {
  const receipt = buildSettlementReceipt({ ref: 'res_1', settlement: 6, refund: 4, dust: 0, currency: 'HBD', disburseTx: 'tx_1', status: 'settled', createdAt: 1700 });
  const signed = signReport(receipt, SK);
  assert.equal(verifyReport(signed), true);
  assert.equal(verifyReport({ ...signed, refund: 999 }), false);   // can't restate the split
});

test('pubkey binding: verify fails when the signer is not the expected reporting key', () => {
  const report = buildEventReport({ service: 'v4call', ref: 'res_1', facts: {}, nonce: 'n1', reporter: 'alice' });
  const signed = signReport(report, OTHER_SK);

  assert.equal(verifyReport(signed), true, 'sig itself is valid');
  assert.equal(verifyReport(signed, PUB), false, 'but it is not the on-chain-bound key → rejected');
  assert.equal(verifyReport(signReport(report, SK), PUB), true, 'the bound key verifies');
});

test('canonical form is key-order independent (sign is stable)', () => {
  const a = { proto: PROTO, ref: 'r', facts: { b: 1, a: 2 } };
  const b = { facts: { a: 2, b: 1 }, ref: 'r', proto: PROTO };
  assert.equal(canonicalize(a), canonicalize(b));
  // signing the same logical payload built in different key order verifies cross-wise
  const s1 = signReport(a, SK);
  assert.equal(verifyReport({ ...b, sig: s1.sig, pubkey: s1.pubkey }), true);
});

// ── Memo grammar ─────────────────────────────────────────────────────────────
test('parseMemo(buildMemo(x)) === x across namespaces', () => {
  for (const x of [
    { namespace: 'v4call', purpose: 'call', reservationId: 'call_abc123' },
    { namespace: 'ipfs-gate', purpose: 'upload', reservationId: 'a1b2c3d4e5f60718' },
    { namespace: 'v4call', purpose: 'invite', reservationId: 'id:with:colons' },   // resId may contain colons
  ]) {
    assert.deepEqual(parseMemo(buildMemo(x)), x);
  }
});

test('buildMemo validates namespace/purpose; parseMemo returns null on non-match', () => {
  assert.throws(() => buildMemo({ namespace: 'BAD CAPS', purpose: 'call', reservationId: 'x' }), e => e.code === 'bad_request');
  assert.throws(() => buildMemo({ namespace: 'v4call', purpose: 'call', reservationId: '' }), e => e.code === 'bad_request');
  assert.equal(parseMemo('not-a-memo'), null);
  assert.equal(parseMemo('only:two'), null);
  assert.equal(parseMemo(42), null);
});

// ── One-shot dedup ───────────────────────────────────────────────────────────
test('createSeenIds: markSeen is true once then false (replay/one-shot)', () => {
  const seen = createSeenIds(3);
  assert.equal(seen.markSeen('n1'), true,  'first sighting proceeds');
  assert.equal(seen.markSeen('n1'), false, 'replay is dropped');
  assert.equal(seen.has('n1'), true);

  // bounded: exceeding maxSize resets (cheap in-memory guard; ledger is authoritative)
  seen.markSeen('n2'); seen.markSeen('n3');
  assert.equal(seen.size, 3);
  seen.markSeen('n4');                  // triggers clear() then add
  assert.equal(seen.has('n1'), false, 'old ids dropped after reset');
  assert.equal(seen.size, 1);
});
