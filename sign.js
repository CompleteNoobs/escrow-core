// escrow-core/sign.js — custodial disburse (the SIGN op). Distilled from ipfs-gate
// hive-verify.js sendRefund, with the handover §2.3 transforms:
//
//   - PARAMETERISED. ipfs-gate hardcoded from=IPFS_GATE_HIVE_ACCOUNT and the key
//     env IPFS_GATE_ACTIVE_KEY. Both become config: `fromAccount` (the escrow
//     account) and `keyEnv` (the NAME of the env var holding the active key — the
//     secret itself stays in env, never a parameter).
//   - PER-CURRENCY PRECISION (Decision #3). ipfs-gate's native branch hardcoded
//     amt.toFixed(3); now routed through settle.precision(currency) (or a locked
//     `places`), so non-3dp Hive-Engine tokens format correctly.
//   - no_refund_key → no_key. Key-optional by design: a missing key throws
//     code:'no_key' so the caller records the refund 'pending' for manual settlement.
//
// Native HIVE/HBD go out as a native `transfer`; everything else as a Hive-Engine
// custom_json tokens/transfer (ssc-mainnet-hive), ACTIVE auth.

'use strict';

const dhive = require('@hiveio/dhive');
const { precision } = require('./settle');
const { hivePost } = require('./verify');

const VALID_ACCOUNT = /^[a-z0-9][a-z0-9.\-]*$/;

/**
 * Broadcast `ops` signed with `key`, using NATIVE fetch (verify.js hivePost — the
 * multi-node JSON-RPC helper this library already trusts for verification) instead of
 * dhive's Client network layer. Why: dhive bundles cross-fetch/node-fetch, which on
 * the production escrow box (Alpine, Node 24) failed ~100% of requests with
 * 'Premature close' while native fetch and core https from the SAME box were clean
 * (diagnosed live 2026-07-07). dhive is still used for what it's good at — OFFLINE
 * transaction signing (cryptoUtils.signTransaction) — so the wire format is identical.
 *
 * Same-shape result as client.broadcast.sendOperations: { id }.
 * @param deps.rpc  injectable JSON-RPC poster (tests); default verify.hivePost
 */
async function nativeBroadcast(ops, key, deps = {}) {
  const rpc = deps.rpc || hivePost;
  const dgp = await rpc('condenser_api.get_dynamic_global_properties', []);
  const headBlockId = Buffer.from(dgp.head_block_id, 'hex');
  const tx = {
    ref_block_num: dgp.head_block_number & 0xffff,
    ref_block_prefix: headBlockId.readUInt32LE(4),
    expiration: new Date(Date.now() + 60 * 1000).toISOString().slice(0, -5),
    operations: ops,
    extensions: [],
  };
  const signed = dhive.cryptoUtils.signTransaction(tx, [key]);
  const id = dhive.cryptoUtils.generateTrxId(signed);
  // Synchronous broadcast: the node answers only after the tx is accepted into a block
  // (or rejects). A tx-level rejection comes back as a JSON-RPC error → hivePost throws.
  try {
    await rpc('condenser_api.broadcast_transaction_synchronous', [signed]);
  } catch (e) {
    // hivePost retries the SAME signed tx across nodes. If node A accepted it but the
    // response was lost, node B answers 'duplicate transaction' — that IS success
    // (identical signed tx ⇒ identical tx id, already known to the chain).
    if (/duplicate transaction/i.test(String(e.message))) return { id };
    throw e;
  }
  return { id };
}

/**
 * Build the disburse operation (PURE — no key, no network). Native HIVE/HBD →
 * ['transfer', …]; HE tokens → ['custom_json', …]. Amount is formatted at the
 * currency's on-chain precision (Decision #3): `places` (reservation-locked) if
 * given, else settle.precision(currency). Throws code:'bad_request' on bad input.
 */
function buildDisburseOp({ to, amount, currency, memo = '', fromAccount, places }) {
  const dest = String(to || '').toLowerCase();
  const from = String(fromAccount || '').toLowerCase();
  const cur = String(currency || '').toUpperCase();
  const amt = Number(amount);

  if (!VALID_ACCOUNT.test(from)) {
    throw Object.assign(new Error(`invalid fromAccount: ${fromAccount}`), { code: 'bad_request' });
  }
  if (!VALID_ACCOUNT.test(dest)) {
    throw Object.assign(new Error(`invalid disburse destination: ${to}`), { code: 'bad_request' });
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    throw Object.assign(new Error(`invalid disburse amount: ${amount}`), { code: 'bad_request' });
  }

  const dp = Number.isInteger(places) ? places : precision(cur);
  const qty = amt.toFixed(dp);

  if (cur === 'HIVE' || cur === 'HBD') {
    return ['transfer', { from, to: dest, amount: `${qty} ${cur}`, memo: memo || '' }];
  }
  return ['custom_json', {
    required_auths: [from],
    required_posting_auths: [],
    id: 'ssc-mainnet-hive',
    json: JSON.stringify({
      contractName: 'tokens',
      contractAction: 'transfer',
      contractPayload: { symbol: cur, to: dest, quantity: qty, memo: memo || '' },
    }),
  }];
}

// A broadcast error is TRANSIENT (network / node hiccup — the tx may or may not have
// landed) vs PERMANENT (bad signature, insufficient balance, RC, malformed op — it
// definitively did NOT land). Only transients are retryable; the caller leaves the
// refund 'pending' and retries AFTER an idempotency probe (findOutgoingByMemo) so a
// landed-but-lost-response tx is never double-paid. Permanent errors bubble up as-is
// so the caller marks 'failed' and stops. Default-permanent for unknown shapes would
// strand real transient failures; we default-transient ONLY for recognised network
// signatures and treat anything with a clear on-chain rejection reason as permanent.
const PERMANENT_BROADCAST = /missing required|insufficient|does not have|not enough|rc[_ ]|resource credits|invalid signature|signature|tapos|expired|does not exist|unknown key|authority|duplicate|already|bad_request/i;
const TRANSIENT_BROADCAST = /premature close|timeout|timed ?out|etimedout|econnreset|econnrefused|enotfound|eai_again|socket|fetch failed|network|aborted|und_err|502|503|504|bad gateway|gateway timeout|service unavailable|invalid response body|too many requests|429/i;

function classifyBroadcastError(e) {
  const msg = String((e && e.message) || '');
  if (e && (e.code === 'no_key' || e.code === 'bad_request')) return 'permanent';
  if (PERMANENT_BROADCAST.test(msg)) return 'permanent';
  if (TRANSIENT_BROADCAST.test(msg)) return 'transient';
  return 'permanent';   // unknown → fail closed (don't retry-broadcast something we don't understand)
}

/**
 * Disburse `amount` of `currency` from `fromAccount`'s escrow to `to`, signed with
 * the active key in process.env[keyEnv]. Returns { txId, currency }.
 *
 * Key-optional: if process.env[keyEnv] is unset/empty this throws code:'no_key'
 * (the caller records the refund 'pending' for manual settlement). Input errors
 * throw code:'bad_request'. A TRANSIENT network/broadcast failure throws
 * code:'transient' (the caller leaves the refund pending and retries after an
 * idempotency probe). A PERMANENT failure throws as-is (caller marks 'failed').
 *
 * Broadcast path: nativeBroadcast (native fetch + offline dhive signing) by default —
 * dhive's own network layer (cross-fetch/node-fetch) is broken on some hosts (see
 * nativeBroadcast docblock). Injecting deps.client (tests / explicit override) routes
 * through client.broadcast.sendOperations instead, unchanged.
 *
 * @param deps.client  injectable dhive client (tests); default = nativeBroadcast
 * @param deps.rpc     injectable JSON-RPC poster for nativeBroadcast (tests)
 */
async function disburse({ to, amount, currency, memo, fromAccount, keyEnv, places }, deps = {}) {
  if (!keyEnv) {
    throw Object.assign(new Error('disburse: keyEnv (active-key env var name) is required'), { code: 'bad_request' });
  }
  const keyStr = (process.env[keyEnv] || '').trim();
  if (!keyStr) {
    throw Object.assign(
      new Error(`${keyEnv} not set — disburse recorded pending; operator must transfer manually`),
      { code: 'no_key' }
    );
  }

  const op = buildDisburseOp({ to, amount, currency, memo, fromAccount, places });   // validates inputs
  const key = dhive.PrivateKey.fromString(keyStr);
  try {
    const res = deps.client
      ? await deps.client.broadcast.sendOperations([op], key)
      : await nativeBroadcast([op], key, deps);
    return { txId: res.id, currency: String(currency).toUpperCase() };
  } catch (e) {
    if (classifyBroadcastError(e) === 'transient') {
      throw Object.assign(new Error(`disburse transient broadcast failure: ${e.message}`), { code: 'transient', cause: e });
    }
    throw e;
  }
}

module.exports = { disburse, buildDisburseOp, classifyBroadcastError, nativeBroadcast };
