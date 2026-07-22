// escrow-core/adapters/ipfs-gate.js — the ipfs-gate EscrowAdapter ("coming home":
// escrow-core was extracted FROM ipfs-gate, so this adapter wraps the very math
// that was carved out — pricing.js is the monolith's file, kept in sync).
//
// Authored from IPFS-Gate/server.js@56c0965's refund behaviour:
//   - escrow account  = IPFS_GATE_HIVE_ACCOUNT                     (server.js:66)
//   - active key env  = IPFS_GATE_ACTIVE_KEY                       (hive-verify.js:380)
//   - metering unit   = pin-hours: consumed = hoursUsed × MB × rate_locked × copies
//   - refund choke    = broadcastRefund (server.js:234) — memo ipfs-gate:refund:<claim_id>
//   - triggers        = broadcastRefund's `reason` strings, reused VERBATIM here
//
// ipfs-gate is simpler than v4call: no callee, no platform-fee account. Consumed
// value simply STAYS in the escrow account (operator revenue); at most ONE outflow
// per settlement — the refund to the claim owner.
//
// THREAT MODEL (why lying is harmless): the box re-verifies every payment in the
// report on-chain and caps settlement at that verified envelope (core settle()).
// A compromised node lying about `trigger`/claim facts can at worst refund the
// whole envelope back to the owner or let escrow keep it all — a RE-SPLIT between
// owner and operator. It can never mint, never redirect (to_account is the claim
// owner the deposits were verified against), never double-pay (tx_id UNIQUE +
// atomicClose + memo-probe).
//
// EXTEND NUANCE (why the envelope, not amount_paid, is the cap): the monolith's
// extendClaim bumps paid_hours/expiry_ts but NOT claim.amount_paid (quota.js:652),
// so after a top-up the legitimate refund can exceed the ORIGINAL payment. The
// deposit the box feeds settle() must therefore be the SUM of all verified
// payments for the claim (upload/pledge/owncopy + every extend top-up).

'use strict';

const { precision: corePrecision, roundCoins } = require('../settle');
const { parseMemo } = require('../escrow-protocol');
const pricing = require('../pricing');

const HOUR_MS = 60 * 60 * 1000;

// Fee-exempt (whitelist) uploads record node-local synthetic payment rows purely
// so the monolith's FK resolves — zero on-chain money. They must NEVER appear in
// a report's payments array; this prefix filter is the belt-and-braces guard
// (the node-side builder is the belt).
const SYNTHETIC_TX_PREFIX = 'whitelist-free:';

// Per-service ledger columns appended to the core `payments` table — the durable
// home for the claim facts a settlement was computed from. version ≥ 100 by the
// adapter-migration convention.
const SCHEMA_VERSION = 100;
const LEDGER_SCHEMA = `
  ALTER TABLE payments ADD COLUMN claim_id         TEXT;
  ALTER TABLE payments ADD COLUMN owner            TEXT;
  ALTER TABLE payments ADD COLUMN claim_kind       TEXT;
  ALTER TABLE payments ADD COLUMN claim_state      TEXT;
  ALTER TABLE payments ADD COLUMN rate_locked      REAL;
  ALTER TABLE payments ADD COLUMN size_bytes       INTEGER;
  ALTER TABLE payments ADD COLUMN copies_requested INTEGER;
  ALTER TABLE payments ADD COLUMN paid_hours       REAL;
  ALTER TABLE payments ADD COLUMN start_ts         INTEGER;
  ALTER TABLE payments ADD COLUMN expiry_ts        INTEGER;
  ALTER TABLE payments ADD COLUMN cancel_fee_pct   REAL;
  ALTER TABLE payments ADD COLUMN settle_trigger   TEXT;
`;

// The monolith's broadcastRefund `reason` strings (server.js settleClaimRefund /
// settleForcedRefund call sites), reused verbatim as the report's `trigger` so
// node and box speak the same vocabulary. Any UNKNOWN trigger falls through to
// the default metering (dormant → fee, active → pro-rata) — the same refund the
// monolith computes for every user-initiated end — so a future reason string
// keeps working without an adapter change (and the settle cap bounds it anyway).
const TRIGGERS = Object.freeze([
  'cancel', 'user_deleted', 'released', 'released-via-receipt',  // user-initiated, active → pro-rata
  'dormant_cancel',                         // user cancels a dormant guardian → fee only
  'admin_void_innocent_guardian',           // CID ban voided an innocent pledge → full back
  'admin_void_forfeit',                     // refund_policy 'none' → escrow keeps all
  'admin_void_prorata',                     // banned user, policy 'prorata' → dormant full / active pro-rata
]);

/**
 * Build an ipfs-gate EscrowAdapter. Config defaults to env (the adapter IS the
 * config boundary — env reads belong here, not in the core), with overrides for
 * hermetic tests. `cancelFeePct` (dormant-guardian anti-churn fee, %) and
 * `minRefund` (dust floor) are BOX-authoritative: the box passes them into
 * meteredUsage/settle regardless of what the node's env says.
 */
function createIpfsGateAdapter({ account, currency, keyEnv, cancelFeePct, minRefund } = {}) {
  const feePct = Number.isFinite(Number(cancelFeePct))
    ? Number(cancelFeePct)
    : pricing.GUARDIAN_CANCEL_FEE_PCT;
  const dustFloor = Number.isFinite(Number(minRefund))
    ? Number(minRefund)
    : pricing.MIN_REFUND;

  return {
    // ── config ──
    account: account
      || process.env.ESCROW_ACCOUNT
      || process.env.IPFS_GATE_HIVE_ACCOUNT
      || 'ipfs-gate-escrow',
    currency: currency || process.env.ESCROW_CURRENCY || process.env.PAYMENT_CURRENCY || 'CNOOBS',
    keyEnv: keyEnv || 'IPFS_GATE_ACTIVE_KEY',
    memoNamespace: 'ipfs-gate',
    schemaVersion: SCHEMA_VERSION,
    // Box-authoritative settlement knobs (consistency guard: the node's quotes
    // must be configured to match, but on divergence THESE values win).
    cancelFeePct: feePct,
    minRefund: dustFloor,

    /** Per-currency precision (Decision #3) — registry-locked, 3dp default. */
    precision(cur) {
      return corePrecision(cur || this.currency);
    },

    /**
     * Metering-unit seam: pin-hours → coins CONSUMED by the escrow (the input to
     * the core settle() cap; refund = verified deposit − min(consumed, deposit)).
     * Trigger-aware so the cap reproduces the monolith's refunds exactly:
     *
     *   cancel/release/delete, active:   hoursUsed × MB × rate_locked × copies
     *                                    (hoursUsed = max(1, ceil((now−start)/1h)))
     *   …but PERMANENT claim:            record.deposit (one-time fee buys
     *                                    host-until-unpinned; nothing refundable)
     *   dormant_cancel:                  deposit × cancelFeePct/100 (fee retained)
     *   admin_void_innocent_guardian:    0                (full escrow back)
     *   admin_void_forfeit:              record.deposit   (fully consumed)
     *   admin_void_prorata:              dormant → 0 (never metered) / active → pro-rata
     *
     * `record` carries the claim facts from the report PLUS `deposit` = the box's
     * on-chain-verified envelope (needed by the full-consumption triggers; settle()
     * still caps independently, so an inflated deposit here cannot mint).
     */
    meteredUsage(record, now) {
      const dep = Number(record.deposit ?? record.amount_paid ?? 0);
      const trigger = record.trigger ?? record.settle_trigger ?? 'cancel';
      const state = record.claim_state ?? record.state ?? 'active';
      const currency = record.currency || this.currency;

      if (trigger === 'admin_void_innocent_guardian') return 0;
      if (trigger === 'admin_void_forfeit') return dep;

      const wasDormant = state === 'dormant';
      if (wasDormant) {
        if (trigger === 'admin_void_prorata') return 0;         // never metered → full back
        // user-initiated dormant cancel → anti-churn fee (default 0 = full back)
        const pct = Number(record.cancel_fee_pct ?? this.cancelFeePct);
        return roundCoins(dep * (Math.max(0, pct) / 100), currency);
      }

      // ACTIVE claim → pro-rata (monolith calculateRefund, inverted to "consumed")
      if (pricing.isPermanent(record.expiry_ts)) return dep;    // no time dimension
      const rate = Number(record.rate_locked ?? record.rateLocked ?? 0);
      const start = Number(record.start_ts ?? record.startTs ?? 0);
      if (!(rate > 0) || !(start > 0)) return dep;              // malformed facts → fail toward escrow, cap holds
      const mb = pricing.billableMB(record.size_bytes ?? record.sizeBytes);
      const copies = pricing.cappedCopies(record.copies_requested ?? record.copiesRequested ?? 1);
      const hoursUsed = Math.max(1, Math.ceil((now - start) / HOUR_MS));
      return roundCoins(hoursUsed * mb * rate * copies, currency);
    },

    /**
     * Release-condition seam: the order's release_policy JSON (owner_only /
     * any_of / all_of), evaluated by the core's evaluateRelease. Default is the
     * monolith's default: only the owner releases early.
     */
    releasePolicy(record) {
      const rp = record && (record.release_policy ?? record.releasePolicy);
      if (!rp) return { type: 'owner_only' };
      if (typeof rp === 'string') {
        try { return JSON.parse(rp); } catch { return { type: 'owner_only' }; }
      }
      return rp;
    },

    /**
     * Settlement-split seam. ipfs-gate: at most ONE outflow — the refund to the
     * claim owner (memo `ipfs-gate:refund:<claim_id>`, the disburse-retry probe
     * key). No callee, no fee account: the settled (consumed) portion simply
     * stays in the escrow account. Dust below the floor was already suppressed
     * by settle(); the `>= floor` guard here mirrors the precision floor.
     *
     * CONSERVATION: refund ≤ verified envelope always (settle's cap), and the
     * remainder stays put — nothing to a third party, ever.
     *
     * @param facts   { owner, currency, trigger }        (from the verified report)
     * @param settled { settlement, refund, dust }        (from core settle())
     * @param ctx     { ref, places? }                    (ref = claim_id)
     * @returns { outflows: [{ kind, to_account, amount, currency, memo, reason }], settlement, refundAmount }
     */
    settlementSplit(facts = {}, settled = {}, ctx = {}) {
      const currency = facts.currency || this.currency;
      const places = Number.isInteger(ctx.places) ? ctx.places : this.precision(currency);
      const floor = Math.pow(10, -places);
      const owner = facts.owner ?? facts.to_account;
      const refundAmount = Number(settled.refund ?? 0);

      const outflows = [];
      if (owner && refundAmount >= floor) {
        outflows.push({
          kind: 'refund', to_account: owner, amount: refundAmount, currency,
          memo: `ipfs-gate:refund:${ctx.ref}`, reason: facts.trigger || 'refund',
        });
      }
      return { outflows, settlement: Number(settled.settlement ?? 0), refundAmount };
    },

    /**
     * Build the claim-settle `event-report` FACTS (the node↔box envelope) from a
     * claim row + its durable payment rows. Defined here — the shared lib — so
     * node and box agree by construction. PURE.
     *
     * `payments` carries EVERY escrowed tx for the claim (the original
     * upload/pledge/owncopy deposit plus each extend top-up) so the box can
     * re-verify them on-chain and SUM the true envelope. Synthetic whitelist
     * rows are filtered here (belt-and-braces — the node must not enqueue
     * fee-exempt claims at all: their amount is 0, nothing to settle).
     * `purpose` is advisory — the box re-derives it from each verified memo.
     *
     * @param claim    the monolith claims row (pre-flip state — state reflects what it WAS)
     * @param payRows  payment rows for the claim (node-local reference table)
     * @param trigger  one of TRIGGERS (broadcastRefund's reason vocabulary)
     * @param now      epoch ms (settlement clock)
     */
    buildClaimSettleReportFacts({ claim = {}, payRows, trigger = 'cancel', now } = {}) {
      const rows = (Array.isArray(payRows) ? payRows : [])
        .filter(r => r && r.tx_id && !String(r.tx_id).startsWith(SYNTHETIC_TX_PREFIX));
      const currency = claim.currency || this.currency;
      const claimFacts = {
        claim_id: claim.claim_id,
        owner: claim.owner,
        claim_kind: claim.kind ?? claim.claim_kind ?? 'original',
        claim_state: claim.state ?? claim.claim_state ?? 'active',
        rate_locked: (claim.rate_locked != null) ? Number(claim.rate_locked) : 0,
        size_bytes: (claim.size_bytes != null) ? Number(claim.size_bytes) : null,
        copies_requested: (claim.copies_requested != null) ? Number(claim.copies_requested) : 1,
        paid_hours: (claim.paid_hours != null) ? Number(claim.paid_hours) : null,
        start_ts: (claim.start_ts != null) ? Number(claim.start_ts) : null,
        expiry_ts: (claim.expiry_ts != null) ? Number(claim.expiry_ts) : null,
        amount_paid: (claim.amount_paid != null) ? Number(claim.amount_paid) : 0,
      };
      const payments = rows.map(r => ({
        txId: r.tx_id,
        sender: r.sender ?? r.uploader,
        purpose: (parseMemo(r.memo) || {}).purpose || 'upload',
        amount: Number(r.amount),
        memo: r.memo,
        currency: r.currency || currency,
      }));
      return { kind: 'claim-settle', trigger, endedAt: now || null, currency, claimFacts, payments };
    },

    /**
     * Build a single-payment event-report FACTS — for one-off refunds outside
     * the claim lifecycle (e.g. an eventual admin orphan-payment refund path).
     * One verified on-chain payment, platformFee 0 = pure refund to payoutTo.
     * Not wired in v1; kept for parity with the v4call adapter's proven shape.
     */
    buildSinglePaymentReportFacts({ txId, sender, amount, currency, memo, payoutTo, platformFee = 0 } = {}) {
      const cur = currency || this.currency;
      return {
        kind: 'single-payment',
        currency: cur,
        payoutTo,
        platformFee: Number(platformFee) || 0,
        payments: [{ txId, sender, amount: Number(amount), memo, currency: cur }],
      };
    },

    /**
     * Split for a single-payment report — the box calls this with the amount it
     * independently verified on-chain. platformFee 0 collapses to a pure refund.
     */
    singlePaymentSplit(verifiedAmount, facts = {}, ctx = {}) {
      const currency = facts.currency || this.currency;
      const places = Number.isInteger(ctx.places) ? ctx.places : this.precision(currency);
      const floor = Math.pow(10, -places);
      const r = (n) => parseFloat(Number(n || 0).toFixed(places));

      const platformFee = Number(facts.platformFee) || 0;
      const gross = r(verifiedAmount);
      const fee   = r(gross * platformFee);
      const net   = r(gross - fee);

      const outflows = [];
      if (facts.payoutTo && net >= floor) {
        outflows.push({ kind: 'refund', to_account: facts.payoutTo, amount: net, currency,
          memo: `ipfs-gate:refund:${ctx.ref}`, reason: 'refund' });
      }
      if (ctx.feeAccount && fee >= floor) {
        outflows.push({ kind: 'platform_fee', to_account: ctx.feeAccount, amount: fee, currency,
          memo: `ipfs-gate:fee:${ctx.ref}`, reason: 'platform_fee' });
      }
      return { outflows, gross, fee, net };
    },

    /** Per-service ledger columns (the migration SQL appended to the core tables). */
    ledgerSchema() {
      return LEDGER_SCHEMA;
    },

    /** Convenience: the migration entries to hand to openLedger({ adapterMigrations }). */
    ledgerMigrations() {
      return [{ version: SCHEMA_VERSION, sql: LEDGER_SCHEMA }];
    },
  };
}

module.exports = { createIpfsGateAdapter, SCHEMA_VERSION, TRIGGERS, SYNTHETIC_TX_PREFIX };
