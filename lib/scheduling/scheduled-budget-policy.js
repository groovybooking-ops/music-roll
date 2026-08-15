const DEFAULT_SCHEDULED_BUDGETS = Object.freeze({
    providers: {
        spotify: { maxRequests: 6, maxPages: 2, maxNormalizedOccurrences: 15, maxNewCandidates: 8 },
        ticketmaster: { maxRequests: 6, maxPages: 2, maxNormalizedOccurrences: 15, maxNewCandidates: 7 }
    },
    workers: { stage3Candidates: 5, identityDiscoveryCandidates: 3 },
    queueHighWaterMarks: { identity_pending: 50, identity_discovery_pending: 25, retry_wait: 25, needs_review: 100 }
});

const PROVIDER_COUNTERS = Object.freeze(["requests", "pages", "normalizedOccurrences", "newCandidates"]);
const LIMIT_FIELDS = Object.freeze({
    requests: "maxRequests",
    pages: "maxPages",
    normalizedOccurrences: "maxNormalizedOccurrences",
    newCandidates: "maxNewCandidates"
});

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function validateBudgets(budgets) {
    assert(budgets && typeof budgets === "object" && !Array.isArray(budgets), "Scheduled-run budgets are required.");
    for (const provider of ["spotify", "ticketmaster"]) {
        const limits = budgets.providers?.[provider];
        assert(limits && typeof limits === "object", `Scheduled-run ${provider} budgets are required.`);
        for (const field of Object.values(LIMIT_FIELDS)) {
            assert(Number.isInteger(limits[field]) && limits[field] >= 0, `${provider} budget ${field} must be a non-negative integer.`);
        }
    }
    for (const field of ["stage3Candidates", "identityDiscoveryCandidates"]) {
        assert(Number.isInteger(budgets.workers?.[field]) && budgets.workers[field] >= 0, `Worker budget ${field} must be a non-negative integer.`);
    }
    for (const state of ["identity_pending", "identity_discovery_pending", "retry_wait", "needs_review"]) {
        assert(Number.isInteger(budgets.queueHighWaterMarks?.[state]) && budgets.queueHighWaterMarks[state] >= 0, `Queue high-water mark ${state} must be a non-negative integer.`);
    }
    return true;
}

function emptyBudgetConsumption() {
    return {
        providers: {
            spotify: { requests: 0, pages: 0, normalizedOccurrences: 0, newCandidates: 0 },
            ticketmaster: { requests: 0, pages: 0, normalizedOccurrences: 0, newCandidates: 0 }
        },
        workers: { stage3Candidates: 0, identityDiscoveryCandidates: 0 }
    };
}

function validateBudgetConsumption(consumption) {
    assert(consumption && typeof consumption === "object" && !Array.isArray(consumption), "Scheduled-run budget consumption is required.");
    for (const provider of ["spotify", "ticketmaster"]) {
        for (const counter of PROVIDER_COUNTERS) {
            assert(Number.isInteger(consumption.providers?.[provider]?.[counter]) && consumption.providers[provider][counter] >= 0, `Budget consumption ${provider}.${counter} is invalid.`);
        }
    }
    for (const field of ["stage3Candidates", "identityDiscoveryCandidates"]) {
        assert(Number.isInteger(consumption.workers?.[field]) && consumption.workers[field] >= 0, `Worker consumption ${field} is invalid.`);
    }
    return true;
}

function providerStopReason(provider, consumption, budgets, queueCounts = {}, nextItem = {}) {
    validateBudgets(budgets);
    validateBudgetConsumption(consumption);
    const used = consumption.providers[provider];
    const limits = budgets.providers[provider];
    if (nextItem.requiresRequest && used.requests >= limits.maxRequests) return "request_budget_reached";
    if (nextItem.startsPage && used.pages >= limits.maxPages) return "page_budget_reached";
    if (nextItem.normalizesOccurrence && used.normalizedOccurrences >= limits.maxNormalizedOccurrences) return "occurrence_budget_reached";
    if (nextItem.createsCandidate && used.newCandidates >= limits.maxNewCandidates) return "new_candidate_budget_reached";
    if (nextItem.createsCandidate && nextItem.targetState) {
        const highWater = budgets.queueHighWaterMarks[nextItem.targetState];
        if (highWater != null && (queueCounts[nextItem.targetState] || 0) >= highWater) return `queue_high_water_reached:${nextItem.targetState}`;
    }
    return null;
}

function consumeProvider(consumption, provider, delta) {
    validateBudgetConsumption(consumption);
    const next = structuredClone(consumption);
    for (const counter of PROVIDER_COUNTERS) {
        const value = delta[counter] || 0;
        assert(Number.isInteger(value) && value >= 0, `Budget delta ${provider}.${counter} is invalid.`);
        next.providers[provider][counter] += value;
    }
    validateBudgetConsumption(next);
    return next;
}

module.exports = {
    DEFAULT_SCHEDULED_BUDGETS,
    LIMIT_FIELDS,
    PROVIDER_COUNTERS,
    consumeProvider,
    emptyBudgetConsumption,
    providerStopReason,
    validateBudgetConsumption,
    validateBudgets
};
