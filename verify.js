// escrow-core/verify.js — on-chain payment verification (VERIFY + the op-shape half
// of REPLAY). Distilled from ipfs-gate hive-verify.js with two transforms:
//
//   1. DE-GLOBALISED config. ipfs-gate read IPFS_GATE_HIVE_ACCOUNT / PAYMENT_CURRENCY
//      / PAYMENT_AMOUNT at module load and compared against them directly. Those are
//      MONEY config and now flow in as PARAMETERS (account, currency, expectedAmount)
//      supplied by the adapter — never module globals. (Operational knobs — the Hive
//      node list, retries, timeouts — stay env-overridable; they're not money config.)
//
//   2. NATIVE HIVE/HBD path ADDED. ipfs-gate only matched the Hive-Engine custom_json
//      (ssc-mainnet-hive) op shape. v4call also takes native HBD/HIVE (['transfer',{…}]).
//      verifyPayment branches on currency and verifies native transfers too — the one
//      real functional addition. The tx_id-anchored + EXACT-memo-match discipline is
//      kept identical (we deliberately DISCARD v4call's get_account_history balance scan).
//
// Replay protection itself is the ledger's tx_id UNIQUE (ledger.recordPayment); this
// module proves the on-chain FACT (a real transfer to `account`, `currency`, ≥ amount,
// memo `expectedMemo`). For Hive-Engine tokens the caller additionally hard-confirms
// the sidechain accepted it via verifySidechain(txId) (Hive-layer broadcast succeeding
// does NOT mean the sidechain action was accepted).

'use strict';

const dhive = require('@hiveio/dhive');

// ─── Operational config (env-overridable — NOT money config) ────────────────
const HIVE_NODE_FALLBACK = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://rpc.mahdiyari.info',
  'https://api.openhive.network',
  'https://techcoderx.com',
  // hive-api.arcange.eu removed 2026-07-07 — consistently ETIMEDOUT from the escrow
  // box AND the dev box; a 10s timeout per dead node stalls every disburse retry.
];
const HIVE_ENGINE_API = 'https://api.hive-engine.com/rpc/contracts';
const HIVE_ENGINE_BLOCKCHAIN_API = 'https://api.hive-engine.com/rpc/blockchain';

const PAYMENT_VERIFY_RETRIES = parseInt(process.env.PAYMENT_VERIFY_RETRIES || '5', 10);
const PAYMENT_VERIFY_DELAY_MS = parseInt(process.env.PAYMENT_VERIFY_DELAY_MS || '3000', 10);

function getHiveNodes() {
  const override = (process.env.HIVE_API || '').trim();
  return override ? [override, ...HIVE_NODE_FALLBACK] : HIVE_NODE_FALLBACK;
}

function isNativeCurrency(currency) {
  const c = String(currency || '').toUpperCase();
  return c === 'HIVE' || c === 'HBD';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Hive JSON-RPC (multi-node fallback + retries; the v4call lesson) ───────
async function hivePost(method, params) {
  let lastErr = null;
  for (const node of getHiveNodes()) {
    try {
      const res = await fetch(node, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      if (!res.ok) { console.warn(`[verify] ${node} HTTP ${res.status}: ${text.slice(0, 200)}`); lastErr = new Error(`HTTP ${res.status} from ${node}`); continue; }
      let data;
      try { data = JSON.parse(text); } catch (e) { console.warn(`[verify] ${node} non-JSON: ${text.slice(0, 200)}`); lastErr = e; continue; }
      if (data.error) { lastErr = new Error(`JSON-RPC: ${data.error.message || JSON.stringify(data.error)}`); continue; }
      if (!('result' in data)) { lastErr = new Error('No result in response'); continue; }
      return data.result;
    } catch (e) {
      console.warn(`[verify] ${node} threw: ${e.message}`);
      lastErr = e;
    }
  }
  throw lastErr || new Error('All Hive nodes failed');
}

/** Fetch a Hive transaction by id, retrying for block-confirmation lag (~3s). */
async function getTransactionWithRetry(txId, { retries = PAYMENT_VERIFY_RETRIES, delayMs = PAYMENT_VERIFY_DELAY_MS } = {}) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const tx = await hivePost('condenser_api.get_transaction', [txId]);
      if (tx && Array.isArray(tx.operations) && tx.operations.length > 0) return tx;
    } catch (e) {
      if (!/missing|not found|unknown|null/i.test(String(e.message)) && attempt === retries - 1) throw e;
    }
    if (attempt < retries - 1) await sleep(delayMs);
  }
  throw Object.assign(new Error(`Hive transaction ${txId} not found after ${retries} attempts`), { code: 'unprocessable_entity' });
}

// ─── Op extraction (two shapes) ─────────────────────────────────────────────

/**
 * Extract the Hive-Engine tokens/transfer custom_json op (ssc-mainnet-hive).
 * The sender is implicit in required_auths (HE contractPayload has no `from`).
 */
function extractTokenTransferOp(tx, expectedSender) {
  if (!tx || !Array.isArray(tx.operations)) {
    throw Object.assign(new Error('transaction has no operations'), { code: 'unprocessable_entity' });
  }
  const who = String(expectedSender || '').toLowerCase();
  for (const op of tx.operations) {
    if (!Array.isArray(op) || op.length < 2 || op[0] !== 'custom_json') continue;
    const payload = op[1];
    if (!payload || payload.id !== 'ssc-mainnet-hive') continue;
    const auths = (payload.required_auths || []).concat(payload.required_posting_auths || []).map(a => String(a).toLowerCase());
    if (!auths.includes(who)) continue;
    let inner;
    try { inner = JSON.parse(payload.json); } catch { continue; }
    for (const a of (Array.isArray(inner) ? inner : [inner])) {
      if (a && a.contractName === 'tokens' && a.contractAction === 'transfer') return a.contractPayload;
    }
  }
  throw Object.assign(new Error('no matching tokens/transfer custom_json op found in transaction'), { code: 'unprocessable_entity' });
}

/**
 * Extract a NATIVE Hive transfer op (['transfer', { from, to, amount:"X.XXX SYM", memo }]).
 * Native ops carry an explicit `from`. (Op shape from v4call's verifyHivePayment, but
 * tx_id-anchored per ipfs-gate's discipline — NOT v4call's account-history scan.)
 */
function extractNativeTransferOp(tx, expectedSender) {
  if (!tx || !Array.isArray(tx.operations)) {
    throw Object.assign(new Error('transaction has no operations'), { code: 'unprocessable_entity' });
  }
  const who = String(expectedSender || '').toLowerCase();
  for (const op of tx.operations) {
    if (!Array.isArray(op) || op.length < 2 || op[0] !== 'transfer') continue;
    const t = op[1];
    if (!t || String(t.from || '').toLowerCase() !== who) continue;
    return t;
  }
  throw Object.assign(new Error('no matching native transfer op found in transaction'), { code: 'unprocessable_entity' });
}

// ─── Payload validation (de-globalised — config is parameters) ──────────────

function requireAmount(minAmount) {
  const required = Number(minAmount);
  if (!Number.isFinite(required)) {
    throw Object.assign(new Error('expectedAmount is required'), { code: 'bad_request' });
  }
  return required;
}

/** Validate a Hive-Engine tokens/transfer payload against expected account/currency/amount/memo. */
function validateTransferPayload(payload, { account, currency, expectedMemo, minAmount }) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('invalid payload'), { code: 'unprocessable_entity' });
  }
  const acct = String(account || '').toLowerCase();
  if ((payload.to || '').toLowerCase() !== acct) {
    throw Object.assign(new Error(`transfer to wrong account: ${payload.to} (expected ${acct})`), { code: 'unprocessable_entity' });
  }
  if (payload.symbol !== currency) {
    throw Object.assign(new Error(`wrong currency: ${payload.symbol} (expected ${currency})`), { code: 'unprocessable_entity' });
  }
  const required = requireAmount(minAmount);
  const paid = parseFloat(payload.quantity);
  if (!Number.isFinite(paid) || paid < required) {
    throw Object.assign(new Error(`underpaid: ${payload.quantity} (expected at least ${required} ${currency})`), { code: 'unprocessable_entity' });
  }
  if (payload.memo !== expectedMemo) {
    throw Object.assign(new Error(`memo mismatch: "${payload.memo}" (expected "${expectedMemo}")`), { code: 'unprocessable_entity' });
  }
  return { paid, currency: payload.symbol };
}

/** Validate a NATIVE Hive transfer op (amount string "X.XXX SYM") — same discipline. */
function validateNativeTransfer(t, { account, currency, expectedMemo, minAmount }) {
  if (!t || typeof t !== 'object') {
    throw Object.assign(new Error('invalid transfer op'), { code: 'unprocessable_entity' });
  }
  const acct = String(account || '').toLowerCase();
  if (String(t.to || '').toLowerCase() !== acct) {
    throw Object.assign(new Error(`transfer to wrong account: ${t.to} (expected ${acct})`), { code: 'unprocessable_entity' });
  }
  const [amtStr, symbol] = String(t.amount || '').trim().split(/\s+/);
  if (symbol !== currency) {
    throw Object.assign(new Error(`wrong currency: ${symbol} (expected ${currency})`), { code: 'unprocessable_entity' });
  }
  const required = requireAmount(minAmount);
  const paid = parseFloat(amtStr);
  if (!Number.isFinite(paid) || paid < required) {
    throw Object.assign(new Error(`underpaid: ${t.amount} (expected at least ${required} ${currency})`), { code: 'unprocessable_entity' });
  }
  if ((t.memo || '') !== expectedMemo) {
    throw Object.assign(new Error(`memo mismatch: "${t.memo}" (expected "${expectedMemo}")`), { code: 'unprocessable_entity' });
  }
  return { paid, currency: symbol };
}

// ─── The public verify entrypoint ───────────────────────────────────────────

/**
 * Verify an on-chain payment. Fetches the tx by id (tx_id-anchored), branches on
 * currency (native HIVE/HBD vs Hive-Engine token), and validates account / currency
 * / amount / memo. Throws coded errors on any mismatch.
 *
 * @param txId,sender            the on-chain tx + claimed payer
 * @param account                escrow account the payment must go to   (adapter config)
 * @param currency               expected token symbol                   (adapter config)
 * @param expectedMemo           exact memo (<namespace>:<purpose>:<ref>) (adapter)
 * @param expectedAmount         minimum acceptable amount (the quote)    (adapter)
 * @param deps.getTransaction    injectable tx fetcher (tests); default getTransactionWithRetry
 * @returns { txId, sender, paid, currency, blockNum, confirmed }
 */
async function verifyPayment({ txId, sender, account, currency, expectedMemo, expectedAmount }, deps = {}) {
  if (!txId || !sender || !account || !currency || expectedMemo == null) {
    throw Object.assign(new Error('verifyPayment: txId, sender, account, currency, expectedMemo are required'), { code: 'bad_request' });
  }
  const getTransaction = deps.getTransaction || getTransactionWithRetry;
  const senderLc = String(sender).toLowerCase();
  const tx = await getTransaction(txId);

  let paid, matchedCurrency;
  if (isNativeCurrency(currency)) {
    const t = extractNativeTransferOp(tx, senderLc);
    ({ paid, currency: matchedCurrency } = validateNativeTransfer(t, { account, currency, expectedMemo, minAmount: expectedAmount }));
  } else {
    const payload = extractTokenTransferOp(tx, senderLc);
    ({ paid, currency: matchedCurrency } = validateTransferPayload(payload, { account, currency, expectedMemo, minAmount: expectedAmount }));
  }

  return { txId, sender: senderLc, paid, currency: matchedCurrency, blockNum: tx.block_num ?? null, confirmed: true };
}

// ─── Hive-Engine sidechain hard-confirm + balance (HE-token only) ───────────

/**
 * Poll Hive-Engine for a tx's sidechain result. A Hive-layer broadcast succeeding
 * does NOT mean the wrapped HE action was accepted (an under-balanced transfer
 * broadcasts fine then is rejected). Returns:
 *   { confirmed:true, logs }                                   accepted
 *   { confirmed:false, reason:'rejected', errors, logs }       sidechain rejected
 *   { confirmed:false, reason:'pending', logs:null }           not yet processed
 */
async function verifySidechain(txId, { retries = PAYMENT_VERIFY_RETRIES, delayMs = PAYMENT_VERIFY_DELAY_MS } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(HIVE_ENGINE_BLOCKCHAIN_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'getTransactionInfo', params: { txid: txId }, id: 1 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { lastErr = new Error(`Hive-Engine blockchain HTTP ${res.status}`); }
      else {
        const data = await res.json();
        if (data.error) { lastErr = new Error(`Hive-Engine blockchain: ${JSON.stringify(data.error)}`); }
        else if (data.result === null) { if (attempt < retries - 1) await sleep(delayMs); continue; }
        else {
          const logsRaw = data.result.logs || '{}';
          let logsObj = {};
          try { logsObj = JSON.parse(logsRaw); } catch {}
          if (Array.isArray(logsObj.errors) && logsObj.errors.length > 0) {
            return { confirmed: false, reason: 'rejected', errors: logsObj.errors, logs: logsRaw };
          }
          return { confirmed: true, logs: logsRaw };
        }
      }
    } catch (e) { lastErr = e; }
    if (attempt < retries - 1) await sleep(delayMs);
  }
  if (lastErr) throw lastErr;
  return { confirmed: false, reason: 'pending', logs: null };
}

/**
 * A Hive-Engine token's on-chain precision (decimal places), from the tokens table.
 * Returns an integer 0..8, or throws (unknown token / network). Callers cache via
 * settle.registerPrecision — see index.resolvePrecision.
 */
async function getTokenPrecision(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const res = await fetch(HIVE_ENGINE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'findOne', params: { contract: 'tokens', table: 'tokens', query: { symbol: sym } }, id: 1 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Hive-Engine HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Hive-Engine: ${JSON.stringify(data.error)}`);
  const p = data.result && Number(data.result.precision);
  if (!Number.isInteger(p) || p < 0 || p > 8) {
    throw Object.assign(new Error(`unknown token or bad precision for ${sym}`), { code: 'unprocessable_entity' });
  }
  return p;
}

/** Hive-Engine token balance for an account (Number). */
async function getHiveEngineBalance(account, symbol) {
  const res = await fetch(HIVE_ENGINE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'findOne', params: { contract: 'tokens', table: 'balances', query: { account, symbol } }, id: 1 }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Hive-Engine HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Hive-Engine: ${JSON.stringify(data.error)}`);
  return data.result ? (parseFloat(data.result.balance) || 0) : 0;
}

/**
 * Idempotency probe for retryable disburse: has `account` ALREADY sent an outgoing
 * transfer carrying EXACTLY `memo` (in `currency`)? Used before re-broadcasting a
 * refund whose first attempt threw a transient/network error — so a broadcast that
 * actually landed but whose response was lost can NEVER be double-paid. Disburse
 * memos are unique per outflow (v4call:payout:<ref>:…, v4call:offer-refund:<ref>, …),
 * so an exact-memo match is a reliable "already sent".
 *
 * Returns { status:'found', txId } | { status:'not_found' } | { status:'error' }.
 * status:'error' (the on-chain read itself failed) means UNKNOWN — the caller MUST
 * NOT re-broadcast this cycle; retry the probe next tick.
 *
 * @param deps.hivePostFn / deps.fetchHE   injectable for tests
 */
async function findOutgoingByMemo(account, memo, currency, deps = {}) {
  const acct = String(account || '').toLowerCase();
  const cur  = String(currency || '').toUpperCase();
  const wantMemo = String(memo || '');
  if (!wantMemo) return { status: 'not_found' };   // no memo → can't dedup by memo

  try {
    if (cur === 'HIVE' || cur === 'HBD') {
      const post = deps.hivePostFn || hivePost;
      // Last 500 account-history ops; scan for a matching outgoing native transfer.
      const hist = await post('condenser_api.get_account_history', [acct, -1, 500]);
      if (!Array.isArray(hist)) return { status: 'error' };
      for (const entry of hist) {
        const rec = entry && entry[1];
        const op  = rec && rec.op;
        if (!op || op[0] !== 'transfer') continue;
        const d = op[1] || {};
        if (String(d.from).toLowerCase() === acct && d.memo === wantMemo &&
            typeof d.amount === 'string' && d.amount.endsWith(' ' + cur)) {
          return { status: 'found', txId: rec.trx_id || null };
        }
      }
      return { status: 'not_found' };
    }
    // Hive-Engine token: scan this account's recent transfer history for the memo.
    const fetchHE = deps.fetchHE || ((url) => fetch(url, { signal: AbortSignal.timeout(10000) }));
    const url = `https://history.hive-engine.com/accountHistory?account=${encodeURIComponent(acct)}&symbol=${encodeURIComponent(cur)}&limit=100&offset=0`;
    const res = await fetchHE(url);
    if (!res || !res.ok) return { status: 'error' };
    const arr = await res.json();
    if (!Array.isArray(arr)) return { status: 'error' };
    for (const t of arr) {
      if (String(t.from).toLowerCase() === acct && t.memo === wantMemo && String(t.symbol).toUpperCase() === cur) {
        return { status: 'found', txId: t.transactionId || t.txid || null };
      }
    }
    return { status: 'not_found' };
  } catch (e) {
    console.warn(`[verify] findOutgoingByMemo(${acct},${cur}) probe failed: ${e.message}`);
    return { status: 'error' };
  }
}

/**
 * An account's current POSTING public keys (STM-prefixed) — the identity control
 * for signed user endpoints that carry no on-chain payment to anchor identity.
 * Returns [] if the account doesn't exist; throws (network) only if all nodes fail.
 */
async function getAccountPostingPubkeys(account) {
  const acct = String(account || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(acct)) {
    throw Object.assign(new Error('invalid Hive account name'), { code: 'bad_request' });
  }
  const result = await hivePost('condenser_api.get_accounts', [[acct]]);
  if (!Array.isArray(result) || result.length === 0) return [];
  const keyAuths = (result[0] && result[0].posting && result[0].posting.key_auths) || [];
  return keyAuths.map(ka => ka[0]).filter(k => typeof k === 'string');
}

module.exports = {
  hivePost,
  getTransactionWithRetry,
  extractTokenTransferOp,
  extractNativeTransferOp,
  validateTransferPayload,
  validateNativeTransfer,
  verifyPayment,
  verifySidechain,
  getHiveEngineBalance,
  getTokenPrecision,
  getAccountPostingPubkeys,
  findOutgoingByMemo,
  isNativeCurrency,
  HIVE_NODE_FALLBACK,
};
