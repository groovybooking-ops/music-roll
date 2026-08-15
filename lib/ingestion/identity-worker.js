const { createEventId } = require("./candidate-schema");
const { TemporaryIdentityError } = require("./queue-identity-resolver");

const OUTCOME_ROUTES = Object.freeze({
    coherent_identity_evidence: { state: "identity_coherent", reasonCode: "identity_evidence_coherent" },
    coherent_identity_with_same_name_ambiguity: { state: "needs_review", reasonCode: "identity_same_name_ambiguity_requires_review" },
    provider_profile_multiplicity: { state: "needs_review", reasonCode: "identity_provider_multiplicity_requires_review" },
    insufficient_corroboration: { state: "needs_review", reasonCode: "identity_corroboration_insufficient" },
    semantic_identity_conflict: { state: "conflicting_identity", reasonCode: "semantic_identity_conflict_detected" },
    unresolved_identity: { state: "failed_match", reasonCode: "no_safe_exact_identity_resolved" }
});

function routeIdentityReport(report) {
    if (report.outcome === "provider_profile_multiplicity" && report.conflictResolution?.mechanicalClosure?.mechanicallyClosed === true) {
        return { state: "identity_coherent", reasonCode: "identity_provider_multiplicity_mechanically_closed" };
    }
    return OUTCOME_ROUTES[report.outcome] || null;
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function agreementValues(report, type) {
    const comparison = report.identifierAgreement?.[type];
    return unique(comparison?.observedValues || (comparison?.agreedValue ? [comparison.agreedValue] : []));
}

function resolvedIdentityFromReport(candidate, report, evidenceRefs, resolvedAt) {
    const coherentUnderlyingEntity = new Set([
        "coherent_identity_evidence",
        "coherent_identity_with_same_name_ambiguity",
        "provider_profile_multiplicity"
    ]).has(report.outcome);
    return {
        outcome: report.outcome,
        selectedSpotifyArtistId: coherentUnderlyingEntity ? candidate.candidateIdentifiers.spotifyArtistId : null,
        wikidataQids: agreementValues(report, "wikidataQid"),
        musicBrainzArtistIds: agreementValues(report, "musicBrainzArtistId"),
        discogsArtistIds: agreementValues(report, "discogsArtistId"),
        identityConfidence: { value: null, band: "unknown", methodVersion: null, evidenceRefs: [] },
        evidenceRefs: unique(evidenceRefs),
        conflicts: report.conflictingIdentifiers || [],
        sameNameAmbiguity: report.sameNameAmbiguity || null,
        providerMultiplicity: report.conflictResolution || null,
        provenanceClaims: report.provenanceClaims || [],
        providerErrors: report.providerErrors || [],
        resolverVersion: "queue_identity_resolver_v1",
        resolvedAt
    };
}

function retryIdentity(candidate, error, evidenceRefs, resolvedAt) {
    return {
        ...candidate.resolvedIdentity,
        outcome: "unresolved_identity",
        selectedSpotifyArtistId: null,
        identityConfidence: { value: null, band: "unknown", methodVersion: null, evidenceRefs: [] },
        evidenceRefs: unique([...candidate.resolvedIdentity.evidenceRefs, ...evidenceRefs]),
        providerErrors: [...candidate.resolvedIdentity.providerErrors, {
            provider: error.provider || null,
            operation: error.operation || null,
            identifier: error.identifier || null,
            statusCode: error.statusCode || null,
            message: error.message,
            retryable: true
        }],
        resolverVersion: "queue_identity_resolver_v1",
        resolvedAt
    };
}

class IdentityQueueWorker {
    constructor({ store, resolver, evidenceStore, workerId = "identity_worker_v1", clock, leaseDurationMs = 300000, retryDelayMs = 60000 }) {
        if (!store || !resolver || !evidenceStore) throw new Error("Identity worker requires a candidate store, resolver, and evidence store.");
        this.store = store;
        this.resolver = resolver;
        this.evidenceStore = evidenceStore;
        this.workerId = workerId;
        this.clock = clock || (() => new Date().toISOString());
        this.leaseDurationMs = leaseDurationMs;
        this.retryDelayMs = retryDelayMs;
    }

    now() {
        return new Date(this.clock()).toISOString();
    }

    async recoverExpired(candidateId = null) {
        const now = this.now();
        const nowMs = Date.parse(now);
        const candidates = await this.store.listCandidates();
        const results = [];
        for (const candidate of candidates) {
            if (candidateId && candidate.candidateId !== candidateId) continue;
            if (candidate.state !== "identity_resolving" || !candidate.processing.lease?.expiresAt || Date.parse(candidate.processing.lease.expiresAt) > nowMs) continue;
            try {
                const recovered = await this.store.transitionCandidate(candidate.candidateId, {
                    expectedRevision: candidate.revision,
                    nextState: "retry_wait",
                    reasonCode: "identity_worker_lease_expired",
                    actor: { type: "system", id: this.workerId },
                    payload: {
                        processing: {
                            lease: null,
                            retryAt: now,
                            resumeState: "identity_pending",
                            lastFailure: { code: "identity_worker_lease_expired", retryable: true }
                        },
                        enrichment: { identity: "retry_wait" }
                    }
                });
                results.push({ candidateId: recovered.candidateId, action: "expired_lease_recovered" });
            } catch (error) {
                if (!/Stale candidate revision/.test(error.message)) throw error;
            }
        }
        return results;
    }

    async requeueEligibleRetries(candidateId = null) {
        const nowMs = Date.parse(this.now());
        const candidates = await this.store.listCandidates();
        const results = [];
        for (const candidate of candidates) {
            if (candidateId && candidate.candidateId !== candidateId) continue;
            if (candidate.state !== "retry_wait" || candidate.processing.resumeState !== "identity_pending") continue;
            if (candidate.processing.retryAt && Date.parse(candidate.processing.retryAt) > nowMs) continue;
            try {
                const requeued = await this.store.transitionCandidate(candidate.candidateId, {
                    expectedRevision: candidate.revision,
                    nextState: "identity_pending",
                    reasonCode: "identity_retry_became_eligible",
                    actor: { type: "system", id: this.workerId },
                    payload: {
                        processing: { lease: null, retryAt: null, resumeState: null },
                        enrichment: { identity: "pending" }
                    }
                });
                results.push({ candidateId: requeued.candidateId, action: "retry_requeued" });
            } catch (error) {
                if (!/Stale candidate revision/.test(error.message)) throw error;
            }
        }
        return results;
    }

    async acquire(candidate) {
        const acquiredAt = this.now();
        const expiresAt = new Date(Date.parse(acquiredAt) + this.leaseDurationMs).toISOString();
        const attemptsByStep = { ...candidate.processing.attemptsByStep, identity: (candidate.processing.attemptsByStep.identity || 0) + 1 };
        return this.store.transitionCandidate(candidate.candidateId, {
            expectedRevision: candidate.revision,
            nextState: "identity_resolving",
            reasonCode: "identity_worker_lease_acquired",
            actor: { type: "worker", id: this.workerId },
            payload: {
                processing: {
                    attemptsByStep,
                    lease: { leaseId: createEventId(), workerId: this.workerId, acquiredAt, expiresAt, startingRevision: candidate.revision },
                    retryAt: null,
                    resumeState: null,
                    lastFailure: null
                },
                enrichment: { identity: "resolving" }
            }
        });
    }

    async finish(acquired, resolution) {
        const evidence = await this.evidenceStore.persistIdentityEvidence(acquired.candidateId, {
            report: resolution.report,
            acquisition: resolution.acquisition || {}
        }, resolution.provenanceRefs || []);
        const route = routeIdentityReport(resolution.report);
        if (!route) throw new Error(`Identity worker cannot route outcome: ${resolution.report.outcome}.`);
        const evidenceRefs = unique([evidence.evidenceRef, ...(resolution.provenanceRefs || [])]);
        const resolvedAt = this.now();
        const next = await this.store.transitionCandidate(acquired.candidateId, {
            expectedRevision: acquired.revision,
            nextState: route.state,
            reasonCode: route.reasonCode,
            actor: { type: "worker", id: this.workerId },
            evidenceRefs,
            payload: {
                resolvedIdentity: resolvedIdentityFromReport(acquired, resolution.report, evidenceRefs, resolvedAt),
                processing: { lease: null, retryAt: null, resumeState: null, lastFailure: null },
                enrichment: { identity: route.state === "identity_coherent" ? "complete" : route.state }
            }
        });
        return { candidateId: next.candidateId, status: "processed", outcome: resolution.report.outcome, state: next.state, evidenceRef: evidence.evidenceRef };
    }

    async retry(acquired, error) {
        const retryableError = error instanceof TemporaryIdentityError || error.retryable === true
            ? error
            : new TemporaryIdentityError(`Identity worker infrastructure failure: ${error.message}`, { cause: error, operation: "identity_worker" });
        const failureEvidence = await this.evidenceStore.persistIdentityEvidence(acquired.candidateId, {
            failure: {
                name: retryableError.name,
                message: retryableError.message,
                provider: retryableError.provider || null,
                operation: retryableError.operation || null,
                identifier: retryableError.identifier || null,
                statusCode: retryableError.statusCode || null,
                retryable: true
            }
        });
        const now = this.now();
        const retryAt = new Date(Date.parse(now) + this.retryDelayMs).toISOString();
        const next = await this.store.transitionCandidate(acquired.candidateId, {
            expectedRevision: acquired.revision,
            nextState: "retry_wait",
            reasonCode: "identity_provider_retry_scheduled",
            actor: { type: "worker", id: this.workerId },
            evidenceRefs: [failureEvidence.evidenceRef],
            payload: {
                resolvedIdentity: retryIdentity(acquired, retryableError, [failureEvidence.evidenceRef], now),
                processing: {
                    lease: null,
                    retryAt,
                    resumeState: "identity_pending",
                    lastFailure: { message: retryableError.message, retryable: true, evidenceRef: failureEvidence.evidenceRef }
                },
                enrichment: { identity: "retry_wait" }
            }
        });
        return { candidateId: next.candidateId, status: "retry_wait", outcome: "unresolved_identity", state: next.state, evidenceRef: failureEvidence.evidenceRef, retryAt };
    }

    async processCandidate(candidate) {
        let acquired;
        try {
            acquired = await this.acquire(candidate);
        } catch (error) {
            if (/Stale candidate revision/.test(error.message)) return { candidateId: candidate.candidateId, status: "stale_revision" };
            throw error;
        }
        try {
            return await this.finish(acquired, await this.resolver.resolve(acquired));
        } catch (error) {
            if (/Stale candidate revision/.test(error.message)) return { candidateId: candidate.candidateId, status: "stale_revision" };
            try {
                return await this.retry(acquired, error);
            } catch (retryError) {
                if (/Stale candidate revision/.test(retryError.message)) return { candidateId: candidate.candidateId, status: "stale_revision" };
                throw retryError;
            }
        }
    }

    async run(options = {}) {
        const limit = options.limit ?? 25;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Identity worker limit must be an integer from 1 to 1000.");
        await this.recoverExpired(options.candidateId);
        await this.requeueEligibleRetries(options.candidateId);
        const candidates = (await this.store.listCandidates())
            .filter(candidate => candidate.state === "identity_pending")
            .filter(candidate => !options.candidateId || candidate.candidateId === options.candidateId)
            .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.candidateId.localeCompare(right.candidateId))
            .slice(0, limit);
        const results = [];
        for (const candidate of candidates) {
            try {
                results.push(await this.processCandidate(candidate));
            } catch (error) {
                results.push({ candidateId: candidate.candidateId, status: "worker_error", message: error.message });
            }
        }
        await this.store.rebuildIndexes();
        return {
            selected: candidates.length,
            processed: results.filter(result => result.status === "processed").length,
            retryWait: results.filter(result => result.status === "retry_wait").length,
            staleRevisions: results.filter(result => result.status === "stale_revision").length,
            workerErrors: results.filter(result => result.status === "worker_error").length,
            results
        };
    }
}

module.exports = { IdentityQueueWorker, OUTCOME_ROUTES, resolvedIdentityFromReport, routeIdentityReport };
