// escrow-core/settle.js — the money-safety cap invariant + per-currency precision.
//
// Distilled from ipfs-gate pricing.js (roundCoins / MIN_REFUND / the cap implicit
// in calculateRefund). The metering UNIT (pin-hours, call-seconds, …) is NOT here —
// each deployment supplies meteredUsage(record, now) via its adapter. This module
// holds only the two things the core exists to guarantee:
//
//   settlement = min(meteredUsage, deposit)   ← a lying/over-stated usage report can
//   refund     = deposit − settlement            only RE-SPLIT the verified envelope,
//                                                 never mint money (deposit is the cap).
//
// DECISION #3: ipfs-gate's single global RATE_FLOOR (3dp) becomes a PER-CURRENCY
// precision registry — configurable, and in production LOCKED at reservation time
// (passed as `places`), never a live money-path query. Defaults preserve ipfs-gate's
// 3dp exactly; correct for non-3dp Hive-Engine tokens.

'use strict';

// ─── Per-currency precision registry (Decision #3) ──────────────────────────
// ipfs-gate ran one global RATE_FLOOR=0.001 → 3dp for everything. The core
// generalises: each token rounds to its actual on-chain precision. Over-precise
// → the chain rejects the transfer; under-precise → funds round to 0 and strand.
const DEFAULT_PRECISION = parseInt(process.env.ESCROW_DEFAULT_PRECISION || '3', 10);

const PRECISION = new Map([
  // Native Hive chain assets are 3dp on-chain (preserves ipfs-gate behaviour).
  ['HIVE', 3],
  ['HBD', 3],
]);

/** Register/override a currency's on-chain precision (the value an adapter locks). */
function registerPrecision(currency, places) {
  if (typeof currency !== 'string' || !currency) {
    throw Object.assign(new Error('currency must be a non-empty string'), { code: 'bad_request' });
  }
  const p = Number(places);
  if (!Number.isInteger(p) || p < 0 || p > 12) {
    throw Object.assign(new Error(`precision places out of range: ${places}`), { code: 'bad_request' });
  }
  PRECISION.set(currency.toUpperCase(), p);
  return p;
}

/** Decimal places for a currency — registry hit, else the global default. */
function precision(currency) {
  if (currency && PRECISION.has(String(currency).toUpperCase())) {
    return PRECISION.get(String(currency).toUpperCase());
  }
  return DEFAULT_PRECISION;
}

// ─── Per-currency rounding ──────────────────────────────────────────────────
/**
 * Round a coin amount to a currency's on-chain precision.
 *   roundCoins(x)                  → DEFAULT_PRECISION (3dp) — ipfs-gate parity.
 *   roundCoins(x, 'SWAP.HBD')      → that currency's registered places.
 *   roundCoins(x, currency, 8)     → explicit `places` (the reservation-locked
 *                                     value) bypasses the registry — the money path.
 */
function roundCoins(amount, currency, places) {
  const p = Number.isInteger(places) ? places : precision(currency);
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error('amount must be a finite number'), { code: 'bad_request' });
  }
  return parseFloat(n.toFixed(p));
}

// ─── The cap invariant (money-safety core) ──────────────────────────────────
/**
 * settle — the one rule the custodial escrow guarantees.
 *
 *   settlement = round(min(meteredUsage, deposit))   // capped by the verified deposit
 *   refund     = round(deposit − settlement)         // always ≥ 0
 *   dust       = sub-floor refund remainder, RETAINED (not disbursed)
 *
 * When the refund falls below `dustFloor` it is suppressed (refund → 0) and the
 * remainder is reported as `dust` — reproducing ipfs-gate's MIN_REFUND discipline
 * (don't pay out amounts too small to be worth a transaction).
 *
 * Both deposit and meteredUsage are in the SAME coin unit: the adapter's
 * meteredUsage() has already multiplied through the locked rate. `lockedRate` is
 * accepted for API parity but intentionally NOT consumed here — settle stays
 * unit-agnostic so the rate lives in exactly one place (the adapter).
 *
 * @param {number} deposit       on-chain-verified amount paid — the hard cap. REQUIRED.
 * @param {number} meteredUsage  adapter-computed usage, in coins. REQUIRED.
 * @param {number} [dustFloor=0] below this a refund is retained as dust (ipfs-gate: 0.05).
 * @param {string} [currency]    for per-currency rounding (Decision #3).
 * @param {number} [places]      reservation-locked precision; overrides the registry.
 * @param {number} [lockedRate]  reserved (adapter pre-applies it into meteredUsage).
 * @returns {{settlement:number, refund:number, dust:number}}
 */
function settle({ deposit, meteredUsage, dustFloor = 0, currency, places, lockedRate } = {}) {
  const dep   = Number(deposit);
  const use   = Number(meteredUsage);
  const floor = Number(dustFloor) || 0;

  if (!Number.isFinite(dep) || dep < 0) {
    throw Object.assign(new Error('deposit must be a non-negative number'), { code: 'bad_request' });
  }
  if (!Number.isFinite(use) || use < 0) {
    throw Object.assign(new Error('meteredUsage must be a non-negative number'), { code: 'bad_request' });
  }

  const settlement = roundCoins(Math.min(use, dep), currency, places);
  const rawRefund  = roundCoins(dep - settlement, currency, places);

  if (rawRefund < floor) {
    return { settlement, refund: 0, dust: rawRefund };
  }
  return { settlement, refund: rawRefund, dust: 0 };
}

module.exports = { settle, roundCoins, precision, registerPrecision, PRECISION, DEFAULT_PRECISION };
