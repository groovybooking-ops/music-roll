const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { uuidV7 } = require("../lib/ingestion/candidate-schema");
const {
    PHASES,
    stableConfigurationHash,
    validateEvent,
    validateManifest
} = require("../lib/scheduling/scheduled-run-schema");
const { firstIncompletePhase } = require("../lib/scheduling/scheduled-run-journal");
const { ScheduledRunStore, checksumFiles } = require("../lib/scheduling/scheduled-run-store");

const projectRoot = path.join(__dirname, "..");
const fixture = require("./fixtures/scheduled-discovery/run-configuration.json");
const protectedChecksums = {
    "data/artists.json": "a".repeat(64),
    "data/artist-id-registry.json": "b".repeat(64)
};

function idFactory(prefix, initial = 0) {
    let counter = initial;
    return () => {
        counter += 1;
        return `${prefix}${uuidV7(Date.parse("2026-08-15T12:00:00.000Z") + counter, Buffer.alloc(10, counter))}`;
    };
}

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-scheduled-run-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let clockTick = 0;
    const options = {
        clock: () => new Date(Date.parse("2026-08-15T12:00:00.000Z") + clockTick++).toISOString(),
        runIdGenerator: idFactory("mr_discovery_run_"),
        eventIdGenerator: idFactory("mr_discovery_run_event_", 50)
    };
    return { root, options, store: new ScheduledRunStore(root, options) };
}

async function create(store, overrides = {}) {
    return store.createRun({
        configuration: structuredClone(fixture.configuration),
        budgets: structuredClone(fixture.budgets),
        networkAllowed: false,
        protectedChecksums,
        actor: { type: "command", id: "fixture_scheduler" },
        ...overrides
    });
}

async function advance(store, manifest, phase, overrides = {}) {
    return store.completePhase(manifest.runId, {
        expectedRevision: manifest.revision,
        configuration: structuredClone(fixture.configuration),
        phase,
        checkpointRefs: [],
        actor: { type: "system", id: "fixture_coordinator" },
        ...overrides
    });
}

test("fresh scheduled run creates a validated offline manifest and immutable created event", async t => {
    const { store } = await setup(t);
    const manifest = await create(store);
    assert.equal(validateManifest(manifest), true);
    assert.equal(manifest.networkAllowed, false);
    assert.equal(manifest.revision, 1);
    assert.equal(manifest.createdAt, manifest.startedAt);
    assert.equal(manifest.completedAt, null);
    assert.equal(manifest.lastCompletedPhase, "created");
    assert.equal(manifest.providerPhaseStatuses.spotify, "pending");
    assert.equal(manifest.workerPhaseStatuses.stage3, "pending");
    assert.equal(firstIncompletePhase(manifest), "spotify_discovery_complete_or_skipped");
    const events = await store.readEvents(manifest.runId);
    assert.equal(events.length, 1);
    assert.equal(validateEvent(events[0]), true);
    assert.equal(store.ingestionStoreRoot, path.join(store.root, "store"));
});

test("phase advancement is ordered, append-only, and records provider, worker, and checkpoint status", async t => {
    const { store } = await setup(t);
    let manifest = await create(store);
    let result = await advance(store, manifest, "spotify_discovery_complete_or_skipped", {
        disposition: "completed",
        checkpointRefs: ["checkpoints/spotify/run-1.json"]
    });
    manifest = result.manifest;
    assert.equal(manifest.providerPhaseStatuses.spotify, "completed");
    assert.deepEqual(manifest.checkpointRefs, ["checkpoints/spotify/run-1.json"]);
    result = await advance(store, manifest, "ticketmaster_discovery_complete_or_skipped", { disposition: "skipped" });
    assert.equal(result.manifest.providerPhaseStatuses.ticketmaster, "skipped");
    assert.equal(result.nextPhase, "convergence_complete");
    assert.equal((await store.readEvents(manifest.runId)).length, 3);
});

test("illegal phase skipping fails without appending an event", async t => {
    const { store } = await setup(t);
    const manifest = await create(store);
    await assert.rejects(() => advance(store, manifest, "ticketmaster_discovery_complete_or_skipped"), /Illegal scheduled-run phase transition/);
    assert.equal((await store.readEvents(manifest.runId)).length, 1);
});

test("duplicate phase completion is idempotent and conflicting duplicate evidence is rejected", async t => {
    const { store } = await setup(t);
    const created = await create(store);
    const first = await advance(store, created, "spotify_discovery_complete_or_skipped", { checkpointRefs: ["checkpoint:a"] });
    const duplicate = await advance(store, first.manifest, "spotify_discovery_complete_or_skipped", { checkpointRefs: ["checkpoint:a"] });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.completed, false);
    assert.equal((await store.readEvents(created.runId)).length, 2);
    await assert.rejects(() => advance(store, first.manifest, "spotify_discovery_complete_or_skipped", { checkpointRefs: ["checkpoint:b"] }), /different evidence/);
});

test("crash recovery rebuilds a missing manifest and resumes at the first incomplete phase", async t => {
    const { root, options, store } = await setup(t);
    const created = await create(store);
    const spotify = await advance(store, created, "spotify_discovery_complete_or_skipped");
    await fs.unlink(store.manifestPath(created.runId));
    const restarted = new ScheduledRunStore(root, options);
    const recovery = await restarted.resumeRun(created.runId, { configuration: structuredClone(fixture.configuration) });
    assert.equal(recovery.nextPhase, "ticketmaster_discovery_complete_or_skipped");
    assert.deepEqual(recovery.completedPhases, ["created", "spotify_discovery_complete_or_skipped"]);
    assert.equal(recovery.manifest.revision, spotify.manifest.revision);
    assert.equal(await restarted.verifyManifest(created.runId), true);
});

test("stale scheduled-run revisions are rejected without creating events", async t => {
    const { store } = await setup(t);
    const created = await create(store);
    const first = await advance(store, created, "spotify_discovery_complete_or_skipped");
    await assert.rejects(() => store.completePhase(created.runId, {
        expectedRevision: created.revision,
        configuration: fixture.configuration,
        phase: "ticketmaster_discovery_complete_or_skipped"
    }), /Stale scheduled-run revision/);
    assert.equal((await store.readEvents(created.runId)).length, first.manifest.revision);
});

test("protected live-data checksums are recorded and drift blocks run completion", async t => {
    const { store } = await setup(t);
    const actual = await checksumFiles(projectRoot);
    const created = await create(store, { protectedChecksums: actual });
    assert.deepEqual(created.protectedChecksums.before, actual);
    let manifest = created;
    for (const phase of PHASES.slice(1, -1)) manifest = (await advance(store, manifest, phase)).manifest;
    await assert.rejects(() => advance(store, manifest, "summary_complete", {
        protectedChecksums: { ...actual, "data/artists.json": "f".repeat(64) }
    }), /checksums changed/);
    const complete = await advance(store, manifest, "summary_complete", { protectedChecksums: actual });
    assert.equal(complete.manifest.control.status, "completed");
    assert.deepEqual(complete.manifest.protectedChecksums.after, actual);
    assert.ok(complete.manifest.completedAt);
});

test("stable configuration hashing ignores object key order and rejects semantic drift", async t => {
    const { store } = await setup(t);
    const reversed = {
        workers: structuredClone(fixture.configuration.workers),
        providers: structuredClone(fixture.configuration.providers),
        coordinatorVersion: fixture.configuration.coordinatorVersion,
        schemaVersion: 1
    };
    assert.equal(stableConfigurationHash(fixture.configuration), stableConfigurationHash(reversed));
    const manifest = await create(store);
    await assert.rejects(() => store.resumeRun(manifest.runId, {
        configuration: { ...fixture.configuration, coordinatorVersion: "scheduled_discovery_coordinator_v2" }
    }), /configuration drift/);
});

test("pause and resume preserve reasons without completing or replaying a phase", async t => {
    const { store } = await setup(t);
    const created = await create(store);
    const paused = await store.controlRun(created.runId, {
        expectedRevision: created.revision,
        configuration: fixture.configuration,
        action: "pause",
        reason: "fixture_manual_pause"
    });
    assert.equal(paused.control.status, "paused");
    assert.equal(paused.control.pauseReason, "fixture_manual_pause");
    assert.equal(firstIncompletePhase(paused), "spotify_discovery_complete_or_skipped");
    await assert.rejects(() => advance(store, paused, "spotify_discovery_complete_or_skipped"), /phase advancement is disabled/);
    const resumed = await store.controlRun(created.runId, {
        expectedRevision: paused.revision,
        configuration: fixture.configuration,
        action: "resume",
        reason: "fixture_manual_resume"
    });
    assert.equal(resumed.control.status, "running");
    assert.equal(firstIncompletePhase(resumed), "spotify_discovery_complete_or_skipped");
    const stopped = await store.controlRun(created.runId, {
        expectedRevision: resumed.revision,
        configuration: fixture.configuration,
        action: "stop",
        reason: "fixture_operator_stop"
    });
    assert.equal(stopped.control.status, "stopped");
    assert.equal(stopped.control.stopReason, "fixture_operator_stop");
});

test("event replay exactly reproduces the scheduled-run manifest", async t => {
    const { store } = await setup(t);
    const created = await create(store);
    const advanced = await advance(store, created, "spotify_discovery_complete_or_skipped");
    assert.deepEqual(await store.replay(created.runId), advanced.manifest);
    assert.equal(await store.verifyManifest(created.runId), true);
});
