const RETRY_DELAYS_MS = Object.freeze([15 * 60 * 1000, 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]);
const MAX_ELAPSED_MS = 72 * 60 * 60 * 1000;

function assert(condition, message) { if (!condition) throw new Error(message); }
function validTime(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }

function parseRetryAfter(value, now) {
    if (value == null || value === "") return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return Number.isNaN(date) ? 0 : Math.max(0, date - Date.parse(now));
}

function retryRecordKey(candidateId, provider, operation) { return `${candidateId}:${provider}:${operation}`; }

function validateRetryRecord(record) {
    assert(record?.schemaVersion === 1, "Retry record schemaVersion must be 1.");
    assert(typeof record.candidateId === "string" && record.candidateId.trim(), "Retry candidate ID is required.");
    assert(typeof record.provider === "string" && record.provider.trim(), "Retry provider is required.");
    assert(typeof record.operation === "string" && record.operation.trim(), "Retry operation is required.");
    assert(Number.isInteger(record.attemptCount) && record.attemptCount >= 1, "Retry attempt count is invalid.");
    assert(validTime(record.firstFailureAt) && validTime(record.lastFailureAt), "Retry failure timestamps are invalid.");
    assert(record.nextRetryAt == null || validTime(record.nextRetryAt), "Retry next timestamp is invalid.");
    assert(typeof record.failureCategory === "string" && record.failureCategory.trim(), "Retry failure category is required.");
    assert(Array.isArray(record.evidenceRefs), "Retry evidence refs are invalid.");
    assert(typeof record.exhausted === "boolean", "Retry exhausted flag is invalid.");
    return true;
}

function recordRetryFailure(previous, input) {
    const now = input.occurredAt;
    assert(validTime(now), "Retry failure timestamp is invalid.");
    const firstFailureAt = previous?.firstFailureAt || now;
    const attemptCount = (previous?.attemptCount || 0) + 1;
    const elapsed = Date.parse(now) - Date.parse(firstFailureAt);
    const exhausted = attemptCount > RETRY_DELAYS_MS.length || elapsed >= MAX_ELAPSED_MS;
    const policyDelay = exhausted ? 0 : RETRY_DELAYS_MS[attemptCount - 1];
    const retryAfterMs = parseRetryAfter(input.retryAfter, now);
    const record = {
        schemaVersion: 1,
        candidateId: input.candidateId,
        provider: input.provider,
        operation: input.operation,
        attemptCount,
        firstFailureAt,
        lastFailureAt: now,
        nextRetryAt: exhausted ? null : new Date(Date.parse(now) + Math.max(policyDelay, retryAfterMs)).toISOString(),
        providerRetryAfterMs: retryAfterMs || null,
        failureCategory: input.failureCategory,
        evidenceRefs: [...new Set([...(previous?.evidenceRefs || []), ...(input.evidenceRefs || [])])].sort(),
        exhausted,
        exhaustionReason: exhausted ? (elapsed >= MAX_ELAPSED_MS ? "retry_elapsed_time_exhausted" : "retry_attempts_exhausted") : null
    };
    validateRetryRecord(record);
    return record;
}

function evaluateRetryRecord(record, occurredAt) {
    validateRetryRecord(record);
    assert(validTime(occurredAt), "Retry evaluation timestamp is invalid.");
    if (record.exhausted || Date.parse(occurredAt) - Date.parse(record.firstFailureAt) < MAX_ELAPSED_MS) return structuredClone(record);
    return { ...structuredClone(record), exhausted: true, exhaustionReason: "retry_elapsed_time_exhausted", nextRetryAt: null };
}

async function routeRetryExhaustion(store, candidate, record, options = {}) {
    validateRetryRecord(record);
    assert(record.exhausted, "Retry record is not exhausted.");
    assert(candidate.state === "retry_wait", "Only retry_wait candidates can be placed on review hold.");
    return store.transitionCandidate(candidate.candidateId, {
        expectedRevision: candidate.revision,
        nextState: "needs_review",
        reasonCode: "retry_budget_exhausted",
        actor: options.actor || { type: "system", id: "scheduled_retry_controller_v1" },
        occurredAt: options.occurredAt,
        evidenceRefs: record.evidenceRefs,
        payload: {
            failureReason: "retry_budget_exhausted",
            processing: { lease: null, retryAt: null, resumeState: null, retryRecord: record }
        }
    });
}

module.exports = { MAX_ELAPSED_MS, RETRY_DELAYS_MS, evaluateRetryRecord, parseRetryAfter, recordRetryFailure, retryRecordKey, routeRetryExhaustion, validateRetryRecord };
