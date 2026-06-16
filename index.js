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
const adapter = require('./adapter');
const { createV4callAdapter } = require('./adapters/v4call');

let version = '0.1.0';
try { version = require('./package.json').version; } catch { /* best effort */ }

module.exports = {
  version,

  // ── VERIFY + REPLAY (on-chain payment proof; native + HE-token) ──
  verifyPayment: verify.verifyPayment,
  verifySidechain: verify.verifySidechain,
  getAccountPostingPubkeys: verify.getAccountPostingPubkeys,
  isNativeCurrency: verify.isNativeCurrency,

  // ── SIGN (custodial disburse) ──
  disburse: sign.disburse,

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
