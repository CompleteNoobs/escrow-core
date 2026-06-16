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
