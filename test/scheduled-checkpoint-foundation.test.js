const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { uuidV7 } = require("../lib/ingestion/candidate-schema");
const {
    DEFAULT_SCHEDULED_BUDGETS,
    emptyBudgetConsumption,
    validateBudgets
} = require("../lib/scheduling/scheduled-budget-policy");
const {
    DAY,
    DEFAULT_FRESHNESS_POLICY,
    HOUR,
    evaluateFreshness,
    freshnessFor,
    validateFreshnessPolicy
} = require("../lib/scheduling/listing-freshness-policy");
const {
    stableSourceConfigurationHash,
    validateCheckpoint
} = require("../lib/scheduling/provider-checkpoint-schema");
const { ProviderCheckpointStore } = require("../lib/scheduling/provider-checkpoint-store");
const { runFixtureProvider } = require("../lib/scheduling/fixture-bounded-provider-run");
const { ScheduledRunStore } = require("../lib/scheduling/scheduled-run-store");

const runFixture = require("./fixtures/scheduled-discovery/run-configuration.json");
const pages = require("./fixtures/scheduled-discovery/provider-pages.json");
const checksums = { "data/artists.json": "a".repeat(64), "data/artist-id-registry.json": "b".repeat(64) };
const spotifySource = {
    mode: "artist_search_results",
    querySet: ["fixture-a", "fixture-b"],
    market: "US",
    discoveredAt: "2026-08-15T12:00:00.000Z",
    runTimestamp: "2026-08-15T12:00:00.000Z"
};
const ticketmasterSource = {
    mode: "event_attractions",
    market: "CA",
    startDateTime: "2026-08-16T00:00:00Z",
    endDateTime: "2026-08-23T00:00:00Z",
    runTimestamp: "2026-08-15T12:00:00.000Z"
};

function idFactory(prefix, initial = 0) {
    let counter = initial;
    return () => `${prefix}${uuidV7(Date.parse("2026-08-15T12:00:00.000Z") + ++counter, Buffer.alloc(10, counter))}`;
}

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-checkpoint-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let tick = 0;
    const clock = () => new Date(Date.parse("2026-08-15T12:00:00.000Z") + tick++).toISOString();
    return {
        root,
        checkpointStore: new ProviderCheckpointStore(root, { clock }),
        runStore: new ScheduledRunStore(root, {
            clock,
            runIdGenerator: idFactory("mr_discovery_run_"),
            eventIdGenerator: idFactory("mr_discovery_run_event_", 100)
        })
    };
}

async function checkpoint(store, overrides = {}) {
    const created = await store.createCheckpoint({
        provider: "spotify",
        adapterId: "spotify_live_bounded_discovery_v1",
        adapterVersion: "v1",
        sourceConfiguration: spotifySource,
        rollingWindowIdentity: null,
        ...overrides
    });
    return { ...created, checkpointStore: store };
}

async function scheduledRun(store) {
    return store.createRun({
        configuration: runFixture.configuration,
        budgets: runFixture.budgets,
        networkAllowed: false,
        protectedChecksums: checksums
    });
}

function processWithSet(seen) {
    return async item => {
        const idempotent = seen.has(item.occurrenceId);
        seen.add(item.occurrenceId);
        return { created: !idempotent && item.createsCandidate, idempotent };
    };
}

function runnerOptions(created, overrides = {}) {
    return {
        provider: "spotify",
        adapterId: "spotify_live_bounded_discovery_v1",
        adapterVersion: "v1",
        sourceConfiguration: spotifySource,
        pages: pages.spotify,
        budgets: structuredClone(DEFAULT_SCHEDULED_BUDGETS),
        runId: "mr_discovery_run_0198ac95-5c00-7001-8101-010101010101",
        checkpointStore: created.checkpointStore,
        checkpoint: created.checkpoint,
        checkpointRef: created.checkpointRef,
        processOccurrence: processWithSet(new Set()),
        networkAllowed: false,
        ...overrides
    };
}

test("fresh checkpoint creation preserves namespace, position, rolling window, and immutable revision", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore, {
        provider: "ticketmaster",
        adapterId: "ticketmaster_live_bounded_discovery_v1",
        sourceConfiguration: ticketmasterSource,
        rollingWindowIdentity: { market: "CA", window: "2026-08-16/2026-08-23" }
    });
    assert.equal(validateCheckpoint(created.checkpoint), true);
    assert.equal(created.checkpoint.revision, 1);
    assert.deepEqual(created.checkpoint.position, { providerPage: 0, cursor: null, itemOffset: 0 });
    assert.deepEqual(created.checkpoint.rollingWindowIdentity, { market: "CA", window: "2026-08-16/2026-08-23" });
    assert.match(created.checkpointRef, /history\/000001\.json$/);
});

test("page advancement preserves cursor and immutable prior checkpoint revision", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const advanced = await checkpointStore.updateCheckpoint(created.checkpoint, {
        provider: "spotify", adapterId: "spotify_live_bounded_discovery_v1", adapterVersion: "v1", sourceConfiguration: spotifySource,
        expectedRevision: 1,
        position: { providerPage: 1, cursor: "cursor-1", itemOffset: 0 },
        latestRawPageEvidenceRef: "fixture:spotify-page-0"
    });
    assert.equal(advanced.checkpoint.revision, 2);
    assert.deepEqual(advanced.checkpoint.position, { providerPage: 1, cursor: "cursor-1", itemOffset: 0 });
    assert.equal(JSON.parse(await fs.readFile(path.join(checkpointStore.root, created.checkpointRef), "utf8")).revision, 1);
});

test("item-offset advancement preserves unprocessed page items", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const advanced = await checkpointStore.updateCheckpoint(created.checkpoint, {
        provider: "spotify", adapterId: "spotify_live_bounded_discovery_v1", adapterVersion: "v1", sourceConfiguration: spotifySource,
        expectedRevision: 1,
        position: { providerPage: 0, cursor: null, itemOffset: 2 },
        latestRawPageEvidenceRef: pages.spotify[0].rawEvidenceRef
    });
    assert.equal(advanced.checkpoint.position.itemOffset, 2);
    assert.equal(pages.spotify[0].items[2].occurrenceId, "spotify-occurrence-003");
});

test("exhausted checkpoint records the completing run ID", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const seen = new Set();
    const result = await runFixtureProvider(runnerOptions(created, { processOccurrence: processWithSet(seen) }));
    assert.equal(result.stopped, false);
    assert.equal(result.checkpoint.exhausted, true);
    assert.equal(result.checkpoint.position.providerPage, 2);
    assert.equal(result.checkpoint.lastCompletedRunId, runnerOptions(created).runId);
    assert.equal(seen.size, 4);
});

test("crash after occurrence persistence resumes mid-page and reprocesses idempotently", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const seen = new Set();
    await assert.rejects(() => runFixtureProvider(runnerOptions(created, {
        processOccurrence: processWithSet(seen),
        crashAfterOccurrenceId: "spotify-occurrence-001"
    })), /Simulated fixture crash/);
    const afterCrash = await checkpointStore.readLatest(created.checkpoint);
    assert.equal(afterCrash.position.itemOffset, 0);
    const resumed = await runFixtureProvider(runnerOptions({ checkpoint: afterCrash, checkpointRef: created.checkpointRef, checkpointStore }, {
        checkpoint: afterCrash,
        processOccurrence: processWithSet(seen)
    }));
    assert.equal(resumed.stopped, false);
    assert.equal(resumed.processed[0].occurrenceId, "spotify-occurrence-001");
    assert.equal(resumed.processed[0].idempotent, true);
    assert.equal(seen.size, 4);
});

test("request budget stop records exact reason, checkpoint ref, consumption, and run journal", async t => {
    const { checkpointStore, runStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const manifest = await scheduledRun(runStore);
    const budgets = structuredClone(DEFAULT_SCHEDULED_BUDGETS);
    budgets.providers.spotify.maxRequests = 0;
    const result = await runFixtureProvider(runnerOptions(created, {
        budgets,
        runId: manifest.runId,
        runStore,
        runManifest: manifest,
        runConfiguration: runFixture.configuration
    }));
    assert.equal(result.stopReason, "request_budget_reached");
    assert.deepEqual(result.checkpoint.position, { providerPage: 0, cursor: null, itemOffset: 0 });
    assert.equal(result.runManifest.control.stopReason, "request_budget_reached");
    assert.deepEqual(result.runManifest.checkpointRefs, [created.checkpointRef]);
    assert.deepEqual(result.runManifest.budgetConsumption, emptyBudgetConsumption());
});

test("page budget stop resumes at the next unprocessed page", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const budgets = structuredClone(DEFAULT_SCHEDULED_BUDGETS);
    budgets.providers.spotify.maxPages = 1;
    const first = await runFixtureProvider(runnerOptions(created, { budgets }));
    assert.equal(first.stopReason, "page_budget_reached");
    assert.deepEqual(first.checkpoint.position, { providerPage: 1, cursor: "spotify-cursor-1", itemOffset: 0 });
    const resumed = await runFixtureProvider(runnerOptions({ checkpoint: first.checkpoint, checkpointRef: first.checkpointRef, checkpointStore }, {
        checkpoint: first.checkpoint,
        checkpointRef: first.checkpointRef,
        budgets,
        processOccurrence: processWithSet(new Set(first.processed.map(item => item.occurrenceId)))
    }));
    assert.equal(resumed.stopped, false);
    assert.equal(resumed.processed[0].occurrenceId, "spotify-occurrence-004");
});

test("occurrence budget stop preserves the exact next item offset", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const budgets = structuredClone(DEFAULT_SCHEDULED_BUDGETS);
    budgets.providers.spotify.maxNormalizedOccurrences = 1;
    const result = await runFixtureProvider(runnerOptions(created, { budgets }));
    assert.equal(result.stopReason, "occurrence_budget_reached");
    assert.equal(result.checkpoint.position.itemOffset, 1);
    assert.equal(pages.spotify[0].items[result.checkpoint.position.itemOffset].occurrenceId, "spotify-occurrence-002");
});

test("new-candidate budget stop preserves the first unprocessed candidate occurrence", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const budgets = structuredClone(DEFAULT_SCHEDULED_BUDGETS);
    budgets.providers.spotify.maxNewCandidates = 1;
    const result = await runFixtureProvider(runnerOptions(created, { budgets }));
    assert.equal(result.stopReason, "new_candidate_budget_reached");
    assert.equal(result.checkpoint.position.itemOffset, 2);
    assert.equal(pages.spotify[0].items[2].occurrenceId, "spotify-occurrence-003");
});

test("queue high-water stop occurs before candidate creation", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const result = await runFixtureProvider(runnerOptions(created, { queueCounts: { identity_pending: 50 } }));
    assert.equal(result.stopReason, "queue_high_water_reached:identity_pending");
    assert.equal(result.checkpoint.position.itemOffset, 0);
    assert.equal(result.consumption.providers.spotify.newCandidates, 0);
});

test("listing cache freshness is independent and fresh inside provider TTL", () => {
    assert.equal(validateFreshnessPolicy(DEFAULT_FRESHNESS_POLICY), true);
    const spotify = evaluateFreshness({ kind: "spotify_discovery_listing", retrievedAt: "2026-08-10T12:00:00Z", now: "2026-08-15T11:59:00Z" });
    const ticketmaster = evaluateFreshness({ kind: "ticketmaster_event_listing", retrievedAt: "2026-08-15T00:00:00Z", now: "2026-08-15T11:59:00Z" });
    assert.equal(spotify.fresh, true);
    assert.equal(ticketmaster.fresh, true);
    assert.equal(freshnessFor("temporary_failure").cacheable, false);
    assert.ok(freshnessFor("successful_exact_identity").ttlMs > freshnessFor("semantic_absence").ttlMs);
});

test("listing cache becomes stale after its TTL while checkpoint position is unaffected", () => {
    const spotify = evaluateFreshness({ kind: "spotify_discovery_listing", retrievedAt: "2026-08-09T00:00:00Z", now: "2026-08-15T00:00:01Z" });
    const ticketmaster = evaluateFreshness({ kind: "ticketmaster_event_listing", retrievedAt: "2026-08-14T00:00:00Z", now: "2026-08-15T00:00:01Z" });
    assert.equal(spotify.stale, true);
    assert.equal(ticketmaster.stale, true);
    assert.equal(DEFAULT_FRESHNESS_POLICY.spotifyDiscoveryListingMs >= 3 * DAY, true);
    assert.equal(DEFAULT_FRESHNESS_POLICY.ticketmasterEventListingMs >= 6 * HOUR, true);
});

test("meaningful provider configuration drift rejects resume unless a new namespace is explicitly created", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const changed = { ...spotifySource, querySet: ["different-query"] };
    await assert.rejects(() => checkpointStore.resumeCheckpoint(created.checkpoint, {
        provider: "spotify", adapterId: "spotify_live_bounded_discovery_v1", adapterVersion: "v1", sourceConfiguration: changed
    }), /configuration drift/);
    const separate = await checkpoint(checkpointStore, { sourceConfiguration: changed });
    assert.notEqual(separate.checkpoint.checkpointId, created.checkpoint.checkpointId);

    const ticketmaster = await checkpoint(checkpointStore, {
        provider: "ticketmaster",
        adapterId: "ticketmaster_live_bounded_discovery_v1",
        sourceConfiguration: ticketmasterSource,
        rollingWindowIdentity: { market: "CA", window: "2026-08-16/2026-08-23" }
    });
    await assert.rejects(() => checkpointStore.resumeCheckpoint(ticketmaster.checkpoint, {
        provider: "ticketmaster",
        adapterId: "ticketmaster_live_bounded_discovery_v1",
        adapterVersion: "v1",
        sourceConfiguration: { ...ticketmasterSource, market: "NY" }
    }), /configuration drift/);
    await assert.rejects(() => checkpointStore.resumeCheckpoint(ticketmaster.checkpoint, {
        provider: "ticketmaster",
        adapterId: "ticketmaster_live_bounded_discovery_v1",
        adapterVersion: "v1",
        sourceConfiguration: { ...ticketmasterSource, endDateTime: "2026-08-24T00:00:00Z" }
    }), /configuration drift/);
});

test("run timestamp-only source changes retain the stable checkpoint namespace", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const later = { ...spotifySource, discoveredAt: "2026-08-20T12:00:00Z", runTimestamp: "2026-08-20T12:00:00Z" };
    assert.equal(stableSourceConfigurationHash(spotifySource), stableSourceConfigurationHash(later));
    const resumed = await checkpointStore.resumeCheckpoint(created.checkpoint, {
        provider: "spotify", adapterId: "spotify_live_bounded_discovery_v1", adapterVersion: "v1", sourceConfiguration: later
    });
    assert.equal(resumed.checkpointId, created.checkpoint.checkpointId);
});

test("stale checkpoint revision is rejected without a history write", async t => {
    const { checkpointStore } = await setup(t);
    const created = await checkpoint(checkpointStore);
    const advanced = await checkpointStore.updateCheckpoint(created.checkpoint, {
        provider: "spotify", adapterId: "spotify_live_bounded_discovery_v1", adapterVersion: "v1", sourceConfiguration: spotifySource,
        expectedRevision: 1,
        position: { providerPage: 0, cursor: null, itemOffset: 1 }
    });
    await assert.rejects(() => checkpointStore.updateCheckpoint(created.checkpoint, {
        provider: "spotify", adapterId: "spotify_live_bounded_discovery_v1", adapterVersion: "v1", sourceConfiguration: spotifySource,
        expectedRevision: 1,
        position: { providerPage: 0, cursor: null, itemOffset: 2 }
    }), /Stale provider checkpoint revision/);
    const history = await fs.readdir(path.dirname(path.join(checkpointStore.root, advanced.checkpointRef)));
    assert.deepEqual(history.sort(), ["000001.json", "000002.json"]);
});

test("approved provider, worker, and queue defaults validate exactly", () => {
    assert.equal(validateBudgets(DEFAULT_SCHEDULED_BUDGETS), true);
    assert.deepEqual(DEFAULT_SCHEDULED_BUDGETS.providers.spotify, { maxRequests: 6, maxPages: 2, maxNormalizedOccurrences: 15, maxNewCandidates: 8 });
    assert.deepEqual(DEFAULT_SCHEDULED_BUDGETS.providers.ticketmaster, { maxRequests: 6, maxPages: 2, maxNormalizedOccurrences: 15, maxNewCandidates: 7 });
    assert.deepEqual(DEFAULT_SCHEDULED_BUDGETS.workers, { stage3Candidates: 5, identityDiscoveryCandidates: 3 });
    assert.deepEqual(DEFAULT_SCHEDULED_BUDGETS.queueHighWaterMarks, { identity_pending: 50, identity_discovery_pending: 25, retry_wait: 25, needs_review: 100 });
});
