const { classifyProviderFailure, createCircuitBreaker, emptyProviderMetrics, enterHalfOpen, laneAvailability, recordBreakerFailure, recordBreakerSuccess } = require("./provider-failure-policy");
const { recordRetryFailure } = require("./candidate-retry-policy");

class FixtureProviderExecutor {
    constructor(options = {}) {
        this.clock = options.clock || (() => new Date().toISOString());
        this.transientThreshold = options.transientThreshold ?? 2;
        this.breakers = new Map();
        this.retryRecords = new Map();
        this.metrics = new Map();
    }

    breaker(provider, runId) {
        if (!this.breakers.has(provider)) this.breakers.set(provider, createCircuitBreaker(provider, { occurredAt: this.clock(), runId }));
        return this.breakers.get(provider);
    }

    providerMetrics(provider) {
        if (!this.metrics.has(provider)) this.metrics.set(provider, emptyProviderMetrics());
        return this.metrics.get(provider);
    }

    async execute(job, handler) {
        const now = this.clock();
        let breaker = this.breaker(job.provider, job.runId);
        const availability = laneAvailability(breaker, now, job.runId);
        const metrics = this.providerMetrics(job.provider);
        if (!availability.available) {
            metrics.candidatesSkippedLaneOpen += 1;
            return { status: "skipped_lane_open", candidateUntouched: true, breaker };
        }
        if (breaker.state === "open") {
            breaker = enterHalfOpen(breaker, now);
            this.breakers.set(job.provider, breaker);
        }
        metrics.requestsAttempted += 1;
        try {
            const result = await handler(job);
            if (result?.statusCode >= 400) {
                const error = new Error(result.message || `Fixture provider status ${result.statusCode}`);
                Object.assign(error, result);
                throw error;
            }
            metrics.successfulRequests += 1;
            if (breaker.state === "half_open" || breaker.failureCount > 0) this.breakers.set(job.provider, recordBreakerSuccess(breaker, now));
            return { status: "success", value: result, breaker: this.breakers.get(job.provider) };
        } catch (error) {
            const category = classifyProviderFailure(error);
            metrics.errors += 1;
            if (category === "permanent_semantic_absence") {
                metrics.permanentAbsences += 1;
                if (breaker.state === "half_open" || breaker.failureCount > 0) this.breakers.set(job.provider, recordBreakerSuccess(breaker, now));
                return { status: "permanent_absence", retryable: false, candidateUntouched: true, error };
            }
            if (category === "authentication_or_configuration") metrics.authenticationFailures += 1;
            else if (category === "transient_infrastructure") metrics.transientFailures += 1;
            const retryAfter = error.retryAfter ?? error.headers?.["retry-after"] ?? null;
            if (category === "transient_infrastructure" && job.started !== false) {
                const key = `${job.candidateId}:${job.provider}:${job.operation}`;
                const retry = recordRetryFailure(this.retryRecords.get(key), { candidateId: job.candidateId, provider: job.provider, operation: job.operation, occurredAt: now, retryAfter, failureCategory: category, evidenceRefs: job.evidenceRefs || [] });
                this.retryRecords.set(key, retry);
                metrics.retries += retry.exhausted ? 0 : 1;
                if (retry.providerRetryAfterMs) metrics.retryAfterWaits += 1;
            }
            const failureInput = { occurredAt: now, failureType: category, reason: error.message, retryAfterMs: Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0, runId: job.runId };
            this.breakers.set(job.provider, recordBreakerFailure(breaker, failureInput, { transientThreshold: this.transientThreshold }));
            return { status: category, candidateUntouched: job.started === false, retryRecord: this.retryRecords.get(`${job.candidateId}:${job.provider}:${job.operation}`) || null, error, breaker: this.breakers.get(job.provider) };
        }
    }
}

module.exports = { FixtureProviderExecutor };
