// ipfs-gate v1 — claim-based pricing engine (MB-hour).
// Pure functions, no I/O — fully unit-testable in isolation (the reason Stage 1a
// is the safe place to start). DESIGN LOCKED: PRICING-V1-DESIGN-NOTES.md.
//
//   total_cost = billable_MB × billable_hrs × rate × copies
//     billable_MB  = max(1, ceil(bytes / MB_DIVISOR))   (decimal MB, §9)
//     billable_hrs = max(PRICE_MIN_HOURS, ceil(hours))   (1-hour minimum)
//     copies       = min(copies_requested, NODE_COUNT)   (capped at live nodes)
//     rate         = PRICE_RATE_PER_MB_HOUR              (locked at purchase)

// ─── Config knobs (additive; all greenfield) ────────────────────────────────
const RATE_PER_MB_HOUR = parseFloat(process.env.PRICE_RATE_PER_MB_HOUR || '1');
const MIN_HOURS        = parseInt(process.env.PRICE_MIN_HOURS || '1', 10);
const MB_DIVISOR       = parseInt(process.env.MB_DIVISOR || '1000000', 10); // decimal MB — confirmed
const NODE_COUNT       = parseInt(process.env.NODE_COUNT || '1', 10);       // v1: config (1 Kubo node)
const MIN_REFUND       = parseFloat(process.env.MIN_REFUND || '0.05');      // below this, don't refund (dust)
// Universal precision floor — the v4call lesson: the gate must be able to actually
// charge/refund at whatever precision it quotes, or funds round to 0 and stick.
const RATE_FLOOR       = parseFloat(process.env.RATE_FLOOR || '0.001');
// Stage-1b seam: documented now, consumed when backstops land. NOT used in 1a.
const BACKSTOP_CANCEL_FEE_PCT = parseFloat(process.env.BACKSTOP_CANCEL_FEE_PCT || '1');

const HOUR_MS = 60 * 60 * 1000;

// ─── Billable units ─────────────────────────────────────────────────────────

/** Decimal MB, rounded up, minimum 1. */
function billableMB(sizeBytes) {
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw Object.assign(new Error('size_bytes must be a positive number'), { code: 'bad_request' });
  }
  return Math.max(1, Math.ceil(bytes / MB_DIVISOR));
}

/** Hours, rounded up, minimum MIN_HOURS. */
function billableHours(hoursRequested) {
  const h = Number(hoursRequested);
  if (!Number.isFinite(h) || h <= 0) {
    throw Object.assign(new Error('hours_requested must be a positive number'), { code: 'bad_request' });
  }
  return Math.max(MIN_HOURS, Math.ceil(h));
}

/** Copies clamped to [1, NODE_COUNT] — nobody escrows for redundancy the gate can't deliver. */
function cappedCopies(copiesRequested, nodeCount = NODE_COUNT) {
  const c = Math.floor(Number(copiesRequested) || 1);
  return Math.min(Math.max(1, c), Math.max(1, nodeCount));
}

/** Round a coin amount to the gate's processable precision (RATE_FLOOR discipline). */
function roundCoins(amount) {
  // RATE_FLOOR 0.001 → 3 decimal places. Derive places from the floor so the two stay in lock-step.
  const places = Math.max(0, Math.round(-Math.log10(RATE_FLOOR)));
  return parseFloat(Number(amount).toFixed(places));
}

// ─── Cost + refund ──────────────────────────────────────────────────────────

/**
 * Quote a new claim. Returns the full breakdown so /reserve can show the user
 * exactly how the number was reached.
 *   { billable_mb, billable_hrs, copies, rate, total }
 */
function calculateCost({ sizeBytes, hoursRequested, copies = 1, rate = RATE_PER_MB_HOUR, nodeCount = NODE_COUNT }) {
  const mb  = billableMB(sizeBytes);
  const hrs = billableHours(hoursRequested);
  const cps = cappedCopies(copies, nodeCount);
  const total = roundCoins(mb * hrs * rate * cps);
  return { billable_mb: mb, billable_hrs: hrs, copies: cps, rate, total };
}

/**
 * Pro-rata refund for an ACTIVE claim cancelled early.
 *   hours_used     = max(1, ceil((now - start_ts) / 1h))   (min 1 hr consumed)
 *   hours_refunded = max(paid_hours - hours_used, 0)
 *   refund         = hours_refunded × billable_MB × rate_locked × copies
 * Returns { hours_used, hours_refunded, amount, dust } — amount is 0 (dust=true)
 * when below MIN_REFUND. Rate is the claim's locked rate, never the live rate.
 */
function calculateRefund(claim, now = Date.now()) {
  const startTs    = Number(claim.start_ts);
  const paidHours  = Number(claim.paid_hours);
  const rateLocked = Number(claim.rate_locked);
  const copies     = cappedCopies(claim.copies_requested);
  const mb         = billableMB(claim.size_bytes);

  const hoursUsed     = Math.max(1, Math.ceil((now - startTs) / HOUR_MS));
  const hoursRefunded = Math.max(paidHours - hoursUsed, 0);
  const raw           = roundCoins(hoursRefunded * mb * rateLocked * copies);

  if (raw < MIN_REFUND) {
    return { hours_used: hoursUsed, hours_refunded: hoursRefunded, amount: 0, dust: true };
  }
  return { hours_used: hoursUsed, hours_refunded: hoursRefunded, amount: raw, dust: false };
}

/**
 * Refund for a DORMANT backstop the pledger cancels before it ever activates.
 * Full escrow back minus BACKSTOP_CANCEL_FEE_PCT (anti-churn; cohosting §3/§6).
 * The fee applies ONLY to user-initiated dormant cancels — admin-forced voids
 * pass feePct=0 (cohosting §7). Returns { amount, fee, dust }.
 */
function calculateDormantRefund(claim, feePct = BACKSTOP_CANCEL_FEE_PCT) {
  const escrow = Number(claim.amount_paid);
  if (!Number.isFinite(escrow) || escrow <= 0) return { amount: 0, fee: 0, dust: true };
  const fee = roundCoins(escrow * (Math.max(0, feePct) / 100));
  const amount = roundCoins(escrow - fee);
  if (amount < MIN_REFUND) return { amount: 0, fee, dust: true };
  return { amount, fee, dust: false };
}

/**
 * Refund amount for a claim ended by an ADMIN force-action (cohosting §7).
 *   - innocent backstopper (CID ban voided an innocent third party's pledge)
 *       → FULL escrow back, no fee.
 *   - offender / banned-user's own claim, policy 'none'  → 0 (forfeit).
 *   - offender / banned-user's own claim, policy 'prorata':
 *       active  → pro-rata unused hours;  dormant → full escrow (never ran).
 * `claim.state` is the PRE-VOID state (active|dormant). Returns a number.
 */
function forcedRefundAmount(claim, { policy = 'prorata', innocent = false } = {}, now = Date.now()) {
  const wasDormant = claim.state === 'dormant';
  if (innocent) return calculateDormantRefund(claim, 0).amount;   // full escrow, no fee
  if (policy === 'none') return 0;                                // forfeit
  if (wasDormant) return calculateDormantRefund(claim, 0).amount; // never metered → full back
  return calculateRefund(claim, now).amount;                      // active offender → pro-rata
}

module.exports = {
  billableMB,
  billableHours,
  cappedCopies,
  roundCoins,
  calculateCost,
  calculateRefund,
  calculateDormantRefund,
  forcedRefundAmount,
  // constants (exposed for server.js + tests)
  RATE_PER_MB_HOUR,
  MIN_HOURS,
  MB_DIVISOR,
  NODE_COUNT,
  MIN_REFUND,
  RATE_FLOOR,
  BACKSTOP_CANCEL_FEE_PCT,
  HOUR_MS
};
