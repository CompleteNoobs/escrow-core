// ── escrow-core/attestation.js — v4call call attestations (Step 6, shadow mode) ──
//
// Answers the trust question nGate cannot: "did the reported call REALLY happen with
// that duration?" (handover-decoupling §7). Caller and callee each sign their own view
// of the call facts with their HIVE POSTING KEY — the key both parties already hold in
// the call client, already bound on-chain to their account. The escrow box verifies
// each signature INDEPENDENTLY of the reporting node (ECDSA-recover → match against
// the account's on-chain posting key_auths), so a lying node cannot fabricate them:
// it would need the users' private keys.
//
// SHADOW MODE (the shipping default): the box verifies + logs a per-call verdict and
// settles exactly as before, regardless of the verdict. ATTESTATION_ENFORCE=true (the
// Step-6 promotion flag — restricted circle → expert review → enforce → open fed)
// makes a failed/absent verdict terminally reject the settlement instead.
//
// Payload is a FIXED PIPE-DELIMITED string, not JSON — the client (browser), the node
// and the box must produce byte-identical payloads and a fixed grammar has no
// canonicalization pitfalls across three runtimes:
//
//     v4call-call-attest-v1|<callId>|<role>|<account>|<startTs>|<endTs>
//
// role ∈ caller|callee. startTs = the SERVER-authoritative call start (echoed to both
// clients at call-accepted), endTs = the signer's local clock at signing. Each party
// signs their OWN view; the box checks each attestation's implied duration against the
// report's metered duration within a tolerance instead of requiring the two parties to
// coordinate byte-identical facts at hang-up.
//
// Signature scheme: Hive ECDSA (recoverable, dhive Signature.toString() compact form)
// over sha256(payload) — the exact scheme desktop-app.html's signRaw()/signMessage()
// already produce and verifySignature() already checks client-side. This is the THIRD
// signature family in the protocol and stays distinct: Hive ECDSA release-consent
// (users), schnorr/BIP340 escrow-protocol (node↔box), and now Hive ECDSA attestations
// (users again — same family as release-consent, different payload grammar).

'use strict';

const dhive = require('@hiveio/dhive');

const ATTESTATION_V1_PREFIX = 'v4call-call-attest-v1';
const ROLES = new Set(['caller', 'callee']);

/** Build the exact string both the client signs and the box verifies. */
function buildCallAttestationPayload({ callId, role, account, startTs, endTs }) {
  if (!callId || !ROLES.has(role) || !account) {
    throw Object.assign(new Error('attestation payload: callId, role (caller|callee), account required'), { code: 'bad_request' });
  }
  return `${ATTESTATION_V1_PREFIX}|${callId}|${role}|${String(account).toLowerCase()}|${Number(startTs) || 0}|${Number(endTs) || 0}`;
}

/**
 * Verify ONE attestation object { callId, role, account, startTs, endTs, sig } against
 * the account's on-chain posting pubkeys. PURE given the pubkeys — chain I/O is the
 * caller's (inject getAccountPostingPubkeys result). Returns
 *   { ok: true }                                on a valid signature
 *   { ok: false, reason: '<short-reason>' }     otherwise (never throws on bad input)
 */
function verifyCallAttestation(att, postingPubkeys) {
  try {
    if (!att || !att.sig) return { ok: false, reason: 'missing' };
    const payload = buildCallAttestationPayload(att);
    const hash = dhive.cryptoUtils.sha256(payload);
    const recovered = dhive.Signature.fromString(String(att.sig)).recover(hash).toString();
    const keys = (postingPubkeys || []).map(String);
    if (!keys.length) return { ok: false, reason: 'no_posting_keys' };
    return keys.includes(recovered) ? { ok: true } : { ok: false, reason: 'sig_not_posting_key' };
  } catch (e) {
    return { ok: false, reason: `malformed: ${e.message}` };
  }
}

/**
 * Verify the attestation SET carried in a call-end report's facts against the report's
 * own money facts. Shadow-mode verdict builder — NEVER throws; chain lookups are
 * injected and individually fail-soft (an unreachable Hive node yields 'unverifiable',
 * not a crash — the box must still settle in shadow mode).
 *
 * @param attestations   facts.attestations — array of { callId, role, account, startTs, endTs, sig }
 * @param expect         { callId, caller, callee, durationMs, toleranceMs? }
 * @param deps           { getAccountPostingPubkeys(account) → [pubkeys] }
 * @returns { caller: 'ok'|'absent'|'<fail reason>', callee: …, ok: bool (both ok),
 *            anyPresent: bool, details: [per-attestation {role, account, verdict, durationDeltaMs}] }
 */
async function verifyCallAttestationSet(attestations, expect, deps = {}) {
  const out = { caller: 'absent', callee: 'absent', ok: false, anyPresent: false, details: [] };
  const list = Array.isArray(attestations) ? attestations : [];
  const tolerance = Number(expect.toleranceMs) || Math.max(30_000, (Number(expect.durationMs) || 0) * 0.10);

  for (const att of list) {
    if (!att || !ROLES.has(att.role)) continue;
    out.anyPresent = true;
    const expectedAccount = att.role === 'caller' ? expect.caller : expect.callee;
    let verdict;
    const attDur = (Number(att.endTs) || 0) - (Number(att.startTs) || 0);
    const durationDeltaMs = Math.abs(attDur - (Number(expect.durationMs) || 0));
    if (String(att.callId) !== String(expect.callId)) {
      verdict = 'wrong_callId';
    } else if (!expectedAccount || String(att.account).toLowerCase() !== String(expectedAccount).toLowerCase()) {
      verdict = 'wrong_account';
    } else if (durationDeltaMs > tolerance) {
      verdict = `duration_mismatch(Δ${Math.round(durationDeltaMs / 1000)}s>±${Math.round(tolerance / 1000)}s)`;
    } else {
      let pubkeys = null;
      try { pubkeys = await deps.getAccountPostingPubkeys(att.account); }
      catch (e) { verdict = 'unverifiable'; }
      if (pubkeys) {
        const v = verifyCallAttestation(att, pubkeys);
        verdict = v.ok ? 'ok' : v.reason;
      }
    }
    out[att.role] = verdict;
    out.details.push({ role: att.role, account: att.account, verdict, durationDeltaMs });
  }
  out.ok = out.caller === 'ok' && out.callee === 'ok';
  return out;
}

module.exports = {
  ATTESTATION_V1_PREFIX,
  buildCallAttestationPayload,
  verifyCallAttestation,
  verifyCallAttestationSet,
};
