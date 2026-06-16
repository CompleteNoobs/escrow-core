// escrow-core/adapter.js — the EscrowAdapter contract + validateAdapter().
//
// Everything money-critical (verify recipe, replay guard, signer, the settlement
// cap, durable refund lifecycle, sig families) lives in the CORE. The per-service
// differences live HERE, in a small adapter — config + ~2 functions — NOT in
// `if (service === …)` branches (handover guardrail §8).
//
//   EscrowAdapter = {
//     account,                       // escrow Hive account the payment must go to
//     currency,                      // default/primary token symbol (per-call currency
//                                    //   may still be passed through at verify/settle time)
//     keyEnv,                        // NAME of the env var holding the active key
//                                    //   (the secret itself NEVER leaves env)
//     memoNamespace,                 // <namespace> in <namespace>:<purpose>:<reservation_id>
//
//     precision(currency) → places,  // Decision #3 — per-currency, reservation-locked
//     meteredUsage(record, now) → coins,   // THE metering-unit seam (in deposit's unit)
//     releasePolicy(record) → policyObject,// THE release-condition seam (for evaluateRelease)
//     ledgerSchema() → migrationSQL, // per-service columns appended to the core tables
//   }
//
// meteredUsage returns usage in the SAME coin unit as the deposit — it has already
// applied the locked rate — so the core settle() stays unit-agnostic.

'use strict';

const REQUIRED_CONFIG = ['account', 'currency', 'keyEnv', 'memoNamespace'];
const REQUIRED_METHODS = ['precision', 'meteredUsage', 'releasePolicy', 'ledgerSchema'];
const MEMO_NAMESPACE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate that `adapter` satisfies the EscrowAdapter contract. Throws
 * code:'bad_request' (with an `issues` array) on any violation; returns the adapter
 * on success so callers can `const a = validateAdapter(makeAdapter())`.
 */
function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') {
    throw Object.assign(new Error('adapter must be an object'), { code: 'bad_request' });
  }
  const issues = [];
  for (const k of REQUIRED_CONFIG) {
    if (typeof adapter[k] !== 'string' || !adapter[k]) issues.push(`config '${k}' must be a non-empty string`);
  }
  for (const m of REQUIRED_METHODS) {
    if (typeof adapter[m] !== 'function') issues.push(`method '${m}' must be a function`);
  }
  if (typeof adapter.memoNamespace === 'string' && !MEMO_NAMESPACE.test(adapter.memoNamespace)) {
    issues.push(`memoNamespace '${adapter.memoNamespace}' must match ${MEMO_NAMESPACE}`);
  }
  if (issues.length) {
    throw Object.assign(new Error(`invalid EscrowAdapter: ${issues.join('; ')}`), { code: 'bad_request', issues });
  }
  return adapter;
}

module.exports = { validateAdapter, REQUIRED_CONFIG, REQUIRED_METHODS };
