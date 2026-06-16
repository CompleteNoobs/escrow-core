// escrow-core/escrow-protocol.js — the escrow-protocol/0.1 contract (Decision #1).
//
// NEW code — NONE of the 5 extracted ipfs-gate files contained Nostr signing. The
// node↔escrow messages (event-report / settlement-receipt) are signed by the
// on-chain-bound escrow-reporting NOSTR key (schnorr / BIP340) — the SAME x-only
// key family as v4call's nostr-fed.mjs identity (interoperable: schnorr.getPublicKey
// here == nostr-tools getPublicKey there).
//
// The signature is over a CANONICAL serialisation of the payload (sorted-key JSON),
// NOT over a Nostr event id — so the transport stays swappable. A transport
// (nostr-fed.mjs, a future escrow transport, even WS) merely CARRIES the signed
// payload; trust rides on this sig + the consumer's pubkey↔account binding check.
//
// This sig family is DISTINCT from the release-consent layer (release.verifyHiveSig,
// Hive ECDSA). Two families by design — never merge them.
//
// We use @noble/curves' schnorr (the primitive nostr-tools is built on) so the core
// stays synchronous CommonJS (nostr-tools v2 is ESM-only). sha256 via node crypto.

'use strict';

const crypto = require('crypto');
const { schnorr } = require('@noble/curves/secp256k1');

const PROTO = 'escrow-protocol/0.1';
const RECEIPT_STATUSES = ['settled', 'pending', 'skipped', 'failed'];

// ─── Canonical serialisation (deterministic, sorted keys) ───────────────────
// Stable across key-insertion order so sign + verify always agree. Arrays keep
// order; objects sort keys recursively; undefined is dropped.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw Object.assign(new Error('invalid hex'), { code: 'bad_request' });
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
const bytesToHex = (bytes) => Buffer.from(bytes).toString('hex');

function payloadDigest(payload) {
  return crypto.createHash('sha256').update(canonicalize(payload), 'utf8').digest();
}

// ─── Canonical payloads (parent §9 decision #1 field sets) ──────────────────

/** node → escrow: a signed report of metering facts for one escrow `ref`. */
function buildEventReport({ service, ref, subject, facts, nonce, createdAt, reporter }) {
  if (!service || !ref || !nonce || !reporter) {
    throw Object.assign(new Error('buildEventReport: service, ref, nonce, reporter are required'), { code: 'bad_request' });
  }
  if (facts != null && (typeof facts !== 'object' || Array.isArray(facts))) {
    throw Object.assign(new Error('buildEventReport: facts must be an object'), { code: 'bad_request' });
  }
  return {
    proto: PROTO,
    type: 'event-report',
    service,
    ref,
    subject: subject ?? null,        // callId | pinId
    facts: facts ?? {},              // adapter inputs to meteredUsage()
    nonce,                           // one-shot replay key (see createSeenIds)
    created_at: createdAt ?? null,
    reporter,                        // node hive account
  };
}

/** escrow → node: a signed settlement outcome for one escrow `ref`. */
function buildSettlementReceipt({ ref, settlement, refund, dust, currency, disburseTx, status, createdAt }) {
  if (!ref || !currency || !status) {
    throw Object.assign(new Error('buildSettlementReceipt: ref, currency, status are required'), { code: 'bad_request' });
  }
  if (!RECEIPT_STATUSES.includes(status)) {
    throw Object.assign(new Error(`buildSettlementReceipt: status must be one of ${RECEIPT_STATUSES.join('|')}`), { code: 'bad_request' });
  }
  return {
    proto: PROTO,
    type: 'settlement-receipt',
    ref,
    settlement: Number(settlement),
    refund: Number(refund),
    dust: Number(dust ?? 0),
    currency,
    disburse_tx: disburseTx ?? null,  // txId | null (pending/skipped/failed)
    status,
    created_at: createdAt ?? null,
  };
}

// ─── Schnorr sign / verify over the canonical payload ───────────────────────

/** Derive the x-only reporting pubkey (hex) from a 32-byte secret key (hex). */
function getReportingPubkey(skHex) {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(skHex)));
}

/**
 * Sign a report/receipt payload with the escrow-reporting key. Returns the payload
 * with `sig` (hex) + `pubkey` (x-only hex) attached. Works for any escrow-protocol
 * payload (event-report or settlement-receipt) — generic over the canonical form.
 */
function signReport(payload, skHex) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('signReport: payload must be an object'), { code: 'bad_request' });
  }
  const { sig: _s, pubkey: _p, ...clean } = payload;   // never sign over an existing sig/pubkey
  const sk = hexToBytes(skHex);
  const sig = bytesToHex(schnorr.sign(payloadDigest(clean), sk));
  return { ...clean, sig, pubkey: bytesToHex(schnorr.getPublicKey(sk)) };
}

/**
 * Verify a signed report/receipt. Recomputes the canonical digest over the payload
 * (minus sig/pubkey) and checks the schnorr sig. Fails CLOSED (returns false) on any
 * malformed input. If `expectedPubkey` is given, also asserts the signer matches it
 * (the consumer's on-chain-bound-key check — caller still owns that binding).
 */
function verifyReport(signed, expectedPubkey) {
  try {
    if (!signed || typeof signed !== 'object') return false;
    const { sig, pubkey, ...payload } = signed;
    if (typeof sig !== 'string' || typeof pubkey !== 'string') return false;
    if (expectedPubkey && pubkey !== expectedPubkey) return false;
    return schnorr.verify(hexToBytes(sig), payloadDigest(payload), hexToBytes(pubkey));
  } catch {
    return false;
  }
}

// ─── Memo grammar: <namespace>:<purpose>:<reservation_id> ───────────────────
// Generalises ipfs-gate's hardcoded `ipfs-gate:upload:<16hex>` (quota.js) and
// v4call's `v4call:call:<id>`. namespace + purpose are adapter config; the
// reservation_id is server-minted. Zero migration to live verify.
const MEMO_FIELD = /^[a-z0-9][a-z0-9-]*$/;

function buildMemo({ namespace, purpose, reservationId }) {
  if (!MEMO_FIELD.test(String(namespace || ''))) {
    throw Object.assign(new Error(`invalid memo namespace: ${namespace}`), { code: 'bad_request' });
  }
  if (!MEMO_FIELD.test(String(purpose || ''))) {
    throw Object.assign(new Error(`invalid memo purpose: ${purpose}`), { code: 'bad_request' });
  }
  const rid = String(reservationId || '');
  if (!rid) {
    throw Object.assign(new Error('invalid memo reservationId'), { code: 'bad_request' });
  }
  return `${namespace}:${purpose}:${reservationId}`;
}

/** Parse a memo into { namespace, purpose, reservationId }, or null if it doesn't match. */
function parseMemo(memo) {
  if (typeof memo !== 'string') return null;
  const m = memo.match(/^([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*):(.+)$/);
  return m ? { namespace: m[1], purpose: m[2], reservationId: m[3] } : null;
}

// ─── One-shot dedup (mirrors v4call's seenIds / seenFedEventIds) ─────────────
/**
 * Bounded one-shot dedup set for nonces / event ids (replay / store-and-forward).
 * markSeen(id) → true the FIRST time (proceed), false on a repeat (drop). The set
 * resets when it exceeds maxSize — the durable ledger (tx_id UNIQUE) is the
 * authoritative replay guard; this is the cheap in-memory first line.
 */
function createSeenIds(maxSize = 5000) {
  const seen = new Set();
  return {
    markSeen(id) {
      if (seen.has(id)) return false;
      if (seen.size >= maxSize) seen.clear();
      seen.add(id);
      return true;
    },
    has: (id) => seen.has(id),
    clear: () => seen.clear(),
    get size() { return seen.size; },
  };
}

module.exports = {
  PROTO,
  RECEIPT_STATUSES,
  canonicalize,
  buildEventReport,
  buildSettlementReceipt,
  signReport,
  verifyReport,
  getReportingPubkey,
  buildMemo,
  parseMemo,
  createSeenIds,
};
