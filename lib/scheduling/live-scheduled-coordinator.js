const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { CandidateStore } = require("../ingestion/candidate-store");
const { IdentityEvidenceStore } = require("../ingestion/identity-evidence-store");
const { QueueIdentityResolver } = require("../ingestion/queue-identity-resolver");
const { IdentityQueueWorker } = require("../ingestion/identity-worker");
const { IdentityDiscoveryEvidenceStore } = require("../ingestion/identity-discovery-evidence-store");
const { IdentityDiscoveryResolver } = require("../ingestion/identity-discovery-resolver");
const { IdentityDiscoveryWorker } = require("../ingestion/identity-discovery-worker");
const { DiscoveryConvergence } = require("../discovery/discovery-convergence");
const { DiscoveryStore } = require("../discovery/discovery-store");
const { createSpotifyLiveDiscoveryAdapter, createTicketmasterLiveDiscoveryAdapter } = require("../discovery/live-discovery-adapters");
const { BoundedRequestLedger, ImmutableListingCache } = require("../discovery/live-pilot-support");
const { createFixtureCheckpoint } = require("../discovery/fixture-checkpoint");
const { createBoundedMusicBrainzFetch } = require("../../scripts/run-ingestion-identity-discovery-worker");
const { emptyBudgetConsumption, providerStopReason, validateBudgets } = require("./scheduled-budget-policy");
const { ProviderCheckpointStore } = require("./provider-checkpoint-store");
const { checkpointIdFor, stableSourceConfigurationHash } = require("./provider-checkpoint-schema");
const { classifyProviderFailure, createCircuitBreaker, emptyProviderMetrics, recordBreakerFailure } = require("./provider-failure-policy");
const { ScheduledRunStore, checksumFiles } = require("./scheduled-run-store");
const { firstIncompletePhase } = require("./scheduled-run-journal");
const { stableConfigurationHash } = require("./scheduled-run-schema");
const { buildDailySummary } = require("./scheduled-summary-generator");
const { loadImmutableSummarySources } = require("./scheduled-summary-source-loader");
const { ScheduledSummaryStore } = require("./scheduled-summary-store");

function assert(condition, message) { if (!condition) throw new Error(message); }
function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }
async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function listJson(root) { const output = []; async function visit(current) { const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error)); for (const entry of entries) { const target = path.join(current, entry.name); if (entry.isDirectory()) await visit(target); else if (entry.name.endsWith(".json")) output.push(target); } } await visit(root); return output.sort(); }

class LiveScheduledCoordinator {
    constructor(options) {
        assert(options?.allowNetwork === true, "Refusing live scheduled ingestion: pass --allow-network after explicit approval.");
        this.projectRoot = path.resolve(options.projectRoot);
        this.scheduledRoot = path.resolve(options.scheduledRoot);
        this.configuration = structuredClone(options.configuration);
        validateBudgets(this.configuration.budgets);
        assert(this.configuration.maximumTotalNewCandidates === 6, "Live scheduled run total candidate cap must remain six.");
        this.allowNetwork = true;
        this.environment = options.environment || process.env;
        this.fetchImpl = options.fetchImpl || fetch;
        this.clock = options.clock || (() => new Date().toISOString());
        this.runStore = new ScheduledRunStore(this.scheduledRoot, { clock: this.clock });
        this.checkpointStore = new ProviderCheckpointStore(this.scheduledRoot, { clock: this.clock });
        this.candidateStore = new CandidateStore(path.join(this.scheduledRoot, "store"), { clock: this.clock });
        this.discoveryStore = new DiscoveryStore(path.join(this.scheduledRoot, "store"), { clock: this.clock });
        this.summaryStore = new ScheduledSummaryStore(path.join(this.scheduledRoot, "summaries"));
        this.protectedPaths = ["data/artists.json", "data/artist-id-registry.json"];
    }

    artifactPath(runId, name) { return path.join(this.runStore.runDirectory(runId), "artifacts", `${name}.json`); }
    relative(file) { return path.relative(this.scheduledRoot, file).split(path.sep).join("/"); }
    async writeImmutable(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); const bytes = JSON.stringify(value, null, 2) + "\n"; try { await fs.writeFile(file, bytes, { flag: "wx" }); return { value, created: true }; } catch (error) { if (error.code !== "EEXIST") throw error; const existing = await readJson(file); if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error(`Immutable scheduled artifact collision: ${file}`); return { value: existing, created: false }; } }
    async readArtifact(runId, name) { return readJson(this.artifactPath(runId, name)).catch(error => error.code === "ENOENT" ? null : Promise.reject(error)); }

    async findRun(runId = null) {
        if (runId) return this.runStore.readManifest(runId);
        const hash = stableConfigurationHash(this.configuration);
        const manifests = await Promise.all((await listJson(this.runStore.runsRoot)).filter(file => file.endsWith("manifest.json")).map(readJson));
        return manifests.filter(item => item.stableConfigurationHash === hash && item.control.status !== "completed").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
    }

    async createOrResume(runId = null) {
        let manifest = await this.findRun(runId);
        if (manifest) return { manifest, created: false };
        assert(!runId, `Scheduled run does not exist: ${runId}`);
        const protectedChecksums = await checksumFiles(this.projectRoot, this.protectedPaths);
        manifest = await this.runStore.createRun({ configuration: this.configuration, budgets: this.configuration.budgets, networkAllowed: true, protectedChecksums, actor: { type: "command", id: "human_triggered_scheduled_coordinator_v1" } });
        const candidates = await this.candidateStore.listCandidates();
        await this.writeImmutable(this.artifactPath(manifest.runId, "run-start"), { schemaVersion: 1, runId: manifest.runId, createdAt: manifest.createdAt, queue: this.queueProjection(candidates), candidateRevisions: Object.fromEntries(candidates.map(item => [item.candidateId, item.revision])), protectedChecksums });
        return { manifest, created: true };
    }

    queueProjection(candidates) { return { total: candidates.length, byState: Object.fromEntries([...new Set(candidates.map(item => item.state))].sort().map(state => [state, candidates.filter(item => item.state === state).length])) }; }

    checkpointReference(provider, adapter, sourceConfiguration, createdAt) {
        const stableHash = stableSourceConfigurationHash(sourceConfiguration);
        return { schemaVersion: 1, checkpointId: checkpointIdFor({ provider, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion, stableConfigurationHash: stableHash }), provider, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion, stableConfigurationHash: stableHash, revision: 1, position: { providerPage: 0, cursor: null, itemOffset: 0 }, rollingWindowIdentity: provider === "ticketmaster" ? { startDateTime: sourceConfiguration.startDateTime, endDateTime: sourceConfiguration.endDateTime } : null, exhausted: false, lastCompletedRunId: null, latestRawPageEvidenceRef: null, createdAt, updatedAt: createdAt };
    }

    async ensureCheckpoint(provider, adapter, sourceConfiguration, createdAt) {
        const reference = this.checkpointReference(provider, adapter, sourceConfiguration, createdAt);
        try { return { checkpoint: await this.checkpointStore.readLatest(reference), checkpointRef: this.checkpointStore.relative(this.checkpointStore.historyPath(await this.checkpointStore.readLatest(reference), (await this.checkpointStore.readLatest(reference)).revision)) }; }
        catch (error) { if (error.code !== "ENOENT") throw error; return this.checkpointStore.createCheckpoint({ provider, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion, sourceConfiguration, rollingWindowIdentity: reference.rollingWindowIdentity, createdAt }); }
    }

    async recordProvider(manifest, provider, metrics, breaker, stopReason = null) {
        const existing = manifest.providerExecution[provider];
        const combined = { ...emptyProviderMetrics() };
        for (const key of Object.keys(combined)) combined[key] = (existing?.metrics?.[key] || 0) + (metrics[key] || 0);
        return this.runStore.recordProviderExecution(manifest.runId, { expectedRevision: manifest.revision, configuration: this.configuration, provider, metrics: combined, circuitBreaker: breaker, stopReason });
    }

    async discoveryPhase(manifest, provider) {
        const phase = provider === "spotify" ? "spotify_discovery_complete_or_skipped" : "ticketmaster_discovery_complete_or_skipped";
        const artifactName = `${provider}-discovery`;
        let artifact = await this.readArtifact(manifest.runId, artifactName);
        const providerConfig = { ...this.configuration[provider], discoveredAt: manifest.startedAt };
        if (this.configuration[provider]?.enabled === false) {
            if (!artifact) {
                artifact = {
                    schemaVersion: 1,
                    runId: manifest.runId,
                    provider,
                    configuration: providerConfig,
                    acquiredAt: this.clock(),
                    rawEvidenceRef: null,
                    occurrences: [],
                    metrics: emptyProviderMetrics(),
                    circuitBreaker: null,
                    error: null,
                    skippedReason: "provider_disabled_for_scheduled_job",
                    reviewOnly: true
                };
                artifact = (await this.writeImmutable(this.artifactPath(manifest.runId, artifactName), artifact)).value;
            }
            return (await this.runStore.completePhase(manifest.runId, {
                expectedRevision: manifest.revision,
                configuration: this.configuration,
                phase,
                disposition: "skipped",
                checkpointRefs: [this.relative(this.artifactPath(manifest.runId, artifactName))],
                budgetConsumption: manifest.budgetConsumption
            })).manifest;
        }
        const cache = new ImmutableListingCache(path.join(this.scheduledRoot, "store"), { freshnessMs: this.configuration.listingFreshnessHours[provider] * 3600000, clock: this.clock });
        const ledger = new BoundedRequestLedger({ fetchImpl: this.fetchImpl, totalCap: this.configuration.budgets.providers[provider].maxRequests, spotifyCap: this.configuration.budgets.providers.spotify.maxRequests, ticketmasterCap: this.configuration.budgets.providers.ticketmaster.maxRequests });
        const adapter = provider === "spotify" ? createSpotifyLiveDiscoveryAdapter({ cache, ledger, credentials: { clientId: this.environment.SPOTIFY_CLIENT_ID, clientSecret: this.environment.SPOTIFY_CLIENT_SECRET } }) : createTicketmasterLiveDiscoveryAdapter({ cache, ledger, apiKey: this.environment.TICKETMASTER_API_KEY });
        const sourceConfiguration = structuredClone(this.configuration[provider]);
        let checkpointResult = await this.ensureCheckpoint(provider, adapter, sourceConfiguration, manifest.startedAt);
        if (!artifact) {
            let page = null, occurrences = [], error = null;
            try {
                page = await adapter.acquirePage({ configuration: providerConfig, checkpoint: createFixtureCheckpoint(adapter.canonicalConfigurationHash(providerConfig)), networkAllowed: true });
                occurrences = adapter.normalizePage(page, { configuration: providerConfig }).slice(0, provider === "spotify" ? 4 : 2);
            } catch (caught) { error = { name: caught.name, message: caught.message, statusCode: caught.statusCode || null }; }
            const metrics = { ...emptyProviderMetrics(), requestsAttempted: ledger.requests[provider], successfulRequests: Math.max(0, ledger.requests[provider] - ledger.errors.filter(item => item.provider === provider).length), cacheHits: page?.cacheHit ? 1 : 0, retries: ledger.retries[provider], errors: ledger.errors.filter(item => item.provider === provider).length + (error ? 1 : 0), retryAfterWaits: ledger.retries[provider], permanentAbsences: error && [404, 409, 410, 422].includes(error.statusCode) ? 1 : 0, authenticationFailures: error && [401, 403].includes(error.statusCode) ? 1 : 0, transientFailures: error && (error.statusCode == null || [408, 425, 429, 500, 502, 503, 504].includes(error.statusCode)) ? 1 : 0 };
            let breaker = createCircuitBreaker(provider, { occurredAt: this.clock(), runId: manifest.runId });
            if (error && !metrics.permanentAbsences) breaker = recordBreakerFailure(breaker, { occurredAt: this.clock(), failureType: classifyProviderFailure(error), reason: error.message, runId: manifest.runId }, { transientThreshold: 1 });
            artifact = { schemaVersion: 1, runId: manifest.runId, provider, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion, configuration: providerConfig, configurationHash: adapter.canonicalConfigurationHash(providerConfig), acquiredAt: this.clock(), rawEvidenceRef: page?.rawEvidenceRef || null, occurrences, metrics, circuitBreaker: breaker, error, reviewOnly: true };
            artifact = (await this.writeImmutable(this.artifactPath(manifest.runId, artifactName), artifact)).value;
        }
        let checkpoint = checkpointResult.checkpoint;
        if (!checkpoint.exhausted) {
            checkpointResult = await this.checkpointStore.updateCheckpoint(checkpoint, { provider, adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion, sourceConfiguration, expectedRevision: checkpoint.revision, position: { providerPage: 1, cursor: null, itemOffset: 0 }, exhausted: true, lastCompletedRunId: manifest.runId, latestRawPageEvidenceRef: artifact.rawEvidenceRef, updatedAt: this.clock() });
            checkpoint = checkpointResult.checkpoint;
        }
        if (manifest.providerExecution[provider].runId !== manifest.runId) manifest = await this.recordProvider(manifest, provider, artifact.metrics, artifact.circuitBreaker, artifact.error ? `provider_failure:${artifact.error.statusCode || "network"}` : null);
        const consumption = structuredClone(manifest.budgetConsumption); consumption.providers[provider].requests = artifact.metrics.requestsAttempted; consumption.providers[provider].pages = artifact.error ? 0 : 1; consumption.providers[provider].normalizedOccurrences = artifact.occurrences.length;
        const completed = await this.runStore.completePhase(manifest.runId, { expectedRevision: manifest.revision, configuration: this.configuration, phase, disposition: artifact.error ? "skipped" : "completed", checkpointRefs: [checkpointResult.checkpointRef, this.relative(this.artifactPath(manifest.runId, artifactName))].filter(Boolean), budgetConsumption: consumption });
        return completed.manifest;
    }

    async convergencePhase(manifest, permanentRegistry, liveArtists) {
        let artifact = await this.readArtifact(manifest.runId, "convergence");
        if (!artifact) {
            const before = await this.candidateStore.listCandidates();
            const convergence = new DiscoveryConvergence({ candidateStore: this.candidateStore, discoveryStore: this.discoveryStore, permanentRegistry, liveArtists });
            const sources = await Promise.all([this.readArtifact(manifest.runId, "spotify-discovery"), this.readArtifact(manifest.runId, "ticketmaster-discovery")]);
            const results = [], createdByProvider = { spotify: 0, ticketmaster: 0 };
            for (const source of sources.filter(Boolean)) for (const occurrence of source.occurrences) {
                if (createdByProvider[source.provider] >= this.configuration.budgets.providers[source.provider].maxNewCandidates || createdByProvider.spotify + createdByProvider.ticketmaster >= this.configuration.maximumTotalNewCandidates) break;
                const currentCounts = this.queueProjection(await this.candidateStore.listCandidates()).byState;
                const targetState = source.provider === "spotify" ? "identity_pending" : "identity_discovery_pending";
                const highWaterReason = providerStopReason(source.provider, manifest.budgetConsumption, this.configuration.budgets, currentCounts, { createsCandidate: true, targetState });
                if (highWaterReason?.startsWith("queue_high_water")) { results.push({ provider: source.provider, occurrenceId: occurrence.occurrenceId, action: "held_queue_high_water", stopReason: highWaterReason }); break; }
                const result = await convergence.converge(occurrence);
                const created = ["create_new_candidate", "create_identity_discovery_candidate"].includes(result.action);
                if (created) createdByProvider[source.provider] += 1;
                results.push({ provider: source.provider, occurrenceId: occurrence.occurrenceId, artistName: occurrence.artist.rawName, providerEntityId: occurrence.providerEntity.id, action: result.action, targetType: result.targetType, targetId: result.targetId, lifecycleState: result.candidate?.state || null, occurrenceCreated: result.occurrenceCreated, createdCandidate: created });
            }
            const after = await this.candidateStore.listCandidates();
            artifact = { schemaVersion: 1, runId: manifest.runId, createdAt: this.clock(), queueBefore: this.queueProjection(before), queueAfter: this.queueProjection(after), queueGrowth: after.length - before.length, createdByProvider, results, reviewOnly: true };
            artifact = (await this.writeImmutable(this.artifactPath(manifest.runId, "convergence"), artifact)).value;
        }
        const consumption = structuredClone(manifest.budgetConsumption); for (const provider of ["spotify", "ticketmaster"]) consumption.providers[provider].newCandidates = artifact.createdByProvider[provider];
        return (await this.runStore.completePhase(manifest.runId, { expectedRevision: manifest.revision, configuration: this.configuration, phase: "convergence_complete", checkpointRefs: [this.relative(this.artifactPath(manifest.runId, "convergence"))], budgetConsumption: consumption })).manifest;
    }

    async eligibleSnapshot(runId, state, limit, name) {
        let snapshot = await this.readArtifact(runId, name);
        if (snapshot) return snapshot;
        const candidates = (await this.candidateStore.listCandidates()).filter(item => item.state === state).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.candidateId.localeCompare(b.candidateId)).slice(0, limit);
        snapshot = { schemaVersion: 1, runId, createdAt: this.clock(), lifecycleState: state, limit, candidateIds: candidates.map(item => item.candidateId), candidateRevisions: Object.fromEntries(candidates.map(item => [item.candidateId, item.revision])), reviewOnly: true };
        return (await this.writeImmutable(this.artifactPath(runId, name), snapshot)).value;
    }

    async stage3Phase(manifest) {
        const snapshot = await this.eligibleSnapshot(manifest.runId, "identity_pending", this.configuration.budgets.workers.stage3Candidates, "stage3-eligible-snapshot");
        let artifact = await this.readArtifact(manifest.runId, "stage3");
        if (!artifact) {
            const metrics = { cacheHits: 0, liveRequests: 0, retries: 0, immutableEvidenceReuses: 0, immutableEvidenceWrites: 0, byProvider: {} };
            const evidenceStore = new IdentityEvidenceStore(path.join(this.scheduledRoot, "store"), { allowNetwork: true, metrics, clock: this.clock });
            const worker = new IdentityQueueWorker({ store: this.candidateStore, resolver: new QueueIdentityResolver(evidenceStore, { fetchOptions: { fetchImpl: this.fetchImpl } }), evidenceStore, retryDelayMs: 15 * 60 * 1000, clock: this.clock });
            const results = [];
            for (const candidateId of snapshot.candidateIds) {
                const file = this.artifactPath(manifest.runId, `stage3-result-${candidateId}`); let result = await readJson(file).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
                if (!result) { result = { schemaVersion: 1, runId: manifest.runId, candidateId, completedAt: this.clock(), workerResult: await worker.run({ limit: 1, candidateId }), reviewOnly: true }; result = (await this.writeImmutable(file, result)).value; }
                results.push(result);
            }
            artifact = { schemaVersion: 1, runId: manifest.runId, snapshotRef: this.relative(this.artifactPath(manifest.runId, "stage3-eligible-snapshot")), completedAt: this.clock(), selected: snapshot.candidateIds.length, metrics, results, reviewOnly: true };
            artifact = (await this.writeImmutable(this.artifactPath(manifest.runId, "stage3"), artifact)).value;
        }
        const metrics = artifact.metrics;
        for (const provider of ["wikidata", "musicbrainz", "discogs"]) {
            const providerMetrics = metrics.byProvider[provider] || {};
            const retries = provider === "musicbrainz" ? metrics.retries || 0 : providerMetrics.retries || 0;
            const normalized = { ...emptyProviderMetrics(), requestsAttempted: providerMetrics.liveRequests || 0, successfulRequests: Math.max(0, (providerMetrics.liveRequests || 0) - retries), cacheHits: providerMetrics.cacheHits || 0, retries, retryAfterWaits: retries, errors: 0 };
            const breaker = createCircuitBreaker(provider, { occurredAt: this.clock(), runId: manifest.runId });
            if (normalized.requestsAttempted || normalized.cacheHits) manifest = await this.recordProvider(manifest, provider, normalized, breaker, null);
        }
        const consumption = structuredClone(manifest.budgetConsumption); consumption.workers.stage3Candidates = snapshot.candidateIds.length;
        return (await this.runStore.completePhase(manifest.runId, { expectedRevision: manifest.revision, configuration: this.configuration, phase: "stage3_complete", checkpointRefs: [artifact.snapshotRef, this.relative(this.artifactPath(manifest.runId, "stage3"))], budgetConsumption: consumption })).manifest;
    }

    async identityDiscoveryPhase(manifest, permanentRegistry, liveArtists) {
        const snapshot = await this.eligibleSnapshot(manifest.runId, "identity_discovery_pending", this.configuration.budgets.workers.identityDiscoveryCandidates, "identity-discovery-eligible-snapshot");
        let artifact = await this.readArtifact(manifest.runId, "identity-discovery");
        if (!artifact) {
            const metrics = { cacheHits: 0, cacheMisses: 0, liveRequests: 0, retries: 0, immutableEvidenceWrites: 0, immutableEvidenceReuses: 0, byProvider: {} };
            const evidenceStore = new IdentityDiscoveryEvidenceStore(path.join(this.scheduledRoot, "store"), { allowNetwork: true, metrics, clock: this.clock });
            const resolver = new IdentityDiscoveryResolver({ evidenceStore, discoveryStore: this.discoveryStore, wikidataPropertySemantics: {}, fetchers: { musicbrainz: createBoundedMusicBrainzFetch(metrics, { fetchImpl: this.fetchImpl, maximumRequests: 4, minimumSpacingMs: 1100 }) } });
            const worker = new IdentityDiscoveryWorker({ store: this.candidateStore, resolver, evidenceStore, permanentRegistry, liveArtists, retryDelayMs: 15 * 60 * 1000, clock: this.clock });
            const results = [];
            for (const candidateId of snapshot.candidateIds) {
                const file = this.artifactPath(manifest.runId, `identity-discovery-result-${candidateId}`); let result = await readJson(file).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
                if (!result) { result = { schemaVersion: 1, runId: manifest.runId, candidateId, completedAt: this.clock(), workerResult: await worker.run({ limit: 1, candidateId }), reviewOnly: true }; result = (await this.writeImmutable(file, result)).value; }
                results.push(result);
            }
            artifact = { schemaVersion: 1, runId: manifest.runId, snapshotRef: this.relative(this.artifactPath(manifest.runId, "identity-discovery-eligible-snapshot")), completedAt: this.clock(), selected: snapshot.candidateIds.length, metrics, results, stage3ChainingAllowed: false, reviewOnly: true };
            artifact = (await this.writeImmutable(this.artifactPath(manifest.runId, "identity-discovery"), artifact)).value;
        }
        const metrics = artifact.metrics;
        const providerMetrics = metrics.byProvider.musicbrainz || {};
        if (providerMetrics.liveRequests || providerMetrics.cacheHits) manifest = await this.recordProvider(manifest, "musicbrainz", { ...emptyProviderMetrics(), requestsAttempted: providerMetrics.liveRequests || 0, successfulRequests: providerMetrics.liveRequests || 0, cacheHits: providerMetrics.cacheHits || 0, retries: metrics.retries || 0 }, createCircuitBreaker("musicbrainz", { occurredAt: this.clock(), runId: manifest.runId }));
        const consumption = structuredClone(manifest.budgetConsumption); consumption.workers.identityDiscoveryCandidates = snapshot.candidateIds.length;
        return (await this.runStore.completePhase(manifest.runId, { expectedRevision: manifest.revision, configuration: this.configuration, phase: "identity_discovery_complete", checkpointRefs: [artifact.snapshotRef, this.relative(this.artifactPath(manifest.runId, "identity-discovery"))], budgetConsumption: consumption })).manifest;
    }

    async generateDailySummary(manifest) {
        const start = new Date(manifest.startedAt); start.setUTCHours(0, 0, 0, 0); const end = new Date(start.getTime() + 86400000);
        const sources = await loadImmutableSummarySources(this.scheduledRoot);
        const summary = buildDailySummary({ ...sources, period: { start: start.toISOString(), end: end.toISOString() }, date: start.toISOString().slice(0, 10), generatedAt: end.toISOString() });
        await this.summaryStore.writeDaily(summary);
        return summary;
    }

    async summaryPhase(manifest) {
        const summary = await this.generateDailySummary(manifest);
        const after = await checksumFiles(this.projectRoot, this.protectedPaths);
        return (await this.runStore.completePhase(manifest.runId, { expectedRevision: manifest.revision, configuration: this.configuration, phase: "summary_complete", checkpointRefs: [this.relative(this.summaryStore.dailyPath(summary.date))], protectedChecksums: after, budgetConsumption: manifest.budgetConsumption })).manifest;
    }

    async buildFinalReport(manifest) {
        const [start, spotify, ticketmaster, convergence, stage3, identityDiscovery] = await Promise.all(["run-start", "spotify-discovery", "ticketmaster-discovery", "convergence", "stage3", "identity-discovery"].map(name => this.readArtifact(manifest.runId, name)));
        const candidates = await this.candidateStore.listCandidates(); const summary = await this.summaryStore.readDaily(manifest.startedAt.slice(0, 10));
        const afterChecksums = await checksumFiles(this.projectRoot, this.protectedPaths);
        const reservations = candidates.filter(item => item.musicRollIdReservation.status !== "not_reserved"); const approvals = candidates.filter(item => item.approval.status !== "not_approved");
        const report = { schemaVersion: 1, runId: manifest.runId, reviewOnly: true, phases: manifest.phaseStatuses, providers: summary.providers, checkpoints: summary.checkpoints, budgetConsumption: manifest.budgetConsumption, discovery: { spotify: spotify?.occurrences.length || 0, ticketmaster: ticketmaster?.occurrences.length || 0 }, convergence, stage3, identityDiscovery, queueBefore: start.queue, queueAfter: this.queueProjection(candidates), queueGrowth: candidates.length - start.queue.total, dailySummary: summary, protectedFiles: { before: manifest.protectedChecksums.before, after: afterChecksums, unchanged: JSON.stringify(manifest.protectedChecksums.before) === JSON.stringify(afterChecksums) }, safety: { approvals: approvals.length, reservations: reservations.length, migrationPerformed: false, stage3BarrierPreserved: identityDiscovery?.stage3ChainingAllowed === false } };
        const primary = this.artifactPath(manifest.runId, "final-report");
        const existing = await readJson(primary).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
        if (!existing) await this.writeImmutable(primary, report);
        else if (JSON.stringify(existing) !== JSON.stringify(report)) await this.writeImmutable(this.artifactPath(manifest.runId, `final-report-rebuilt-${summary.artifactDigest.slice(7, 19)}`), report);
        return report;
    }

    async run(options = {}) {
        const current = await this.createOrResume(options.runId || null); let manifest = current.manifest;
        if (manifest.control.status === "completed") { await this.generateDailySummary(manifest); return { manifest, report: await this.buildFinalReport(manifest), resumed: true, phasesExecuted: [] }; }
        const permanentRegistry = await readJson(path.join(this.projectRoot, "data", "artist-id-registry.json")); const liveArtists = await readJson(path.join(this.projectRoot, "data", "artists.json"));
        const phasesExecuted = [];
        while (firstIncompletePhase(manifest)) {
            const phase = firstIncompletePhase(manifest);
            if (phase === "spotify_discovery_complete_or_skipped") manifest = await this.discoveryPhase(manifest, "spotify");
            else if (phase === "ticketmaster_discovery_complete_or_skipped") manifest = await this.discoveryPhase(manifest, "ticketmaster");
            else if (phase === "convergence_complete") manifest = await this.convergencePhase(manifest, permanentRegistry, liveArtists);
            else if (phase === "stage3_complete") manifest = await this.stage3Phase(manifest);
            else if (phase === "identity_discovery_complete") manifest = await this.identityDiscoveryPhase(manifest, permanentRegistry, liveArtists);
            else if (phase === "summary_complete") manifest = await this.summaryPhase(manifest);
            phasesExecuted.push(phase);
        }
        return { manifest, report: await this.buildFinalReport(manifest), resumed: !current.created, phasesExecuted };
    }
}

module.exports = { LiveScheduledCoordinator };
