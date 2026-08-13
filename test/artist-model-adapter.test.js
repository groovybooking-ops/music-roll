const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const { adaptArtist, adaptArtistDirectory } = require("../artist-model-adapter.js");
const { compare, roll } = require("../experiments/v2-compatibility/parity-harness.js");

const root = path.join(__dirname, "..");
const v1Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "artist-model", "artists-v1.json"), "utf8"));
const v2Fixture = JSON.parse(fs.readFileSync(path.join(root, "data", "artists-v2.preview.json"), "utf8"));

test("dedicated v1 fixture remains immutable", () => {
    const bytes = fs.readFileSync(path.join(__dirname, "fixtures", "artist-model", "artists-v1.json"));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "6a8d17a9aea78fa918afd61cad7f561f1d741856ef7a0c4e2bed10339c1235d7");
});

test("adapts a valid v1 artist without changing compatibility values", () => {
    assert.deepEqual(adaptArtist(v1Fixture[0]), v1Fixture[0]);
});

test("derives v2 compatibility values from canonical fields", () => {
    assert.deepEqual(adaptArtist(v2Fixture[0]), adaptArtist(v1Fixture[0]));
});

test("all six dedicated v1 and v2 artists normalize identically", () => {
    assert.deepEqual(adaptArtistDirectory(v2Fixture), adaptArtistDirectory(v1Fixture));
});

test("rejects missing required fields and invalid stage or genre", () => {
    const missingV1SpotifyUrl = structuredClone(v1Fixture[0]);
    delete missingV1SpotifyUrl.spotify;
    assert.throws(() => adaptArtist(missingV1SpotifyUrl), /Artist v1 spotify must be/);
    const missingV2SpotifyUrl = structuredClone(v2Fixture[0]);
    delete missingV2SpotifyUrl.externalUrls.spotify;
    delete missingV2SpotifyUrl.spotify;
    assert.throws(() => adaptArtist(missingV2SpotifyUrl), /externalUrls.spotify/);
    const invalidStage = structuredClone(v2Fixture[0]);
    invalidStage.editorial.stage = "local";
    delete invalidStage.tier;
    assert.throws(() => adaptArtist(invalidStage), /Invalid artist stage/);
    const invalidGenre = structuredClone(v2Fixture[0]);
    invalidGenre.primaryGenre = "jazz";
    delete invalidGenre.genre;
    assert.throws(() => adaptArtist(invalidGenre), /Invalid artist primaryGenre/);
});

test("fails loudly when any v2 legacy field drifts", () => {
    for (const [field, value] of [["genre", "pop"], ["tier", "classic"], ["spotifyId", "wrong"], ["spotify", "wrong"], ["image", "wrong"], ["instagram", "wrong"], ["tiktok", "wrong"]]) {
        const drift = structuredClone(v2Fixture[0]);
        drift[field] = value;
        assert.throws(() => adaptArtist(drift), /compatibility drift/);
    }
});

test("rejects a v2 artist without a Spotify mapping", () => {
    const missing = structuredClone(v2Fixture[0]);
    delete missing.externalIds.spotify;
    assert.throws(() => adaptArtist(missing), /externalIds.spotify/);
});

test("preserves null social URLs", () => {
    const record = structuredClone(v2Fixture[0]);
    record.socialUrls = { instagram: null, tiktok: null };
    delete record.instagram;
    delete record.tiktok;
    assert.equal(adaptArtist(record).instagram, null);
    assert.equal(adaptArtist(record).tiktok, null);
});

test("future multi-genre records retain primaryGenre filtering behavior", () => {
    const record = structuredClone(v2Fixture[0]);
    record.genres = ["rnb", "dance"];
    assert.equal(adaptArtist(record).genre, "rnb");
    assert.equal(roll([adaptArtist(record)], "rnb", "emerging", 0).selected.name, "GROOVY");
    assert.equal(roll([adaptArtist(record)], "dance", "emerging", 0).empty, true);
});

test("browser parity model matches filtering, rolls, cards, links, images, and Roll Again", () => {
    const report = compare(v1Fixture, v2Fixture);
    assert.equal(report.directoriesIdentical, true);
    assert.equal(report.filteringParity, true);
    assert.equal(report.randomSelectionParity, true);
    assert.equal(report.resultCardParity, true);
    assert.equal(report.spotifyLinkParity, true);
    assert.equal(report.imageParity, true);
    assert.equal(report.rollAgainParity, true);
    assert.equal(report.mismatches.length, 0);
});

test("adapter and parity checks remain valid when the simulated live directory is schema v2", () => {
    const simulatedV2Live = structuredClone(v2Fixture);
    assert.deepEqual(adaptArtistDirectory(simulatedV2Live), adaptArtistDirectory(v1Fixture));
    const report = compare(v1Fixture, simulatedV2Live);
    assert.equal(report.directoriesIdentical, true);
    assert.equal(report.filteringParity, true);
    assert.equal(report.randomSelectionParity, true);
    assert.equal(report.resultCardParity, true);
    assert.equal(report.spotifyLinkParity, true);
    assert.equal(report.imageParity, true);
    assert.equal(report.rollAgainParity, true);
    assert.deepEqual(report.mismatches, []);
});
