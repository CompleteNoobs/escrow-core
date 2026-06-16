// ipfs-gate v0.1 — envelope helpers + Hive signature verification.
//
// Two distinct signatures from the spec:
//   1. upload_proof_sig — sender's Hive sig over the upload proof message.
//      Audience: ipfs-gate at /upload. Discarded after verification.
//   2. envelope_sig — sender's Hive sig over the v4call envelope.
//      Audience: recipients. ipfs-gate doesn't verify this; the recipient
//      client does. We expose helpers here so v4call can reuse them.

const crypto = require('crypto');
const dhive = require('@hiveio/dhive');

// ─── Hash helpers ───────────────────────────────────────────────────────────

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest();
}

// ─── Canonical messages ─────────────────────────────────────────────────────

/**
 * Canonical message a sender signs as their upload proof.
 * Server reconstructs the same string from the request fields and verifies.
 *
 * Format:
 *   ipfs-gate:upload-proof:v1:<ciphertext_sha256_hex>:<reservation_id>:<uploader>
 *
 * - Namespaced prefix prevents cross-protocol replay
 * - Versioned ("v1") so future canonical changes don't silently break
 * - Three independent fields colon-separated; all lower-case where possible
 */
function buildUploadProofMessage({ ciphertextSha256Hex, reservationId, uploader }) {
  if (!/^[a-f0-9]{64}$/.test(ciphertextSha256Hex)) {
    throw new Error('ciphertextSha256Hex must be 64 hex chars');
  }
  if (!/^[a-f0-9]{16}$/.test(reservationId)) {
    throw new Error('reservationId must be 16 hex chars');
  }
  const u = String(uploader || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(u)) {
    throw new Error('uploader must be a valid Hive account name');
  }
  return `ipfs-gate:upload-proof:v1:${ciphertextSha256Hex}:${reservationId}:${u}`;
}

/**
 * Canonical hash for the v4call envelope sig.
 * Recipients use this; ipfs-gate exposes it for client reuse.
 *
 * Sort recipient identities (Hive accounts), join with comma. Do NOT include
 * the encrypted K values — see plan-file rationale (allows v0.2 forwarding
 * without re-signing).
 */
function buildEnvelopeSigInput({ cid, size_bytes, sender, created_at, expires_at, room, kind_hint, per_recipient }) {
  const recipients = Object.keys(per_recipient || {}).map(s => s.toLowerCase()).sort();
  return `${cid}|${size_bytes}|${sender}|${created_at}|${expires_at}|${room}|${kind_hint}|${recipients.join(',')}`;
}

function envelopeSigHash(envelope) {
  return sha256Hex(Buffer.from(buildEnvelopeSigInput(envelope), 'utf8'));
}

// ─── Hive signature verification ────────────────────────────────────────────

/**
 * Verify that `sigStr` is a valid Hive signature over `messageBytes` by `pubKeyStr`.
 * - messageBytes: Buffer or string. Will be sha256-hashed before verify (dhive ECDSA over sha256(msg)).
 * - pubKeyStr: STM-prefixed Hive public key string (e.g. "STM6vJmrwaX...").
 * - sigStr: hex string (Keychain returns hex) OR base58 SIG_ format.
 * Returns boolean. Never throws on a malformed sig — returns false.
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
    // Don't leak parsing errors — just fail closed
    console.warn(`[envelope] verifyHiveSig failed: ${e.message}`);
    return false;
  }
}

/**
 * Convenience: verify an upload-proof signature given the raw fields.
 */
function verifyUploadProof({
  ciphertextSha256Hex,
  reservationId,
  uploader,
  uploaderPubkey,
  sigStr
}) {
  const message = buildUploadProofMessage({ ciphertextSha256Hex, reservationId, uploader });
  return verifyHiveSig(message, sigStr, uploaderPubkey);
}

module.exports = {
  sha256Hex,
  sha256Bytes,
  buildUploadProofMessage,
  buildEnvelopeSigInput,
  envelopeSigHash,
  verifyHiveSig,
  verifyUploadProof
};