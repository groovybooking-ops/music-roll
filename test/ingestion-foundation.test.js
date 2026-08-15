const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
    CANDIDATE_ID_PATTERN,
    EVENT_ID_PATTERN,
    createCandidateId,
    createEventId,
    normalizeDiscovery,
    validateCandidate,
    validateCandidateEvent
} = require("../lib/ingestion/candidate-schema");
const { LEGAL_TRANSITIONS, buildCandidateEvent, legalTransition } = require("../lib/ingestion/candidate-state-machine");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { intakeDiscoveries, loadDiscoveryFile, parseCsvDiscoveries, parseJsonDiscoveries } = require("../lib/ingestion/discovery-intake");

const root = path.join(__dirname, "..");
const fixtureRoot = path.join(__dirname, "fixtures", "ingestion");
const permanentRegistry = require("../data/artist-id-registry.json");
const liveArtists = require("../data/artists.json");

function deterministicIdFactory(prefix, initial = 0) {
    let counter = initial;
    return () => {
        counter += 1;
        const options = { now: Date.parse("2026-08-14T12:00:00.000Z") + counter, randomBytes: Buffer.alloc(10, counter) };
        return prefix === "candidate" ? createCandidateId(options) : createEventId(options);
    };
}

async function temporaryStore(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-ingestion-test-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return new CandidateStore(directory, {
        clock: () => "2026-08-14T13:00:00.000Z",
        candidateIdGenerator: deterministicIdFactory("candidate"),
        eventIdGenerator: deterministicIdFactory("event", 100)
    });
}

function record(overrides = {}) {
    return {
        sourceType: "manual_curated_list",
        sourceName: "test intake",
        sourceRecordId: "row-001",
        sourceUrl: "https://example.test/intake/row-001",
        rawArtistName: "Queue Test Artist",
        spotifyArtistId: "2CLclpIC43fLzsYq6LQvlL",
        discoveredAt: "2026-08-14T12:00:00.000Z",
        ...overrides
    };
}

async function intake(store, records) {
    return intakeDiscoveries({
        store,
        records,
        permanentRegistry,
        liveArtists,
        actor: { type: "command", id: "fixture_intake" },
        evidenceRefs: ["test/fixtures/ingestion"]
    });
}

test("creates durable UUIDv7 candidate and event identifiers", () => {
    const candidateId = createCandidateId({ now: 1723636800000, randomBytes: Buffer.alloc(10, 1) });
    const eventId = createEventId({ now: 1723636800000, randomBytes: Buffer.alloc(10, 2) });
    assert.match(candidateId, CANDIDATE_ID_PATTERN);
    assert.match(eventId, EVENT_ID_PATTERN);
    assert.equal(candidateId.split("_").at(-1).split("-")[2][0], "7");
});

test("intakes a new JSON discovery into identity_pending with immutable events", async t => {
    const store = await temporaryStore(t);
    const loaded = await loadDiscoveryFile(path.join(fixtureRoot, "manual-new.json"));
    const result = await intake(store, loaded.records);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].created, true);
    assert.equal(result.results[0].state, "identity_pending");
    const candidate = await store.readCandidate(result.results[0].candidateId);
    assert.match(candidate.candidateId, CANDIDATE_ID_PATTERN);
    assert.equal(candidate.revision, 2);
    assert.equal(candidate.name.raw, "  Fixture New Artist  ");
    assert.equal(candidate.name.normalized, "fixture new artist");
    assert.equal(candidate.discoveries[0].sourceRecordId, "fixture-json-001");
    const events = await store.readEvents(candidate.candidateId);
    assert.equal(events.length, 2);
    events.forEach(validateCandidateEvent);
    assert.deepEqual(events.map(event => [event.previousState, event.nextState]), [[null, "discovered"], ["discovered", "identity_pending"]]);
});

test("re-importing the exact discovery is idempotent", async t => {
    const store = await temporaryStore(t);
    const records = parseJsonDiscoveries(await fs.readFile(path.join(fixtureRoot, "manual-new.json"), "utf8"));
    const first = await intake(store, records);
    const second = await intake(store, records);
    assert.equal(first.results[0].candidateId, second.results[0].candidateId);
    assert.equal(second.results[0].created, false);
    assert.equal(second.results[0].idempotent, true);
    assert.equal((await store.listCandidates()).length, 1);
    assert.equal((await store.readEvents(first.results[0].candidateId)).length, 2);
});

test("CSV intake preserves discovery fields and quoted artist names", async t => {
    const store = await temporaryStore(t);
    const loaded = await loadDiscoveryFile(path.join(fixtureRoot, "manual-intake.csv"));
    assert.equal(loaded.format, "csv");
    assert.equal(loaded.records[0].rawArtistName, "Fixture, CSV Artist");
    const result = await intake(store, [loaded.records[0]]);
    const candidate = await store.readCandidate(result.results[0].candidateId);
    assert.equal(candidate.discoveries[0].sourceType, "manual_curated_list");
    assert.equal(candidate.discoveries[0].sourceName, "fixture CSV intake");
    assert.equal(candidate.discoveries[0].spotifyArtistUrl, "https://open.spotify.com/artist/5qRbfEf4Ooo19aRXKQzvUV");
});

test("an exact live Spotify binding becomes a duplicate and reuses its Music Roll ID", async t => {
    const store = await temporaryStore(t);
    const result = await intake(store, [record({
        sourceRecordId: "live-sza",
        rawArtistName: "SZA",
        spotifyArtistId: "7tYKF4w9nC0nq9CsPZTHyP"
    })]);
    const candidate = await store.readCandidate(result.results[0].candidateId);
    assert.equal(candidate.state, "duplicate");
    assert.equal(candidate.duplicate.status, "existing_live_artist");
    assert.equal(candidate.duplicate.existingMusicRollId, "mr_artist_000002");
    assert.deepEqual(candidate.duplicate.matchedBy, ["exact_spotify_id"]);
    assert.equal(candidate.musicRollIdReservation.proposedMusicRollId, null);
});

test("an exact existing Music Roll binding is reused without requiring a supplied Spotify ID", async t => {
    const store = await temporaryStore(t);
    const result = await intake(store, [record({
        sourceRecordId: "live-by-music-roll-id",
        rawArtistName: "SZA",
        spotifyArtistId: "",
        assertedMusicRollId: "mr_artist_000002"
    })]);
    const candidate = await store.readCandidate(result.results[0].candidateId);
    assert.equal(candidate.state, "duplicate");
    assert.equal(candidate.duplicate.existingMusicRollId, "mr_artist_000002");
    assert.deepEqual(candidate.duplicate.matchedBy, ["exact_music_roll_id"]);
});

test("an exact Spotify ID already queued creates an auditable duplicate candidate", async t => {
    const store = await temporaryStore(t);
    const spotifyArtistId = "2CLclpIC43fLzsYq6LQvlL";
    const first = await intake(store, [record({ sourceRecordId: "queued-1", spotifyArtistId })]);
    const second = await intake(store, [record({ sourceRecordId: "queued-2", sourceUrl: "https://example.test/queued-2", spotifyArtistId })]);
    const duplicate = await store.readCandidate(second.results[0].candidateId);
    assert.notEqual(first.results[0].candidateId, second.results[0].candidateId);
    assert.equal(duplicate.state, "duplicate");
    assert.equal(duplicate.duplicate.status, "queued_candidate");
    assert.equal(duplicate.duplicate.duplicateOfCandidateId, first.results[0].candidateId);
});

test("the same normalized name with different IDs is only a warning", async t => {
    const store = await temporaryStore(t);
    await intake(store, [record({ sourceRecordId: "same-name-1", rawArtistName: "Shared Name", spotifyArtistId: "2CLclpIC43fLzsYq6LQvlL" })]);
    const second = await intake(store, [record({ sourceRecordId: "same-name-2", sourceUrl: "https://example.test/same-name-2", rawArtistName: "  SHARED   NAME ", spotifyArtistId: "5qRbfEf4Ooo19aRXKQzvUV" })]);
    const candidate = await store.readCandidate(second.results[0].candidateId);
    assert.equal(candidate.state, "identity_pending");
    assert.equal(candidate.duplicate.status, "not_duplicate");
    assert.equal(candidate.warnings[0].code, "normalized_name_collision_warning");
    assert.match(candidate.warnings[0].note, /not identity proof/);
});

test("invalid candidate fixture fails schema validation", async () => {
    const invalid = JSON.parse(await fs.readFile(path.join(fixtureRoot, "invalid-candidate.json"), "utf8"));
    assert.throws(() => validateCandidate(invalid), /Invalid durable candidate ID/);
    assert.throws(() => normalizeDiscovery(record({ spotifyArtistId: "bad" })), /Invalid Spotify artist ID/);
});

test("stale revision updates are rejected without appending an event", async t => {
    const store = await temporaryStore(t);
    const result = await intake(store, [record()]);
    const candidateId = result.results[0].candidateId;
    await assert.rejects(() => store.transitionCandidate(candidateId, {
        expectedRevision: 1,
        nextState: "identity_resolving",
        reasonCode: "identity_worker_started",
        actor: { type: "worker", id: "fixture_worker" }
    }), /Stale candidate revision/);
    assert.equal((await store.readEvents(candidateId)).length, 2);
});

test("legal lifecycle transitions pass and illegal jumps fail closed", async t => {
    assert.equal(legalTransition("identity_pending", "identity_resolving"), true);
    assert.equal(legalTransition("identity_pending", "ready_for_live"), false);
    assert.deepEqual(LEGAL_TRANSITIONS.migrated, []);
    const store = await temporaryStore(t);
    const result = await intake(store, [record()]);
    const resolving = await store.transitionCandidate(result.results[0].candidateId, {
        expectedRevision: 2,
        nextState: "identity_resolving",
        reasonCode: "identity_worker_started",
        actor: { type: "worker", id: "fixture_worker" }
    });
    assert.equal(resolving.state, "identity_resolving");
    await assert.rejects(() => store.transitionCandidate(resolving.candidateId, {
        expectedRevision: resolving.revision,
        nextState: "ready_for_live",
        reasonCode: "illegal_jump",
        actor: { type: "worker", id: "fixture_worker" }
    }), /Illegal candidate transition/);
});

test("event replay exactly reproduces the mutable candidate snapshot", async t => {
    const store = await temporaryStore(t);
    const result = await intake(store, [record()]);
    const candidateId = result.results[0].candidateId;
    const replayed = await store.replay(candidateId);
    const snapshot = await store.readCandidate(candidateId);
    assert.deepEqual(replayed, snapshot);
    assert.equal(await store.verifySnapshot(candidateId), true);
    const queueIndex = JSON.parse(await fs.readFile(path.join(store.indexesDir, "queue.json"), "utf8"));
    const reviewIndex = JSON.parse(await fs.readFile(path.join(store.indexesDir, "review.json"), "utf8"));
    assert.equal(queueIndex.rebuildable, true);
    assert.equal(queueIndex.candidateCount, 1);
    assert.equal(reviewIndex.rebuildable, true);
});

test("indexes and future transitions recover from immutable events if a snapshot is absent", async t => {
    const store = await temporaryStore(t);
    const result = await intake(store, [record()]);
    const candidateId = result.results[0].candidateId;
    await fs.unlink(store.candidatePath(candidateId));
    const recovered = (await store.listCandidates())[0];
    assert.equal(recovered.candidateId, candidateId);
    assert.equal(recovered.state, "identity_pending");
    await store.rebuildIndexes();
    const transitioned = await store.transitionCandidate(candidateId, {
        expectedRevision: recovered.revision,
        nextState: "identity_resolving",
        reasonCode: "identity_worker_started",
        actor: { type: "worker", id: "fixture_worker" }
    });
    assert.equal(transitioned.revision, 3);
    assert.equal(await store.verifySnapshot(candidateId), true);
});

test("candidate event schema records revision, actor, reason, evidence, and states", () => {
    const candidateId = createCandidateId({ now: 1723636800000, randomBytes: Buffer.alloc(10, 4) });
    const discovery = normalizeDiscovery(record());
    const event = buildCandidateEvent({
        eventId: createEventId({ now: 1723636800001, randomBytes: Buffer.alloc(10, 5) }),
        candidateId,
        eventType: "candidate_discovered",
        previousState: null,
        nextState: "discovered",
        previousRevision: 0,
        reasonCode: "discovery_intake_created",
        actor: { type: "command", id: "fixture_intake" },
        occurredAt: "2026-08-14T12:00:00.000Z",
        evidenceRefs: ["fixture:manual-new"],
        payload: { discovery }
    });
    assert.equal(event.candidateRevision, 1);
    assert.deepEqual(event.actor, { type: "command", id: "fixture_intake" });
    assert.deepEqual(event.evidenceRefs, ["fixture:manual-new"]);
    assert.equal(validateCandidateEvent(event), true);
});

test("CSV parser rejects missing artist columns", () => {
    assert.throws(() => parseCsvDiscoveries("source_type,source_name\nmanual_curated_list,test\n"), /missing raw_artist_name/);
});
