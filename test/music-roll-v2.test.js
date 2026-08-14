const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
    mappingsChecksum, validateArtistDirectoryV2, validateArtistV2,
    validateEventV1, validateEvidenceV1, validateRegistry
} = require("../lib/music-roll-v2");

const root = path.join(__dirname, "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "data", "artist-id-registry.json"), "utf8"));

function artist() {
    return {
        musicRollId: "mr_artist_000001", schemaVersion: 2,
        editorial: { stage: "emerging", stageConfidence: null },
        genres: ["rnb"], primaryGenre: "rnb", genre: "rnb", tier: "emerging",
        externalIds: { spotify: "spotify-one" }, externalUrls: { spotify: "https://open.spotify.com/artist/spotify-one" },
        spotifyId: "spotify-one", spotify: "https://open.spotify.com/artist/spotify-one",
        image: "image", media: { primaryImageUrl: "image" },
        geography: { home: { city: null, region: null, country: null, coordinates: null }, confidence: "unknown", sceneAssociations: [] }
    };
}

test("validates the permanent registry and checksum", () => {
    assert.equal(mappingsChecksum(registry.mappings), registry.mappingsSha256);
    assert.equal(validateRegistry(registry), true);
});

test("registry rejects duplicate IDs, duplicate Spotify bindings, and mapping drift", () => {
    const duplicateId = structuredClone(registry);
    duplicateId.mappings[1].musicRollId = duplicateId.mappings[0].musicRollId;
    assert.throws(() => validateRegistry(duplicateId), /Duplicate Music Roll ID/);
    const duplicateSpotify = structuredClone(registry);
    duplicateSpotify.mappings[1].spotifyId = duplicateSpotify.mappings[0].spotifyId;
    assert.throws(() => validateRegistry(duplicateSpotify), /Spotify ID maps to multiple/);
    const drift = structuredClone(registry);
    drift.mappings[0].spotifyId = "changed";
    assert.throws(() => validateRegistry(drift), /checksum changed unexpectedly/);
});

test("artist v2 enforces stages and compatibility projections", () => {
    assert.equal(validateArtistV2(artist()), true);
    for (const mutate of [
        value => { value.editorial.stage = "local"; },
        value => { value.primaryGenre = "dance"; },
        value => { value.genres = ["dance", "rnb"]; },
        value => { value.tier = "mainstream"; },
        value => { value.spotifyId = "different"; },
        value => { value.spotify = "different"; },
        value => { value.image = "different"; }
    ]) {
        const invalid = structuredClone(artist());
        mutate(invalid);
        assert.throws(() => validateArtistV2(invalid));
    }
});

test("unknown external IDs are omitted and unverified coordinates fail closed", () => {
    const blankProvider = structuredClone(artist());
    blankProvider.externalIds.musicbrainz = null;
    assert.throws(() => validateArtistV2(blankProvider), /must be omitted/);
    const coordinatesWithoutPlace = structuredClone(artist());
    coordinatesWithoutPlace.geography.home.coordinates = { latitude: 1, longitude: 1 };
    assert.throws(() => validateArtistV2(coordinatesWithoutPlace), /identified city and country/);
});

test("directory IDs are unique", () => {
    assert.throws(() => validateArtistDirectoryV2([artist(), artist()]), /Duplicate Music Roll ID/);
});

test("event v1 and evidence v1 validate identity references", () => {
    assert.equal(validateEventV1({
        musicRollEventId: "mr_event_000001", schemaVersion: 1,
        musicRollArtistIds: ["mr_artist_000001"], provider: "ticketmaster",
        externalEventId: "event-one", location: { city: "New York", country: "US", coordinates: null },
        startsAt: "2026-09-01T20:00:00-04:00", retrievedAt: "2026-08-12T00:00:00Z",
        sourceProvenance: { sourceClass: "event_provider" }
    }), true);
    assert.equal(validateEvidenceV1({
        evidenceId: "mr_evidence_000001", schemaVersion: 1,
        musicRollArtistId: "mr_artist_000001", evidenceType: "geographic", payload: {},
        sourceClass: "editorial", observedAt: "2026-08-12T00:00:00Z", reviewStatus: "review_only"
    }), true);
    assert.throws(() => validateEvidenceV1({
        evidenceId: "mr_evidence_000001", schemaVersion: 1,
        musicRollArtistId: "mr_artist_000001", evidenceType: "fame", payload: {},
        sourceClass: "editorial", observedAt: "2026-08-12T00:00:00Z", reviewStatus: "review_only"
    }), /Invalid evidence type/);
});

test("permanent 41-artist directory validates and preserves the historical six", () => {
    const live = JSON.parse(fs.readFileSync(path.join(root, "data", "artists.json"), "utf8"));
    const preview = JSON.parse(fs.readFileSync(path.join(root, "data", "artists-v2.preview.json"), "utf8"));
    assert.equal(preview.length, 6);
    assert.equal(live.length, 41);
    assert.equal(validateArtistDirectoryV2(preview), true);
    assert.equal(validateArtistDirectoryV2(live), true);
    assert.deepEqual(live.map(item => item.musicRollId), registry.mappings.map(item => item.musicRollId));
    assert.deepEqual(
        preview.map(item => [item.name, item.genre, item.tier, item.spotifyId, item.spotify, item.image, item.instagram, item.tiktok]),
        live.slice(0, 6).map(item => [item.name, item.genre, item.tier, item.spotifyId, item.spotify, item.image, item.instagram, item.tiktok])
    );
    assert.ok(preview.every(item => Object.keys(item.externalIds).join(",") === "spotify"));
    assert.ok(preview.every(item => Object.values(item.geography.home).every(value => value === null)));
});
