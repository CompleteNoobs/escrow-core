// adapter-ipfs-gate.test.js — the ipfs-gate adapter vs the monolith as spec.
//
// pricing.js (kept in sync with IPFS-Gate/pricing.js) is the golden reference:
// every refund the monolith's broadcastRefund would send must be reproduced by
//   settle({ deposit: verifiedEnvelope,
//            meteredUsage: adapter.meteredUsage(record, now),
//            dustFloor: adapter.minRefund })
// to the coin — including dust suppression. Amounts are ALSO pinned as literals
// so an accidental pricing.js edit can't silently shift oracle and subject
// together (golden values ported from IPFS-Gate test/claim-lifecycle,
// guardian-lifecycle, moderation-escrow behaviour).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { settle } = require('../settle');
const pricing = require('../pricing');
const { validateAdapter } = require('../adapter');
const { createIpfsGateAdapter, SCHEMA_VERSION, TRIGGERS } = require('../adapters/ipfs-gate');

const HOUR_MS = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;             // fixed settlement clock (all tests)

// The canonical active claim: 5 MB, rate 1 coin/MB-hour, 1 copy, 48h paid → 240 escrowed.
function activeClaim(overrides = {}) {
  return {
    claim_id: 'c1', owner: 'alice', kind: 'original', state: 'active',
    size_bytes: 5_000_000, rate_locked: 1, copies_requested: 1, paid_hours: 48,
    start_ts: NOW - 10 * HOUR_MS, expiry_ts: NOW + 38 * HOUR_MS,
    amount_paid: 240, currency: 'CNOOBS',
    ...overrides,
  };
}

// The record the box hands meteredUsage: claim facts + verified envelope + trigger.
function rec(claim, trigger, deposit = claim.amount_paid, extra = {}) {
  return { ...claim, claim_state: claim.state, trigger, deposit, ...extra };
}

function settleFor(adapter, claim, trigger, deposit = claim.amount_paid, extra = {}) {
  const usage = adapter.meteredUsage(rec(claim, trigger, deposit, extra), NOW);
  return settle({ deposit, meteredUsage: usage, dustFloor: adapter.minRefund, currency: claim.currency });
}

test('adapter satisfies the EscrowAdapter contract with ipfs-gate config', () => {
  const a = validateAdapter(createIpfsGateAdapter());
  assert.equal(a.keyEnv, 'IPFS_GATE_ACTIVE_KEY');
  assert.equal(a.memoNamespace, 'ipfs-gate');
  assert.equal(a.currency, 'CNOOBS');
  assert.equal(a.schemaVersion, SCHEMA_VERSION);
  assert.ok(SCHEMA_VERSION >= 100, 'adapter-migration convention: version >= 100');
  assert.equal(a.cancelFeePct, pricing.GUARDIAN_CANCEL_FEE_PCT);
  assert.equal(a.minRefund, pricing.MIN_REFUND);
  assert.deepEqual(a.ledgerMigrations(), [{ version: SCHEMA_VERSION, sql: a.ledgerSchema() }]);
});

test('active pro-rata cancel reproduces the monolith refund (golden: 190 of 240)', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim();                       // 10h used of 48h paid
  const oracle = pricing.calculateRefund(claim, NOW); // the monolith's number
  const s = settleFor(a, claim, 'cancel');
  assert.equal(oracle.amount, 190);                  // golden literal
  assert.equal(s.refund, oracle.amount);
  assert.equal(s.settlement, 50);                    // 10h × 5MB × 1 × 1 consumed
});

test('release and delete triggers meter identically to cancel', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim();
  for (const t of ['release', 'delete']) {
    assert.equal(settleFor(a, claim, t).refund, 190, t);
  }
});

test('fully-consumed claim refunds nothing (hours used ≥ hours paid)', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim({ start_ts: NOW - 60 * HOUR_MS }); // 60h used of 48h paid
  const oracle = pricing.calculateRefund(claim, NOW);
  assert.equal(oracle.amount, 0);
  const s = settleFor(a, claim, 'cancel');
  assert.equal(s.refund, 0);
  assert.equal(s.settlement, 240);                   // capped at the envelope
});

test('sub-MIN_REFUND remainders are retained as dust, like the monolith', () => {
  const a = createIpfsGateAdapter();
  // 1 MB at rate 0.001 → raw refund (48−10)h × 1 × 0.001 = 0.038 < MIN_REFUND 0.05
  const claim = activeClaim({ size_bytes: 500_000, rate_locked: 0.001, amount_paid: 0.048 });
  const oracle = pricing.calculateRefund(claim, NOW);
  assert.equal(oracle.dust, true);
  assert.equal(oracle.amount, 0);
  const s = settleFor(a, claim, 'cancel');
  assert.equal(s.refund, 0);
  assert.ok(s.dust > 0, 'remainder reported as dust, not paid');
});

test('dormant guardian cancel: default fee 0 → FULL pledge back (golden: 100)', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim({ state: 'dormant', kind: 'guardian', amount_paid: 100 });
  const oracle = pricing.calculateDormantRefund(claim);
  assert.equal(oracle.amount, 100);
  const s = settleFor(a, claim, 'dormant_cancel', 100);
  assert.equal(s.refund, 100);
  assert.equal(s.settlement, 0);
});

test('dormant guardian cancel with operator anti-churn fee (5% → 95 back)', () => {
  const a = createIpfsGateAdapter({ cancelFeePct: 5 });
  const claim = activeClaim({ state: 'dormant', kind: 'guardian', amount_paid: 100 });
  const oracle = pricing.calculateDormantRefund(claim, 5);
  assert.equal(oracle.amount, 95);
  assert.equal(oracle.fee, 5);
  const s = settleFor(a, claim, 'dormant_cancel', 100);
  assert.equal(s.refund, 95);
  assert.equal(s.settlement, 5);                     // the fee stays in escrow
});

test('admin forfeit (refund_policy none): escrow keeps the whole envelope', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim();
  assert.equal(pricing.forcedRefundAmount(claim, { policy: 'none' }), 0);
  const s = settleFor(a, claim, 'admin_void_forfeit');
  assert.equal(s.refund, 0);
  assert.equal(s.settlement, 240);
});

test('innocent guardian on CID ban: full escrow back, no fee', () => {
  const a = createIpfsGateAdapter({ cancelFeePct: 5 });   // fee must NOT apply
  const claim = activeClaim({ state: 'dormant', kind: 'guardian', amount_paid: 100 });
  assert.equal(pricing.forcedRefundAmount(claim, { innocent: true }), 100);
  const s = settleFor(a, claim, 'admin_void_innocent_guardian', 100);
  assert.equal(s.refund, 100);
});

test('admin prorata void: dormant never metered → full back; active → pro-rata', () => {
  const a = createIpfsGateAdapter();
  const dormant = activeClaim({ state: 'dormant', amount_paid: 100 });
  assert.equal(pricing.forcedRefundAmount(dormant, { policy: 'prorata' }), 100);
  assert.equal(settleFor(a, dormant, 'admin_void_prorata', 100).refund, 100);

  const active = activeClaim();
  assert.equal(pricing.forcedRefundAmount(active, { policy: 'prorata' }, NOW), 190);
  assert.equal(settleFor(a, active, 'admin_void_prorata').refund, 190);
});

test('permanent claim (HOSTING_MODE=permanent sentinel): nothing refundable on cancel', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim({ expiry_ts: pricing.PERMANENT_EXPIRY_TS, amount_paid: 25 });
  const oracle = pricing.calculateRefund(claim, NOW);
  assert.equal(oracle.permanent, true);
  assert.equal(oracle.amount, 0);
  const s = settleFor(a, claim, 'cancel', 25);
  assert.equal(s.refund, 0);
  assert.equal(s.settlement, 25);
});

test('extend envelope: refund can exceed the ORIGINAL payment (golden: 310 > 240)', () => {
  // extendClaim bumps paid_hours but NOT amount_paid (quota.js:652) — the cap must
  // be the SUM of verified payments (240 upload + 120 extend), not amount_paid.
  const a = createIpfsGateAdapter();
  const claim = activeClaim({ paid_hours: 72 });     // 48h + 24h top-up
  const envelope = 240 + 120;
  const oracle = pricing.calculateRefund(claim, NOW); // (72−10)h × 5MB × 1 = 310
  assert.equal(oracle.amount, 310);
  const s = settleFor(a, claim, 'cancel', envelope);
  assert.equal(s.refund, 310);
  assert.equal(s.settlement, 50);
});

test('conservation: for EVERY trigger and lying facts, refund+settlement ≤ deposit, refund ≥ 0', () => {
  const a = createIpfsGateAdapter();
  const shapes = [
    activeClaim(),
    activeClaim({ state: 'dormant', amount_paid: 100 }),
    activeClaim({ rate_locked: 0, start_ts: 0 }),          // malformed facts
    activeClaim({ paid_hours: 72 }),
    activeClaim({ expiry_ts: pricing.PERMANENT_EXPIRY_TS }),
    activeClaim({ rate_locked: 9999, size_bytes: 1e12 }),  // absurd over-metering
  ];
  for (const claim of shapes) {
    for (const trigger of TRIGGERS) {
      for (const deposit of [0, 0.05, 100, 240, 360]) {
        const s = settleFor(a, claim, trigger, deposit);
        assert.ok(s.refund >= 0, `${trigger} refund >= 0`);
        assert.ok(s.settlement >= 0, `${trigger} settlement >= 0`);
        assert.ok(s.refund + s.settlement <= deposit + 1e-9,
          `${trigger} dep=${deposit}: ${s.refund}+${s.settlement} within envelope`);
      }
    }
  }
});

test('malformed active facts fail toward escrow (usage=deposit → refund 0), never mint', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim({ rate_locked: 0, start_ts: 0 });
  const s = settleFor(a, claim, 'cancel');
  assert.equal(s.refund, 0);
  assert.equal(s.settlement, 240);
});

test('settlementSplit: at most ONE outflow — the owner refund, probe-keyed memo', () => {
  const a = createIpfsGateAdapter();
  const split = a.settlementSplit(
    { owner: 'alice', currency: 'CNOOBS', trigger: 'cancel' },
    { settlement: 50, refund: 190, dust: 0 },
    { ref: 'c1' }
  );
  assert.equal(split.outflows.length, 1);
  const o = split.outflows[0];
  assert.equal(o.kind, 'refund');
  assert.equal(o.to_account, 'alice');
  assert.equal(o.amount, 190);
  assert.equal(o.memo, 'ipfs-gate:refund:c1');       // the disburse-retry probe key
  assert.ok(!split.outflows.some(x => x.kind === 'payout' || x.kind === 'platform_fee'),
    'ipfs-gate never pays a callee or fee account');
});

test('settlementSplit: zero refund → zero outflows (consumed value stays in escrow)', () => {
  const a = createIpfsGateAdapter();
  const split = a.settlementSplit(
    { owner: 'alice', trigger: 'admin_void_forfeit' },
    { settlement: 240, refund: 0, dust: 0 },
    { ref: 'c1' }
  );
  assert.deepEqual(split.outflows, []);
});

test('buildClaimSettleReportFacts: full envelope, synthetic whitelist rows filtered', () => {
  const a = createIpfsGateAdapter();
  const claim = activeClaim({ paid_hours: 72 });
  const facts = a.buildClaimSettleReportFacts({
    claim,
    payRows: [
      { tx_id: 'tx-upload', sender: 'alice', amount: 240, memo: 'ipfs-gate:upload:r1', currency: 'CNOOBS' },
      { tx_id: 'tx-extend', sender: 'alice', amount: 120, memo: 'ipfs-gate:extend:c1', currency: 'CNOOBS' },
      { tx_id: 'whitelist-free:upload:r2', sender: 'alice', amount: 0, memo: 'ipfs-gate:upload:r2' },
    ],
    trigger: 'cancel',
    now: NOW,
  });
  assert.equal(facts.kind, 'claim-settle');
  assert.equal(facts.trigger, 'cancel');
  assert.equal(facts.payments.length, 2, 'synthetic row filtered out');
  assert.deepEqual(facts.payments.map(p => p.purpose), ['upload', 'extend']);
  assert.equal(facts.claimFacts.claim_id, 'c1');
  assert.equal(facts.claimFacts.paid_hours, 72);
  assert.equal(facts.claimFacts.claim_state, 'active');
});

test('report trigger vocabulary is exactly broadcastRefund\'s reason strings', () => {
  assert.deepEqual([...TRIGGERS], [
    'cancel', 'release', 'delete', 'dormant_cancel',
    'admin_void_innocent_guardian', 'admin_void_forfeit', 'admin_void_prorata',
  ]);
});

test('singlePaymentSplit with platformFee 0 is a pure refund', () => {
  const a = createIpfsGateAdapter();
  const split = a.singlePaymentSplit(12.5, { payoutTo: 'alice', platformFee: 0, currency: 'CNOOBS' }, { ref: 'orphan-1' });
  assert.equal(split.outflows.length, 1);
  assert.equal(split.outflows[0].to_account, 'alice');
  assert.equal(split.outflows[0].amount, 12.5);
  assert.equal(split.net, 12.5);
  assert.equal(split.fee, 0);
});

test('releasePolicy: defaults to owner_only, parses stored JSON', () => {
  const a = createIpfsGateAdapter();
  assert.deepEqual(a.releasePolicy({}), { type: 'owner_only' });
  assert.deepEqual(a.releasePolicy({ release_policy: '{"type":"any_of","accounts":["a","b"]}' }),
    { type: 'any_of', accounts: ['a', 'b'] });
  assert.deepEqual(a.releasePolicy({ release_policy: 'not-json' }), { type: 'owner_only' });
});
