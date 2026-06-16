// escrow-core/ledger.js — the durable, idempotent escrow ledger.
//
// Distilled from ipfs-gate quota.js: the ESCROW SPINE only — the payments replay
// guard, the single-winner settle flip, the durable refund lifecycle, and the
// idempotent consent/receipt rows. ipfs-gate's pin / reservation / claim / backstop
// / quota / moderation machinery is LEFT BEHIND (this is escrow, not storage).
//
// openLedger(dbPath) returns a HANDLE bound to that DB — a library may open several,
// and tests use throwaway DBs. Config flows through arguments, NEVER module-level
// env reads (handover guardrail).
//
// TWO MONEY INVARIANTS this module enforces — never weaken:
//   1. tx_id UNIQUE      → recordPayment throws code:'conflict' on replay.
//   2. single-winner flip → atomicClose(ref) succeeds for exactly ONE caller; a lost
//      race returns false (changes===0). This is what prevents double-disburse.

'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CORE_MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// ─── Version-aware migration runner (from quota.js:34, generalised) ─────────
// Each NNN_*.sql (and each adapter migration {version, sql}) is applied exactly
// once, gated on schema_version — so ALTER TABLE ADD COLUMN in later migrations
// never re-runs and throws. Adapter migrations use versions ≥ 100 by convention.
function runMigrations(db, migrationsDir, adapterMigrations) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );`);

  const apply = (ver, sql) => {
    const current = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get().v;
    if (ver <= current) return;
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(ver, Date.now());
  };

  const files = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort()
    : [];
  for (const f of files) {
    apply(parseInt(f.match(/^(\d+)/)[1], 10), fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  for (const m of [...adapterMigrations].sort((a, b) => a.version - b.version)) {
    apply(m.version, m.sql);
  }
}

/**
 * Open (and migrate) an escrow ledger. Returns a handle of bound functions.
 *
 * @param dbPath            SQLite path, or ':memory:'.
 * @param opts.now          injectable clock (default Date.now) — keeps tests deterministic.
 * @param opts.migrationsDir core migrations dir (default ./migrations).
 * @param opts.adapterMigrations [{version, sql}] per-service schema (versions ≥ 100).
 */
function openLedger(dbPath, { now = Date.now, migrationsDir = CORE_MIGRATIONS_DIR, adapterMigrations = [] } = {}) {
  if (dbPath && dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });   // Docker-mount / first-boot edge
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');

  runMigrations(db, migrationsDir, adapterMigrations);

  // Whitelist of real payments columns — adapter columns may only be inserted if
  // they actually exist on the table (prevents SQL injection via key names).
  const paymentCols = new Set(db.prepare('PRAGMA table_info(payments)').all().map(c => c.name));

  // ── prepared statements ──
  const q = {
    getPaymentByTxId:   db.prepare('SELECT * FROM payments WHERE tx_id = ?'),
    getPaymentById:     db.prepare('SELECT * FROM payments WHERE id = ?'),
    getPaymentsByRef:   db.prepare('SELECT * FROM payments WHERE ref = ?'),
    markPaymentRefunded: db.prepare(`UPDATE payments SET status = 'refunded', refund_tx_id = ?, refund_at = ? WHERE id = ?`),
    atomicClose:        db.prepare(`UPDATE payments SET settle_state = 'closed', settled_at = ? WHERE ref = ? AND settle_state = 'open'`),
    insertRefund:       db.prepare(`INSERT INTO refunds (refund_id, ref, to_account, amount, currency, memo, status, reason, tx_id, created_ts, settled_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    markRefundSettled:  db.prepare(`UPDATE refunds SET status = ?, tx_id = ?, settled_ts = ? WHERE refund_id = ?`),
    getRefund:          db.prepare('SELECT * FROM refunds WHERE refund_id = ?'),
    insertConsent:      db.prepare(`INSERT OR IGNORE INTO release_consents (ref, releaser, consented_at, sig) VALUES (?, ?, ?, ?)`),
    getConsents:        db.prepare('SELECT releaser FROM release_consents WHERE ref = ?'),
    insertReceipt:      db.prepare(`INSERT OR IGNORE INTO receipts (ref, recipient, proof_hash, received_at, sig) VALUES (?, ?, ?, ?, ?)`),
    getReceipts:        db.prepare('SELECT recipient, proof_hash, received_at FROM receipts WHERE ref = ?'),
  };

  // ── Payments ──
  /**
   * Record a confirmed on-chain deposit. tx_id UNIQUE → replay protection:
   * a duplicate tx_id throws code:'conflict'. Core columns are explicit; any extra
   * keys are treated as adapter columns and inserted IFF they exist on the table.
   */
  function recordPayment(payment) {
    const {
      tx_id, ref, sender, currency, amount, memo,
      block_num = null, status = 'confirmed', ...extra
    } = payment || {};
    if (!tx_id || !ref || !sender || !currency || amount == null || memo == null) {
      throw Object.assign(new Error('recordPayment: tx_id, ref, sender, currency, amount, memo are required'), { code: 'bad_request' });
    }

    const cols = ['tx_id', 'ref', 'sender', 'currency', 'amount', 'memo', 'block_num', 'verified_at', 'status'];
    const vals = [tx_id, ref, sender, currency, amount, memo, block_num, now(), status];
    for (const [k, v] of Object.entries(extra)) {
      if (!paymentCols.has(k)) {
        throw Object.assign(new Error(`recordPayment: unknown payments column '${k}'`), { code: 'bad_request' });
      }
      cols.push(k);
      vals.push(v);
    }

    try {
      const res = db.prepare(`INSERT INTO payments (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
      return { id: res.lastInsertRowid };
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw Object.assign(new Error('tx_id already used (replay)'), { code: 'conflict' });
      }
      throw e;
    }
  }

  const getPaymentByTxId  = (txId) => q.getPaymentByTxId.get(txId);
  const getPaymentById    = (id)   => q.getPaymentById.get(id);
  const getPaymentsByRef  = (ref)  => q.getPaymentsByRef.all(ref);
  const markPaymentRefunded = (paymentId, refundTxId) => q.markPaymentRefunded.run(refundTxId, now(), paymentId);

  /**
   * THE single-winner settle flip — the generic extraction of ipfs-gate's
   * cancelClaim/endActiveClaimForRelease atomic flip, decoupled from pins/claims.
   * Flips every open escrow row for `ref` to 'closed' in one statement. Returns
   * true if THIS call won the race (changes > 0), false if it was already closed /
   * no such ref ("lost the race"). The caller computes settle()+disburse ONLY on
   * true — so the deposit can never be settled twice (no double-disburse).
   */
  function atomicClose(ref) {
    return q.atomicClose.run(now(), ref).changes > 0;
  }

  // ── Refund ledger ──
  function recordRefund({ ref, to_account, amount, currency, memo, status = 'pending', reason = null, tx_id = null }) {
    const refund_id = 'rfd_' + crypto.randomBytes(8).toString('hex');
    const settled_ts = (status === 'sent' || status === 'skipped' || status === 'failed') ? now() : null;
    q.insertRefund.run(refund_id, ref, to_account, amount, currency, memo, status, reason, tx_id, now(), settled_ts);
    return { refund_id };
  }
  const markRefundSettled = (refundId, status, txId = null) => q.markRefundSettled.run(status, txId, now(), refundId);
  const getRefund = (refundId) => q.getRefund.get(refundId);

  // ── Idempotent consent / receipts ──
  /** INSERT OR IGNORE → idempotent. Returns { inserted:false } when it was a no-op (already consented). */
  function recordConsent(ref, releaser, sig = null) {
    const res = q.insertConsent.run(ref, String(releaser).toLowerCase(), now(), sig);
    return { inserted: res.changes > 0 };
  }
  const getConsents = (ref) => q.getConsents.all(ref).map(r => r.releaser);

  function recordReceipt(ref, recipient, proofHash, sig = null) {
    const res = q.insertReceipt.run(ref, String(recipient).toLowerCase(), proofHash, now(), sig);
    return { inserted: res.changes > 0 };
  }
  const getReceipts = (ref) => q.getReceipts.all(ref);

  return {
    db,
    // payments + replay guard
    recordPayment, getPaymentByTxId, getPaymentById, getPaymentsByRef, markPaymentRefunded,
    // single-winner settle flip
    atomicClose,
    // refund ledger
    recordRefund, markRefundSettled, getRefund,
    // idempotent consent / receipts
    recordConsent, getConsents, recordReceipt, getReceipts,
    close: () => db.close(),
  };
}

module.exports = { openLedger, runMigrations, CORE_MIGRATIONS_DIR };
