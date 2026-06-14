// ipfs-gate v0.1 — DB layer + quota / reservation / pin management.
// All persistence runs through this module.

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || '/app/data/ipfs-gate.db';
const RESERVATION_TTL_MIN = parseInt(process.env.RESERVATION_TTL_MIN || '5', 10);
const RESERVATION_PER_ACCOUNT_MAX = parseInt(process.env.RESERVATION_PER_ACCOUNT_MAX || '3', 10);
const DISK_LIMIT_GB = parseFloat(process.env.DISK_LIMIT_GB || '5');
const DISK_LIMIT_BYTES = Math.floor(DISK_LIMIT_GB * 1024 * 1024 * 1024);
// parseFloat so operators can set fractional days for testing sweeper expiry
// (e.g. DEFAULT_TTL_DAYS=0.001 ≈ 86 seconds). Set 7+ for production.
const DEFAULT_TTL_DAYS = parseFloat(process.env.DEFAULT_TTL_DAYS || '7');
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

let db;

function open() {
  if (db) return db;
  // Ensure parent dir exists (Docker mount + first boot edge case)
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

function runMigrations() {
  open();
  const migDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migDir)) {
    throw new Error(`migrations directory not found: ${migDir}`);
  }

  // Version-aware runner (v0.2). Earlier versions re-exec'd every .sql on each
  // boot and relied on IF NOT EXISTS — fine for CREATE TABLE, but ALTER TABLE
  // ADD COLUMN throws on re-run. So each migration file is named `NNN_*.sql`
  // and applied exactly once, gated on schema_version. 001 stays idempotent
  // for fresh DBs; 002+ are ALTERs that must run only when newer than current.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);
  const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;

  const files = fs.readdirSync(migDir)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    const ver = parseInt(f.match(/^(\d+)/)[1], 10);
    if (ver <= current) continue;
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    db.exec(sql);
    console.log(`[quota] applied migration ${f}`);
  }

  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  console.log(`[quota] schema_version = ${v?.v ?? 'none'}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function now() {
  return Date.now();
}

function newReservationId() {
  return crypto.randomBytes(8).toString('hex');
}

function newOrderId() {
  return 'ord_' + crypto.randomBytes(8).toString('hex');
}

function newClaimId() {
  return 'clm_' + crypto.randomBytes(8).toString('hex');
}

function newRefundId() {
  return 'rfd_' + crypto.randomBytes(8).toString('hex');
}

function getMemoForReservation(reservationId) {
  return `ipfs-gate:upload:${reservationId}`;
}

function parseMemoReservationId(memo) {
  if (typeof memo !== 'string') return null;
  const m = memo.match(/^ipfs-gate:upload:([a-f0-9]{16})$/);
  return m ? m[1] : null;
}

// ─── Disk / quota queries ───────────────────────────────────────────────────

function getDiskUsage() {
  const active = db.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS s FROM pins WHERE status = 'active'"
  ).get();
  const pending = db.prepare(
    "SELECT COALESCE(SUM(size_bytes), 0) AS s FROM reservations WHERE status = 'pending' AND expires_at > ?"
  ).get(now());
  return {
    active_bytes: active.s,
    reserved_bytes: pending.s,
    used_bytes: active.s + pending.s,
    limit_bytes: DISK_LIMIT_BYTES,
    available_bytes: Math.max(0, DISK_LIMIT_BYTES - active.s - pending.s)
  };
}

function getAccountPendingCount(uploader) {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM reservations WHERE uploader = ? AND status = 'pending' AND expires_at > ?"
  ).get(uploader, now());
  return row.c;
}

function isAccountBanned(uploader) {
  const row = db.prepare(
    "SELECT 1 FROM banned_accounts WHERE hive_account = ? AND unbanned_at IS NULL"
  ).get(uploader);
  return !!row;
}

function isCidBlocked(cid) {
  const row = db.prepare(
    "SELECT 1 FROM blocked_cids WHERE cid = ? AND unblocked_at IS NULL"
  ).get(cid);
  return !!row;
}

// ─── Reservations ───────────────────────────────────────────────────────────

/**
 * Create a reservation atomically. Throws on quota/per-account/banned failure.
 * Returns { id, expires_at }.
 */
function createReservation(uploader, sizeBytes, mode = 'encrypted', quote = {}) {
  if (!uploader || typeof uploader !== 'string') {
    throw Object.assign(new Error('uploader required'), { code: 'bad_request' });
  }
  if (mode !== 'encrypted' && mode !== 'public') {
    throw Object.assign(new Error("mode must be 'encrypted' or 'public'"), { code: 'bad_request' });
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw Object.assign(new Error('size_bytes must be a positive integer'), { code: 'bad_request' });
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw Object.assign(
      new Error(`size_bytes exceeds MAX_FILE_SIZE_MB=${MAX_FILE_SIZE_MB}`),
      { code: 'payload_too_large' }
    );
  }
  if (isAccountBanned(uploader)) {
    throw Object.assign(new Error('uploader is banned'), { code: 'forbidden' });
  }

  // v1 claim model: the reservation carries the quote (hours/copies/amount) so
  // /upload can validate paid ≥ quote and persist them onto the claim. Defaults
  // keep this callable from any legacy code path that hasn't computed a quote.
  const hoursRequested = Number.isFinite(quote.hoursRequested) ? Math.floor(quote.hoursRequested) : 0;
  const copies = Number.isFinite(quote.copies) ? Math.floor(quote.copies) : 1;
  const quotedAmount = Number.isFinite(quote.quotedAmount) ? quote.quotedAmount : 0;

  const tx = db.transaction(() => {
    const t = now();

    if (getAccountPendingCount(uploader) >= RESERVATION_PER_ACCOUNT_MAX) {
      throw Object.assign(
        new Error(`per-account pending reservation limit (${RESERVATION_PER_ACCOUNT_MAX}) reached`),
        { code: 'rate_limited' }
      );
    }

    const usage = getDiskUsage();
    if (usage.used_bytes + sizeBytes > DISK_LIMIT_BYTES) {
      throw Object.assign(
        new Error('insufficient storage available'),
        { code: 'insufficient_storage' }
      );
    }

    const id = newReservationId();
    const expires_at = t + (RESERVATION_TTL_MIN * 60 * 1000);

    db.prepare(`
      INSERT INTO reservations
        (id, uploader, size_bytes, created_at, expires_at, status, mode,
         hours_requested, copies, quoted_amount)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(id, uploader, sizeBytes, t, expires_at, mode, hoursRequested, copies, quotedAmount);

    return { id, expires_at };
  });

  // SQLite's "BEGIN IMMEDIATE" semantics — use immediate transaction
  return tx.immediate();
}

function getReservation(id) {
  return db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
}

function markReservationPaid(reservationId, txId) {
  return db.prepare(`
    UPDATE reservations SET status = 'paid', payment_tx_id = ?
    WHERE id = ? AND status = 'pending'
  `).run(txId, reservationId);
}

function markReservationUploaded(reservationId, pinId) {
  return db.prepare(`
    UPDATE reservations SET status = 'uploaded', pin_id = ?
    WHERE id = ? AND status = 'paid'
  `).run(pinId, reservationId);
}

function markReservationCancelled(reservationId) {
  return db.prepare(`
    UPDATE reservations SET status = 'cancelled'
    WHERE id = ? AND status IN ('pending','paid')
  `).run(reservationId);
}

// ─── Payments ───────────────────────────────────────────────────────────────

/**
 * Record a confirmed payment. tx_id UNIQUE handles replay protection.
 * Throws with code='conflict' if tx_id already recorded.
 */
function recordPayment({ tx_id, reservation_id, uploader, currency, amount, memo, block_num, status }) {
  try {
    const result = db.prepare(`
      INSERT INTO payments (tx_id, reservation_id, uploader, currency, amount, memo, block_num, verified_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tx_id, reservation_id, uploader, currency, amount, memo, block_num, now(), status);
    return { id: result.lastInsertRowid };
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw Object.assign(new Error('tx_id already used (replay)'), { code: 'conflict' });
    }
    throw e;
  }
}

function getPaymentById(id) {
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

function getPaymentByTxId(txId) {
  return db.prepare('SELECT * FROM payments WHERE tx_id = ?').get(txId);
}

function markPaymentRefunded(paymentId, refundTxId) {
  return db.prepare(`
    UPDATE payments SET status = 'refunded', refund_tx_id = ?, refund_at = ?
    WHERE id = ?
  `).run(refundTxId, now(), paymentId);
}

// ─── Pins ───────────────────────────────────────────────────────────────────

function createPin({ cid, uploader, size_bytes, payment_id, ttl_days, expires_at = null, mode = 'encrypted', mime = null }) {
  const t = now();
  // v1 claim model: the caller passes an explicit expires_at (the claim's
  // expiry_ts, so the pin mirrors the lifecycle authority). Falls back to the
  // legacy ttl_days computation when no explicit expiry is given.
  const exp = (expires_at != null) ? expires_at : t + ((ttl_days || DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000);
  const result = db.prepare(`
    INSERT INTO pins (cid, uploader, size_bytes, payment_id, created_at, expires_at, status, mode, mime)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(cid, uploader, size_bytes, payment_id, t, exp, mode, mime);
  return { id: result.lastInsertRowid, expires_at: exp };
}

/**
 * Rendering info for a CID served over GET /ipfs/:cid. Returns the mode + mime
 * of an active pin (most recently created wins; rows for the same CID agree in
 * practice since identical bytes → identical CID). null when no active pin.
 */
function getServeInfoForCid(cid) {
  return db.prepare(`
    SELECT mode, mime FROM pins
    WHERE cid = ? AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(cid) || null;
}

/**
 * User-initiated delete of the caller's OWN pin(s) for a CID. Flips only the
 * caller's active rows to 'expired' (status_reason='user_deleted'); other
 * accounts' pins for the same CID are untouched. Quota frees automatically
 * (getDiskUsage sums status='active'). Returns { removed, fully_unpinned }.
 * fully_unpinned=true means no active pin remains → caller should kubo-unpin+GC.
 */
function removePinForUploader(cid, uploader) {
  return db.transaction(() => {
    const t = now();
    const res = db.prepare(`
      UPDATE pins SET status = 'expired', status_changed_at = ?, status_reason = 'user_deleted'
      WHERE cid = ? AND uploader = ? AND status = 'active'
    `).run(t, cid, uploader);
    return {
      removed: res.changes,
      fully_unpinned: !hasActivePinForCid(cid)
    };
  }).immediate();
}

function getPinById(id) {
  return db.prepare('SELECT * FROM pins WHERE id = ?').get(id);
}

function getActivePinsForCid(cid) {
  return db.prepare("SELECT * FROM pins WHERE cid = ? AND status = 'active'").all(cid);
}

function hasActivePinForCid(cid) {
  const row = db.prepare("SELECT 1 FROM pins WHERE cid = ? AND status = 'active' LIMIT 1").get(cid);
  return !!row;
}

function getMaxExpiryForCid(cid) {
  const row = db.prepare(
    "SELECT MAX(expires_at) AS max_e FROM pins WHERE cid = ? AND status = 'active'"
  ).get(cid);
  return row?.max_e ?? null;
}

function listUploadsForAccount(account, limit = 100, offset = 0) {
  return db.prepare(`
    SELECT p.id AS pin_id, p.cid, p.size_bytes, p.created_at, p.expires_at,
           p.status, p.status_reason, p.mode, p.mime,
           py.tx_id, py.amount, py.currency
    FROM pins p
    JOIN payments py ON p.payment_id = py.id
    WHERE p.uploader = ?
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(account, limit, offset);
}

function countUploadsForAccount(account) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM pins WHERE uploader = ?').get(account);
  return row.c;
}

// ─── Orders + Claims (v1 claim model) ───────────────────────────────────────
// An ORDER is the user's intent ("keep this CID alive"); a CLAIM is one
// (cid, host) hosting record with its own timer + locked rate + escrow. v1 is
// always 1 order ⇒ 1 claim; the split is the v2 federation seam. The claim's
// expiry_ts is the lifecycle authority — the pins row mirrors it (see §6 of
// PRICING-V1-DESIGN-NOTES.md / cohosting §2).

/**
 * Create an order + its single claim atomically, after the pin + payment rows
 * already exist (so we can link pin_id + payment_id). Returns { order_id, claim_id }.
 */
function createOrderWithClaim({
  cid, owner, pinId, paymentId,
  sizeBytes, sizeMB, rateLocked, paidHours, copies = 1,
  amountPaid, currency, startTs, expiryTs,
  kind = 'original'
}) {
  return db.transaction(() => {
    const t = now();
    const orderId = newOrderId();
    const claimId = newClaimId();

    db.prepare(`
      INSERT INTO orders (order_id, cid, owner, created_ts, status)
      VALUES (?, ?, ?, ?, 'open')
    `).run(orderId, cid, owner, t);

    db.prepare(`
      INSERT INTO claims
        (claim_id, order_id, cid, owner, host_gate, pin_id, size_bytes, size_mb,
         rate_locked, paid_hours, copies_requested, kind, state,
         amount_paid, currency, payment_id, start_ts, expiry_ts, created_ts)
      VALUES (?, ?, ?, ?, 'self', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
    `).run(
      claimId, orderId, cid, owner, pinId, sizeBytes, sizeMB,
      rateLocked, paidHours, copies, kind,
      amountPaid, currency, paymentId, startTs, expiryTs, t
    );

    return { order_id: orderId, claim_id: claimId };
  }).immediate();
}

function getClaim(claimId) {
  return db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claimId);
}

function getActiveClaimsForCid(cid) {
  return db.prepare("SELECT * FROM claims WHERE cid = ? AND state = 'active'").all(cid);
}

function listClaimsForOwner(owner) {
  return db.prepare('SELECT * FROM claims WHERE owner = ? ORDER BY created_ts DESC').all(owner);
}

/**
 * User-initiated early cancel of an ACTIVE claim. Atomic + status-locked so a
 * double-click / concurrent cancel can't double-refund: the claim flips
 * active→cancelled exactly once; a second attempt finds nothing to flip. Also
 * expires the linked pin and reports whether the CID now has no active pin
 * (caller kubo-unpins + GCs). Refund computation/broadcast happens in the
 * caller AFTER this returns — safe because only one cancel wins the status lock.
 *
 * Returns { claim, fully_unpinned }. Throws not_found / forbidden / conflict.
 */
function cancelClaim(claimId, owner) {
  return db.transaction(() => {
    const claim = getClaim(claimId);
    if (!claim) {
      throw Object.assign(new Error('claim not found'), { code: 'not_found' });
    }
    if (claim.owner !== owner) {
      throw Object.assign(new Error('not your claim'), { code: 'forbidden' });
    }
    if (claim.state !== 'active') {
      throw Object.assign(new Error(`claim is ${claim.state}, not active`), { code: 'conflict' });
    }

    const t = now();
    const flip = db.prepare(`
      UPDATE claims SET state = 'cancelled' WHERE claim_id = ? AND state = 'active'
    `).run(claimId);
    if (flip.changes === 0) {
      // Lost the race to a concurrent cancel/sweep.
      throw Object.assign(new Error('claim already closed'), { code: 'conflict' });
    }

    if (claim.pin_id) {
      db.prepare(`
        UPDATE pins SET status = 'expired', status_changed_at = ?, status_reason = 'claim_cancelled'
        WHERE id = ? AND status = 'active'
      `).run(t, claim.pin_id);
    }

    return { claim, fully_unpinned: !hasActivePinForCid(claim.cid) };
  }).immediate();
}

// ─── Refund ledger ──────────────────────────────────────────────────────────
// Escrowed-but-owed money is a real custodial float; every refund is a durable
// row so a pending/failed broadcast is visible + retryable, never silently lost.

function recordRefund({ claim_id, to_account, amount, currency, memo, status = 'pending', reason = null, tx_id = null }) {
  const id = newRefundId();
  db.prepare(`
    INSERT INTO refunds (refund_id, claim_id, to_account, amount, currency, memo, status, reason, tx_id, created_ts, settled_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, claim_id, to_account, amount, currency, memo, status, reason, tx_id, now(),
    (status === 'sent' || status === 'skipped' || status === 'failed') ? now() : null
  );
  return { refund_id: id };
}

function markRefundSettled(refundId, status, txId = null) {
  return db.prepare(`
    UPDATE refunds SET status = ?, tx_id = ?, settled_ts = ?
    WHERE refund_id = ?
  `).run(status, txId, now(), refundId);
}

function getRefund(refundId) {
  return db.prepare('SELECT * FROM refunds WHERE refund_id = ?').get(refundId);
}

// ─── Sweeper helpers ────────────────────────────────────────────────────────

/**
 * Expire stale pending reservations, expire CLAIMS past their timer (the v1
 * lifecycle authority), and expire pins with no live funder. Returns
 * { expired_reservations, expired_claims, expired_pins, cids_to_unpin }.
 * cids_to_unpin = CIDs where NO active pin remains; caller kubo-unpins + GCs.
 *
 * Reconcile is the Stage-1a subset of cohosting §5: when an active claim ends,
 * if no active claim remains the file is unpinned. (Stage 1b inserts the
 * "promote the next dormant backstop instead of unpinning" branch here.)
 */
function sweep() {
  const t = now();
  return db.transaction(() => {
    const expRes = db.prepare(`
      UPDATE reservations SET status = 'expired'
      WHERE status = 'pending' AND expires_at < ?
    `).run(t);

    // 1. Expire claims whose timer ran out, then expire each linked pin.
    const expiringClaims = db.prepare(`
      SELECT claim_id, pin_id FROM claims WHERE state = 'active' AND expiry_ts < ?
    `).all(t);
    if (expiringClaims.length > 0) {
      db.prepare(`
        UPDATE claims SET state = 'expired' WHERE state = 'active' AND expiry_ts < ?
      `).run(t);
      const expirePin = db.prepare(`
        UPDATE pins SET status = 'expired', status_changed_at = ?, status_reason = 'claim_expired'
        WHERE id = ? AND status = 'active'
      `);
      for (const c of expiringClaims) {
        if (c.pin_id) expirePin.run(t, c.pin_id);
      }
    }

    // 2. Legacy/orphan pins (no claim, or pre-cutover rows) still expire by their
    //    own clock. Claim-linked pins already flipped to 'expired' in #1, so the
    //    status='active' filter naturally skips them — no double-touch.
    const expPin = db.prepare(`
      UPDATE pins SET status = 'expired', status_changed_at = ?
      WHERE status = 'active' AND expires_at < ?
    `).run(t, t);

    // Find CIDs touched this tick AND now with no remaining active pins.
    const candidates = db.prepare(`
      SELECT DISTINCT cid FROM pins
      WHERE status = 'expired' AND status_changed_at = ?
    `).all(t);

    const cidsToUnpin = [];
    for (const { cid } of candidates) {
      if (!hasActivePinForCid(cid)) cidsToUnpin.push(cid);
    }

    return {
      expired_reservations: expRes.changes,
      expired_claims: expiringClaims.length,
      expired_pins: expPin.changes,
      cids_to_unpin: cidsToUnpin
    };
  }).immediate();
}

// ─── Module exports ─────────────────────────────────────────────────────────

module.exports = {
  open,
  runMigrations,
  // helpers
  now,
  newReservationId,
  newOrderId,
  newClaimId,
  newRefundId,
  getMemoForReservation,
  parseMemoReservationId,
  // queries
  getDiskUsage,
  getAccountPendingCount,
  isAccountBanned,
  isCidBlocked,
  // reservations
  createReservation,
  getReservation,
  markReservationPaid,
  markReservationUploaded,
  markReservationCancelled,
  // payments
  recordPayment,
  getPaymentById,
  getPaymentByTxId,
  markPaymentRefunded,
  // pins
  createPin,
  getPinById,
  getActivePinsForCid,
  hasActivePinForCid,
  getMaxExpiryForCid,
  getServeInfoForCid,
  removePinForUploader,
  listUploadsForAccount,
  countUploadsForAccount,
  // orders + claims (v1 claim model)
  createOrderWithClaim,
  getClaim,
  getActiveClaimsForCid,
  listClaimsForOwner,
  cancelClaim,
  // refund ledger
  recordRefund,
  markRefundSettled,
  getRefund,
  // sweeper
  sweep,
  // constants
  DEFAULT_TTL_DAYS,
  MAX_FILE_SIZE_BYTES,
  RESERVATION_TTL_MIN
};

// Allow `node -e "require('./quota').runMigrations()"`
if (require.main === module) {
  runMigrations();
}