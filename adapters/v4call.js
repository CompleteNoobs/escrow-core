// escrow-core/adapters/v4call.js — THE v4call EscrowAdapter (the only adapter now).
//
// Authored from v4call-node/server.js's current escrow behaviour:
//   - escrow account  = ESCROW_ACCOUNT (default 'v4call-escrow')            (server.js:118)
//   - active key env  = V4CALL_ESCROW_KEY                                   (server.js:2454)
//   - precision       = getCurrencyPrecision: HBD/HIVE=3, HE token 0..8     (server.js:1439)
//   - metering / cap  = durationCost = min(ratePerHour*durationHr, deposit) (server.js:2658)
//   - release         = the call ends / duration elapses → duration_elapsed (handover §6)
//
// BOUNDARY (handover §6): authoring this adapter is in-scope. REWIRING v4call-node's
// handlers to call escrow-core + moving settlement off the in-memory `activePayments`
// onto durable rows is the SEPARATE, separately-gated v4call escrow-migration — NOT here.

'use strict';

const { precision: corePrecision } = require('../settle');
const { parseMemo } = require('../escrow-protocol');

const HOUR_MS = 60 * 60 * 1000;

// Per-service ledger columns appended to the core `payments` table — the durable
// home for the locked metering facts that today live in the in-memory activePayments
// map (the migration target). version ≥ 100 by the adapter-migration convention.
const SCHEMA_VERSION = 100;
const LEDGER_SCHEMA = `
  ALTER TABLE payments ADD COLUMN rate_per_hour REAL;
  ALTER TABLE payments ADD COLUMN start_ts      INTEGER;
  ALTER TABLE payments ADD COLUMN connect_paid  REAL;
  ALTER TABLE payments ADD COLUMN ring_paid     REAL;
  ALTER TABLE payments ADD COLUMN platform_fee  REAL;
  ALTER TABLE payments ADD COLUMN callee        TEXT;
`;

/**
 * Build a v4call EscrowAdapter. Config defaults to env (the adapter IS the config
 * boundary — this is where env reads belong, not in the core), with overrides for
 * hermetic tests.
 */
function createV4callAdapter({ account, currency, keyEnv } = {}) {
  return {
    // ── config ──
    account: account || process.env.ESCROW_ACCOUNT || 'v4call-escrow',
    currency: currency || 'HBD',          // v4call bills per-call; HBD is the default
    keyEnv: keyEnv || 'V4CALL_ESCROW_KEY',
    memoNamespace: 'v4call',
    schemaVersion: SCHEMA_VERSION,

    /**
     * Per-currency precision (Decision #3). v4call's getCurrencyPrecision does a live
     * HE lookup (HBD/HIVE=3, tokens 0..8); in the core the value is LOCKED at
     * reservation time and read synchronously from settle's registry. HE tokens are
     * registered (settle.registerPrecision) when their precision is fetched at reserve.
     */
    precision(cur) {
      return corePrecision(cur || this.currency);
    },

    /**
     * Metering-unit seam: call-seconds → coins. Reproduces v4call's
     * `ratePerHour * durationHr` (the input to min(cost, deposit)). The deposit cap
     * itself is applied by the core settle() — never here. Reads either the in-memory
     * shape (ratePerHour/startTime) or the durable-row shape (rate_per_hour/start_ts),
     * so it works before AND after the v4call escrow-migration.
     */
    meteredUsage(record, now) {
      const rate = Number(record.ratePerHour ?? record.rate_per_hour ?? 0);
      const start = Number(record.startTime ?? record.start_ts ?? 0);
      if (!(rate > 0) || !(start > 0)) return 0;
      let hours = Math.max(0, (now - start) / HOUR_MS);
      // Optional clamp to v4call's MAX_CALL_DURATION_MIN if the record carries it.
      const maxMin = Number(record.maxDurationMin ?? record.max_duration_min);
      if (Number.isFinite(maxMin) && maxMin > 0) hours = Math.min(hours, maxMin / 60);
      return rate * hours;
    },

    /** Release-condition seam: a v4call call releases when it ends / its duration elapses. */
    releasePolicy(/* record */) {
      return { type: 'duration_elapsed' };
    },

    /**
     * Settlement-split seam: v4call's payout/refund/platform-fee division of a settled
     * call. Ring-fee model (OWNER decision 2026-07-07): the ring fee belongs to the
     * CALLEE (their anti-spam fee — they set it, they keep it); the platform takes its
     * % of the whole callee gross (ring + connect + duration):
     *   calleeGross    = ringPaid + connectPaid + durationCost
     *   platformOnCall = calleeGross * platformFee
     *   calleeNet      = calleeGross - platformOnCall          → callee
     *   refundAmount   = settle().refund                       → caller
     *   platformTotal  = platformOnCall                        → feeAccount
     * Each amount is rounded to the currency precision and only emitted if ≥ the dust
     * floor (10^-places), matching the node's `>= floor` guards.
     *
     * CONSERVATION (the box's safety property): calleeNet + refundAmount + platformTotal
     * = ringPaid + connectPaid + depositPaid − dust, for ANY rate/fee/duration. So a
     * lying event-report can only re-split the verified envelope, never mint or drain —
     * which is why the box verifies ring/connect/deposit ON-CHAIN and feeds the verified
     * buckets in here.
     *
     * @param facts  { connect_paid|connectPaid, ring_paid|ringPaid, platform_fee|platformFee,
     *                 callee, caller|sender, currency }   (verified buckets, from the box)
     * @param settled { settlement (durationCost), refund (refundAmount) }  (from settle())
     * @param ctx    { ref, feeAccount, durationMin?, places? }
     * @returns { outflows: [{ kind, to_account, amount, currency, memo, reason }], calleeGross, platformOnCall, calleeNet, platformTotal }
     */
    settlementSplit(facts = {}, settled = {}, ctx = {}) {
      const currency = facts.currency || this.currency;
      const places = Number.isInteger(ctx.places) ? ctx.places : this.precision(currency);
      const floor = Math.pow(10, -places);
      const r = (n) => parseFloat(Number(n || 0).toFixed(places));

      const connectPaid = Number(facts.connect_paid ?? facts.connectPaid ?? 0);
      const ringPaid    = Number(facts.ring_paid    ?? facts.ringPaid    ?? 0);
      const platformFee = Number(facts.platform_fee ?? facts.platformFee ?? 0.10);
      const callee      = facts.callee;
      const caller      = facts.caller ?? facts.sender;

      const durationCost = Number(settled.settlement ?? 0);
      const refundAmount = Number(settled.refund ?? 0);

      const calleeGross    = r(ringPaid + connectPaid + durationCost);
      const platformOnCall = r(calleeGross * platformFee);
      const calleeNet      = r(calleeGross - platformOnCall);
      const platformTotal  = platformOnCall;

      const ref    = ctx.ref;
      const durMin = (ctx.durationMin != null) ? Number(ctx.durationMin).toFixed(1) : '0.0';

      const outflows = [];
      if (callee && calleeNet >= floor) {
        outflows.push({ kind: 'payout', to_account: callee, amount: calleeNet, currency,
          memo: `v4call:payout:${ref}:${durMin}min`, reason: 'payout' });
      }
      if (caller && refundAmount >= floor) {
        outflows.push({ kind: 'refund', to_account: caller, amount: refundAmount, currency,
          memo: `v4call:refund:${ref}:unused-credit`, reason: 'refund' });
      }
      if (ctx.feeAccount && platformTotal >= floor) {
        outflows.push({ kind: 'platform_fee', to_account: ctx.feeAccount, amount: platformTotal, currency,
          memo: `v4call:fee:${ref}:cut`, reason: 'platform_fee' });
      }
      return { outflows, calleeGross, platformOnCall, calleeNet, platformTotal };
    },

    /**
     * Build the call-end `event-report` FACTS (the node↔box envelope) from a call's durable
     * payment rows. This is the contract the keyless node sends to the box and the box settles
     * against (escrow-box.handleReport reads exactly this shape). Defined here — the shared
     * lib — so node and box agree by construction. PURE.
     *
     * `payments` carries every escrowed tx so the box can RE-VERIFY them on-chain (the safety
     * envelope); `callFacts` are node-asserted metering knobs that the cap + conservation make
     * re-split-only. `purpose` is advisory — the box re-derives it from each verified memo.
     *
     * @param payRows         escrowLedger.getPaymentsByRef(callId)
     * @param endReason       why the call ended
     * @param now             epoch ms (settlement clock)
     * @param maxDurationMin  the node's MAX_CALL_DURATION_MIN (metering clamp)
     */
    buildCallEndReportFacts({ payRows, endReason = 'unknown', now, maxDurationMin, attestations } = {}) {
      const rows = Array.isArray(payRows) ? payRows : [];
      const primary = rows.find(r => r.rate_per_hour != null) || rows[0] || {};
      const currency = primary.currency || this.currency;
      const startTs = (primary.start_ts != null) ? Number(primary.start_ts) : null;
      const durationMs = (startTs && now) ? Math.max(0, now - startTs) : 0;
      const callFacts = {
        ratePerHour: (primary.rate_per_hour != null) ? Number(primary.rate_per_hour) : 0,
        platformFee: (primary.platform_fee != null) ? Number(primary.platform_fee) : 0.10,
        callee: primary.callee || null,
        startTs,
        maxDurationMin: (maxDurationMin != null) ? Number(maxDurationMin) : undefined,
      };
      // Combined-transfer re-split (node-asserted): the live node funds ring+connect+deposit
      // as ONE on-chain transfer and records it as a SINGLE deposit-purpose row, with the
      // non-refundable ring/connect portions as COLUMNS (not separate memo-classified
      // payments). Surface those columns so the box can carve them back out of the verified
      // deposit envelope. Present ONLY in the combined case; absent when ring/connect were
      // their own on-chain transfers (the box then classifies them by memo). The box only
      // ever uses these to RE-SPLIT the on-chain-verified total — never to mint.
      if (primary.connect_paid != null) callFacts.connectPaid = Number(primary.connect_paid);
      if (primary.ring_paid    != null) callFacts.ringPaid    = Number(primary.ring_paid);
      const payments = rows.map(r => ({
        txId: r.tx_id,
        sender: r.sender,
        purpose: (parseMemo(r.memo) || {}).purpose || 'deposit',
        amount: Number(r.amount),
        memo: r.memo,
        currency: r.currency || currency,
      }));
      const facts = { kind: 'call-end', endReason, endedAt: now || null, durationMs, currency, callFacts, payments };
      // Step 6 — caller/callee call attestations (shadow mode). Carried VERBATIM inside
      // the node-signed report envelope (tamper-evident in transit); the box verifies
      // each user signature INDEPENDENTLY against on-chain posting keys, so these are
      // trust-bearing even though the node assembled them. Absent = pre-attestation
      // client or user declined to sign — shadow mode logs, never blocks.
      if (Array.isArray(attestations) && attestations.length) facts.attestations = attestations;
      return facts;
    },

    /**
     * Build a single-payment event-report FACTS — the non-call settlements (paid DMs,
     * attachments, invites, ring-fee refunds). One verified on-chain payment splits into
     * up to two outflows: a payout to `payoutTo` and a platform fee to the box's configured
     * feeAccount. Set platformFee 0 for a pure refund (the entire verified amount goes back
     * to payoutTo — typically the original sender). Unlike buildCallEndReportFacts there is
     * no metering/cap/refund-of-unused-deposit concept here — the full verified amount is
     * always disbursed, just split by platformFee.
     *
     * @param txId/sender/amount/currency/memo  the ONE on-chain deposit the box re-verifies
     * @param payoutTo     recipient of the net payout (the original sender, for a refund)
     * @param platformFee  0..1 fraction to the feeAccount; 0 = pure refund, no fee line
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
     * Settlement-split for a single-payment report (the box calls this with the amount it
     * independently verified on-chain — never the node's claimed amount). gross splits into
     * fee (gross * platformFee, → feeAccount) and net (the remainder, → payoutTo). platformFee
     * 0 collapses this to a pure refund: the entire verified amount goes to payoutTo.
     *
     * @param verifiedAmount  the box's own on-chain-verified total (the authority)
     * @param facts           { currency, payoutTo, platformFee }  (from buildSinglePaymentReportFacts)
     * @param ctx             { ref, feeAccount, places? }
     * @returns { outflows: [{ kind, to_account, amount, currency, memo, reason }], gross, fee, net }
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
        outflows.push({ kind: 'payout', to_account: facts.payoutTo, amount: net, currency,
          memo: `v4call:payout:${ctx.ref}`, reason: 'payout' });
      }
      if (ctx.feeAccount && fee >= floor) {
        outflows.push({ kind: 'platform_fee', to_account: ctx.feeAccount, amount: fee, currency,
          memo: `v4call:fee:${ctx.ref}`, reason: 'platform_fee' });
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

module.exports = { createV4callAdapter, SCHEMA_VERSION };
