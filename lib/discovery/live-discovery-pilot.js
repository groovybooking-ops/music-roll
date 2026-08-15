const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { CandidateStore } = require("../ingestion/candidate-store");
const { DiscoveryConvergence } = require("./discovery-convergence");
const { DiscoveryStore } = require("./discovery-store");
const { createFixtureCheckpoint } = require("./fixture-checkpoint");

const PILOT_LIMITS = Object.freeze({
    totalProviderRequests: 8,
    spotifyRequests: 4,
    ticketmasterRequests: 4,
    normalizedOccurrences: 20,
    newCandidates: 10,
    unresolvedQueueGrowth: 10
});

function normalizePilotLimits(input = PILOT_LIMITS) {
    const limits = {
        totalProviderRequests: input.totalProviderRequests,
        spotifyRequests: input.spotifyRequests,
        ticketmasterRequests: input.ticketmasterRequests,
        normalizedOccurrences: input.normalizedOccurrences,
        newCandidates: input.newCandidates,
        unresolvedQueueGrowth: input.unresolvedQueueGrowth
    };
    for (const [name, value] of Object.entries(limits)) {
        assert(Number.isInteger(value) && value > 0, `Pilot limit ${name} must be a positive integer.`);
    }
    assert(limits.spotifyRequests <= limits.totalProviderRequests, "Spotify request cap cannot exceed the total request cap.");
    assert(limits.ticketmasterRequests <= limits.totalProviderRequests, "Ticketmaster request cap cannot exceed the total request cap.");
    assert(limits.unresolvedQueueGrowth <= limits.newCandidates, "Unresolved queue growth cap cannot exceed the candidate cap.");
    return Object.freeze(limits);
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function sha256(file) {
    return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function writeJsonExclusive(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function writeJsonAtomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    try { await fs.rename(temporary, file); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

class PilotCandidateStore extends CandidateStore {
    constructor(root, options = {}) {
        super(root, options);
        this.maximumCandidates = options.maximumCandidates ?? PILOT_LIMITS.newCandidates;
    }

    async createCandidateLocked(discovery, options = {}) {
        const count = (await this.listCandidateIds()).length;
        if (count >= this.maximumCandidates) throw new Error(`Pilot candidate cap of ${this.maximumCandidates} reached before candidate creation.`);
        return super.createCandidateLocked(discovery, options);
    }
}

async function runAdapter(adapter, configuration, context) {
    const configurationHash = adapter.canonicalConfigurationHash(configuration);
    const initial = createFixtureCheckpoint(configurationHash);
    try {
        const page = await adapter.acquirePage({ configuration, checkpoint: initial, networkAllowed: context.allowNetwork });
        const occurrences = adapter.normalizePage(page, { configuration });
        const checkpoint = adapter.nextCheckpoint({ configuration, checkpoint: initial, page, consumedItems: occurrences.length });
        return {
            provider: adapter.provider,
            adapterId: adapter.adapterId,
            configurationHash,
            pageCount: 1,
            cacheHit: page.cacheHit,
            liveRequests: page.liveRequests,
            checkpoint,
            occurrences,
            error: null
        };
    } catch (error) {
        return {
            provider: adapter.provider,
            adapterId: adapter.adapterId,
            configurationHash,
            pageCount: 0,
            cacheHit: false,
            liveRequests: 0,
            checkpoint: initial,
            occurrences: [],
            error: { message: error.message, statusCode: error.statusCode || null }
        };
    }
}

function actionMetrics(results) {
    const count = action => results.filter(item => item.action === action).length;
    return {
        idempotentOccurrences: count("idempotent_existing_occurrence"),
        candidateAttachments: count("attach_existing_candidate"),
        existingLiveAssociations: count("associate_existing_live_artist"),
        newSpotifyCandidates: count("create_new_candidate"),
        newTicketmasterOnlyCandidates: results.filter(item => item.action === "create_identity_discovery_candidate" && item.provider === "ticketmaster").length,
        convergenceReviewCandidates: count("route_ambiguous_exact_convergence_to_review")
    };
}

async function runLiveDiscoveryPilot(options) {
    assert(options?.allowNetwork === true, "Refusing live discovery: pass --allow-network only after explicit approval.");
    const root = path.resolve(options.projectRoot);
    const pilotRoot = path.resolve(options.pilotRoot);
    const limits = normalizePilotLimits(options.limits);
    const storeRoot = path.join(pilotRoot, "store");
    const protectedPaths = ["data/artists.json", "data/artist-id-registry.json"];
    const beforeChecksums = Object.fromEntries(await Promise.all(protectedPaths.map(async relative => [relative, await sha256(path.join(root, relative))])));
    const candidateStore = new PilotCandidateStore(storeRoot, { maximumCandidates: limits.newCandidates });
    const discoveryStore = new DiscoveryStore(storeRoot);
    const convergence = new DiscoveryConvergence({
        candidateStore,
        discoveryStore,
        permanentRegistry: options.permanentRegistry,
        liveArtists: options.liveArtists
    });
    const candidatesBefore = await candidateStore.listCandidates();
    const occurrencesBefore = await discoveryStore.listOccurrences();
    const associationsBefore = await discoveryStore.listAssociations();
    const adapterRuns = [];
    for (const item of options.adapters) adapterRuns.push(await runAdapter(item.adapter, item.configuration, { allowNetwork: options.allowNetwork }));
    const occurrences = adapterRuns.flatMap(run => run.occurrences.map(occurrence => ({ provider: run.provider, occurrence })));
    assert(occurrences.length <= limits.normalizedOccurrences, `Pilot normalized occurrence cap exceeded: ${occurrences.length}.`);

    const results = [];
    for (const { provider, occurrence } of occurrences) {
        const result = await convergence.converge(occurrence);
        results.push({
            provider,
            occurrenceId: occurrence.occurrenceId,
            artistName: occurrence.artist.rawName,
            providerEntityId: occurrence.providerEntity.id,
            action: result.action,
            targetType: result.targetType,
            targetId: result.targetId,
            lifecycleState: result.candidate?.state || null,
            occurrenceCreated: result.occurrenceCreated
        });
    }
    const candidatesAfter = await candidateStore.listCandidates();
    const occurrencesAfter = await discoveryStore.listOccurrences();
    const associationsAfter = await discoveryStore.listAssociations();
    const newCandidateCount = candidatesAfter.length - candidatesBefore.length;
    assert(newCandidateCount <= limits.newCandidates, "Pilot created too many candidates.");
    assert(newCandidateCount <= limits.unresolvedQueueGrowth, "Pilot unresolved queue growth cap was exceeded.");
    assert(options.ledger.requests.total <= limits.totalProviderRequests, "Pilot total provider request cap was exceeded.");
    assert(options.ledger.requests.spotify <= limits.spotifyRequests, "Pilot Spotify request cap was exceeded.");
    assert(options.ledger.requests.ticketmaster <= limits.ticketmasterRequests, "Pilot Ticketmaster request cap was exceeded.");
    await Promise.all(candidatesAfter.map(candidate => candidateStore.verifySnapshot(candidate.candidateId)));

    const providerSets = new Map(candidatesAfter.map(candidate => [candidate.candidateId, new Set((candidate.discoveryAssociations || []).map(item => item.provider))]));
    const crossSourceCandidates = [...providerSets].filter(([, providers]) => providers.size > 1).map(([candidateId, providers]) => ({ candidateId, providers: [...providers].sort() }));
    const warnings = candidatesAfter.flatMap(candidate => candidate.warnings.map(warning => ({ candidateId: candidate.candidateId, ...warning })));
    const metrics = actionMetrics(results);
    const afterChecksums = Object.fromEntries(await Promise.all(protectedPaths.map(async relative => [relative, await sha256(path.join(root, relative))])));
    const protectedFilesUnchanged = protectedPaths.every(relative => beforeChecksums[relative] === afterChecksums[relative]);
    assert(protectedFilesUnchanged, "Protected live data changed during discovery pilot.");
    const completedAt = new Date().toISOString();
    const report = {
        schemaVersion: 1,
        pilotId: options.pilotId,
        reviewOnly: true,
        completedAt,
        limits,
        providerMetrics: {
            requests: options.ledger.requests,
            cacheHits: Object.fromEntries(adapterRuns.map(run => [run.provider, run.cacheHit ? 1 : 0])),
            pages: Object.fromEntries(adapterRuns.map(run => [run.provider, run.pageCount])),
            retries: options.ledger.retries,
            errors: [...options.ledger.errors, ...adapterRuns.filter(run => run.error).map(run => ({ provider: run.provider, ...run.error }))]
        },
        occurrenceMetrics: {
            totalNormalized: occurrences.length,
            spotify: occurrences.filter(item => item.provider === "spotify").length,
            ticketmaster: occurrences.filter(item => item.provider === "ticketmaster").length,
            before: occurrencesBefore.length,
            after: occurrencesAfter.length,
            created: occurrencesAfter.length - occurrencesBefore.length
        },
        queueImpact: {
            before: candidatesBefore.length,
            after: candidatesAfter.length,
            growth: newCandidateCount,
            countsByState: Object.fromEntries([...new Set(candidatesAfter.map(item => item.state))].sort().map(state => [state, candidatesAfter.filter(item => item.state === state).length])),
            ...metrics,
            crossSourceConvergences: crossSourceCandidates,
            duplicateCandidatesPrevented: metrics.idempotentOccurrences + metrics.candidateAttachments + metrics.existingLiveAssociations,
            nameCollisionWarnings: warnings.filter(item => item.code === "normalized_name_collision_warning")
        },
        associations: { before: associationsBefore.length, after: associationsAfter.length, created: associationsAfter.length - associationsBefore.length },
        checkpoints: Object.fromEntries(adapterRuns.map(run => [run.provider, run.checkpoint])),
        occurrenceResults: results,
        providerErrors: adapterRuns.filter(run => run.error).map(run => ({ provider: run.provider, ...run.error })),
        replayVerification: { checked: candidatesAfter.length, exact: candidatesAfter.length },
        protectedFiles: { before: beforeChecksums, after: afterChecksums, unchanged: protectedFilesUnchanged },
        safety: {
            identityWorkerRun: false,
            candidatesApproved: false,
            candidatesMigrated: false,
            liveDirectoryModified: false,
            permanentRegistryModified: false
        }
    };
    const checkpointFile = path.join(pilotRoot, "checkpoints", "latest.json");
    await writeJsonAtomic(checkpointFile, { schemaVersion: 1, updatedAt: completedAt, checkpoints: report.checkpoints });
    const reportFile = path.join(pilotRoot, "reports", `run-${completedAt.replace(/[:.]/g, "-")}.json`);
    await writeJsonExclusive(reportFile, report);
    return { report, reportFile, storeRoot };
}

module.exports = { PILOT_LIMITS, PilotCandidateStore, normalizePilotLimits, runLiveDiscoveryPilot };
