const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { assessCorroboration, distinctiveTitleOverlap } = require("../lib/identity-corroboration");
const { fetchMusicBrainzJsonWithRetry, readFixtureJson } = require("../lib/cached-fixture-reader");

const fixtureRoot = path.join(__dirname, "fixtures", "identity-corroboration");
const manual = { status: "manual_review_required", confidence: 79, requiresHumanReview: true };
const verified = { status: "verified_existing", confidence: 100, requiresHumanReview: false };
const high = { status: "high_confidence_candidate", confidence: 95, requiresHumanReview: false };

test("cached Spotify and MusicBrainz fixture readers are path constrained", async () => {
    const spotify = await readFixtureJson(fixtureRoot, "spotify", "scenarios.json");
    const musicBrainz = await readFixtureJson(fixtureRoot, "musicbrainz", "scenarios.json");
    assert.ok(spotify.Future.catalogFingerprint);
    assert.equal(musicBrainz.Future.crossDatabaseIdentifiers.musicBrainzSpotifyUrl, "match");
    await assert.rejects(() => readFixtureJson(fixtureRoot, "spotify", "../../../package.json"), /escapes/);
});

test("existing verified IDs remain verified and controls do not regress", () => {
    assert.equal(assessCorroboration(verified, {}).status, "verified_existing");
    assert.equal(assessCorroboration(high, {}).status, "high_confidence_candidate");
});

test("empty alternatives alone cannot trigger promotion", () => {
    const result = assessCorroboration(manual, { catalogFingerprint: { primaryCoherent: true, emptyAlternativeCount: 3, complete: true } });
    assert.equal(result.status, "manual_review_required");
    assert.equal(result.independentCorroboration.satisfied, false);
});

test("direct MusicBrainz Spotify URL agreement strongly corroborates", () => {
    const result = assessCorroboration(manual, { crossDatabaseIdentifiers: { musicBrainzSpotifyUrl: "match" } });
    assert.equal(result.status, "high_confidence_candidate");
    assert.ok(result.independentCorroboration.strongClasses.includes("cross_database_identifiers"));
    assert.equal(result.inferredIdentityMarkedVerified, false);
});

test("multiple plausible same-name catalogs remain manual through a conflict gate", () => {
    const result = assessCorroboration(manual, {
        crossDatabaseIdentifiers: { musicBrainzSpotifyUrl: "match" },
        catalogFingerprint: { multiplePlausibleSameNameCatalogs: true, complete: true }
    });
    assert.equal(result.status, "conflicting_identity");
    assert.equal(result.requiresHumanReview, true);
});

test("artist type, chronology, and external identifier conflicts block promotion", () => {
    for (const fixture of [
        { crossDatabaseEntityMetadata: { artistType: "conflict" } },
        { catalogFingerprint: { chronology: "conflict" } },
        { crossDatabaseIdentifiers: { spotifyUrl: "conflict" } }
    ]) {
        const result = assessCorroboration(manual, { crossDatabaseIdentifiers: { musicBrainzSpotifyUrl: "match" }, ...fixture });
        assert.equal(result.status, "conflicting_identity");
    }
});

test("a matching identifier cannot erase conflicting same-name Spotify identifiers", () => {
    const result = assessCorroboration(manual, {
        crossDatabaseIdentifiers: {
            musicBrainzSpotifyUrl: "match",
            spotifyUrl: "conflict"
        }
    });
    assert.equal(result.status, "conflicting_identity");
    assert.ok(result.conflicts.some(conflict => conflict.type === "external_identifier_conflict"));
});

test("duplicate Spotify IDs produce conflicts", () => {
    const result = assessCorroboration(manual, { crossDatabaseIdentifiers: { musicBrainzSpotifyUrl: "match" } }, { duplicateSpotifyId: { otherArtist: "Collision" } });
    assert.equal(result.status, "conflicting_identity");
});

test("distinctive titles count while generic titles do not", () => {
    assert.deepEqual(distinctiveTitleOverlap(["Greatest Hits", "DS2", "HNDRXX"], ["Greatest Hits", "DS2", "HNDRXX"]), ["ds2", "hndrxx"]);
});

test("weak evidence alone never satisfies independent corroboration", () => {
    const result = assessCorroboration(manual, { weakPresentationEvidence: { imageAvailable: true, punctuationOrCaseAgreement: true, hasRelease: true } });
    assert.equal(result.status, "manual_review_required");
    assert.equal(result.independentCorroboration.satisfied, false);
});

test("partial dates and posthumous reissues are preserved but do not independently promote", () => {
    const result = assessCorroboration(manual, { catalogFingerprint: {
        partialDatePrecisions: ["year", "month"], posthumousOrReissueActivity: true, complete: true
    } });
    assert.equal(result.status, "manual_review_required");
    const catalog = result.evidenceClasses.find(item => item.class === "catalog_fingerprint");
    assert.deepEqual(catalog.evidence.find(item => item.type === "partial_date_precisions").result, ["year", "month"]);
});

test("incomplete catalogs cannot promote", () => {
    const result = assessCorroboration(manual, {
        crossDatabaseIdentifiers: { musicBrainzSpotifyUrl: "match" },
        catalogFingerprint: { complete: false }
    });
    assert.equal(result.status, "conflicting_identity");
});

test("MusicBrainz 503 behavior retries with backoff", async () => {
    let calls = 0;
    const waits = [];
    const data = await fetchMusicBrainzJsonWithRetry("fixture://artist", {
        fetchImpl: async () => {
            calls += 1;
            return calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ id: "mbid" }) };
        },
        waitImpl: async milliseconds => waits.push(milliseconds)
    });
    assert.deepEqual(data, { id: "mbid" });
    assert.deepEqual(waits, [1000]);
});

test("no inferred identity can become verified", () => {
    const result = assessCorroboration(manual, {
        crossDatabaseIdentifiers: { musicBrainzSpotifyUrl: "match", musicRollVerifiedExternalId: "match" },
        catalogFingerprint: { spotifyReleaseTitles: ["One", "Two", "Three"], musicBrainzReleaseTitles: ["One", "Two", "Three"], complete: true }
    });
    assert.equal(result.status, "high_confidence_candidate");
    assert.equal(result.inferredIdentityMarkedVerified, false);
});
