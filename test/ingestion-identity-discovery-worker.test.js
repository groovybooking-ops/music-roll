const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { IdentityQueueWorker } = require("../lib/ingestion/identity-worker");
const { DiscoveryConvergence } = require("../lib/discovery/discovery-convergence");
const { normalizeDiscoveryOccurrence } = require("../lib/discovery/discovery-schema");
const { DiscoveryStore } = require("../lib/discovery/discovery-store");
const { IdentityDiscoveryEvidenceStore } = require("../lib/ingestion/identity-discovery-evidence-store");
const { FixtureIdentityDiscoveryResolver, IdentityDiscoveryResolver, cacheIdentifier, classifyAcquisition } = require("../lib/ingestion/identity-discovery-resolver");
const { IdentityDiscoveryWorker } = require("../lib/ingestion/identity-discovery-worker");
const { createBoundedMusicBrainzFetch, parseArguments } = require("../scripts/run-ingestion-identity-discovery-worker");
const fixture = require("./fixtures/ingestion-identity-discovery-worker/scenarios.json");

const SPOTIFY_A = "AAAAAAAAAAAAAAAAAAAAAA";
const SPOTIFY_B = "BBBBBBBBBBBBBBBBBBBBBB";
const MBID = "11111111-1111-4111-8111-111111111111";
const clock = () => "2026-08-15T01:00:00.000Z";
const emptyRegistry = { schemaVersion: 1, mappings: [] };

function blankAcquisition() {
    return { inputProviderEntities: [], attemptedPaths: [], bridgePaths: [], spotifyCandidates: [], unresolvedAlternates: [], contradictions: [], providerErrors: [], provenanceClaims: [] };
}

function pathClaim(source, spotifyArtistId) {
    return { source, independentOrigins: [source], relationshipType: "fixture_exact_relationship", steps: [{ sourceEntity: `${source}:fixture`, target: spotifyArtistId }], resultingSpotifyArtistId: spotifyArtistId };
}

function acquisitionFor(kind) {
    const value = blankAcquisition();
    if (["unique_local", "unique_wikidata", "unique_musicbrainz", "unique_cross_provider"].includes(kind)) {
        const source = kind === "unique_wikidata" ? "wikidata" : kind === "unique_musicbrainz" ? "musicbrainz" : kind === "unique_cross_provider" ? "musicbrainz" : "ticketmaster";
        value.spotifyCandidates = [SPOTIFY_A]; value.bridgePaths = [pathClaim(source, SPOTIFY_A)];
    } else if (kind === "agreeing_paths") {
        value.spotifyCandidates = [SPOTIFY_A, SPOTIFY_A]; value.bridgePaths = [pathClaim("wikidata", SPOTIFY_A), pathClaim("musicbrainz", SPOTIFY_A)];
    } else if (kind === "multiple_qids") {
        value.spotifyCandidates = [SPOTIFY_A]; value.bridgePaths = [pathClaim("wikidata", SPOTIFY_A)]; value.unresolvedAlternates = [{ code: "multiple_wikidata_qids", qids: ["Q1", "Q2"] }];
    } else if (kind === "multiple_mbids") {
        value.unresolvedAlternates = [{ code: "multiple_mbids_for_exact_ticketmaster_url", mbids: [MBID, "22222222-2222-4222-8222-222222222222"] }];
    } else if (kind === "multiple_spotify") {
        value.spotifyCandidates = [SPOTIFY_A, SPOTIFY_B]; value.bridgePaths = [pathClaim("musicbrainz", SPOTIFY_A), pathClaim("musicbrainz", SPOTIFY_B)]; value.unresolvedAlternates = [{ code: "multiple_spotify_urls_on_mbid" }];
    } else if (kind === "independent_disagreement") {
        value.spotifyCandidates = [SPOTIFY_A, SPOTIFY_B]; value.bridgePaths = [pathClaim("wikidata", SPOTIFY_A), pathClaim("musicbrainz", SPOTIFY_B)];
    } else if (kind === "semantic_contradiction") {
        value.spotifyCandidates = [SPOTIFY_A]; value.bridgePaths = [pathClaim("musicbrainz", SPOTIFY_A)]; value.contradictions = [{ code: "person_group_project_mismatch" }];
    }
    return value;
}

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-identity-discovery-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new CandidateStore(root, { clock });
    const discoveryStore = new DiscoveryStore(root, { clock });
    const evidenceStore = new IdentityDiscoveryEvidenceStore(root, { clock, fixtureMode: true });
    return { root, store, discoveryStore, evidenceStore };
}

async function ticketCandidate(context, name, options = {}) {
    const convergence = new DiscoveryConvergence({ candidateStore: context.store, discoveryStore: context.discoveryStore, permanentRegistry: emptyRegistry, liveArtists: [], clock });
    const suffix = String(options.suffix || name).replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "Fixture";
    const occurrence = normalizeDiscoveryOccurrence({
        provider: "ticketmaster",
        sourceType: "ticketmaster_event",
        sourceName: "identity discovery fixture",
        sourceRecordId: `event-${suffix}/attraction/K8vZ${suffix}`,
        sourceUrl: `https://www.ticketmaster.com/event-${suffix}`,
        rawArtistName: name,
        providerEntity: { type: "attraction", id: `K8vZ${suffix}`, url: `https://www.ticketmaster.com/${suffix.toLowerCase()}-tickets/artist/${options.legacyId || "12345"}`, legacyIds: [options.legacyId || "12345"] },
        exactIdentityBridges: options.bridges || [],
        rawEvidenceRef: `fixture:ticketmaster:${suffix}`,
        discoveredAt: clock()
    });
    return (await convergence.converge(occurrence)).candidate;
}

async function spotifyCandidate(context, name, spotifyArtistId) {
    const convergence = new DiscoveryConvergence({ candidateStore: context.store, discoveryStore: context.discoveryStore, permanentRegistry: emptyRegistry, liveArtists: [], clock });
    return (await convergence.converge(normalizeDiscoveryOccurrence({
        provider: "spotify", sourceType: "public_music_database", sourceName: "queued fixture", sourceRecordId: `seed:${spotifyArtistId}`, sourceUrl: `https://open.spotify.com/artist/${spotifyArtistId}`, rawArtistName: name,
        providerEntity: { type: "artist", id: spotifyArtistId, url: `https://open.spotify.com/artist/${spotifyArtistId}` }, trustedIdentifiers: { spotifyArtistId, spotifyArtistUrl: `https://open.spotify.com/artist/${spotifyArtistId}` }, rawEvidenceRef: "fixture:spotify:queued", discoveredAt: clock()
    }))).candidate;
}

function worker(context, scenarios, options = {}) {
    const resolver = new FixtureIdentityDiscoveryResolver(scenarios);
    return new IdentityDiscoveryWorker({ store: context.store, resolver, evidenceStore: context.evidenceStore, permanentRegistry: options.permanentRegistry || emptyRegistry, liveArtists: options.liveArtists || [], clock, retryDelayMs: 60000 });
}

test("all 23 approved identity-discovery scenarios are fixture-defined", () => {
    assert.equal(fixture.scenarios.length, 23);
    assert.equal(new Set(fixture.scenarios.map(item => item.id)).size, 23);
});

test("exact bridge classifier separates unique, ambiguous, conflicting, and no-bridge evidence", () => {
    const candidate = { candidateId: "mr_candidate_fixture", name: { raw: "Fixture" } };
    const covered = new Set();
    for (const item of fixture.scenarios.slice(0, 12)) {
        const result = classifyAcquisition(candidate, acquisitionFor(item.kind));
        assert.equal(result.status, item.expected, item.id);
        covered.add(item.id);
    }
    assert.equal(covered.size, 12);
});

test("real cache-only resolver follows exact local, Wikidata, and MusicBrainz URL paths without names", async t => {
    const context = await setup(t);
    const local = await ticketCandidate(context, "Local Exact", { suffix: "LocalExact", bridges: [{ targetProvider: "spotify", targetEntityType: "artist", targetId: SPOTIFY_A, relationshipType: "explicit_provider_relationship", assertedByProvider: "ticketmaster", evidenceRef: "fixture:local-exact-bridge" }] });
    const localResolver = new IdentityDiscoveryResolver({ evidenceStore: context.evidenceStore, discoveryStore: context.discoveryStore });
    const localResult = await localResolver.resolve(local);
    assert.equal(localResult.status, "unique_exact_bridge");

    const mb = await ticketCandidate(context, "MusicBrainz Exact", { suffix: "MusicBrainzExact", legacyId: "67890" });
    const occurrence = await context.discoveryStore.findOccurrenceById(mb.discoveryAssociations[0].occurrenceId);
    await context.evidenceStore.seedFixture({ provider: "musicbrainz", identifier: cacheIdentifier(occurrence.providerEntity.url), operation: "exact-provider-url", value: { exactUrlFound: true, candidates: [{ musicBrainzArtistId: MBID }] } });
    await context.evidenceStore.seedFixture({ provider: "musicbrainz", identifier: MBID, operation: "artist", value: { artist: { musicBrainzArtistId: MBID, name: "Untrusted Display Name", artistType: "Group", externalUrls: [{ relationshipType: "streaming", url: `https://open.spotify.com/artist/${SPOTIFY_A}` }] } } });
    const mbResult = await new IdentityDiscoveryResolver({ evidenceStore: context.evidenceStore, discoveryStore: context.discoveryStore }).resolve(mb);
    assert.equal(mbResult.status, "unique_exact_bridge");
    assert.equal(mbResult.spotifyArtistId, SPOTIFY_A);

    const wd = await ticketCandidate(context, "Wikidata Exact", { suffix: "WikidataExact", legacyId: "24680" });
    const wdOccurrence = await context.discoveryStore.findOccurrenceById(wd.discoveryAssociations[0].occurrenceId);
    await context.evidenceStore.seedFixture({ provider: "wikidata", identifier: cacheIdentifier(`P9999:${wdOccurrence.providerEntity.id}`), operation: "ticketmaster-id-bridge", value: { bridge: { candidates: [{ wikidataQid: "Q123", statementRanks: ["normal"], spotifyArtistIds: [SPOTIFY_A], musicBrainzArtistIds: [], entityTypes: [] }] } } });
    await context.evidenceStore.seedFixture({ provider: "musicbrainz", identifier: cacheIdentifier(wdOccurrence.providerEntity.url), operation: "exact-provider-url", value: { exactUrlFound: false, candidates: [] } });
    const wdResult = await new IdentityDiscoveryResolver({ evidenceStore: context.evidenceStore, discoveryStore: context.discoveryStore, wikidataPropertySemantics: { discovery: "P9999" } }).resolve(wd);
    assert.equal(wdResult.status, "unique_exact_bridge");
});

test("worker routes unique, ambiguous, no-bridge, conflict, temporary failure, and cache miss deterministically", async t => {
    const context = await setup(t);
    const definitions = [
        ["Unique", "unique_local", "identity_pending"],
        ["Ambiguous", "multiple_spotify", "needs_review"],
        ["No Bridge", "no_bridge", "needs_review"],
        ["Conflict", "independent_disagreement", "conflicting_identity"]
    ];
    const scenarios = {};
    for (const [name, kind] of definitions) { await ticketCandidate(context, name); scenarios[name] = { acquisition: acquisitionFor(kind) }; }
    await ticketCandidate(context, "Temporary"); scenarios.Temporary = { temporaryFailure: { message: "fixture 503", provider: "musicbrainz", operation: "exact-provider-url", statusCode: 503 } };
    const cacheMiss = await ticketCandidate(context, "Cache Miss"); scenarios["Cache Miss"] = { cacheMiss: { provider: "musicbrainz", operation: "exact-provider-url", identifier: "missing" } };
    const revisionBefore = cacheMiss.revision;
    const run = await worker(context, scenarios).run({ limit: 10 });
    for (const [name,, expectedState] of definitions) assert.equal((await context.store.listCandidates()).find(item => item.name.raw === name).state, expectedState);
    assert.equal((await context.store.listCandidates()).find(item => item.name.raw === "Temporary").state, "retry_wait");
    const cacheAfter = (await context.store.listCandidates()).find(item => item.name.raw === "Cache Miss");
    assert.equal(cacheAfter.state, "identity_discovery_pending");
    assert.equal(cacheAfter.revision, revisionBefore);
    assert.equal(run.skippedCacheMiss, 1);
    assert.equal(run.retryWait, 1);
});

test("Charles Mingus Orchestra cannot resolve to Charles Mingus through name or event-title similarity", async t => {
    const context = await setup(t);
    const candidate = await ticketCandidate(context, "Charles Mingus Orchestra", { suffix: "CharlesMingusOrchestra", legacyId: "1478438" });
    const run = await worker(context, { "Charles Mingus Orchestra": { acquisition: blankAcquisition() } }).run({ candidateId: candidate.candidateId });
    const after = await context.store.readCandidate(candidate.candidateId);
    assert.equal(run.results[0].decision, "completed_without_safe_exact_bridge");
    assert.equal(after.state, "needs_review");
    assert.equal(after.candidateIdentifiers.spotifyArtistId, null);
    assert.equal(after.identityDiscovery.resultingSpotifyArtistId, null);
});

test("identifier attachment is append-only, human-attributable, idempotent, stale-safe, replayable, and cannot overwrite", async t => {
    const context = await setup(t);
    const candidate = await ticketCandidate(context, "Human Attachment");
    const identifier = { provider: "spotify", entityType: "artist", value: SPOTIFY_A, url: `https://open.spotify.com/artist/${SPOTIFY_A}`, bridgeEvidenceId: `sha256:${"a".repeat(64)}` };
    const first = await context.store.attachIdentifier(candidate.candidateId, { expectedRevision: candidate.revision, identifier, actor: { type: "human", id: "fixture_reviewer" }, reasonCode: "human_approved_exact_identifier_attachment", evidenceRefs: ["fixture:human-decision"] });
    assert.equal(first.attached, true);
    assert.equal(first.candidate.identifierAttachments[0].actor.type, "human");
    assert.equal((await context.store.readEvents(candidate.candidateId)).at(-1).eventType, "candidate_identifier_attached");
    const repeated = await context.store.attachIdentifier(candidate.candidateId, { expectedRevision: first.candidate.revision, identifier });
    assert.equal(repeated.idempotent, true);
    await assert.rejects(() => context.store.attachIdentifier(candidate.candidateId, { expectedRevision: candidate.revision, identifier }), /Stale candidate revision/);
    await assert.rejects(() => context.store.attachIdentifier(candidate.candidateId, { expectedRevision: first.candidate.revision, identifier: { ...identifier, value: SPOTIFY_B, url: `https://open.spotify.com/artist/${SPOTIFY_B}` } }), /overwrite/);
    assert.equal(await context.store.verifySnapshot(candidate.candidateId), true);
});

test("unique bridges run duplicate preflight for existing live and queued Spotify IDs", async t => {
    const context = await setup(t);
    await spotifyCandidate(context, "Queued Existing", SPOTIFY_A);
    await ticketCandidate(context, "Queued Bridge", { suffix: "QueuedBridge" });
    await ticketCandidate(context, "Live Bridge", { suffix: "LiveBridge" });
    const scenarios = { "Queued Bridge": { acquisition: acquisitionFor("unique_local") }, "Live Bridge": { acquisition: acquisitionFor("unique_local") } };
    const liveRegistry = { schemaVersion: 1, mappings: [{ musicRollId: "mr_artist_000001", spotifyId: SPOTIFY_B }] };
    scenarios["Live Bridge"].acquisition = { ...blankAcquisition(), spotifyCandidates: [SPOTIFY_B], bridgePaths: [pathClaim("wikidata", SPOTIFY_B)] };
    await worker(context, scenarios, { permanentRegistry: liveRegistry, liveArtists: [{ musicRollId: "mr_artist_000001", name: "Live", spotifyId: SPOTIFY_B }] }).run({ limit: 10 });
    const candidates = await context.store.listCandidates();
    const queued = candidates.find(item => item.name.raw === "Queued Bridge");
    const live = candidates.find(item => item.name.raw === "Live Bridge");
    assert.equal(queued.state, "duplicate");
    assert.equal(queued.duplicate.status, "queued_candidate");
    assert.equal(live.state, "duplicate");
    assert.equal(live.duplicate.existingMusicRollId, "mr_artist_000001");
});

test("expired leases recover, and Stage 3 still skips discovery states", async t => {
    const context = await setup(t);
    const candidate = await ticketCandidate(context, "Expired Lease");
    const discovering = await context.store.transitionCandidate(candidate.candidateId, { expectedRevision: candidate.revision, nextState: "identity_discovering", reasonCode: "fixture_expired_lease", actor: { type: "worker", id: "fixture" }, payload: { processing: { lease: { leaseId: "mr_candidate_event_018f0000-0000-7000-8000-000000000001", workerId: "fixture", acquiredAt: "2026-08-14T00:00:00.000Z", expiresAt: "2026-08-14T00:01:00.000Z", startingRevision: candidate.revision } } } });
    const scenarios = { "Expired Lease": { cacheMiss: { provider: "musicbrainz", operation: "exact-provider-url", identifier: "missing" } } };
    await worker(context, scenarios).run({ candidateId: discovering.candidateId });
    assert.equal((await context.store.readCandidate(candidate.candidateId)).state, "identity_discovery_pending");
    let stage3Calls = 0;
    const stage3 = new IdentityQueueWorker({ store: context.store, resolver: { resolve: async () => { stage3Calls += 1; } }, evidenceStore: { persistIdentityEvidence: async () => ({}) } });
    const run = await stage3.run({ limit: 10 });
    assert.equal(run.selected, 0);
    assert.equal(stage3Calls, 0);
});

test("explicit live mode acquires only exact URL and MBID relationships before routing identity_pending", async t => {
    const context = await setup(t);
    const candidate = await ticketCandidate(context, "Bounded Network Exact", { suffix: "BoundedNetworkExact", legacyId: "76543" });
    const metrics = { cacheHits: 0, cacheMisses: 0, liveRequests: 0, retries: 0, immutableEvidenceWrites: 0, immutableEvidenceReuses: 0, byProvider: {} };
    const evidenceStore = new IdentityDiscoveryEvidenceStore(context.root, { clock, allowNetwork: true, metrics });
    const requests = [];
    const fetchImpl = async url => {
        requests.push(String(url));
        if (String(url).includes("/ws/2/url?")) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ relations: [{ "target-type": "artist", artist: { id: MBID, name: "Provider Name", type: "Group" } }] }) };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ id: MBID, name: "Provider Name", type: "Group", relations: [{ type: "free streaming", url: { resource: `https://open.spotify.com/artist/${SPOTIFY_A}` } }] }) };
    };
    const resolver = new IdentityDiscoveryResolver({ evidenceStore, discoveryStore: context.discoveryStore, fetchers: { musicbrainz: fetchImpl } });
    const liveWorker = new IdentityDiscoveryWorker({ store: context.store, resolver, evidenceStore, permanentRegistry: emptyRegistry, liveArtists: [], clock });
    const run = await liveWorker.run({ candidateId: candidate.candidateId });
    const after = await context.store.readCandidate(candidate.candidateId);
    assert.equal(run.processed, 1);
    assert.equal(requests.length, 2);
    assert.ok(requests[0].includes("/ws/2/url?"));
    assert.ok(requests[1].includes(`/ws/2/artist/${MBID}`));
    assert.equal(after.state, "identity_pending");
    assert.equal(after.candidateIdentifiers.spotifyArtistId, SPOTIFY_A);
    assert.equal(after.approval.status, "not_approved");
});

test("network remains explicitly gated and the MusicBrainz request wrapper hard-stops at four", async () => {
    assert.equal(parseArguments([]).allowNetwork, false);
    assert.equal(parseArguments(["--allow-network"]).allowNetwork, true);
    const metrics = { liveRequests: 0, retries: 0, byProvider: {} };
    const bounded = createBoundedMusicBrainzFetch(metrics, { maximumRequests: 4, minimumSpacingMs: 0, waitImpl: async () => {}, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null } }) });
    for (let index = 0; index < 4; index += 1) await bounded(`https://musicbrainz.test/${index}`);
    await assert.rejects(() => bounded("https://musicbrainz.test/overflow"), /request cap of 4/);
    assert.equal(metrics.liveRequests, 4);
});
