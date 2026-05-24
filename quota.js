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
const DEFAULT_TTL_DAYS = parseInt(process.env.DEFAULT_TTL_DAYS || '7', 10);
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
  const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    db.exec(sql);
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
function createReservation(uploader, sizeBytes) {
  if (!uploader || typeof uploader !== 'string') {
    throw Object.assign(new Error('uploader required'), { code: 'bad_request' });
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
      INSERT INTO reservations (id, uploader, size_bytes, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(id, uploader, sizeBytes, t, expires_at);

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

function createPin({ cid, uploader, size_bytes, payment_id, ttl_days }) {
  const t = now();
  const days = ttl_days || DEFAULT_TTL_DAYS;
  const expires_at = t + (days * 24 * 60 * 60 * 1000);
  const result = db.prepare(`
    INSERT INTO pins (cid, uploader, size_bytes, payment_id, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
  `).run(cid, uploader, size_bytes, payment_id, t, expires_at);
  return { id: result.lastInsertRowid, expires_at };
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
           p.status, p.status_reason,
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

// ─── Sweeper helpers ────────────────────────────────────────────────────────

/**
 * Expire stale pending reservations + active pins past TTL.
 * Returns { expired_reservations, expired_pins, cids_to_unpin }.
 * cids_to_unpin = CIDs where NO active pin remains; caller should kubo-unpin + GC.
 */
function sweep() {
  const t = now();
  return db.transaction(() => {
    const expRes = db.prepare(`
      UPDATE reservations SET status = 'expired'
      WHERE status = 'pending' AND expires_at < ?
    `).run(t);

    const expPin = db.prepare(`
      UPDATE pins SET status = 'expired', status_changed_at = ?
      WHERE status = 'active' AND expires_at < ?
    `).run(t, t);

    // Find CIDs that just got expired AND have no remaining active pins.
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
  listUploadsForAccount,
  countUploadsForAccount,
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