const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildReviewMigrationPackage } = require("../lib/review-migration-package");
const { mappingsChecksum, validateArtistDirectoryV2 } = require("../lib/music-roll-v2");

const readJson = relative => JSON.parse(fs.readFileSync(path.join(__dirname, "..", relative), "utf8"));
function build() {
    const liveArtists = readJson("data/artists-v2.preview.json");
    const mappings = readJson("data/artist-id-registry.json").mappings.slice(0, 6);
    const permanentRegistry = { schemaVersion: 1, mappings, mappingsSha256: mappingsChecksum(mappings) };
    return buildReviewMigrationPackage({ accounting: readJson("data/artists-46-v2.accounting.preview.json"), reanalysis: readJson("data/identity-experiments/curated-40-provider-multiplicity-reanalysis/curated-40-provider-multiplicity-reanalysis-2026-08-14T04-18-32-340Z.review.json"), liveArtists, permanentRegistry, generatedAt: "2026-08-14T00:00:00.000Z", evidenceRef: "fixture://curated-40-reanalysis" });
}

test("review package contains six permanent and fourteen deterministic proposed IDs", () => {
    const result = build();
    assert.equal(result.humanReview.artists.length, 14);
    assert.equal(result.migrationPreview.length, 20);
    assert.deepEqual(result.migrationPreview.slice(0, 6).map(item => item.musicRollId), ["mr_artist_000001", "mr_artist_000002", "mr_artist_000003", "mr_artist_000004", "mr_artist_000005", "mr_artist_000006"]);
    assert.equal(result.humanReview.artists.find(item => item.curatedName === "Beyoncé").proposedMusicRollId, "mr_artist_000011");
    assert.equal(result.humanReview.artists.find(item => item.curatedName === "Peggy Gou").proposedMusicRollId, "mr_artist_000042");
});

test("proposed artists remain unverified candidates and the v2 preview validates", () => {
    const result = build();
    assert.equal(validateArtistDirectoryV2(result.migrationPreview), true);
    assert.ok(result.migrationPreview.slice(6).every(item => item.identity.status === "review_only_candidate" && item.identity.confidence === null && item.status.directory === "candidate"));
    assert.ok(result.registryPreview.mappings.slice(6).every(item => item.approvalState === "proposed_not_permanent" && item.migrationEligible === false && item.humanApprovalRequired === true));
});

test("human review includes curated presentation and multiplicity evidence notes", () => {
    const result = build();
    assert.ok(result.humanReview.artists.every(item => item.curatedName && item.genre && item.stage && item.spotifyId && item.spotifyUrl && item.image && item.evidenceSummary));
    assert.ok(result.humanReview.artists.find(item => item.curatedName === "Little Simz").providerProfileMultiplicityNotes.includes("mutually_linked_discogs_alias_profiles"));
    assert.deepEqual(result.humanReview.safety, { identitiesApproved: 0, identitiesVerified: 0, migrationsPerformed: 0, liveDirectoryModified: false, permanentRegistryModified: false, apiRequests: 0 });
});
