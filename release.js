// escrow-core/release.js — signed-condition RELEASE + the Hive-sig primitive.
//
// Distilled from ipfs-gate release-policy.js (evaluateRelease / normalizeReleasePolicy
// / RELEASE_TYPES) + the CORE half of envelope.js (verifyHiveSig + sha256 helpers).
// ipfs-gate's upload-proof / envelope canonical-message builders are deliberately
// LEFT OUT — they're ipfs-gate's wire format, not escrow-core's concern.
//
// TWO SIGNATURE FAMILIES exist in the system and MUST stay distinct (handover §5):
//   - RELEASE-CONSENT sigs (HERE): Hive ECDSA over sha256(canonical msg) — verifyHiveSig.
//   - escrow-protocol report/receipt sigs: NOSTR schnorr/BIP340 (escrow-protocol.js).
// Don't merge them.
//
// A release_policy decides WHO (or WHAT condition) may end an escrow. The OWNER
// can always release (override), regardless of type.
//   owner_only                       only the owner                         (ipfs-gate)
//   any_of  { addresses:[a,b,…] }    owner OR any listed recipient          (ipfs-gate)
//   all_of  { addresses:[a,b,…] }    owner, OR ALL listed recipients (consensus) (ipfs-gate)
//   duration_elapsed                 auto-release once the time/end signal fires (v4call)

'use strict';

const crypto = require('crypto');
const dhive = require('@hiveio/dhive');

// ─── Hash helpers (from envelope.js — drop-in) ──────────────────────────────

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

// ─── Hive signature verification (from envelope.js — drop-in, fail-closed) ──

/**
 * Verify `sigStr` is a valid Hive signature over `messageBytes` by `pubKeyStr`.
 * - messageBytes: Buffer or string; sha256-hashed before verify (dhive ECDSA over sha256(msg)).
 * - pubKeyStr: STM-prefixed Hive public key (e.g. "STM6vJ…").
 * - sigStr: hex string (Keychain) OR base58 SIG_ format.
 * Returns boolean. Never throws on a malformed sig — fails closed (returns false).
 */
function verifyHiveSig(messageBytes, sigStr, pubKeyStr) {
  try {
    const msg = Buffer.isBuffer(messageBytes) ? messageBytes : Buffer.from(messageBytes, 'utf8');
    const msgHash = sha256Bytes(msg);

    const pub = dhive.PublicKey.from(pubKeyStr);
    let sig;
    if (typeof sigStr === 'string' && sigStr.startsWith('SIG_')) {
      sig = dhive.Signature.fromString(sigStr);
    } else if (typeof sigStr === 'string' && /^[0-9a-f]{130,}$/i.test(sigStr)) {
      sig = dhive.Signature.fromBuffer(Buffer.from(sigStr, 'hex'));
    } else {
      return false;
    }

    return pub.verify(msgHash, sig);
  } catch (e) {
    // Don't leak parsing errors — fail closed.
    console.warn(`[release] verifyHiveSig failed: ${e.message}`);
    return false;
  }
}

// ─── Release-policy evaluation (from release-policy.js + duration_elapsed) ───

const RELEASE_TYPES = ['owner_only', 'any_of', 'all_of', 'duration_elapsed'];

/** Validate + normalise a release_policy object. Throws code:'bad_request' on bad input. */
function normalizeReleasePolicy(policy) {
  const p = policy || { type: 'owner_only' };
  const type = p.type || 'owner_only';
  if (!RELEASE_TYPES.includes(type)) {
    throw Object.assign(new Error(`release_policy.type must be one of ${RELEASE_TYPES.join('|')}`), { code: 'bad_request' });
  }
  let addresses = Array.isArray(p.addresses) ? p.addresses : [];
  addresses = [...new Set(addresses.map(a => String(a).toLowerCase().replace(/^@/, '')))].filter(Boolean);
  if ((type === 'any_of' || type === 'all_of') && addresses.length === 0) {
    throw Object.assign(new Error(`release_policy.type '${type}' requires a non-empty addresses list`), { code: 'bad_request' });
  }
  // duration_elapsed carries no addresses; any are ignored.
  return { type, addresses };
}

/**
 * Decide a release attempt. PURE — the caller supplies prior consent (all_of) and,
 * for duration_elapsed, the `elapsed` signal (computed by the adapter from the
 * record + now; this module never reads the clock). Returns:
 *   { authorized,        // may this account / has this condition cleared to act?
 *     ends,              // is the threshold now met → end the escrow?
 *     records_consent }  // should the caller persist this releaser's consent? (all_of only)
 *
 * @param policy     release_policy object (normalised internally).
 * @param owner      the escrow owner (always allowed — override).
 * @param releaser   the account attempting release.
 * @param consented  accounts that have ALREADY consented (all_of).
 * @param elapsed    boolean — for duration_elapsed, has the time/end condition fired?
 */
function evaluateRelease({ policy, owner, releaser, consented = [], elapsed }) {
  const { type, addresses } = normalizeReleasePolicy(policy);
  const who = String(releaser || '').toLowerCase().replace(/^@/, '');
  const ownerLc = String(owner || '').toLowerCase();

  if (who && who === ownerLc) {
    return { authorized: true, ends: true, records_consent: false };  // owner override
  }

  if (type === 'duration_elapsed') {
    // No human releaser — the time/call-ended condition decides.
    const done = !!elapsed;
    return { authorized: done, ends: done, records_consent: false };
  }

  if (type === 'owner_only') {
    return { authorized: false, ends: false, records_consent: false };
  }
  if (!addresses.includes(who)) {
    return { authorized: false, ends: false, records_consent: false }; // not a listed recipient
  }
  if (type === 'any_of') {
    return { authorized: true, ends: true, records_consent: false };
  }
  // all_of — every listed address must have consented (incl. this one).
  const have = new Set(consented.map(a => String(a).toLowerCase()));
  have.add(who);
  const ends = addresses.every(a => have.has(a));
  return { authorized: true, ends, records_consent: true };
}

module.exports = {
  // crypto primitives
  sha256Hex,
  sha256Bytes,
  verifyHiveSig,
  // policy evaluation
  RELEASE_TYPES,
  normalizeReleasePolicy,
  evaluateRelease,
};
