// escrow-core/index.js — the public API surface.
//
// This is what consumers require: `const escrow = require('escrow-core')`. It distils
// the proven escrow logic from ipfs-gate v0.1.3 (verify/replay/sign/settle/ledger/
// release) into one audited core, adds the escrow-protocol/0.1 Nostr-signed report
// contract, and exposes the small per-service adapter seam. Consumers PIN a version
// (escrow-core@^0.1) so a change for one service can't silently move another.
//
// The full module surfaces are also reachable under `.modules` for power users/tests.

'use strict';

const verify = require('./verify');
const sign = require('./sign');
const settle = require('./settle');
const ledger = require('./ledger');
const release = require('./release');
const protocol = require('./escrow-protocol');
const attestation = require('./attestation');
const adapter = require('./adapter');
const { createV4callAdapter } = require('./adapters/v4call');

let version = '0.1.0';
try { version = require('./package.json').version; } catch { /* best effort */ }

module.exports = {
  version,

  // ── CALL ATTESTATIONS (Step 6 — caller+callee co-sign call facts; shadow mode) ──
  buildCallAttestationPayload: attestation.buildCallAttestationPayload,
  verifyCallAttestation: attestation.verifyCallAttestation,
  verifyCallAttestationSet: attestation.verifyCallAttestationSet,

  // ── VERIFY + REPLAY (on-chain payment proof; native + HE-token) ──
  verifyPayment: verify.verifyPayment,
  verifySidechain: verify.verifySidechain,
  getAccountPostingPubkeys: verify.getAccountPostingPubkeys,
  findOutgoingByMemo: verify.findOutgoingByMemo,
  getTokenPrecision: verify.getTokenPrecision,
  isNativeCurrency: verify.isNativeCurrency,

  /**
   * Resolve (and cache) a currency's true on-chain precision. Native HIVE/HBD and
   * already-registered currencies answer from the registry; an unknown HE token is
   * looked up once on Hive-Engine (tokens table) and registered, so every later
   * precision()/roundCoins() call — including the sync placesFor paths — sees the
   * real value instead of the 3dp default. Fail-safe: on lookup failure returns the
   * registry default (3) WITHOUT caching, so a later call retries the lookup.
   * @param deps.lookup  injectable precision fetcher (tests); default getTokenPrecision
   */
  async resolvePrecision(currency, deps = {}) {
    const cur = String(currency || '').toUpperCase();
    if (!cur || verify.isNativeCurrency(cur) || settle.PRECISION.has(cur)) return settle.precision(cur);
    try {
      const p = await (deps.lookup || verify.getTokenPrecision)(cur);
      settle.registerPrecision(cur, p);
      return p;
    } catch (e) {
      console.warn(`[escrow] resolvePrecision(${cur}) lookup failed — using default ${settle.precision(cur)}dp this time: ${e.message}`);
      return settle.precision(cur);
    }
  },

  // ── SIGN (custodial disburse) ──
  disburse: sign.disburse,
  classifyBroadcastError: sign.classifyBroadcastError,

  // ── SETTLE (the money-safety cap + per-currency precision, Decision #3) ──
  settle: settle.settle,
  roundCoins: settle.roundCoins,
  precision: settle.precision,
  registerPrecision: settle.registerPrecision,

  // ── LEDGER (durable, idempotent; tx_id UNIQUE replay + single-winner flip) ──
  openLedger: ledger.openLedger,

  // ── RELEASE (signed-condition + the Hive-sig primitive) ──
  verifyHiveSig: release.verifyHiveSig,
  evaluateRelease: release.evaluateRelease,
  normalizeReleasePolicy: release.normalizeReleasePolicy,
  RELEASE_TYPES: release.RELEASE_TYPES,
  sha256Hex: release.sha256Hex,
  sha256Bytes: release.sha256Bytes,

  // ── ESCROW-PROTOCOL 0.1 (Nostr-signed reports/receipts + memo grammar) ──
  PROTO: protocol.PROTO,
  buildEventReport: protocol.buildEventReport,
  buildSettlementReceipt: protocol.buildSettlementReceipt,
  signReport: protocol.signReport,
  verifyReport: protocol.verifyReport,
  getReportingPubkey: protocol.getReportingPubkey,
  canonicalize: protocol.canonicalize,
  buildMemo: protocol.buildMemo,
  parseMemo: protocol.parseMemo,
  createSeenIds: protocol.createSeenIds,

  // ── ADAPTERS (the small per-service seam) ──
  validateAdapter: adapter.validateAdapter,
  createV4callAdapter,
  adapters: { v4call: createV4callAdapter },

  // ── Full module surfaces (escape hatch for internals/tests) ──
  modules: { verify, sign, settle, ledger, release, protocol, adapter },
};
