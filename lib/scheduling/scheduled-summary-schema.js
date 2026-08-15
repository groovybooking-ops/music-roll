const crypto = require("crypto");
const { canonicalize } = require("./scheduled-run-schema");

const DAILY_TYPE = "daily_operational";
const WEEKLY_TYPE = "weekly_human_review";
const REVIEW_GROUPS = Object.freeze([
    "same_name_ambiguity",
    "provider_profile_multiplicity",
    "missing_exact_bridge",
    "unresolved_identifiers",
    "semantic_identity_conflict",
    "retry_budget_exhausted",
    "editorial_input_missing"
]);

function assert(condition, message) { if (!condition) throw new Error(message); }
function validTimestamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function summaryDigest(value) {
    const copy = structuredClone(value);
    delete copy.artifactDigest;
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(copy))).digest("hex")}`;
}
function validateRate(value, label) { assert(value == null || (typeof value === "number" && value >= 0 && value <= 1), `${label} rate is invalid.`); }
function validateCounts(value, label) { assert(value && typeof value === "object" && Object.values(value).every(item => Number.isInteger(item) && item >= 0), `${label} counts are invalid.`); }

function validateDailySummary(summary) {
    assert(summary?.schemaVersion === 1 && summary.summaryType === DAILY_TYPE, "Daily summary schema is invalid.");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(summary.date || ""), "Daily summary date is invalid.");
    assert(validTimestamp(summary.period.start) && validTimestamp(summary.period.end), "Daily summary period is invalid.");
    assert(Array.isArray(summary.runIds), "Daily summary run IDs are invalid.");
    assert(summary.providers && summary.checkpoints && summary.budgets, "Daily summary operational sections are required.");
    validateCounts(summary.queue.before, "Daily queue before"); validateCounts(summary.queue.after, "Daily queue after");
    assert(Number.isInteger(summary.queue.netGrowth), "Daily queue growth is invalid.");
    for (const key of ["discoveryYield", "rediscoveryRate", "duplicatePreventionRate", "identityCoherentRoutingRate", "reviewRoutingRate", "failedMatchRate", "ticketmasterExactBridgeRate", "retryRecoveryRate", "retryExhaustionRate"]) validateRate(summary.metrics[key], key);
    assert(summary.metrics.medianDiscoveryToIdentityTerminalHours == null || summary.metrics.medianDiscoveryToIdentityTerminalHours >= 0, "Daily median resolution time is invalid.");
    assert(summary.artifactDigest === summaryDigest(summary), "Daily summary digest drifted.");
    assert(summary.reviewOnly === true && summary.mutatesCandidateState === false, "Daily summary safety flags are invalid.");
    return true;
}

function validateWeeklySummary(summary) {
    assert(summary?.schemaVersion === 1 && summary.summaryType === WEEKLY_TYPE, "Weekly summary schema is invalid.");
    assert(validTimestamp(summary.period.start) && validTimestamp(summary.period.end), "Weekly summary period is invalid.");
    assert(summary.groups && REVIEW_GROUPS.every(group => Array.isArray(summary.groups[group])), "Weekly review groups are incomplete.");
    assert(Number.isInteger(summary.actionableCandidateCount) && summary.actionableCandidateCount >= 0, "Weekly actionable count is invalid.");
    assert(Number.isInteger(summary.metrics.weeklyNetQueueGrowth), "Weekly queue growth is invalid.");
    assert(summary.artifactDigest === summaryDigest(summary), "Weekly summary digest drifted.");
    assert(summary.reviewOnly === true && summary.mutatesCandidateState === false && summary.recommendationsAreAdvisory === true, "Weekly summary safety flags are invalid.");
    return true;
}

module.exports = { DAILY_TYPE, REVIEW_GROUPS, WEEKLY_TYPE, summaryDigest, validateDailySummary, validateWeeklySummary };
