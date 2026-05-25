// ipfs-gate v0.1 — Hive payment verification.
// Implements Option C from the design: tx_id lookup on Hive +
// Hive-Engine balance check belt-and-braces.

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
function validateTransferPayload(payload, { sender, expectedMemo }) {
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
  const paid = parseFloat(payload.quantity);
  if (!Number.isFinite(paid) || paid < PAYMENT_AMOUNT) {
    throw Object.assign(
      new Error(`underpaid: ${payload.quantity} (expected at least ${PAYMENT_AMOUNT} ${PAYMENT_CURRENCY})`),
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
async function verifyPayment({ tx_id, sender, expectedMemo, expectedReservationBalanceFloor }) {
  if (!IPFS_GATE_HIVE_ACCOUNT) {
    throw new Error('IPFS_GATE_HIVE_ACCOUNT not configured');
  }

  // Step 1: fetch transaction (with retries for block confirmation)
  const tx = await getTransactionWithRetry(tx_id);

  // Step 2: extract + validate the tokens/transfer op
  const payload = extractTokenTransferOp(tx, sender);
  const { paid, currency } = validateTransferPayload(payload, { sender, expectedMemo });

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
 * Issue a refund — send tokens from ipfs-gate's escrow back to a user.
 * Uses dhive to broadcast a custom_json with the active key.
 *
 * NOTE: signed broadcast is a v0.2 polish; for v0.1 we expose this stub
 * so the moderation + sweeper code can call it. Actual broadcast left as
 * TODO until the first refund flow is wired.
 */
async function sendRefund({ to, amount, currency, memo }) {
  // TODO v0.1: implement using @hiveio/dhive PrivateKey + Operation.custom_json
  // For now, log + throw so a caller can choose to handle (e.g. mark refund
  // 'failed' in DB and surface to operator for manual transfer).
  console.warn(`[hive-verify] sendRefund stub: would send ${amount} ${currency} to @${to} memo "${memo}"`);
  throw Object.assign(
    new Error('sendRefund not yet implemented; operator must refund manually + POST /admin/log-refund'),
    { code: 'not_implemented' }
  );
}

module.exports = {
  hivePost,
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