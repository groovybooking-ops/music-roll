const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { DiscoveryConvergence } = require("../lib/discovery/discovery-convergence");
const { DiscoveryStore } = require("../lib/discovery/discovery-store");
const { createFixtureCheckpoint } = require("../lib/discovery/fixture-checkpoint");
const { createSpotifyFixtureDiscoveryAdapter } = require("../lib/discovery/spotify-discovery-adapter");
const { createTicketmasterFixtureDiscoveryAdapter } = require("../lib/discovery/ticketmaster-discovery-adapter");
const spotifyFixtures = require("./fixtures/discovery/spotify-adapter-pages.json");
const ticketmasterFixtures = require("./fixtures/discovery/ticketmaster-adapter-pages.json");
const foundationFixture = require("./fixtures/discovery/foundation.json");

const discoveredAt = "2026-08-14T23:30:00.000Z";

function spotifyConfiguration(fixtureKey, mode, sourceType = "manual_curated_list") {
    return { fixtureKey, mode, sourceType, sourceName: `Spotify fixture ${fixtureKey}`, discoveredAt };
}

function ticketmasterConfiguration(fixtureKey, mode = "event_attractions") {
    return { fixtureKey, mode, sourceType: "ticketmaster_event", sourceName: `Ticketmaster fixture ${fixtureKey}`, discoveredAt };
}

async function acquireOccurrences(adapter, configuration, checkpoint = null) {
    const page = await adapter.acquirePage({ configuration, checkpoint });
    return { page, occurrences: adapter.normalizePage(page, { configuration }) };
}

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-discovery-adapters-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const clock = () => "2026-08-14T23:45:00.000Z";
    const candidateStore = new CandidateStore(root, { clock });
    const discoveryStore = new DiscoveryStore(root, { clock });
    const convergence = new DiscoveryConvergence({
        candidateStore,
        discoveryStore,
        permanentRegistry: structuredClone(foundationFixture.permanentRegistry),
        liveArtists: structuredClone(foundationFixture.liveArtists),
        clock
    });
    return { root, candidateStore, discoveryStore, convergence };
}

test("Spotify fixture adapter implements the shared contract and refuses network mode", async () => {
    const adapter = createSpotifyFixtureDiscoveryAdapter({ fixtures: spotifyFixtures });
    const configuration = spotifyConfiguration("exactSeeds", "exact_artist_seeds");
    assert.equal(adapter.adapterId, "spotify_fixture_discovery_v1");
    assert.equal(adapter.provider, "spotify");
    assert.equal(adapter.adapterVersion, "v1");
    assert.equal(adapter.validateConfiguration(configuration), true);
    assert.equal(adapter.configurationHash(configuration), adapter.canonicalConfigurationHash(configuration));
    assert.match(adapter.canonicalConfigurationHash(configuration), /^sha256:[0-9a-f]{64}$/);
    await assert.rejects(() => adapter.acquirePage({ configuration, networkAllowed: true }), /fixture-only/);
    await assert.rejects(() => adapter.acquirePage({ configuration: { ...configuration, allowNetwork: true } }), /fixture-only/);
});

test("Spotify exact seeds, search results, and album artists normalize as exact provider occurrences", async () => {
    const adapter = createSpotifyFixtureDiscoveryAdapter({ fixtures: spotifyFixtures });
    const exact = await acquireOccurrences(adapter, spotifyConfiguration("exactSeeds", "exact_artist_seeds"));
    assert.equal(exact.occurrences.length, 2);
    assert.deepEqual(exact.occurrences[0].providerEntity, {
        provider: "spotify",
        type: "artist",
        id: "1111111111111111111111",
        url: "https://open.spotify.com/artist/1111111111111111111111",
        legacyIds: []
    });
    assert.equal(exact.occurrences[0].trustedIdentifiers.spotifyArtistId, "1111111111111111111111");
    assert.equal(exact.occurrences[0].reviewOnly, true);

    const search = await acquireOccurrences(adapter, spotifyConfiguration("searchResults", "artist_search_results", "public_music_database"));
    assert.equal(search.occurrences.length, 2);
    assert.equal(search.occurrences[0].sourceContext.query, "fixture discovery query");
    assert.equal(search.occurrences[0].sourceContext.resultPosition, 0);
    assert.match(search.occurrences[0].sourceContext.note, /not proof/);
    assert.notEqual(search.occurrences[0].occurrenceId, search.occurrences[1].occurrenceId);

    const albums = await acquireOccurrences(adapter, spotifyConfiguration("albumArtists", "album_artist_relationships", "related_artist"));
    assert.equal(albums.occurrences.length, 2);
    assert.equal(albums.occurrences[0].sourceContext.albumId, "album-fixture-001");
    assert.equal(albums.occurrences[0].sourceContext.relationshipType, "album_artist");
});

test("Ticketmaster fixture adapter preserves legacy attraction and event geography evidence and refuses network", async () => {
    const adapter = createTicketmasterFixtureDiscoveryAdapter({ fixtures: ticketmasterFixtures });
    const exactConfiguration = ticketmasterConfiguration("exactSeeds", "exact_attraction_seeds");
    assert.equal(adapter.validateConfiguration(exactConfiguration), true);
    await assert.rejects(() => adapter.acquirePage({ configuration: exactConfiguration, networkAllowed: true }), /fixture-only/);
    const exact = await acquireOccurrences(adapter, exactConfiguration);
    assert.equal(exact.occurrences.length, 1);
    assert.equal(exact.occurrences[0].providerEntity.id, "K8vZTicketOnly");
    assert.deepEqual(exact.occurrences[0].providerEntity.legacyIds, ["1850001"]);
    assert.equal(exact.occurrences[0].sourceContext.classifications[0].genre.name, "R&B");
    assert.equal(exact.occurrences[0].sourceContext.note.includes("do not set Music Roll genre or stage"), true);

    const event = await acquireOccurrences(adapter, ticketmasterConfiguration("providerRediscovery"));
    const context = event.occurrences[0].sourceContext;
    assert.equal(context.eventId, "event-provider-rediscovery");
    assert.deepEqual(context.eventDateTime, { localDate: "2026-10-01", localTime: "20:00:00", utcDateTime: "2026-10-02T00:00:00Z" });
    assert.deepEqual(context.venue, { id: "venue-repeat", name: "Repeat Arena", city: "New York", region: "NY", country: "US", latitude: 40.7505, longitude: -73.9934 });
    assert.equal(event.occurrences[0].rawEvidenceRef, "fixture:ticketmaster:event:provider-rediscovery");
});

test("Ticketmaster emits one occurrence per embedded attraction and none from an event title", async () => {
    const adapter = createTicketmasterFixtureDiscoveryAdapter({ fixtures: ticketmasterFixtures });
    const result = await acquireOccurrences(adapter, ticketmasterConfiguration("multipleAttractions"));
    assert.equal(result.page.itemCount, 2);
    assert.deepEqual(result.occurrences.map(item => item.artist.rawName), ["Explicit Artist One", "Explicit Artist Two"]);
    assert.ok(result.occurrences.every(item => item.sourceContext.eventId === "event-multiple-attractions"));
    assert.ok(result.occurrences.every(item => item.artist.rawName !== "Title That Looks Like An Artist"));
    assert.equal(result.occurrences[0].sourceContext.venue.id, "venue-multi");
    assert.equal(result.occurrences[0].sourceContext.eventClassifications[0].genre.name, "Pop");
});

test("adapter occurrences route through Stage 1 convergence without bypassing identity", async t => {
    const { convergence, candidateStore } = await setup(t);
    const spotifyAdapter = createSpotifyFixtureDiscoveryAdapter({ fixtures: spotifyFixtures });
    const ticketmasterAdapter = createTicketmasterFixtureDiscoveryAdapter({ fixtures: ticketmasterFixtures });
    const spotify = await acquireOccurrences(spotifyAdapter, spotifyConfiguration("exactSeeds", "exact_artist_seeds"));
    const alpha = spotify.occurrences.find(item => item.providerEntity.id === "1111111111111111111111");
    const sza = spotify.occurrences.find(item => item.providerEntity.id === "7tYKF4w9nC0nq9CsPZTHyP");
    const alphaResult = await convergence.converge(alpha);
    const liveResult = await convergence.converge(sza);
    assert.equal(alphaResult.candidate.state, "identity_pending");
    assert.equal(liveResult.action, "associate_existing_live_artist");
    assert.equal(liveResult.targetId, "mr_artist_000001");

    const ticketOnly = await acquireOccurrences(ticketmasterAdapter, ticketmasterConfiguration("exactSeeds", "exact_attraction_seeds"));
    const ticketResult = await convergence.converge(ticketOnly.occurrences[0]);
    assert.equal(ticketResult.candidate.state, "identity_discovery_pending");
    assert.equal((await candidateStore.listCandidates()).length, 2);
});

test("Ticketmaster exact provider rediscovery attaches and its exact rerun is inert", async t => {
    const { convergence, candidateStore } = await setup(t);
    const adapter = createTicketmasterFixtureDiscoveryAdapter({ fixtures: ticketmasterFixtures });
    const seed = (await acquireOccurrences(adapter, ticketmasterConfiguration("exactSeeds", "exact_attraction_seeds"))).occurrences[0];
    const rediscovery = (await acquireOccurrences(adapter, ticketmasterConfiguration("providerRediscovery"))).occurrences[0];
    const first = await convergence.converge(seed);
    const second = await convergence.converge(rediscovery);
    const eventCount = (await candidateStore.readEvents(first.targetId)).length;
    const rerun = await convergence.converge(rediscovery);
    assert.equal(second.action, "attach_existing_candidate");
    assert.equal(second.targetId, first.targetId);
    assert.equal(rerun.action, "idempotent_existing_occurrence");
    assert.equal((await candidateStore.readEvents(first.targetId)).length, eventCount);
});

test("Spotify and Ticketmaster converge only through an explicit exact bridge", async t => {
    const { convergence, candidateStore } = await setup(t);
    const spotifyAdapter = createSpotifyFixtureDiscoveryAdapter({ fixtures: spotifyFixtures });
    const ticketmasterAdapter = createTicketmasterFixtureDiscoveryAdapter({ fixtures: ticketmasterFixtures });
    const spotifyAlpha = (await acquireOccurrences(spotifyAdapter, spotifyConfiguration("exactSeeds", "exact_artist_seeds"))).occurrences[0];
    const spotifyResult = await convergence.converge(spotifyAlpha);

    const bridged = (await acquireOccurrences(ticketmasterAdapter, ticketmasterConfiguration("explicitSpotifyBridge"))).occurrences[0];
    const bridgeResult = await convergence.converge(bridged);
    assert.equal(bridgeResult.action, "attach_existing_candidate");
    assert.equal(bridgeResult.targetId, spotifyResult.targetId);

    const sameName = (await acquireOccurrences(ticketmasterAdapter, ticketmasterConfiguration("sameNameNoBridge"))).occurrences[0];
    const sameNameResult = await convergence.converge(sameName);
    assert.notEqual(sameNameResult.targetId, spotifyResult.targetId);
    assert.equal(sameNameResult.candidate.state, "identity_discovery_pending");
    assert.ok(sameNameResult.candidate.warnings.some(warning => warning.code === "normalized_name_collision_warning"));
    assert.equal((await candidateStore.listCandidates()).length, 2);
});

test("multiple incompatible exact bridge fixtures route to review", async t => {
    const { convergence } = await setup(t);
    const adapter = createTicketmasterFixtureDiscoveryAdapter({ fixtures: ticketmasterFixtures });
    const item = (await acquireOccurrences(adapter, ticketmasterConfiguration("incompatibleBridges"))).occurrences[0];
    const result = await convergence.converge(item);
    assert.equal(result.action, "route_ambiguous_exact_convergence_to_review");
    assert.equal(result.candidate.state, "needs_review");
    assert.equal(result.candidate.candidateIdentifiers.spotifyArtistId, null);
});

test("fixture checkpoints resume mid-page without duplicate occurrences or candidates", async t => {
    const { convergence, candidateStore } = await setup(t);
    const adapter = createSpotifyFixtureDiscoveryAdapter({ fixtures: spotifyFixtures });
    const configuration = spotifyConfiguration("searchResults", "artist_search_results", "public_music_database");
    const configurationHash = adapter.canonicalConfigurationHash(configuration);
    const initial = createFixtureCheckpoint(configurationHash);
    const firstPage = await adapter.acquirePage({ configuration, checkpoint: initial });
    const firstNormalization = adapter.normalizePage(firstPage, { configuration });
    await convergence.converge(firstNormalization[0]);

    const crashedCheckpoint = adapter.nextCheckpoint({ configuration, checkpoint: initial, page: firstPage, consumedItems: 1 });
    assert.deepEqual(crashedCheckpoint, { schemaVersion: 1, configurationHash, providerPage: 0, itemOffset: 1, exhausted: false });

    const resumedPage = await adapter.acquirePage({ configuration, checkpoint: crashedCheckpoint });
    const resumedNormalization = adapter.normalizePage(resumedPage, { configuration });
    assert.deepEqual(resumedNormalization.map(item => item.occurrenceId), firstNormalization.map(item => item.occurrenceId));
    const remaining = resumedNormalization.slice(crashedCheckpoint.itemOffset);
    assert.equal(remaining.length, 1);
    await convergence.converge(remaining[0]);
    const completed = adapter.nextCheckpoint({ configuration, checkpoint: crashedCheckpoint, page: resumedPage, consumedItems: remaining.length });
    assert.deepEqual(completed, { schemaVersion: 1, configurationHash, providerPage: 1, itemOffset: 0, exhausted: true });

    const eventsBefore = await Promise.all((await candidateStore.listCandidateIds()).map(id => candidateStore.readEvents(id)));
    await convergence.converge(firstNormalization[0]);
    const eventsAfter = await Promise.all((await candidateStore.listCandidateIds()).map(id => candidateStore.readEvents(id)));
    assert.deepEqual(eventsAfter.map(events => events.length), eventsBefore.map(events => events.length));
    assert.equal((await candidateStore.listCandidates()).length, 2);
});
