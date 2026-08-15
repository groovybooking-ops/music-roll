const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
    createCandidateId,
    createEventId,
    normalizeDiscovery
} = require("../lib/ingestion/candidate-schema");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { IdentityEvidenceStore, OfflineCacheMissError } = require("../lib/ingestion/identity-evidence-store");
const { FixtureIdentityResolver, resolveIdentityAcquisition } = require("../lib/ingestion/queue-identity-resolver");
const { IdentityQueueWorker, routeIdentityReport } = require("../lib/ingestion/identity-worker");
const { assessMechanicallyClosedProviderMultiplicity } = require("../lib/identity-conflict-resolution");

const fixturePath = path.join(__dirname, "fixtures", "ingestion-identity-worker", "scenarios.json");
const scenariosFixture = require("./fixtures/ingestion-identity-worker/scenarios.json");
const lowRiskFixture = require("./fixtures/ingestion-identity-worker/low-risk-upgrades.json");
const multiplicityHardeningFixture = require("./fixtures/ingestion-identity-worker/mechanical-multiplicity-hardening.json");

function fixtureReport(fixture) {
    return resolveIdentityAcquisition({
        name: { raw: fixture.name },
        candidateIdentifiers: { spotifyArtistId: fixture.spotifyArtistId }
    }, structuredClone(fixture.acquisition));
}

function deterministicIdFactory(prefix, initial = 0) {
    let counter = initial;
    return () => {
        counter += 1;
        const options = { now: Date.parse("2026-08-14T14:00:00.000Z") + counter, randomBytes: Buffer.alloc(10, counter) };
        return prefix === "candidate" ? createCandidateId(options) : createEventId(options);
    };
}

async function setup(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-identity-worker-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const time = options.time || { value: Date.parse("2026-08-14T14:00:00.000Z") };
    const clock = () => new Date(time.value).toISOString();
    const store = new CandidateStore(root, {
        clock,
        candidateIdGenerator: deterministicIdFactory("candidate"),
        eventIdGenerator: deterministicIdFactory("event", 100)
    });
    const metrics = { cacheHits: 0, liveRequests: 0, retries: 0, immutableEvidenceReuses: 0, immutableEvidenceWrites: 0, byProvider: {} };
    const evidenceStore = new IdentityEvidenceStore(root, { clock, allowNetwork: false, metrics });
    return { root, time, clock, store, evidenceStore, metrics };
}

async function createPending(store, spotifyArtistId, rawArtistName) {
    const discovery = normalizeDiscovery({
        sourceType: "manual_curated_list",
        sourceName: "Stage 3 fixture cohort",
        sourceRecordId: `fixture-${spotifyArtistId}`,
        rawArtistName,
        spotifyArtistId,
        spotifyArtistUrl: `https://open.spotify.com/artist/${spotifyArtistId}`,
        discoveredAt: "2026-08-14T14:00:00.000Z"
    });
    const created = await store.createCandidate(discovery, { actor: { type: "command", id: "stage_3_fixture_intake" } });
    return store.transitionCandidate(created.candidateId, {
        expectedRevision: created.revision,
        nextState: "identity_pending",
        reasonCode: "identity_queued",
        actor: { type: "system", id: "duplicate_preflight_v1" }
    });
}

async function allJsonFiles(directory) {
    const output = [];
    async function visit(current) {
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
        for (const entry of entries) {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) await visit(target);
            else if (entry.name.endsWith(".json")) output.push(target);
        }
    }
    await visit(directory);
    return output.sort();
}

async function fileHashes(files) {
    return Object.fromEntries(await Promise.all(files.map(async file => [file, crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex")])));
}

test("fixture evidence produces every required Stage 3 identity outcome", () => {
    const expected = {
        "7tYKF4w9nC0nq9CsPZTHyP": "coherent_identity_evidence",
        "6olE6TJLqED3rqDCT0FyPh": "coherent_identity_with_same_name_ambiguity",
        "6vWDO969PvNqNYHIOW5v0m": "provider_profile_multiplicity",
        "0000000000000000000004": "coherent_identity_evidence",
        "0000000000000000000005": "insufficient_corroboration",
        "0000000000000000000006": "semantic_identity_conflict"
    };
    for (const [spotifyArtistId, outcome] of Object.entries(expected)) {
        const candidate = { name: { raw: scenariosFixture[spotifyArtistId].label }, candidateIdentifiers: { spotifyArtistId } };
        assert.equal(resolveIdentityAcquisition(candidate, scenariosFixture[spotifyArtistId].acquisition).outcome, outcome);
    }
});

test("an exact Spotify ID with multiple Wikidata entities cannot route coherent", () => {
    const spotifyArtistId = "0000000000000000000004";
    const candidate = { name: { raw: "Fallback Artist" }, candidateIdentifiers: { spotifyArtistId } };
    const acquisition = structuredClone(scenariosFixture[spotifyArtistId].acquisition);
    acquisition.blockingIdentityAmbiguity = "multiple_wikidata_entities_for_exact_spotify_id";
    const report = resolveIdentityAcquisition(candidate, acquisition);
    assert.equal(report.outcome, "unresolved_identity");
    assert.ok(report.missingEvidence.includes("multiple_wikidata_entities_for_exact_spotify_id"));
});

test("Discogs absence can qualify only through complete unique Wikidata and MusicBrainz exact paths", () => {
    const elmiene = fixtureReport(lowRiskFixture.elmiene);
    assert.equal(elmiene.outcome, "coherent_identity_evidence");
    assert.equal(elmiene.discogsOptionalCoherence.qualifies, true);
    assert.equal(elmiene.discogsOptionalCoherence.absenceRemainsMissingEvidence, true);
    assert.ok(elmiene.missingEvidence.includes("discogs_artist_id"));
    assert.deepEqual(routeIdentityReport(elmiene), { state: "identity_coherent", reasonCode: "identity_evidence_coherent" });

    const sameName = fixtureReport(lowRiskFixture.sameNameSpotifyCompetitor);
    assert.equal(sameName.outcome, "insufficient_corroboration");
    assert.equal(sameName.discogsOptionalCoherence.qualifies, false);
    assert.deepEqual(sameName.discogsOptionalCoherence.sameNameSpotifyConflicts, ["0000000000000000000012"]);
    assert.equal(routeIdentityReport(sameName).state, "needs_review");

    const failedAcquisition = structuredClone(lowRiskFixture.elmiene.acquisition);
    failedAcquisition.providerErrors = [{ provider: "discogs", operation: "artist", statusCode: 503, message: "Fixture provider failure." }];
    const failed = resolveIdentityAcquisition({ name: { raw: "Elmiene" }, candidateIdentifiers: { spotifyArtistId: lowRiskFixture.elmiene.spotifyArtistId } }, failedAcquisition);
    assert.equal(failed.outcome, "insufficient_corroboration");
    assert.equal(failed.discogsOptionalCoherence.qualifies, false);
    assert.equal(failed.discogsOptionalCoherence.providerEvidenceComplete, false);
});

test("mechanical closure explains every alternate and cannot cross-cover another provider", () => {
    const erykah = fixtureReport(lowRiskFixture.erykahBadu);
    assert.equal(erykah.outcome, "provider_profile_multiplicity");
    assert.equal(erykah.conflictResolution.mechanicalClosure.mechanicallyClosed, true);
    assert.deepEqual(erykah.conflictResolution.mechanicalClosure.reasons, []);
    assert.equal(erykah.conflictResolution.mechanicalClosure.explainedAlternates.length, 2);
    assert.deepEqual(routeIdentityReport(erykah), { state: "identity_coherent", reasonCode: "identity_provider_multiplicity_mechanically_closed" });

    const charli = fixtureReport(lowRiskFixture.charliXcx);
    assert.equal(charli.outcome, "provider_profile_multiplicity");
    assert.equal(charli.conflictResolution.mechanicalClosure.mechanicallyClosed, false);
    assert.ok(charli.conflictResolution.mechanicalClosure.reasons.includes("unresolved_alternate_spotify_identifier"));
    assert.equal(routeIdentityReport(charli).state, "needs_review");

    const tyler = fixtureReport(lowRiskFixture.tylerPersona);
    assert.equal(tyler.outcome, "provider_profile_multiplicity");
    assert.equal(tyler.conflictResolution.mechanicalClosure.mechanicallyClosed, false);
    assert.ok(tyler.conflictResolution.mechanicalClosure.reasons.includes("musicbrainz_identifier_not_unique"));
    assert.equal(routeIdentityReport(tyler).state, "needs_review");

    const solange = fixtureReport(lowRiskFixture.solangeSameName);
    assert.equal(solange.outcome, "provider_profile_multiplicity");
    assert.equal(solange.conflictResolution.mechanicalClosure.mechanicallyClosed, false);
    assert.ok(solange.conflictResolution.mechanicalClosure.reasons.includes("same_name_ambiguity_present_or_not_evaluated"));
    assert.equal(routeIdentityReport(solange).state, "needs_review");

    const frankie = fixtureReport(lowRiskFixture.frankieProject);
    assert.equal(frankie.outcome, "unresolved_identity");
    assert.equal(frankie.conflictResolution.mechanicalClosure.mechanicallyClosed, false);
    assert.ok(frankie.conflictResolution.mechanicalClosure.reasons.includes("unresolved_alternate_spotify_identifier"));
    assert.equal(routeIdentityReport(frankie).state, "failed_match");
});

test("mechanical closure requires non-empty legal names on every active Discogs alternate", () => {
    for (const [fixtureName, fixture] of Object.entries(multiplicityHardeningFixture)) {
        const discogsArtistIds = Object.keys(fixture.discogsRecords);
        const claims = [
            { identifierType: "spotifyArtistId", value: fixture.spotifyArtistId },
            { identifierType: "wikidataQid", value: fixture.wikidataQid },
            { identifierType: "musicBrainzArtistId", value: fixture.musicBrainzArtistId },
            ...discogsArtistIds.map(value => ({ identifierType: "discogsArtistId", value }))
        ];
        const assessmentInput = {
            claims,
            musicBrainzRecords: { [fixture.musicBrainzArtistId]: { artist: { musicBrainzArtistId: fixture.musicBrainzArtistId } } },
            discogsRecords: fixture.discogsRecords,
            resolution: {
                interpretation: {
                    conflictType: "provider_profile_multiplicity",
                    signals: { semanticContradictions: [], unresolvedIdentifiers: [] }
                },
                hasPositiveCatalogAnchor: true
            },
            sameNameAudit: { sameNameAmbiguity: "none_observed" },
            providerErrors: [],
            storedSpotifyArtistId: fixture.spotifyArtistId,
            spotifyConfirmedByMusicBrainz: true
        };
        const result = assessMechanicallyClosedProviderMultiplicity(assessmentInput);
        assert.equal(result.mechanicallyClosed, fixture.expectedClosed, fixtureName);
        if (fixture.expectedReason) assert.ok(result.reasons.includes(fixture.expectedReason), fixtureName);
        if (fixture.expectedClosed) {
            assert.deepEqual(result.reasons, [], fixtureName);
            assert.equal(result.explainedAlternates.length, discogsArtistIds.length, fixtureName);
            assert.ok(result.explainedAlternates.every(item => item.explanation === "mutual_alias_and_shared_nonempty_legal_name"), fixtureName);
        } else {
            assert.equal(result.explainedAlternates.length, 0, fixtureName);
            assert.ok(result.reasons.includes("discogs_alternates_lack_corroborated_legal_name_relationship"), fixtureName);
        }
        if (fixtureName === "aliasGraphWithoutLegalNameEvidence") {
            const explicitlyCorroborated = assessMechanicallyClosedProviderMultiplicity({
                ...assessmentInput,
                legalNameRelationshipEvidence: [{
                    relationshipType: "legal_name_stage_name",
                    discogsArtistIds,
                    providerAssertion: { source: "discogs", evidenceRef: "provider-cache/discogs/alias-graph.json" },
                    independentCorroboration: [{ source: "musicbrainz", evidenceRef: "provider-cache/musicbrainz/legal-name-relation.json" }]
                }]
            });
            assert.equal(explicitlyCorroborated.mechanicallyClosed, true);
            assert.ok(explicitlyCorroborated.explainedAlternates.every(item => item.explanation === "mutual_alias_and_independently_corroborated_legal_name_relationship"));
        }
    }
});

test("a mechanically closed multiplicity routes coherent without approving identity", async t => {
    const context = await setup(t);
    const fixture = lowRiskFixture.erykahBadu;
    const candidate = await createPending(context.store, fixture.spotifyArtistId, fixture.name);
    const resolver = new FixtureIdentityResolver({ [fixture.spotifyArtistId]: { label: fixture.name, acquisition: structuredClone(fixture.acquisition) } });
    const worker = new IdentityQueueWorker({ store: context.store, resolver, evidenceStore: context.evidenceStore, clock: context.clock });
    const run = await worker.run({ candidateId: candidate.candidateId, limit: 1 });
    assert.equal(run.processed, 1);
    const resolved = await context.store.readCandidate(candidate.candidateId);
    assert.equal(resolved.state, "identity_coherent");
    assert.equal(resolved.resolvedIdentity.outcome, "provider_profile_multiplicity");
    assert.equal(resolved.resolvedIdentity.providerMultiplicity.mechanicalClosure.mechanicallyClosed, true);
    assert.equal(resolved.approval.status, "not_approved");
    assert.equal(resolved.musicRollIdReservation.status, "not_reserved");
    assert.equal(await context.store.verifySnapshot(candidate.candidateId), true);
});

test("bounded worker routes the seven-candidate fixture cohort and continues after failure", async t => {
    const context = await setup(t);
    const order = [
        ["0000000000000000000007", "Temporary Artist"],
        ["7tYKF4w9nC0nq9CsPZTHyP", "SZA"],
        ["6olE6TJLqED3rqDCT0FyPh", "Nirvana"],
        ["6vWDO969PvNqNYHIOW5v0m", "Beyoncé"],
        ["0000000000000000000004", "Fallback Artist"],
        ["0000000000000000000005", "Insufficient Artist"],
        ["0000000000000000000006", "Conflict Artist"]
    ];
    const candidates = new Map();
    for (const [spotifyArtistId, name] of order) candidates.set(spotifyArtistId, await createPending(context.store, spotifyArtistId, name));
    const resolver = new FixtureIdentityResolver(structuredClone(scenariosFixture), { fixtureRef: `test/fixtures/${path.relative(path.join(__dirname, "fixtures"), fixturePath)}` });
    const worker = new IdentityQueueWorker({ store: context.store, resolver, evidenceStore: context.evidenceStore, clock: context.clock });
    const run = await worker.run({ limit: 7 });
    assert.equal(run.selected, 7);
    assert.equal(run.processed, 6);
    assert.equal(run.retryWait, 1);
    assert.equal(run.workerErrors, 0);

    const expected = {
        "7tYKF4w9nC0nq9CsPZTHyP": ["identity_coherent", "coherent_identity_evidence"],
        "6olE6TJLqED3rqDCT0FyPh": ["needs_review", "coherent_identity_with_same_name_ambiguity"],
        "6vWDO969PvNqNYHIOW5v0m": ["identity_coherent", "provider_profile_multiplicity"],
        "0000000000000000000004": ["identity_coherent", "coherent_identity_evidence"],
        "0000000000000000000005": ["needs_review", "insufficient_corroboration"],
        "0000000000000000000006": ["conflicting_identity", "semantic_identity_conflict"],
        "0000000000000000000007": ["retry_wait", "unresolved_identity"]
    };
    for (const [spotifyArtistId, [state, outcome]] of Object.entries(expected)) {
        const candidate = await context.store.readCandidate(candidates.get(spotifyArtistId).candidateId);
        assert.equal(candidate.state, state);
        assert.equal(candidate.resolvedIdentity.outcome, outcome);
        assert.equal(candidate.resolvedIdentity.identityConfidence.value, null);
        assert.equal(candidate.approval.status, "not_approved");
        assert.equal(candidate.processing.lease, null);
        assert.equal(await context.store.verifySnapshot(candidate.candidateId), true);
    }
    assert.equal((await context.store.readCandidate(candidates.get("6olE6TJLqED3rqDCT0FyPh").candidateId)).resolvedIdentity.sameNameAmbiguity.sameNameAmbiguity, "multiple_exact_display_name_entities");
    assert.equal((await context.store.readCandidate(candidates.get("6vWDO969PvNqNYHIOW5v0m").candidateId)).resolvedIdentity.providerMultiplicity.qualifiesAsProviderMultiplicity, true);
    assert.equal((await context.store.readCandidate(candidates.get("6vWDO969PvNqNYHIOW5v0m").candidateId)).resolvedIdentity.providerMultiplicity.mechanicalClosure.mechanicallyClosed, true);
    assert.equal(context.metrics.liveRequests, 0);
});

test("rerunning unchanged completed evidence creates no events or evidence", async t => {
    const context = await setup(t);
    const candidate = await createPending(context.store, "7tYKF4w9nC0nq9CsPZTHyP", "SZA");
    const resolver = new FixtureIdentityResolver(structuredClone(scenariosFixture));
    const worker = new IdentityQueueWorker({ store: context.store, resolver, evidenceStore: context.evidenceStore, clock: context.clock });
    const first = await worker.run({ candidateId: candidate.candidateId, limit: 1 });
    const eventsBefore = await context.store.readEvents(candidate.candidateId);
    const evidenceFiles = await allJsonFiles(context.evidenceStore.evidenceRoot);
    const evidenceBefore = await fileHashes(evidenceFiles);
    const second = await worker.run({ candidateId: candidate.candidateId, limit: 1 });
    assert.equal(first.processed, 1);
    assert.equal(second.selected, 0);
    assert.equal((await context.store.readEvents(candidate.candidateId)).length, eventsBefore.length);
    assert.deepEqual(await fileHashes(await allJsonFiles(context.evidenceStore.evidenceRoot)), evidenceBefore);
    assert.equal(resolver.calls.length, 1);
});

test("content-addressed provider evidence is immutable and reusable", async t => {
    const context = await setup(t);
    const candidate = await createPending(context.store, "0000000000000000000005", "Evidence Artist");
    const payload = { report: { outcome: "insufficient_corroboration" }, acquisition: { provider: "fixture" } };
    const first = await context.evidenceStore.persistIdentityEvidence(candidate.candidateId, payload, ["fixture:one"]);
    const second = await context.evidenceStore.persistIdentityEvidence(candidate.candidateId, structuredClone(payload), ["fixture:one"]);
    assert.deepEqual(first, second);
    assert.equal((await allJsonFiles(context.evidenceStore.evidenceRoot)).length, 1);
    assert.equal(context.metrics.immutableEvidenceWrites, 1);
    assert.equal(context.metrics.immutableEvidenceReuses, 1);
});

test("offline cache mode refuses acquisition before invoking a provider", async t => {
    const context = await setup(t);
    let called = false;
    await assert.rejects(() => context.evidenceStore.getOrAcquire({
        provider: "wikidata",
        identifier: "0000000000000000000008",
        operation: "spotify-bridge",
        acquire: async () => { called = true; return {}; }
    }), OfflineCacheMissError);
    assert.equal(called, false);
    assert.equal(context.metrics.liveRequests, 0);
});

test("a stale worker cannot overwrite a concurrent candidate transition", async t => {
    const context = await setup(t);
    const candidate = await createPending(context.store, "7tYKF4w9nC0nq9CsPZTHyP", "SZA");
    const fixture = structuredClone(scenariosFixture["7tYKF4w9nC0nq9CsPZTHyP"].acquisition);
    const resolver = {
        async resolve(acquired) {
            await context.store.transitionCandidate(acquired.candidateId, {
                expectedRevision: acquired.revision,
                nextState: "needs_review",
                reasonCode: "concurrent_human_review_hold",
                actor: { type: "human", id: "fixture_reviewer" }
            });
            return { report: resolveIdentityAcquisition(acquired, fixture), acquisition: fixture, provenanceRefs: ["fixture:stale"] };
        }
    };
    const worker = new IdentityQueueWorker({ store: context.store, resolver, evidenceStore: context.evidenceStore, clock: context.clock });
    const result = await worker.run({ candidateId: candidate.candidateId, limit: 1 });
    assert.equal(result.staleRevisions, 1);
    const current = await context.store.readCandidate(candidate.candidateId);
    assert.equal(current.state, "needs_review");
    assert.equal(current.resolvedIdentity.outcome, "unresolved_identity");
    assert.equal(current.revision, 4);
    assert.equal(await context.store.verifySnapshot(candidate.candidateId), true);
});

test("retry_wait resumes after its deterministic retry time", async t => {
    const context = await setup(t);
    const spotifyArtistId = "0000000000000000000007";
    const candidate = await createPending(context.store, spotifyArtistId, "Temporary Artist");
    const scenarios = structuredClone(scenariosFixture);
    const resolver = new FixtureIdentityResolver(scenarios);
    const worker = new IdentityQueueWorker({ store: context.store, resolver, evidenceStore: context.evidenceStore, clock: context.clock, retryDelayMs: 60000 });
    const first = await worker.run({ candidateId: candidate.candidateId, limit: 1 });
    assert.equal(first.retryWait, 1);
    const fallback = structuredClone(scenariosFixture["0000000000000000000004"]);
    fallback.acquisition.exactSpotifyUrlLookup.spotifyArtistUrl = `https://open.spotify.com/artist/${spotifyArtistId}`;
    fallback.acquisition.musicBrainzRecords["00000000-0000-4000-8000-000000000004"].artist.externalUrls[0].url = `https://open.spotify.com/artist/${spotifyArtistId}`;
    scenarios[spotifyArtistId] = fallback;
    context.time.value += 61000;
    const second = await worker.run({ candidateId: candidate.candidateId, limit: 1 });
    assert.equal(second.processed, 1);
    const resolved = await context.store.readCandidate(candidate.candidateId);
    assert.equal(resolved.state, "identity_coherent");
    assert.equal(resolved.resolvedIdentity.outcome, "coherent_identity_evidence");
    assert.equal(resolved.processing.attemptsByStep.identity, 2);
    assert.equal(await context.store.verifySnapshot(candidate.candidateId), true);
});

test("Stage 3 fixture processing does not alter protected live files", async t => {
    const artistPath = path.join(__dirname, "..", "data", "artists.json");
    const registryPath = path.join(__dirname, "..", "data", "artist-id-registry.json");
    const before = await fileHashes([artistPath, registryPath]);
    const context = await setup(t);
    const candidate = await createPending(context.store, "0000000000000000000004", "Fallback Artist");
    const worker = new IdentityQueueWorker({ store: context.store, resolver: new FixtureIdentityResolver(structuredClone(scenariosFixture)), evidenceStore: context.evidenceStore, clock: context.clock });
    await worker.run({ candidateId: candidate.candidateId, limit: 1 });
    assert.deepEqual(await fileHashes([artistPath, registryPath]), before);
});
