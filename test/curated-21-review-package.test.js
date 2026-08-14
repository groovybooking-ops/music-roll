const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildCurated21ReviewPackage, EXCLUDED_NAMES } = require("../lib/curated-21-review-package");
const { validateArtistDirectoryV2, validateRegistry } = require("../lib/music-roll-v2");

const root = path.join(__dirname, "..");
const readJson = relative => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
const evidenceRef = "data/identity-experiments/curated-26-reconsideration/curated-26-2026-08-14T05-23-01-208Z/cohort-summary.review.json";
function build() {
    const packagePreview = readJson("data/identity-experiments/curated-21-review-migration-package/curated-21-2026-08-14T05-28-44-713Z/artists-v2-migration-ready.preview.json");
    const liveArtists = packagePreview.slice(0, 20);
    const liveIds = new Set(liveArtists.map(artist => artist.musicRollId));
    const mappings = readJson("data/artist-id-registry.json").mappings.filter(mapping => liveIds.has(mapping.musicRollId));
    const { mappingsChecksum } = require("../lib/music-roll-v2");
    const permanentRegistry = { schemaVersion: 1, mappings, mappingsSha256: mappingsChecksum(mappings) };
    return buildCurated21ReviewPackage({ accounting: readJson("data/artists-46-v2.accounting.preview.json"), registryExtension: readJson("data/artist-id-registry-46.extension.preview.json"), reconsideration: readJson(evidenceRef), liveArtists, permanentRegistry, generatedAt: "2026-08-14T06:00:00.000Z", evidenceRef });
}

test("selects exactly the requested 6 coherent, 4 ambiguous, and 11 multiplicity candidates", () => {
    const result = build();
    assert.deepEqual(result.humanReview.countsByOutcome, { coherent_identity_evidence: 6, coherent_identity_with_same_name_ambiguity: 4, provider_profile_multiplicity: 11 });
    assert.equal(result.humanReview.artists.length, 21);
    assert.ok(EXCLUDED_NAMES.every(name => !result.humanReview.artists.some(artist => artist.artistName === name)));
});

test("preserves curated-46 proposed IDs without renumbering gaps", () => {
    const result = build();
    const byName = new Map(result.humanReview.artists.map(artist => [artist.artistName, artist.proposedMusicRollId]));
    assert.equal(byName.get("Fana Hues"), "mr_artist_000008");
    assert.equal(byName.get("redveil"), "mr_artist_000015");
    assert.equal(byName.get("Kendrick Lamar"), "mr_artist_000017");
    assert.equal(byName.get("Donna Summer"), "mr_artist_000045");
    assert.ok(!new Set(byName.values()).has("mr_artist_000009"));
});

test("keeps all 20 live records unchanged and produces a valid unique 41-record preview", () => {
    const live = readJson("data/identity-experiments/curated-21-review-migration-package/curated-21-2026-08-14T05-28-44-713Z/artists-v2-migration-ready.preview.json").slice(0, 20);
    const result = build();
    assert.deepEqual(result.migrationPreview.slice(0, 20), live);
    assert.equal(result.migrationPreview.length, 41);
    assert.equal(validateArtistDirectoryV2(result.migrationPreview), true);
    assert.equal(validateRegistry(result.registryPreview, result.migrationPreview), true);
    assert.equal(new Set(result.migrationPreview.map(artist => artist.musicRollId)).size, 41);
    assert.equal(new Set(result.migrationPreview.map(artist => artist.spotifyId)).size, 41);
});

test("all proposed records are explicitly not approved and contain no invented metadata", () => {
    const result = build();
    for (const artist of result.migrationPreview.slice(20)) {
        assert.equal(artist.identity.status, "not_approved");
        assert.equal(artist.identity.confidence, null);
        assert.equal(artist.migrationEligible, false);
        assert.deepEqual(Object.keys(artist.externalIds), ["spotify"]);
        assert.deepEqual(artist.socialUrls, { instagram: null, tiktok: null });
        assert.deepEqual(artist.geography.home, { city: null, region: null, country: null, coordinates: null });
        assert.equal(artist.geography.confidence, "unknown");
    }
    assert.ok(result.registryPreview.mappings.slice(20).every(mapping => mapping.approvalState === "not_approved" && mapping.migrationEligible === false));
});

test("curated genre and stage remain exact and review notes match the outcome", () => {
    const accounting = readJson("data/artists-46-v2.accounting.preview.json");
    const sourceBySpotify = new Map(accounting.records.map(record => [record.spotify.id, record]));
    const result = build();
    for (const artist of result.humanReview.artists) {
        const source = sourceBySpotify.get(artist.spotifyId);
        assert.equal(artist.genre, source.genre);
        assert.equal(artist.stage, source.stage);
        assert.equal(artist.approvalState, "not_approved");
        assert.equal(artist.migrationEligible, false);
        if (artist.identityOutcome === "coherent_identity_with_same_name_ambiguity") assert.ok(artist.sameNameAmbiguityNote?.note);
        else assert.equal(artist.sameNameAmbiguityNote, null);
        if (artist.identityOutcome === "provider_profile_multiplicity") assert.ok(artist.providerProfileMultiplicityNote?.note);
        else assert.equal(artist.providerProfileMultiplicityNote, null);
    }
});
