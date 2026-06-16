-- escrow-core v0.1 — 001 core ledger schema.
--
-- The ESCROW-LEDGER SUBSET distilled from ipfs-gate's schema (001_initial.sql,
-- 003_claims.sql, 004_release_consents.sql, 005_receipts.sql). ipfs-gate's
-- pin / reservation / claim / order / backstop / quota / moderation machinery is
-- intentionally NOT here — only the escrow spine: a replay-guarded payment
-- (the deposit) with a single-winner settle flip, a durable refund lifecycle, and
-- idempotent consent / receipt rows.
--
-- ipfs-gate's reservation_id / uploader / claim_id / order_id all collapse to a
-- generic `ref` (the escrow reference, server-minted at reservation). Per-service
-- columns (e.g. v4call's call metadata, locked rate, start_ts) are appended to
-- these base tables by the adapter's ledgerSchema() — NOT added here.
--
-- All timestamps INTEGER unix-ms (UTC). Connection pragmas (WAL, foreign_keys,
-- synchronous=NORMAL, busy_timeout) are set per-connection in openLedger(). The
-- version-aware runner CREATEs schema_version before this file runs.

-- ─── payments: confirmed on-chain deposits + the single-winner settle flip ───
-- tx_id UNIQUE is the REPLAY GUARD (schema-level). `amount` is the verified
-- deposit — the hard settlement cap. `settle_state` is the generic extraction of
-- ipfs-gate's claims.state single-winner flip (active→cancelled), decoupled from
-- pins/claims: atomicClose(ref) flips open→closed exactly once.
CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id         TEXT NOT NULL UNIQUE,          -- replay protection
  ref           TEXT NOT NULL,                 -- generic escrow ref (was reservation_id)
  sender        TEXT NOT NULL,                 -- generic payer (was uploader)
  currency      TEXT NOT NULL,
  amount        REAL NOT NULL,                 -- the verified DEPOSIT = settlement cap
  memo          TEXT NOT NULL,
  block_num     INTEGER,
  verified_at   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('confirmed','paid_unconfirmed','orphan','refunded')),
  settle_state  TEXT NOT NULL DEFAULT 'open'
                  CHECK (settle_state IN ('open','closed')),   -- single-winner flip target
  settled_at    INTEGER,
  refund_tx_id  TEXT,
  refund_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_payments_ref          ON payments(ref);
CREATE INDEX IF NOT EXISTS idx_payments_settle_state ON payments(settle_state);
CREATE INDEX IF NOT EXISTS idx_payments_status       ON payments(status);

-- ─── refunds: durable custodial refund ledger ────────────────────────────────
-- Escrowed-but-owed money is a real float; every refund is a durable, status-locked
-- row so a pending/failed broadcast is visible + retryable, never silently lost.
CREATE TABLE IF NOT EXISTS refunds (
  refund_id   TEXT PRIMARY KEY,
  ref         TEXT NOT NULL,                   -- was claim_id
  to_account  TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL,
  memo        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','sent','failed','skipped')),
  reason      TEXT,                            -- cancel | dust | admin | error detail
  tx_id       TEXT,
  created_ts  INTEGER NOT NULL,
  settled_ts  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_refunds_ref    ON refunds(ref);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);

-- ─── release_consents: idempotent per-(ref, releaser) signed consent ─────────
CREATE TABLE IF NOT EXISTS release_consents (
  ref          TEXT NOT NULL,                  -- was order_id
  releaser     TEXT NOT NULL,                  -- Hive account that consented (lowercased)
  consented_at INTEGER NOT NULL,
  sig          TEXT,                           -- the release signature (audit)
  PRIMARY KEY (ref, releaser)                  -- INSERT OR IGNORE → idempotent
);

CREATE INDEX IF NOT EXISTS idx_release_consents_ref ON release_consents(ref);

-- ─── receipts: idempotent per-(ref, recipient) proof-of-receipt ──────────────
CREATE TABLE IF NOT EXISTS receipts (
  ref         TEXT NOT NULL,                   -- was order_id
  recipient   TEXT NOT NULL,                   -- Hive account that proved receipt (lowercased)
  proof_hash  TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  sig         TEXT,                            -- the receipt signature (audit)
  PRIMARY KEY (ref, recipient)                 -- INSERT OR IGNORE → idempotent
);

CREATE INDEX IF NOT EXISTS idx_receipts_ref ON receipts(ref);

INSERT OR IGNORE INTO schema_version (version, applied_at)
  VALUES (1, CAST(strftime('%s','now') AS INTEGER) * 1000);
