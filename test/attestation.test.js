// Call attestations (Step 6, shadow mode) — build/sign/verify round-trip using the
// EXACT client scheme: Hive ECDSA (dhive) over sha256 of the pipe-format payload,
// verified by pubkey-recover against the account's posting keys. Offline (keys are
// local throwaways; chain lookups injected).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dhive = require('@hiveio/dhive');
const {
  buildCallAttestationPayload,
  verifyCallAttestation,
  verifyCallAttestationSet,
} = require('../attestation');

// Two throwaway "user" posting keys (caller + callee).
const callerKey = dhive.PrivateKey.fromSeed('attest-caller');
const calleeKey = dhive.PrivateKey.fromSeed('attest-callee');
const callerPub = callerKey.createPublic().toString();
const calleePub = calleeKey.createPublic().toString();

// Sign exactly like desktop-app.html signRaw(): ECDSA over sha256(payload string).
function clientSign(att, key) {
  const payload = buildCallAttestationPayload(att);
  return key.sign(dhive.cryptoUtils.sha256(payload)).toString();
}

const START = 1_783_450_000_000;
const END   = START + 10 * 60_000; // 10 min call

function mkAtt(role, account, key, over = {}) {
  const att = { callId: 'call_1', role, account, startTs: START, endTs: END, ...over };
  att.sig = clientSign(att, key);
  return att;
}

const pubkeysFor = (map) => async (account) => {
  if (!(account in map)) throw new Error('account not found');
  return map[account];
};
const CHAIN = pubkeysFor({ alice: [callerPub], bob: [calleePub] });

test('payload is the fixed v1 pipe grammar, account lowercased', () => {
  assert.equal(
    buildCallAttestationPayload({ callId: 'call_1', role: 'caller', account: 'Alice', startTs: START, endTs: END }),
    `v4call-call-attest-v1|call_1|caller|alice|${START}|${END}`
  );
  assert.throws(() => buildCallAttestationPayload({ callId: 'x', role: 'operator', account: 'a' }), /role/);
});

test('single attestation: valid sig verifies, wrong key / tampered facts fail', () => {
  const att = mkAtt('caller', 'alice', callerKey);
  assert.deepEqual(verifyCallAttestation(att, [callerPub]), { ok: true });
  assert.equal(verifyCallAttestation(att, [calleePub]).ok, false, 'wrong posting key');
  assert.equal(verifyCallAttestation({ ...att, endTs: END + 60_000 }, [callerPub]).ok, false, 'tampered endTs breaks the sig');
  assert.equal(verifyCallAttestation({ ...att, sig: undefined }, [callerPub]).reason, 'missing');
  assert.match(verifyCallAttestation({ ...att, sig: 'garbage' }, [callerPub]).reason, /malformed/);
});

test('set verdict: both valid → ok:true, verdicts ok/ok', async () => {
  const atts = [mkAtt('caller', 'alice', callerKey), mkAtt('callee', 'bob', calleeKey)];
  const v = await verifyCallAttestationSet(atts, { callId: 'call_1', caller: 'alice', callee: 'bob', durationMs: END - START }, { getAccountPostingPubkeys: CHAIN });
  assert.equal(v.caller, 'ok');
  assert.equal(v.callee, 'ok');
  assert.equal(v.ok, true);
  assert.equal(v.anyPresent, true);
});

test('set verdict: absent attestations are absent, never an error (shadow-safe)', async () => {
  const v = await verifyCallAttestationSet([], { callId: 'call_1', caller: 'alice', callee: 'bob', durationMs: 1000 }, { getAccountPostingPubkeys: CHAIN });
  assert.deepEqual([v.caller, v.callee, v.ok, v.anyPresent], ['absent', 'absent', false, false]);
});

test('set verdict: a NODE-fabricated attestation (facts signed by the wrong user) fails sig check', async () => {
  // a lying node invents a callee attestation but can only sign with a key it holds
  const forged = mkAtt('callee', 'bob', callerKey); // signed with alice's key, claims bob
  const v = await verifyCallAttestationSet([forged], { callId: 'call_1', caller: 'alice', callee: 'bob', durationMs: END - START }, { getAccountPostingPubkeys: CHAIN });
  assert.equal(v.callee, 'sig_not_posting_key');
  assert.equal(v.ok, false);
});

test('set verdict: duration outside tolerance flags duration_mismatch BEFORE any chain lookup', async () => {
  const shortCall = mkAtt('caller', 'alice', callerKey, { endTs: START + 1_000 }); // 1s view vs 10min report
  const v = await verifyCallAttestationSet([shortCall], { callId: 'call_1', caller: 'alice', callee: 'bob', durationMs: END - START },
    { getAccountPostingPubkeys: async () => { throw new Error('must not be called'); } });
  assert.match(v.caller, /^duration_mismatch/);
});

test('set verdict: wrong callId / wrong account / unreachable chain are individually soft', async () => {
  const wrongCall = mkAtt('caller', 'alice', callerKey, { callId: 'call_2' });
  const wrongAcct = mkAtt('callee', 'mallory', calleeKey);
  const v = await verifyCallAttestationSet([wrongCall, wrongAcct], { callId: 'call_1', caller: 'alice', callee: 'bob', durationMs: END - START }, { getAccountPostingPubkeys: CHAIN });
  assert.equal(v.caller, 'wrong_callId');
  assert.equal(v.callee, 'wrong_account');

  const ok = mkAtt('caller', 'alice', callerKey);
  const down = await verifyCallAttestationSet([ok], { callId: 'call_1', caller: 'alice', callee: 'bob', durationMs: END - START },
    { getAccountPostingPubkeys: async () => { throw new Error('all hive nodes down'); } });
  assert.equal(down.caller, 'unverifiable', 'chain outage degrades, never throws');
});

test('adapter carries attestations verbatim into call-end facts', () => {
  const { createV4callAdapter } = require('../adapters/v4call');
  const adapter = createV4callAdapter({ account: 'test-escrow', currency: 'HBD', keyEnv: 'X' });
  const atts = [mkAtt('caller', 'alice', callerKey)];
  const rows = [{ tx_id: 't1', sender: 'alice', amount: 2, memo: 'v4call:pay:call_1:bob', currency: 'HBD', rate_per_hour: 1, start_ts: START, platform_fee: 0.1, callee: 'bob' }];
  const facts = adapter.buildCallEndReportFacts({ payRows: rows, endReason: 'hangup', now: END, attestations: atts });
  assert.deepEqual(facts.attestations, atts);
  const bare = adapter.buildCallEndReportFacts({ payRows: rows, endReason: 'hangup', now: END });
  assert.equal(bare.attestations, undefined, 'absent stays absent (no empty arrays in the signed payload)');
});
