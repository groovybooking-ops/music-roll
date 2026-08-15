const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { IdentityQueueWorker } = require("../lib/ingestion/identity-worker");
const { DiscoveryConvergence } = require("../lib/discovery/discovery-convergence");
const { normalizeDiscoveryOccurrence, providerEntityKey } = require("../lib/discovery/discovery-schema");
const { DiscoveryStore } = require("../lib/discovery/discovery-store");
const { defineDiscoverySourceAdapter } = require("../lib/discovery/source-adapter");
const fixture = require("./fixtures/discovery/foundation.json");

function occurrence(name, overrides = {}) {
    return normalizeDiscoveryOccurrence({ ...structuredClone(fixture.occurrences[name]), ...overrides });
}

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-discovery-foundation-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const clock = () => "2026-08-14T23:00:00.000Z";
    const candidateStore = new CandidateStore(root, { clock });
    const discoveryStore = new DiscoveryStore(root, { clock });
    const convergence = new DiscoveryConvergence({
        candidateStore,
        discoveryStore,
        permanentRegistry: structuredClone(fixture.permanentRegistry),
        liveArtists: structuredClone(fixture.liveArtists),
        clock
    });
    return { root, candidateStore, discoveryStore, convergence };
}

test("discovery occurrence IDs are stable and the generic adapter contract validates output", () => {
    const first = occurrence("spotifyAlphaFirst");
    const rerun = occurrence("spotifyAlphaFirst", { discoveredAt: "2026-08-15T01:00:00.000Z", rawEvidenceRef: "fixture:later-retrieval" });
    assert.equal(first.occurrenceId, rerun.occurrenceId);
    const adapter = defineDiscoverySourceAdapter({
        adapterId: "fixture_spotify_v1",
        provider: "spotify",
        adapterVersion: "v1",
        validateConfiguration: configuration => configuration,
        acquirePage: async () => ({}),
        normalizePage: () => [first],
        nextCheckpoint: checkpoint => checkpoint
    });
    assert.deepEqual(adapter.normalizePage({}, {}), [first]);
    assert.match(adapter.configurationHash({ b: 2, a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test("an exact occurrence rerun is idempotent with no new candidate event", async t => {
    const { convergence, candidateStore } = await setup(t);
    const item = occurrence("spotifyAlphaFirst");
    const first = await convergence.converge(item);
    const before = await candidateStore.readEvents(first.targetId);
    const second = await convergence.converge(item);
    assert.equal(first.action, "create_new_candidate");
    assert.equal(second.action, "idempotent_existing_occurrence");
    assert.equal(second.targetId, first.targetId);
    assert.equal((await candidateStore.readEvents(first.targetId)).length, before.length);
});

test("a second exact Spotify discovery attaches to the existing candidate", async t => {
    const { convergence, candidateStore } = await setup(t);
    const first = await convergence.converge(occurrence("spotifyAlphaFirst"));
    const before = await candidateStore.readCandidate(first.targetId);
    const second = await convergence.converge(occurrence("spotifyAlphaSecond"));
    const after = await candidateStore.readCandidate(first.targetId);
    assert.equal(second.action, "attach_existing_candidate");
    assert.equal(second.targetId, first.targetId);
    assert.equal(after.state, "identity_pending");
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.discoveryAssociations.length, 2);
    assert.equal(await candidateStore.verifySnapshot(first.targetId), true);
});

test("Spotify rediscovery of a permanent artist writes only live association evidence", async t => {
    const { convergence, candidateStore, discoveryStore } = await setup(t);
    const result = await convergence.converge(occurrence("spotifyLiveSza"));
    assert.equal(result.action, "associate_existing_live_artist");
    assert.equal(result.targetId, "mr_artist_000001");
    assert.equal((await candidateStore.listCandidates()).length, 0);
    const associations = await discoveryStore.listAssociations();
    assert.equal(associations.length, 1);
    assert.equal(associations[0].targetType, "live_artist");
    assert.equal(associations[0].targetId, "mr_artist_000001");
});

test("an exact provider entity rediscovery attaches without a name merge", async t => {
    const { convergence, candidateStore } = await setup(t);
    const first = await convergence.converge(occurrence("ticketmasterOnlyFirst"));
    const second = await convergence.converge(occurrence("ticketmasterOnlySecond"));
    const candidate = await candidateStore.readCandidate(first.targetId);
    assert.equal(first.candidate.state, "identity_discovery_pending");
    assert.equal(second.action, "attach_existing_candidate");
    assert.equal(second.targetId, first.targetId);
    assert.equal(candidate.discoveryAssociations.length, 2);
});

test("cross-source convergence follows only an explicit exact bridge", async t => {
    const { convergence, candidateStore } = await setup(t);
    const spotify = await convergence.converge(occurrence("spotifyAlphaFirst"));
    const ticketmaster = await convergence.converge(occurrence("ticketmasterSpotifyBridge"));
    const candidate = await candidateStore.readCandidate(spotify.targetId);
    assert.equal(ticketmaster.action, "attach_existing_candidate");
    assert.equal(ticketmaster.targetId, spotify.targetId);
    assert.deepEqual(new Set(candidate.discoveryAssociations.map(item => item.provider)), new Set(["spotify", "ticketmaster"]));
});

test("the same normalized name with another exact Spotify ID remains separate", async t => {
    const { convergence, candidateStore } = await setup(t);
    const first = await convergence.converge(occurrence("spotifyAlphaFirst"));
    const second = await convergence.converge(occurrence("spotifySameNameDifferentId"));
    assert.notEqual(second.targetId, first.targetId);
    assert.equal((await candidateStore.listCandidates()).length, 2);
    assert.ok(second.candidate.warnings.some(warning => warning.code === "normalized_name_collision_warning"));
});

test("multiple incompatible exact bridges route to review without selecting Spotify identity", async t => {
    const { convergence } = await setup(t);
    const result = await convergence.converge(occurrence("ticketmasterAmbiguousBridges"));
    assert.equal(result.action, "route_ambiguous_exact_convergence_to_review");
    assert.equal(result.candidate.state, "needs_review");
    assert.equal(result.candidate.candidateIdentifiers.spotifyArtistId, null);
    assert.ok(result.candidate.warnings.some(warning => warning.code === "ambiguous_exact_discovery_convergence"));
});

test("Ticketmaster-only candidates enter identity_discovery_pending and Stage 3 skips them", async t => {
    const { convergence, candidateStore } = await setup(t);
    const result = await convergence.converge(occurrence("ticketmasterOnlyFirst"));
    let resolverCalls = 0;
    const worker = new IdentityQueueWorker({
        store: candidateStore,
        resolver: { resolve: async () => { resolverCalls += 1; throw new Error("Stage 3 must not run."); } },
        evidenceStore: { persistIdentityEvidence: async () => { throw new Error("No identity evidence should be written."); } }
    });
    const run = await worker.run({ limit: 25 });
    assert.equal(result.candidate.state, "identity_discovery_pending");
    assert.equal(run.selected, 0);
    assert.equal(resolverCalls, 0);
});

test("discovery attachment replay is exact, duplicate attachment is inert, and stale writes fail", async t => {
    const { convergence, candidateStore } = await setup(t);
    const first = await convergence.converge(occurrence("spotifyAlphaFirst"));
    await convergence.converge(occurrence("spotifyAlphaSecond"));
    const candidate = await candidateStore.readCandidate(first.targetId);
    const eventsBefore = await candidateStore.readEvents(first.targetId);
    assert.equal(await candidateStore.verifySnapshot(first.targetId), true);
    const duplicateAssociation = candidate.discoveryAssociations[1];
    const duplicateDiscovery = candidate.discoveries.find(item => item.sourceRecordId === "playlist-1/artist-alpha");
    const duplicate = await candidateStore.attachDiscovery(first.targetId, {
        expectedRevision: candidate.revision,
        discovery: duplicateDiscovery,
        discoveryAssociation: duplicateAssociation
    });
    assert.equal(duplicate.idempotent, true);
    assert.equal((await candidateStore.readEvents(first.targetId)).length, eventsBefore.length);
    await assert.rejects(() => candidateStore.attachDiscovery(first.targetId, {
        expectedRevision: candidate.revision - 1,
        discovery: duplicateDiscovery,
        discoveryAssociation: { ...duplicateAssociation, occurrenceId: `sha256:${"f".repeat(64)}` }
    }), /Stale candidate revision/);
    assert.equal((await candidateStore.readEvents(first.targetId)).length, eventsBefore.length);
});

test("occurrence, provider-entity, and target indexes rebuild from immutable artifacts", async t => {
    const { convergence, discoveryStore } = await setup(t);
    const firstOccurrence = occurrence("ticketmasterOnlyFirst");
    const first = await convergence.converge(firstOccurrence);
    await convergence.converge(occurrence("ticketmasterOnlySecond"));
    const indexes = await discoveryStore.rebuildIndexes();
    const entity = indexes.providerEntities.providerEntities[providerEntityKey(firstOccurrence)];
    assert.equal(entity.occurrenceIds.length, 2);
    assert.deepEqual(entity.targets, [{ targetType: "candidate", targetId: first.targetId }]);
    assert.equal(indexes.targets.targets[`candidate:${first.targetId}`].length, 2);
    assert.ok(indexes.occurrences.occurrences[firstOccurrence.occurrenceId]);
});
