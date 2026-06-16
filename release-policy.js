// ipfs-gate v1 — Stage 3 release-authority policy evaluation (pure, no I/O).
//
// A release_policy decides WHO can tell the gate "I've received the file, you can
// stop hosting it" (cohosting handover §12). Release ENDS the owner's active
// claim (then the §5 lifecycle runs — a queued backstop still takes the baton;
// release ≠ deletion). The OWNER can always release (override) regardless of type.
//
//   { type: "owner_only" }                              only the owner
//   { type: "any_of",  addresses: [a, b, c] }           the owner OR any listed recipient
//   { type: "all_of",  addresses: [a, b, c] }           the owner, OR ALL listed recipients (consensus)

const RELEASE_TYPES = ['owner_only', 'any_of', 'all_of'];

/** Validate + normalise a release_policy object. Throws code:'bad_request' on bad input. */
function normalizeReleasePolicy(policy) {
  const p = policy || { type: 'owner_only' };
  const type = p.type || 'owner_only';
  if (!RELEASE_TYPES.includes(type)) {
    throw Object.assign(new Error(`release_policy.type must be one of ${RELEASE_TYPES.join('|')}`), { code: 'bad_request' });
  }
  let addresses = Array.isArray(p.addresses) ? p.addresses : [];
  addresses = [...new Set(addresses.map(a => String(a).toLowerCase().replace(/^@/, '')))].filter(Boolean);
  if ((type === 'any_of' || type === 'all_of') && addresses.length === 0) {
    throw Object.assign(new Error(`release_policy.type '${type}' requires a non-empty addresses list`), { code: 'bad_request' });
  }
  return { type, addresses };
}

/**
 * Decide a release attempt. Pure — the caller supplies the set of releasers who
 * have ALREADY consented (for all_of); this function folds in the current
 * releaser. Returns:
 *   { authorized: bool,  // may this account act on this policy at all?
 *     ends: bool,        // is the threshold now met → end the owner's claim?
 *     records_consent: bool } // should the caller persist this releaser's consent? (all_of only)
 */
function evaluateRelease({ policy, owner, releaser, consented = [] }) {
  const { type, addresses } = normalizeReleasePolicy(policy);
  const who = String(releaser || '').toLowerCase().replace(/^@/, '');
  const ownerLc = String(owner || '').toLowerCase();

  if (who && who === ownerLc) {
    return { authorized: true, ends: true, records_consent: false };  // owner override
  }
  if (type === 'owner_only') {
    return { authorized: false, ends: false, records_consent: false };
  }
  if (!addresses.includes(who)) {
    return { authorized: false, ends: false, records_consent: false }; // not a listed recipient
  }
  if (type === 'any_of') {
    return { authorized: true, ends: true, records_consent: false };
  }
  // all_of — need every listed address to have consented (incl. this one)
  const have = new Set(consented.map(a => String(a).toLowerCase()));
  have.add(who);
  const ends = addresses.every(a => have.has(a));
  return { authorized: true, ends, records_consent: true };
}

module.exports = { RELEASE_TYPES, normalizeReleasePolicy, evaluateRelease };
