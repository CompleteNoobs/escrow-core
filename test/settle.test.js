// escrow-core/test/settle.test.js
//
// ipfs-gate's pricing.js IS the spec. The core's settle() + an ipfs-gate-shaped
// meteredUsage() must reproduce calculateRefund's exact numbers — including the
// dust floor and 3dp rounding (handover §7). Then the Decision #3 non-3dp case,
// the cap-can't-mint-money invariant, and roundCoins parity.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../pricing');       // the golden reference (still-present source file)
const { settle, roundCoins, registerPrecision, precision } = require('../settle');

const { HOUR_MS, MB_DIVISOR, MIN_REFUND, RATE_PER_MB_HOUR } = pricing;

// An ipfs-gate-shaped meteredUsage(): pin-hours → coins, exactly the unit
// calculateRefund meters in (hoursUsed × MB × rate_locked × copies).
function ipfsGateMeteredUsage(claim, now) {
  const mb     = pricing.billableMB(claim.size_bytes);
  const copies = pricing.cappedCopies(claim.copies_requested);
  const hoursUsed = Math.max(1, Math.ceil((now - Number(claim.start_ts)) / HOUR_MS));
  return hoursUsed * mb * Number(claim.rate_locked) * copies;
}

// The deposit a user escrowed for the whole reservation = calculateCost's total
// (rounded to chain precision, as calculateCost does).
function depositFor(claim) {
  return pricing.calculateCost({
    sizeBytes:      claim.size_bytes,
    hoursRequested: claim.paid_hours,
    copies:         claim.copies_requested,
    rate:           claim.rate_locked,
  }).total;
}

// ── A matrix of realistic claims, varied so refund lands above floor, below
//    floor (dust), and exactly zero (fully used). now is parameterised — NO
//    Date.now() (sandbox-forbidden + keeps the test deterministic).
const T0 = 1_700_000_000_000; // fixed epoch base for all claims
const CLAIMS = [
  { label: 'half-used, large refund',  size_bytes: 5 * MB_DIVISOR, paid_hours: 10, rate_locked: RATE_PER_MB_HOUR, copies_requested: 1, start_ts: T0, hoursElapsed: 5 },
  { label: 'mostly-used, small refund', size_bytes: 1 * MB_DIVISOR, paid_hours: 10, rate_locked: RATE_PER_MB_HOUR, copies_requested: 1, start_ts: T0, hoursElapsed: 9 },
  { label: 'fully used → zero refund',  size_bytes: 3 * MB_DIVISOR, paid_hours: 6,  rate_locked: RATE_PER_MB_HOUR, copies_requested: 1, start_ts: T0, hoursElapsed: 6 },
  { label: 'over-used (clamped to paid)', size_bytes: 2 * MB_DIVISOR, paid_hours: 4, rate_locked: RATE_PER_MB_HOUR, copies_requested: 1, start_ts: T0, hoursElapsed: 99 },
  { label: 'multi-copy, fractional rate', size_bytes: 7 * MB_DIVISOR, paid_hours: 24, rate_locked: 0.002, copies_requested: 1, start_ts: T0, hoursElapsed: 3 },
  { label: 'tiny refund → dust floor',  size_bytes: 1 * MB_DIVISOR, paid_hours: 100, rate_locked: 0.001, copies_requested: 1, start_ts: T0, hoursElapsed: 60 },
];

test('settle() reproduces ipfs-gate calculateRefund exactly (the spec)', () => {
  for (const claim of CLAIMS) {
    const now = claim.start_ts + claim.hoursElapsed * HOUR_MS;

    const expected = pricing.calculateRefund(claim, now); // { amount, dust, ... }
    const got = settle({
      deposit:      depositFor(claim),
      meteredUsage: ipfsGateMeteredUsage(claim, now),
      dustFloor:    MIN_REFUND,
      places:       3,                 // ipfs-gate's RATE_FLOOR=0.001 ≡ 3dp
    });

    // The money number: refund must match to the cent.
    assert.equal(got.refund, expected.amount, `${claim.label}: refund mismatch`);
    // Dust suppression must agree (ipfs-gate dust:true ⟺ core suppressed refund→0).
    assert.equal(got.refund === 0, expected.dust, `${claim.label}: dust-suppression mismatch`);
    // Cap invariant: settlement + refund never exceeds the deposit.
    assert.ok(got.settlement + got.refund <= depositFor(claim) + 1e-9, `${claim.label}: exceeded deposit`);
  }
});

test('cap invariant — an over-stated usage report can never mint money', () => {
  // meteredUsage 100× the deposit: settlement is clamped to deposit, refund 0.
  const r = settle({ deposit: 12.345, meteredUsage: 1234.5, places: 3 });
  assert.equal(r.settlement, 12.345);
  assert.equal(r.refund, 0);
  assert.ok(r.settlement <= 12.345, 'settlement must not exceed deposit');
});

test('refund is always ≥ 0 and settlement ≤ deposit across the matrix', () => {
  for (const claim of CLAIMS) {
    const now = claim.start_ts + claim.hoursElapsed * HOUR_MS;
    const r = settle({
      deposit: depositFor(claim),
      meteredUsage: ipfsGateMeteredUsage(claim, now),
      dustFloor: MIN_REFUND,
      places: 3,
    });
    assert.ok(r.refund >= 0, `${claim.label}: negative refund`);
    assert.ok(r.dust >= 0, `${claim.label}: negative dust`);
    assert.ok(r.settlement <= depositFor(claim) + 1e-9, `${claim.label}: settlement > deposit`);
  }
});

test('dust floor — a sub-floor refund is retained, not disbursed', () => {
  // deposit 1.000, usage 0.999 → raw refund 0.001 < 0.05 floor → suppressed.
  const r = settle({ deposit: 1.0, meteredUsage: 0.999, dustFloor: 0.05, places: 3 });
  assert.equal(r.refund, 0, 'sub-floor refund must be suppressed');
  assert.equal(r.dust, 0.001, 'the remainder is reported as dust');
  assert.equal(r.settlement, 0.999);

  // Exactly at the floor is NOT dust (matches ipfs-gate's `< MIN_REFUND`).
  const atFloor = settle({ deposit: 1.05, meteredUsage: 1.0, dustFloor: 0.05, places: 3 });
  assert.equal(atFloor.refund, 0.05);
  assert.equal(atFloor.dust, 0);
});

// ── Decision #3 — per-currency precision ────────────────────────────────────

test('roundCoins parity — no-currency rounding matches ipfs-gate roundCoins (3dp)', () => {
  for (const x of [7.9996, 7.9994, 0.0005, 0.0004, 123.456789, 1, 0]) {
    assert.equal(roundCoins(x), pricing.roundCoins(x), `roundCoins(${x})`);
  }
});

test('Decision #3 — 3dp currency matches ipfs-gate; an 8dp token neither strands dust nor over-precises', () => {
  // 3dp registered currency behaves exactly like ipfs-gate's global floor.
  assert.equal(precision('HBD'), 3);
  assert.equal(roundCoins(7.9996, 'HBD'), pricing.roundCoins(7.9996));

  // An 8dp Hive-Engine token: a tiny refund that 3dp would STRAND is preserved.
  registerPrecision('SWAP.TINY', 8);
  assert.equal(precision('SWAP.TINY'), 8);

  const tinyUsage = 0.00000500; // 5e-6 coins
  const at3dp = settle({ deposit: 1.0, meteredUsage: 1 - tinyUsage, currency: 'HBD' });
  assert.equal(at3dp.refund, 0, '3dp strands the 5e-6 refund (rounds to 0.000)');

  const at8dp = settle({ deposit: 1.0, meteredUsage: 1 - tinyUsage, currency: 'SWAP.TINY' });
  assert.equal(at8dp.refund, 0.000005, '8dp preserves the small refund exactly');

  // Over-precision is clamped to the token's places (chain would reject otherwise).
  assert.equal(settle({ deposit: 1, meteredUsage: 0.123456789, currency: 'SWAP.TINY' }).settlement, 0.12345679);
});
