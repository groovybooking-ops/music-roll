const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const DEFAULT_FRESHNESS_POLICY = Object.freeze({
    spotifyDiscoveryListingMs: 5 * DAY,
    ticketmasterEventListingMs: 12 * HOUR,
    successfulExactIdentityMs: 180 * DAY,
    semanticAbsenceMs: 30 * DAY,
    temporaryFailureCacheable: false
});

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function validateFreshnessPolicy(policy) {
    assert(policy && typeof policy === "object", "Listing freshness policy is required.");
    assert(Number.isInteger(policy.spotifyDiscoveryListingMs) && policy.spotifyDiscoveryListingMs >= 3 * DAY && policy.spotifyDiscoveryListingMs <= 7 * DAY, "Spotify listing freshness must be 3-7 days.");
    assert(Number.isInteger(policy.ticketmasterEventListingMs) && policy.ticketmasterEventListingMs >= 6 * HOUR && policy.ticketmasterEventListingMs <= 24 * HOUR, "Ticketmaster listing freshness must be 6-24 hours.");
    assert(Number.isInteger(policy.successfulExactIdentityMs) && policy.successfulExactIdentityMs >= 30 * DAY, "Successful exact identity freshness must be long-lived.");
    assert(Number.isInteger(policy.semanticAbsenceMs) && policy.semanticAbsenceMs > 0 && policy.semanticAbsenceMs < policy.successfulExactIdentityMs, "Semantic absence freshness must be shorter than successful identity freshness.");
    assert(policy.temporaryFailureCacheable === false, "Temporary failures cannot be permanent evidence.");
    return true;
}

function freshnessFor(kind, policy = DEFAULT_FRESHNESS_POLICY) {
    validateFreshnessPolicy(policy);
    const mapping = {
        spotify_discovery_listing: policy.spotifyDiscoveryListingMs,
        ticketmaster_event_listing: policy.ticketmasterEventListingMs,
        successful_exact_identity: policy.successfulExactIdentityMs,
        semantic_absence: policy.semanticAbsenceMs
    };
    if (kind === "temporary_failure") return { cacheable: false, ttlMs: 0 };
    if (!(kind in mapping)) throw new Error(`Unknown freshness evidence kind: ${kind}.`);
    return { cacheable: true, ttlMs: mapping[kind] };
}

function evaluateFreshness({ kind, retrievedAt, now, policy = DEFAULT_FRESHNESS_POLICY }) {
    const rule = freshnessFor(kind, policy);
    if (!rule.cacheable) return { ...rule, fresh: false, stale: true, ageMs: null };
    const retrieved = Date.parse(retrievedAt);
    const current = Date.parse(now || new Date().toISOString());
    if (!Number.isFinite(retrieved) || !Number.isFinite(current) || current < retrieved) throw new Error("Freshness timestamps are invalid.");
    const ageMs = current - retrieved;
    return { ...rule, ageMs, fresh: ageMs <= rule.ttlMs, stale: ageMs > rule.ttlMs };
}

module.exports = { DAY, DEFAULT_FRESHNESS_POLICY, HOUR, evaluateFreshness, freshnessFor, validateFreshnessPolicy };
