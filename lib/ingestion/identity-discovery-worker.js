const { createEventId } = require("./candidate-schema");
const { duplicatePreflight } = require("./duplicate-preflight");
const { OfflineCacheMissError } = require("./identity-evidence-store");
const { TemporaryIdentityDiscoveryError } = require("./identity-discovery-resolver");

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function discoveryMetadata(resolution, evidenceRefs, resolvedAt) {
    return {
        outcome: resolution.report.decision,
        resultingSpotifyArtistId: resolution.spotifyArtistId || null,
        evidenceRefs: unique(evidenceRefs),
        providerErrors: resolution.report.providerErrors || [],
        provenanceClaims: resolution.report.provenanceClaims || [],
        resolvedAt,
        resolverVersion: "identity_discovery_resolver_v1",
        reviewOnly: true
    };
}

class IdentityDiscoveryWorker {
    constructor({ store, resolver, evidenceStore, permanentRegistry, liveArtists = [], workerId = "identity_discovery_worker_v1", clock, leaseDurationMs = 300000, retryDelayMs = 60000 }) {
        if (!store || !resolver || !evidenceStore) throw new Error("Identity-discovery worker requires a candidate store, resolver, and evidence store.");
        if (permanentRegistry?.schemaVersion !== 1 || !Array.isArray(permanentRegistry.mappings)) throw new Error("Identity-discovery worker requires the permanent registry for duplicate preflight.");
        this.store = store;
        this.resolver = resolver;
        this.evidenceStore = evidenceStore;
        this.permanentRegistry = permanentRegistry;
        this.liveArtists = liveArtists;
        this.workerId = workerId;
        this.clock = clock || (() => new Date().toISOString());
        this.leaseDurationMs = leaseDurationMs;
        this.retryDelayMs = retryDelayMs;
    }

    now() { return new Date(this.clock()).toISOString(); }

    async recoverExpired(candidateId = null) {
        const now = this.now();
        const candidates = await this.store.listCandidates();
        const results = [];
        for (const candidate of candidates) {
            if (candidateId && candidate.candidateId !== candidateId) continue;
            if (candidate.state !== "identity_discovering" || !candidate.processing.lease?.expiresAt || Date.parse(candidate.processing.lease.expiresAt) > Date.parse(now)) continue;
            try {
                const next = await this.store.transitionCandidate(candidate.candidateId, {
                    expectedRevision: candidate.revision,
                    nextState: "retry_wait",
                    reasonCode: "identity_discovery_lease_expired",
                    actor: { type: "system", id: this.workerId },
                    payload: { processing: { lease: null, retryAt: now, resumeState: "identity_discovery_pending", lastFailure: { code: "identity_discovery_lease_expired", retryable: true } } }
                });
                results.push({ candidateId: next.candidateId, action: "expired_lease_recovered" });
            } catch (error) {
                if (!/Stale candidate revision/.test(error.message)) throw error;
            }
        }
        return results;
    }

    async requeueEligibleRetries(candidateId = null) {
        const now = this.now();
        const candidates = await this.store.listCandidates();
        const results = [];
        for (const candidate of candidates) {
            if (candidateId && candidate.candidateId !== candidateId) continue;
            if (candidate.state !== "retry_wait" || candidate.processing.resumeState !== "identity_discovery_pending") continue;
            if (candidate.processing.retryAt && Date.parse(candidate.processing.retryAt) > Date.parse(now)) continue;
            try {
                const next = await this.store.transitionCandidate(candidate.candidateId, {
                    expectedRevision: candidate.revision,
                    nextState: "identity_discovery_pending",
                    reasonCode: "identity_discovery_retry_became_eligible",
                    actor: { type: "system", id: this.workerId },
                    payload: { processing: { lease: null, retryAt: null, resumeState: null, lastFailure: null } }
                });
                results.push({ candidateId: next.candidateId, action: "retry_requeued" });
            } catch (error) {
                if (!/Stale candidate revision/.test(error.message)) throw error;
            }
        }
        return results;
    }

    async acquire(candidate) {
        const acquiredAt = this.now();
        const attemptsByStep = { ...candidate.processing.attemptsByStep, identityDiscovery: (candidate.processing.attemptsByStep.identityDiscovery || 0) + 1 };
        return this.store.transitionCandidate(candidate.candidateId, {
            expectedRevision: candidate.revision,
            nextState: "identity_discovering",
            reasonCode: "identity_discovery_lease_acquired",
            actor: { type: "worker", id: this.workerId },
            payload: {
                processing: {
                    attemptsByStep,
                    lease: { leaseId: createEventId(), workerId: this.workerId, acquiredAt, expiresAt: new Date(Date.parse(acquiredAt) + this.leaseDurationMs).toISOString(), startingRevision: candidate.revision },
                    retryAt: null,
                    resumeState: null,
                    lastFailure: null
                }
            }
        });
    }

    async retry(acquired, error) {
        const now = this.now();
        const retryAt = new Date(Date.parse(now) + this.retryDelayMs).toISOString();
        const payload = {
            failure: {
                name: error.name,
                message: error.message,
                provider: error.provider || null,
                operation: error.operation || null,
                identifier: error.identifier || null,
                statusCode: error.statusCode || null,
                retryable: true
            }
        };
        const evidence = await this.evidenceStore.persistIdentityDiscoveryEvidence(acquired.candidateId, payload, error.evidenceRef ? [error.evidenceRef] : []);
        const next = await this.store.transitionCandidate(acquired.candidateId, {
            expectedRevision: acquired.revision,
            nextState: "retry_wait",
            reasonCode: "identity_discovery_provider_retry_scheduled",
            actor: { type: "worker", id: this.workerId },
            evidenceRefs: [evidence.evidenceRef],
            payload: {
                identityDiscovery: { outcome: "temporary_provider_failure", resultingSpotifyArtistId: null, evidenceRefs: [evidence.evidenceRef], providerErrors: [payload.failure], provenanceClaims: [], resolvedAt: now, resolverVersion: "identity_discovery_resolver_v1", reviewOnly: true },
                processing: { lease: null, retryAt, resumeState: "identity_discovery_pending", lastFailure: { message: error.message, retryable: true, evidenceRef: evidence.evidenceRef } }
            }
        });
        return { candidateId: next.candidateId, status: "retry_wait", state: next.state, retryAt, evidenceRef: evidence.evidenceRef };
    }

    async finish(acquired, resolution) {
        const evidence = await this.evidenceStore.persistIdentityDiscoveryEvidence(acquired.candidateId, { report: resolution.report, acquisition: resolution.acquisition }, resolution.provenanceRefs || []);
        const evidenceRefs = unique([evidence.evidenceRef, ...(resolution.provenanceRefs || [])]);
        const resolvedAt = this.now();
        if (resolution.status === "unique_exact_bridge") {
            const attachment = await this.store.attachIdentifier(acquired.candidateId, {
                expectedRevision: acquired.revision,
                identifier: {
                    provider: "spotify",
                    entityType: "artist",
                    value: resolution.spotifyArtistId,
                    url: `https://open.spotify.com/artist/${resolution.spotifyArtistId}`,
                    bridgeEvidenceId: evidence.evidenceId
                },
                reasonCode: "exact_spotify_bridge_discovered",
                actor: { type: "worker", id: this.workerId },
                evidenceRefs
            });
            const candidate = attachment.candidate;
            const candidates = await this.store.listCandidates();
            const preflight = duplicatePreflight({ candidate, candidates, permanentRegistry: this.permanentRegistry, liveArtists: this.liveArtists });
            const next = await this.store.transitionCandidate(candidate.candidateId, {
                expectedRevision: candidate.revision,
                nextState: preflight.nextState,
                reasonCode: preflight.nextState === "identity_pending" ? "exact_spotify_bridge_ready_for_corroboration" : preflight.reasonCode,
                actor: { type: "worker", id: this.workerId },
                evidenceRefs: unique([...evidenceRefs, ...(preflight.evidenceRefs || [])]),
                payload: {
                    identityDiscovery: discoveryMetadata(resolution, evidenceRefs, resolvedAt),
                    processing: { lease: null, retryAt: null, resumeState: null, lastFailure: null },
                    ...(preflight.duplicate ? { duplicate: preflight.duplicate } : {}),
                    warnings: preflight.warnings || []
                }
            });
            return { candidateId: next.candidateId, status: "processed", decision: resolution.report.decision, spotifyArtistId: resolution.spotifyArtistId, state: next.state, evidenceRef: evidence.evidenceRef };
        }
        const nextState = resolution.status === "conflicting_identity" ? "conflicting_identity" : "needs_review";
        const next = await this.store.transitionCandidate(acquired.candidateId, {
            expectedRevision: acquired.revision,
            nextState,
            reasonCode: nextState === "conflicting_identity" ? "identity_discovery_semantic_or_exact_conflict" : "identity_discovery_requires_review",
            actor: { type: "worker", id: this.workerId },
            evidenceRefs,
            payload: {
                identityDiscovery: discoveryMetadata(resolution, evidenceRefs, resolvedAt),
                processing: { lease: null, retryAt: null, resumeState: null, lastFailure: null }
            }
        });
        return { candidateId: next.candidateId, status: "processed", decision: resolution.report.decision, spotifyArtistId: null, state: next.state, evidenceRef: evidence.evidenceRef };
    }

    async processCandidate(candidate) {
        if (this.resolver.networkAllowed === true) {
            let acquired;
            try { acquired = await this.acquire(candidate); }
            catch (error) {
                if (/Stale candidate revision/.test(error.message)) return { candidateId: candidate.candidateId, status: "stale_revision" };
                throw error;
            }
            try { return await this.finish(acquired, await this.resolver.resolve(acquired)); }
            catch (error) {
                if (/Stale candidate revision/.test(error.message)) return { candidateId: candidate.candidateId, status: "stale_revision" };
                const retryable = error instanceof TemporaryIdentityDiscoveryError || error.retryable === true
                    ? error
                    : new TemporaryIdentityDiscoveryError(`Identity-discovery infrastructure failure: ${error.message}`, { operation: "identity_discovery_worker", statusCode: error.statusCode || null });
                return this.retry(acquired, retryable);
            }
        }
        let resolution;
        let resolutionError = null;
        try { resolution = await this.resolver.resolve(candidate); }
        catch (error) {
            if (error instanceof OfflineCacheMissError) return { candidateId: candidate.candidateId, status: "skipped_cache_miss", state: candidate.state, provider: error.provider, operation: error.operation, identifier: error.identifier };
            resolutionError = error;
        }
        let acquired;
        try { acquired = await this.acquire(candidate); }
        catch (error) {
            if (/Stale candidate revision/.test(error.message)) return { candidateId: candidate.candidateId, status: "stale_revision" };
            throw error;
        }
        if (resolutionError) {
            if (resolutionError instanceof TemporaryIdentityDiscoveryError || resolutionError.retryable === true) return this.retry(acquired, resolutionError);
            throw resolutionError;
        }
        return this.finish(acquired, resolution);
    }

    async run(options = {}) {
        const limit = options.limit ?? 25;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Identity-discovery worker limit must be an integer from 1 to 1000.");
        await this.recoverExpired(options.candidateId);
        await this.requeueEligibleRetries(options.candidateId);
        const candidates = (await this.store.listCandidates())
            .filter(candidate => candidate.state === "identity_discovery_pending")
            .filter(candidate => !options.candidateId || candidate.candidateId === options.candidateId)
            .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.candidateId.localeCompare(right.candidateId))
            .slice(0, limit);
        const results = [];
        for (const candidate of candidates) {
            try { results.push(await this.processCandidate(candidate)); }
            catch (error) {
                if (/Stale candidate revision/.test(error.message)) results.push({ candidateId: candidate.candidateId, status: "stale_revision" });
                else results.push({ candidateId: candidate.candidateId, status: "worker_error", message: error.message });
            }
        }
        await this.store.rebuildIndexes();
        return {
            selected: candidates.length,
            processed: results.filter(item => item.status === "processed").length,
            skippedCacheMiss: results.filter(item => item.status === "skipped_cache_miss").length,
            retryWait: results.filter(item => item.status === "retry_wait").length,
            staleRevisions: results.filter(item => item.status === "stale_revision").length,
            workerErrors: results.filter(item => item.status === "worker_error").length,
            results
        };
    }
}

module.exports = { IdentityDiscoveryWorker, discoveryMetadata };
