const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildCohortReview } = require("../lib/artist-cohort-v2");
const { validateArtistDirectoryV2 } = require("../lib/music-roll-v2");
const { adaptArtistDirectory } = require("../artist-model-adapter");

const root = path.join(__dirname, "..");
const read = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const inputs = () => ({
    sourceArtists: read("data/artists-source.json"),
    enrichedArtists: read("data/artists-enriched.preview.json").artists,
    liveArtists: read("data/artists.json"),
    registry: read("data/artist-id-registry.json"),
    generatedAt: "2026-08-12T00:00:00.000Z"
});

test("accounts for all 46 while keeping identity separate from migration eligibility", () => {
    const result = buildCohortReview(inputs());
    assert.equal(result.accounting.records.length, 46);
    assert.equal(result.accounting.summary.migrationEligible, 6);
    assert.equal(result.accounting.summary.migrationBlocked, 40);
    assert.ok(result.accounting.records.every(record => record.identity.status && typeof record.migrationDecision.eligible === "boolean"));
    assert.ok(result.accounting.records.filter(record => !record.existingLive).every(record => !record.migrationDecision.eligible));
});

test("preserves six permanent IDs and proposes 000007 through 000046 deterministically", () => {
    const result = buildCohortReview(inputs());
    const existing = Object.fromEntries(result.accounting.records.filter(record => record.existingLive).map(record => [record.name, record.proposedMusicRollId]));
    assert.deepEqual(existing, {
        GROOVY: "mr_artist_000001", SZA: "mr_artist_000002", Drake: "mr_artist_000003",
        "Michael Jackson": "mr_artist_000004", "Brent Faiyaz": "mr_artist_000005", Amaarae: "mr_artist_000006"
    });
    const proposed = result.registryPreview.mappings.filter(item => item.approvalState === "proposed_not_permanent");
    assert.equal(proposed[0].musicRollId, "mr_artist_000007");
    assert.equal(proposed.at(-1).musicRollId, "mr_artist_000046");
    assert.equal(new Set(result.registryPreview.mappings.map(item => item.musicRollId)).size, 46);
    assert.equal(new Set(result.registryPreview.mappings.map(item => item.spotifyId)).size, 46);
});

test("migration-ready preview contains only schema-valid eligible live artists", () => {
    const input = inputs();
    const result = buildCohortReview(input);
    assert.equal(result.migrationReady.length, 6);
    assert.equal(validateArtistDirectoryV2(result.migrationReady), true);
    assert.deepEqual(adaptArtistDirectory(result.migrationReady), adaptArtistDirectory(input.liveArtists));
});

test("rejects duplicate Spotify IDs, duplicate artists, and classification drift", () => {
    const duplicateSpotify = inputs();
    duplicateSpotify.enrichedArtists[1].spotifyId = duplicateSpotify.enrichedArtists[0].spotifyId;
    assert.throws(() => buildCohortReview(duplicateSpotify), /Duplicate Spotify ID/);
    const duplicateArtist = inputs();
    duplicateArtist.sourceArtists[1].name = duplicateArtist.sourceArtists[0].name;
    assert.throws(() => buildCohortReview(duplicateArtist), /Duplicate curated artist names/);
    const drift = inputs();
    drift.enrichedArtists[0].tier = "mainstream";
    assert.throws(() => buildCohortReview(drift), /classification drift/i);
});

test("blocked proposals contain no invented provider, geography, or social data", () => {
    const result = buildCohortReview(inputs());
    assert.ok(result.registryPreview.mappings.filter(item => !item.migrationEligible).every(item => item.approvalState === "proposed_not_permanent"));
    assert.equal(result.migrationReady.some(item => item.identity.status !== "verified_existing"), false);
});
