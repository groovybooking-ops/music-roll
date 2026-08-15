const PERMANENT_SEMANTIC_STATUSES = new Set([404, 409, 410, 422]);
const AUTHENTICATION_STATUSES = new Set([401, 403]);
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const BREAKER_STATES = Object.freeze(["closed", "open", "half_open"]);

function assert(condition, message) { if (!condition) throw new Error(message); }
function timestamp(value, label) {
    assert(typeof value === "string" && !Number.isNaN(Date.parse(value)), `${label} is invalid.`);
}

function classifyProviderFailure(input = {}) {
    const statusCode = input.statusCode == null ? null : Number(input.statusCode);
    if (input.category === "configuration" || input.category === "authentication" || AUTHENTICATION_STATUSES.has(statusCode)) return "authentication_or_configuration";
    if (PERMANENT_SEMANTIC_STATUSES.has(statusCode)) return "permanent_semantic_absence";
    if (input.category === "network" || input.category === "transient" || statusCode == null || TRANSIENT_STATUSES.has(statusCode)) return "transient_infrastructure";
    return "permanent_provider_error";
}

function emptyProviderMetrics() {
    return {
        requestsAttempted: 0,
        successfulRequests: 0,
        cacheHits: 0,
        errors: 0,
        retries: 0,
        retryAfterWaits: 0,
        permanentAbsences: 0,
        authenticationFailures: 0,
        transientFailures: 0,
        candidatesSkippedLaneOpen: 0
    };
}

function validateProviderMetrics(metrics) {
    const expected = Object.keys(emptyProviderMetrics());
    assert(metrics && typeof metrics === "object" && expected.every(key => Number.isInteger(metrics[key]) && metrics[key] >= 0), "Provider execution metrics are invalid.");
    return true;
}

function createCircuitBreaker(provider, options = {}) {
    const now = options.occurredAt || new Date().toISOString();
    timestamp(now, "Circuit-breaker timestamp");
    return {
        schemaVersion: 1,
        provider,
        state: "closed",
        revision: 0,
        openedAt: null,
        failureCount: 0,
        lastFailureType: null,
        nextProbeAt: null,
        reason: null,
        runId: options.runId || null,
        createdAt: now,
        updatedAt: now
    };
}

function validateCircuitBreaker(record) {
    assert(record?.schemaVersion === 1, "Circuit-breaker schemaVersion must be 1.");
    assert(typeof record.provider === "string" && record.provider.trim(), "Circuit-breaker provider is required.");
    assert(BREAKER_STATES.includes(record.state), "Circuit-breaker state is invalid.");
    assert(Number.isInteger(record.revision) && record.revision >= 0, "Circuit-breaker revision is invalid.");
    assert(Number.isInteger(record.failureCount) && record.failureCount >= 0, "Circuit-breaker failure count is invalid.");
    timestamp(record.createdAt, "Circuit-breaker createdAt"); timestamp(record.updatedAt, "Circuit-breaker updatedAt");
    if (record.openedAt != null) timestamp(record.openedAt, "Circuit-breaker openedAt");
    if (record.nextProbeAt != null) timestamp(record.nextProbeAt, "Circuit-breaker nextProbeAt");
    if (record.state === "open") assert(record.openedAt && record.nextProbeAt && record.reason, "Open circuit breaker lacks open-state metadata.");
    return true;
}

function openBreaker(record, input) {
    validateCircuitBreaker(record);
    const now = input.occurredAt;
    const delayMs = Math.max(input.probeDelayMs ?? 900000, input.retryAfterMs || 0);
    return {
        ...record,
        state: "open",
        revision: record.revision + 1,
        openedAt: record.openedAt || now,
        failureCount: record.failureCount + 1,
        lastFailureType: input.failureType,
        nextProbeAt: new Date(Date.parse(now) + delayMs).toISOString(),
        reason: input.reason || input.failureType,
        runId: input.runId || record.runId,
        updatedAt: now
    };
}

function recordBreakerFailure(record, input, options = {}) {
    validateCircuitBreaker(record);
    const threshold = options.transientThreshold ?? 2;
    const nextCount = record.failureCount + 1;
    if (input.failureType === "authentication_or_configuration" || record.state === "half_open" || nextCount >= threshold) return openBreaker(record, input);
    return { ...record, revision: record.revision + 1, failureCount: nextCount, lastFailureType: input.failureType, reason: input.reason || input.failureType, runId: input.runId || record.runId, updatedAt: input.occurredAt };
}

function enterHalfOpen(record, occurredAt) {
    validateCircuitBreaker(record);
    assert(record.state === "open", "Only an open circuit breaker can become half-open.");
    assert(Date.parse(occurredAt) >= Date.parse(record.nextProbeAt), "Circuit-breaker probe is not due.");
    return { ...record, state: "half_open", revision: record.revision + 1, updatedAt: occurredAt };
}

function recordBreakerSuccess(record, occurredAt) {
    validateCircuitBreaker(record);
    return { ...record, state: "closed", revision: record.revision + 1, openedAt: null, failureCount: 0, lastFailureType: null, nextProbeAt: null, reason: null, updatedAt: occurredAt };
}

function laneAvailability(record, occurredAt, runId = null) {
    validateCircuitBreaker(record);
    if (record.state === "closed" || record.state === "half_open") return { available: true, probe: record.state === "half_open" };
    if (record.lastFailureType === "authentication_or_configuration" && runId != null && record.runId === runId) return { available: false, probe: false };
    if (record.lastFailureType === "authentication_or_configuration" && runId != null && record.runId !== runId) return { available: true, probe: true };
    return Date.parse(occurredAt) >= Date.parse(record.nextProbeAt) ? { available: true, probe: true } : { available: false, probe: false };
}

module.exports = { AUTHENTICATION_STATUSES, BREAKER_STATES, PERMANENT_SEMANTIC_STATUSES, TRANSIENT_STATUSES, classifyProviderFailure, createCircuitBreaker, emptyProviderMetrics, enterHalfOpen, laneAvailability, openBreaker, recordBreakerFailure, recordBreakerSuccess, validateCircuitBreaker, validateProviderMetrics };
