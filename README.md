# escrow-core

Shared **custodial-escrow library** (the engine): on-chain payment verify + replay protection, custodial signer,
metered → pro-rata refund, durable idempotent settlement/refund ledger, and signed-condition release. This is
**code, not a running service** — the escrow deployments that depend on it pin a version (`escrow-core@^0.1`) and
**do not fork**. Per-service differences (metering unit, release condition, precision, ledger columns) live in
small **adapters**, never in `if (service === …)`  branches.

- **Version:** 0.1.0  ·  **escrow report format:** escrow-protocol 0.1  ·  **succeeds ipfs-gate v0.1.3 escrow**
- Distils the proven escrow logic from **ipfs-gate v0.1.3** (`pricing.js` / `hive-verify.js` / `quota.js` /
  `release-policy.js` / `envelope.js`) into one audited core, tested against **ipfs-gate's behaviour as the spec**.
- **Scope (owner Decision #5):** built **for v4call only** for now — one adapter (`v4call`), one deployment
  (`v4call-escrow`). ipfs-gate stays the golden reference, not a live consumer. See `../handover-escrow-core.md` §9.

## Two money invariants (never weaken)

1. **Replay protection** — `payments.tx_id UNIQUE`; `ledger.recordPayment` throws `code:'conflict'` on a re-used tx.
2. **Settlement cap** — `settle()` guarantees `settlement = min(meteredUsage, deposit)`, so a wrong/over-stated
   event report can only **re-split the verified envelope, never mint money**. The single-winner `atomicClose(ref)`
   flip ensures a crash/double-click can't double-disburse.

## API surface (`require('escrow-core')`)

```
// VERIFY + REPLAY (native HIVE/HBD + Hive-Engine token; tx_id-anchored, exact-memo)
verifyPayment({ txId, sender, account, currency, expectedMemo, expectedAmount }) → { paid, blockNum, confirmed, … }
verifySidechain(txId)                                  // Hive-Engine hard-confirm (HE tokens)
findOutgoingByMemo(account, memo, currency)            // idempotency probe for disburse retries:
                                                       //   found (already sent) | not_found | error (UNKNOWN — don't re-broadcast)

// SIGN (custodial disburse; native + HE token, per-currency precision)
disburse({ to, amount, currency, memo, fromAccount, keyEnv }) → { txId, currency }
//   throws code:'no_key' (record pending) · code:'transient' (network — leave pending, retry via the probe)
//   · permanent errors as-is (mark failed). Broadcasts via nativeBroadcast: OFFLINE dhive signing +
//   native-fetch JSON-RPC with multi-node failover (dhive's bundled node-fetch is broken on some hosts;
//   a cross-node 'duplicate transaction' answer is success — same signed tx ⇒ same tx id).
classifyBroadcastError(err) → 'transient' | 'permanent'

// SETTLE (the cap + per-currency precision — Decision #3)
settle({ deposit, meteredUsage, dustFloor, currency, places }) → { settlement, refund, dust }
roundCoins(amount, currency) · precision(currency) · registerPrecision(currency, places)

// LEDGER (durable, idempotent) — openLedger(dbPath) → handle
openLedger(dbPath, { adapterMigrations }) → {
  recordPayment, getPaymentByTxId, getPaymentById, getPaymentsByRef, markPaymentRefunded,
  atomicClose,                                          // single-winner settle flip
  recordRefund, markRefundSettled, getRefund,
  recordConsent, getConsents, recordReceipt, getReceipts, close,
}

// RELEASE (signed-condition + Hive-sig primitive)
evaluateRelease({ policy, owner, releaser, consented, elapsed }) → { authorized, ends, records_consent }
verifyHiveSig(messageBytes, sig, pubKey) · normalizeReleasePolicy(policy)
// policy types: owner_only · any_of · all_of · duration_elapsed (v4call)

// ESCROW-PROTOCOL 0.1 (node↔escrow, Nostr schnorr — distinct from the Hive release-sig layer)
buildEventReport(...) · buildSettlementReceipt(...)    // canonical payloads; receipts carry an optional
                                                       // `reason` (failure detail on status:'failed')
signReport(payload, skHex) · verifyReport(signed, expectedPubkey?) · getReportingPubkey(skHex)
buildMemo({ namespace, purpose, reservationId }) · parseMemo(memo) · createSeenIds(max)

// ADAPTERS (the small per-service seam)
validateAdapter(adapter) · createV4callAdapter({ account, currency, keyEnv }?)
```

### EscrowAdapter contract

```
EscrowAdapter = {
  account, currency, keyEnv, memoNamespace,   // config (keyEnv = the env var NAME; the secret stays in env)
  precision(currency) → places,               // per-currency, locked at reservation (Decision #3)
  meteredUsage(record, now) → coins,          // metering-unit seam (v4call: call-seconds → hours)
  releasePolicy(record) → policyObject,       // release-condition seam (v4call: { type:'duration_elapsed' })
  ledgerSchema() → migrationSQL,              // per-service columns appended to the core tables
}
```

## Module layout

```
index.js            — public API surface (re-exports the below)
verify.js           — verifyPayment / verifySidechain / op extract+validate (native + HE)   (from hive-verify.js)
sign.js             — disburse / buildDisburseOp                                             (from hive-verify.js)
settle.js           — settle (cap) / roundCoins / per-currency precision registry            (from pricing.js)
ledger.js           — openLedger; replay-guarded payments, atomicClose, refund/consent rows  (distils quota.js)
release.js          — evaluateRelease / normalizeReleasePolicy / verifyHiveSig / sha256      (release-policy + envelope)
escrow-protocol.js  — escrow-protocol/0.1: report/receipt canonical payloads + Nostr sigs + memo grammar  (NEW)
adapter.js          — the EscrowAdapter contract + validateAdapter()
adapters/v4call.js  — the v4call adapter (the only adapter now)
migrations/001_escrow_core.sql — the core ledger subset (payments, refunds, release_consents, receipts)
test/*.test.js      — node --test, ipfs-gate behaviour as the spec
```

## Develop

```
npm install        # better-sqlite3 (native) + @noble/curves (schnorr) + @hiveio/dhive
npm test           # node --test test/ — 80 passing (Node 20; on Node 24 use node --test test/*.test.js)
node scripts/dry-run-adversarial.js   # replay + crash-no-double-disburse harness — 13/13
```

- **Source of truth:** `../handover-decoupling.md`; focused brief `../handover-escrow-core.md` +
  `../handover-escrow-core-api-refactor.md`.
- **Both gated phases are DONE and live** (2026-07): the v4call escrow-migration (v4call-node runs on this core;
  durable rows are the settlement authority) and the isolated `v4call-escrow` box — production node
  `node.v4call.com` runs **keyless** (`ESCROW_MODE=box`) and real TEST-token sessions (paid DMs + v0.17 paid
  expert invites) settle through the box: verify → cap → split → disburse, envelope conserved.
```
