// ipfs-gate v0.1 — Hive payment verification.
// Implements Option C from the design: tx_id lookup on Hive +
// Hive-Engine balance check belt-and-braces.

const dhive = require('@hiveio/dhive');

const HIVE_NODE_FALLBACK = [
  'https://api.hive.blog',
  'https://api.deathwing.me',
  'https://hive-api.arcange.eu',
  'https://api.openhive.network',
  'https://techcoderx.com'
];

const HIVE_ENGINE_API = 'https://api.hive-engine.com/rpc/contracts';
const HIVE_ENGINE_BLOCKCHAIN_API = 'https://api.hive-engine.com/rpc/blockchain';

const IPFS_GATE_HIVE_ACCOUNT = (process.env.IPFS_GATE_HIVE_ACCOUNT || '').toLowerCase();
const PAYMENT_CURRENCY = process.env.PAYMENT_CURRENCY || 'CNOOBS';
const PAYMENT_AMOUNT = parseFloat(process.env.PAYMENT_AMOUNT || '1');
const PAYMENT_VERIFY_RETRIES = parseInt(process.env.PAYMENT_VERIFY_RETRIES || '5', 10);
const PAYMENT_VERIFY_DELAY_MS = parseInt(process.env.PAYMENT_VERIFY_DELAY_MS || '3000', 10);
const SIDECHAIN_CONFIRM_DELAY_MS = parseInt(process.env.SIDECHAIN_CONFIRM_DELAY_MS || '5000', 10);

function getHiveNodes() {
  const override = (process.env.HIVE_API || '').trim();
  if (override) return [override, ...HIVE_NODE_FALLBACK];
  return HIVE_NODE_FALLBACK;
}

// Lazy dhive client for outbound broadcasts (refunds). Built once on first use
// so `require('./hive-verify')` stays cheap for the pricing/lifecycle tests that
// never broadcast anything.
let _dhiveClient = null;
function getDhiveClient() {
  if (!_dhiveClient) _dhiveClient = new dhive.Client(getHiveNodes(), { timeout: 10000 });
  return _dhiveClient;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * POST a JSON-RPC call to a Hive node, with multi-node fallback + retries.
 * Logs HTTP status / JSON-RPC error / body preview on failures (the v4call lesson).
 */
async function hivePost(method, params) {
  const nodes = getHiveNodes();
  let lastErr = null;

  for (const node of nodes) {
    try {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: 1
      });

      const res = await fetch(node, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10000)
      });

      const text = await res.text();

      if (!res.ok) {
        console.warn(`[hive-verify] ${node} HTTP ${res.status}: ${text.slice(0, 200)}`);
        lastErr = new Error(`HTTP ${res.status} from ${node}`);
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn(`[hive-verify] ${node} returned non-JSON: ${text.slice(0, 200)}`);
        lastErr = e;
        continue;
      }

      if (data.error) {
        console.warn(`[hive-verify] ${node} JSON-RPC error: ${JSON.stringify(data.error).slice(0, 300)}`);
        lastErr = new Error(`JSON-RPC: ${data.error.message || JSON.stringify(data.error)}`);
        continue;
      }

      if (!('result' in data)) {
        console.warn(`[hive-verify] ${node} returned 200 OK but no result field: ${text.slice(0, 200)}`);
        lastErr = new Error('No result in response');
        continue;
      }

      return data.result;
    } catch (e) {
      console.warn(`[hive-verify] ${node} threw: ${e.message}`);
      lastErr = e;
      continue;
    }
  }

  throw lastErr || new Error('All Hive nodes failed');
}

/**
 * Fetch a Hive transaction by id. Retries with backoff because block
 * confirmation lags broadcast by ~3 seconds.
 */
async function getTransactionWithRetry(txId) {
  for (let attempt = 0; attempt < PAYMENT_VERIFY_RETRIES; attempt++) {
    try {
      const tx = await hivePost('condenser_api.get_transaction', [txId]);
      if (tx && Array.isArray(tx.operations) && tx.operations.length > 0) {
        return tx;
      }
    } catch (e) {
      // Some nodes return error if tx not yet in a block; treat as retryable
      if (!/missing|not found|unknown|null/i.test(String(e.message))) {
        // Unexpected error — propagate
        if (attempt === PAYMENT_VERIFY_RETRIES - 1) throw e;
      }
    }
    if (attempt < PAYMENT_VERIFY_RETRIES - 1) {
      await sleep(PAYMENT_VERIFY_DELAY_MS);
    }
  }
  throw Object.assign(
    new Error(`Hive transaction ${txId} not found after ${PAYMENT_VERIFY_RETRIES} attempts`),
    { code: 'unprocessable_entity' }
  );
}

/**
 * Extract the Hive-Engine custom_json op from a transaction's operations.
 * Returns the parsed contractPayload for a 'tokens' / 'transfer' action.
 * Throws with code='unprocessable_entity' if the op shape doesn't match.
 */
function extractTokenTransferOp(tx, expectedSender) {
  if (!tx || !Array.isArray(tx.operations)) {
    throw Object.assign(new Error('transaction has no operations'), { code: 'unprocessable_entity' });
  }

  for (const op of tx.operations) {
    if (!Array.isArray(op) || op.length < 2) continue;
    if (op[0] !== 'custom_json') continue;

    const payload = op[1];
    if (!payload || payload.id !== 'ssc-mainnet-hive') continue;

    // required_auths must include the expected sender
    const auths = (payload.required_auths || []).concat(payload.required_posting_auths || []);
    if (!auths.includes(expectedSender)) continue;

    let inner;
    try {
      inner = JSON.parse(payload.json);
    } catch (e) {
      continue;
    }

    // Some custom_json payloads wrap one op; others wrap an array. Normalise.
    const actions = Array.isArray(inner) ? inner : [inner];
    for (const a of actions) {
      if (a && a.contractName === 'tokens' && a.contractAction === 'transfer') {
        return a.contractPayload;
      }
    }
  }

  throw Object.assign(
    new Error('no matching tokens/transfer custom_json op found in transaction'),
    { code: 'unprocessable_entity' }
  );
}

/**
 * Validate a token transfer payload against the expected fields.
 * Throws with detailed code/message on any mismatch.
 */
function validateTransferPayload(payload, { sender, expectedMemo, minAmount }) {
  if (!payload || typeof payload !== 'object') {
    throw Object.assign(new Error('invalid payload'), { code: 'unprocessable_entity' });
  }
  if ((payload.to || '').toLowerCase() !== IPFS_GATE_HIVE_ACCOUNT) {
    throw Object.assign(
      new Error(`transfer to wrong account: ${payload.to} (expected ${IPFS_GATE_HIVE_ACCOUNT})`),
      { code: 'unprocessable_entity' }
    );
  }
  if (payload.symbol !== PAYMENT_CURRENCY) {
    throw Object.assign(
      new Error(`wrong currency: ${payload.symbol} (expected ${PAYMENT_CURRENCY})`),
      { code: 'unprocessable_entity' }
    );
  }
  // v1 claim model: the required amount is the per-claim QUOTE (size×time×copies),
  // passed in as minAmount. Falls back to the legacy flat PAYMENT_AMOUNT when the
  // caller didn't compute a quote (e.g. a legacy/test path).
  const required = (minAmount !== undefined && minAmount !== null) ? Number(minAmount) : PAYMENT_AMOUNT;
  const paid = parseFloat(payload.quantity);
  if (!Number.isFinite(paid) || paid < required) {
    throw Object.assign(
      new Error(`underpaid: ${payload.quantity} (expected at least ${required} ${PAYMENT_CURRENCY})`),
      { code: 'unprocessable_entity' }
    );
  }
  if (payload.memo !== expectedMemo) {
    throw Object.assign(
      new Error(`memo mismatch: "${payload.memo}" (expected "${expectedMemo}")`),
      { code: 'unprocessable_entity' }
    );
  }
  // NOTE: Hive-Engine's tokens/transfer contractPayload has no `from` field —
  // the sender is implicit in the wrapping custom_json's required_auths, which
  // extractTokenTransferOp() already validates against `expectedSender`. A
  // redundant `payload.from` check here always fails for real transfers (the
  // field is always undefined) and was a v0.1.1 first-test bug.
  return { paid, currency: payload.symbol };
}

/**
 * Hive-Engine sidechain transaction lookup.
 * Polls api.hive-engine.com/rpc/blockchain getTransactionInfo until the tx
 * either appears with success/failure info or the retry budget is exhausted.
 *
 * Why we need this: Hive Keychain reports success on Hive-layer broadcast
 * regardless of whether the wrapped Hive-Engine custom_json action will be
 * accepted by the sidechain. An under-balanced or otherwise-invalid token
 * transfer broadcasts fine but is rejected when the sidechain processes it.
 * The legacy balance check (compare ipfs-gate balance to claimed amount) is
 * useless here: the existing escrow balance already exceeds the per-payment
 * amount, so the check passes even when 0 actually landed.
 *
 * Returns:
 *   { confirmed: true,  logs: '{}'  }                              accepted
 *   { confirmed: false, reason: 'rejected', errors: [...], logs }  sidechain rejected
 *   { confirmed: false, reason: 'pending',  logs: null }           not yet processed
 *
 * Throws only on RPC/network failure after exhausting retries.
 */
async function verifyHiveEngineSidechain(txId, {
  retries = PAYMENT_VERIFY_RETRIES,
  delayMs = PAYMENT_VERIFY_DELAY_MS
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(HIVE_ENGINE_BLOCKCHAIN_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', method: 'getTransactionInfo',
          params: { txid: txId }, id: 1
        }),
        signal: AbortSignal.timeout(10000)
      });
      if (!res.ok) {
        lastErr = new Error(`Hive-Engine blockchain HTTP ${res.status}`);
      } else {
        const data = await res.json();
        if (data.error) {
          lastErr = new Error(`Hive-Engine blockchain: ${JSON.stringify(data.error)}`);
        } else if (data.result === null) {
          // Not yet processed by the sidechain — retry
          if (attempt < retries - 1) await sleep(delayMs);
          continue;
        } else {
          // Result present. Inspect logs for errors.
          const logsRaw = data.result.logs || '{}';
          let logsObj = {};
          try { logsObj = JSON.parse(logsRaw); } catch (_) {}
          if (Array.isArray(logsObj.errors) && logsObj.errors.length > 0) {
            return {
              confirmed: false,
              reason: 'rejected',
              errors: logsObj.errors,
              logs: logsRaw
            };
          }
          return { confirmed: true, logs: logsRaw };
        }
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries - 1) await sleep(delayMs);
  }
  if (lastErr) throw lastErr;
  // Exhausted retries without success or error → still pending
  return { confirmed: false, reason: 'pending', logs: null };
}

/**
 * Hive-Engine balance check for ipfs-gate's escrow account.
 * Returns balance as a Number (the token quantity).
 */
async function getHiveEngineBalance(account, symbol) {
  const res = await fetch(HIVE_ENGINE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'findOne',
      params: { contract: 'tokens', table: 'balances', query: { account, symbol } },
      id: 1
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) {
    throw new Error(`Hive-Engine HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`Hive-Engine: ${JSON.stringify(data.error)}`);
  }
  if (!data.result) return 0;
  return parseFloat(data.result.balance) || 0;
}

/**
 * Full payment verification.
 * Throws with .code on any failure.
 * Returns { tx_id, sender, paid, currency, block_num } on success.
 */
async function verifyPayment({ tx_id, sender, expectedMemo, expectedAmount, expectedReservationBalanceFloor }) {
  if (!IPFS_GATE_HIVE_ACCOUNT) {
    throw new Error('IPFS_GATE_HIVE_ACCOUNT not configured');
  }

  // Step 1: fetch transaction (with retries for block confirmation)
  const tx = await getTransactionWithRetry(tx_id);

  // Step 2: extract + validate the tokens/transfer op. expectedAmount = the
  // per-claim quote the gate computed at /reserve (v1 claim model). When omitted,
  // validateTransferPayload falls back to the legacy flat PAYMENT_AMOUNT.
  const payload = extractTokenTransferOp(tx, sender);
  const { paid, currency } = validateTransferPayload(payload, { sender, expectedMemo, minAmount: expectedAmount });

  // Step 3: optional sidechain confirmation via balance check.
  // Caller passes expectedReservationBalanceFloor = the minimum balance we
  // expect to see for this payment to be considered landed.
  // If balance check fails, the caller may flag status='paid_unconfirmed'.
  let balance = null;
  let confirmed = true;
  if (expectedReservationBalanceFloor !== undefined && expectedReservationBalanceFloor !== null) {
    await sleep(SIDECHAIN_CONFIRM_DELAY_MS);
    balance = await getHiveEngineBalance(IPFS_GATE_HIVE_ACCOUNT, PAYMENT_CURRENCY);
    if (balance < expectedReservationBalanceFloor) {
      confirmed = false;
    }
  }

  return {
    tx_id,
    sender,
    paid,
    currency,
    block_num: tx.block_num || null,
    balance_after: balance,
    confirmed
  };
}

/**
 * Issue a refund — send `amount` of `currency` from ipfs-gate's escrow back to
 * `to`, signed with the escrow ACTIVE key (IPFS_GATE_ACTIVE_KEY). HIVE/HBD go
 * out as a native `transfer`; everything else as a Hive-Engine `custom_json`
 * tokens/transfer (`ssc-mainnet-hive`). Returns { tx_id, currency }.
 *
 * Key-optional by design: if IPFS_GATE_ACTIVE_KEY is unset the gate still boots
 * and runs — this throws `code:'no_refund_key'` so the caller records the refund
 * `pending` for manual settlement (operator transfers + POST /admin/log-refund),
 * exactly the pre-v1 behaviour. Network/broadcast failures throw normally so the
 * caller can mark the refund `failed` and retry.
 */
async function sendRefund({ to, amount, currency, memo }) {
  const keyStr = (process.env.IPFS_GATE_ACTIVE_KEY || '').trim();
  if (!keyStr) {
    throw Object.assign(
      new Error('IPFS_GATE_ACTIVE_KEY not set — refund recorded pending; operator must transfer manually + POST /admin/log-refund'),
      { code: 'no_refund_key' }
    );
  }
  const dest = String(to || '').toLowerCase();
  const cur = String(currency || '').toUpperCase();
  const amt = Number(amount);
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(dest)) {
    throw Object.assign(new Error(`invalid refund destination: ${to}`), { code: 'bad_request' });
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    throw Object.assign(new Error(`invalid refund amount: ${amount}`), { code: 'bad_request' });
  }

  const key = dhive.PrivateKey.fromString(keyStr);
  const client = getDhiveClient();

  let op;
  if (cur === 'HIVE' || cur === 'HBD') {
    // Native transfer — amount must carry 3-dp + the asset symbol.
    op = ['transfer', {
      from: IPFS_GATE_HIVE_ACCOUNT,
      to: dest,
      amount: `${amt.toFixed(3)} ${cur}`,
      memo: memo || ''
    }];
  } else {
    // Hive-Engine token transfer (sidechain) via custom_json, ACTIVE auth.
    op = ['custom_json', {
      required_auths: [IPFS_GATE_HIVE_ACCOUNT],
      required_posting_auths: [],
      id: 'ssc-mainnet-hive',
      json: JSON.stringify({
        contractName: 'tokens',
        contractAction: 'transfer',
        contractPayload: { symbol: cur, to: dest, quantity: String(amt), memo: memo || '' }
      })
    }];
  }

  const res = await client.broadcast.sendOperations([op], key);
  return { tx_id: res.id, currency: cur };
}

/**
 * Fetch an account's current POSTING public keys from Hive.
 *
 * The load-bearing identity control for the signed user endpoints
 * (/uploads/by-user, /uploads/delete): those carry no on-chain payment to
 * anchor identity the way /upload does, so the caller-supplied pubkey MUST be
 * proven to belong to the claimed account. A signature alone only proves
 * "whoever holds THIS key signed" — not that the key is the account's.
 *
 * Returns an array of STM-prefixed pubkey strings (the posting authority's
 * key_auths). Returns [] if the account does not exist. Throws (network) only
 * if every Hive node is unreachable — callers should fail closed on throw.
 */
async function getAccountPostingPubkeys(account) {
  const acct = String(account || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.\-]*$/.test(acct)) {
    throw Object.assign(new Error('invalid Hive account name'), { code: 'bad_request' });
  }
  const result = await hivePost('condenser_api.get_accounts', [[acct]]);
  if (!Array.isArray(result) || result.length === 0) return [];
  const posting = result[0] && result[0].posting;
  const keyAuths = (posting && posting.key_auths) || [];
  // key_auths is [[pubkey, weight], ...]; we only need the key strings.
  return keyAuths.map(ka => ka[0]).filter(k => typeof k === 'string');
}

module.exports = {
  hivePost,
  getAccountPostingPubkeys,
  getTransactionWithRetry,
  extractTokenTransferOp,
  validateTransferPayload,
  getHiveEngineBalance,
  verifyHiveEngineSidechain,
  verifyPayment,
  sendRefund,
  // exposed for tests + caller convenience
  IPFS_GATE_HIVE_ACCOUNT,
  PAYMENT_CURRENCY,
  PAYMENT_AMOUNT
};