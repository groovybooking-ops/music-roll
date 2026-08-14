const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getWikidataIdentityBridge } = require("../lib/wikidata-client");
const { normalizeArtist: normalizeDiscogs } = require("../lib/discogs-client");
const { normalizeArtist: normalizeMusicBrainz } = require("../lib/musicbrainz-client");
const { auditSameNameMusicBrainzEntities, compareIdentityEvidence } = require("../lib/identity-evidence-comparison");

const fixture = relative => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", relative), "utf8"));
const spotifyId = "7tYKF4w9nC0nq9CsPZTHyP";
const qidRaw = fixture("wikidata/sza-spotify-bridge.json");
const discogs = normalizeDiscogs(fixture("discogs/sza-artist.json"), "3272791");
const musicBrainz = normalizeMusicBrainz(fixture("musicbrainz-exact/sza-artist.json"), "272989c8-5535-492d-a25c-9f58803e027f");

test("Wikidata bridge uses the exact Spotify ID and normalizes linked IDs", async () => {
    let requestedUrl;
    const result = await getWikidataIdentityBridge(spotifyId, { fetchImpl: async url => { requestedUrl = url; return { ok: true, status: 200, json: async () => qidRaw }; } });
    assert.match(decodeURIComponent(requestedUrl), new RegExp(spotifyId));
    assert.deepEqual(result.bridge, { spotifyArtistId: spotifyId, wikidataQid: "Q16210722", name: "SZA", musicBrainzArtistId: "272989c8-5535-492d-a25c-9f58803e027f", discogsArtistId: "3272791" });
});

test("comparison reports identifier agreement without calculating confidence", () => {
    const wikidata = { spotifyArtistId: spotifyId, wikidataQid: "Q16210722", name: "SZA", musicBrainzArtistId: musicBrainz.musicBrainzArtistId, discogsArtistId: discogs.discogsArtistId };
    const result = compareIdentityEvidence({ spotifyArtistId: spotifyId, wikidata, discogs, musicBrainz });
    assert.equal(result.identifierComparison.spotifyArtistId.status, "agreement");
    assert.equal(result.identifierComparison.musicBrainzArtistId.status, "agreement");
    assert.equal(result.identifierComparison.discogsArtistId.status, "agreement");
    assert.equal(result.confidenceScoreCalculated, false);
    assert.equal(result.automaticIdentityDecisionMade, false);
});

test("repeated links preserve provenance and do not become unnamed confirmations", () => {
    const wikidata = { spotifyArtistId: spotifyId, wikidataQid: "Q16222597", name: "SZA", musicBrainzArtistId: musicBrainz.musicBrainzArtistId, discogsArtistId: discogs.discogsArtistId };
    const musicBrainzWithSpotifyLink = structuredClone(musicBrainz);
    musicBrainzWithSpotifyLink.externalUrls.push({ relationshipType: "free streaming", url: `https://open.spotify.com/artist/${spotifyId}` });
    const result = compareIdentityEvidence({ spotifyArtistId: spotifyId, wikidata, discogs, musicBrainz: musicBrainzWithSpotifyLink });
    const spotifyClaims = result.identifierComparison.spotifyArtistId.claims;
    assert.deepEqual(spotifyClaims.map(claim => claim.source).sort(), ["music_roll_input", "musicbrainz", "wikidata"]);
    assert.equal(result.identifierComparison.spotifyArtistId.independentSourceCount, 3);
    assert.ok(spotifyClaims.every(claim => claim.path));
});

test("conflicting identifiers are explicit", () => {
    const wikidata = { spotifyArtistId: spotifyId, wikidataQid: "Q999", name: "SZA", musicBrainzArtistId: "00000000-0000-4000-8000-000000000001", discogsArtistId: "999" };
    const result = compareIdentityEvidence({ spotifyArtistId: spotifyId, wikidata, discogs, musicBrainz });
    assert.equal(result.identifierComparison.musicBrainzArtistId.status, "conflict");
    assert.equal(result.identifierComparison.discogsArtistId.status, "conflict");
    assert.equal(result.conflicts.length, 3);
});

test("same-name ambiguity remains separate from exact-ID agreement", () => {
    const candidates = [
        { musicBrainzArtistId: "5b11f4ce-a62d-471e-81fc-a69a8278c7da", name: "Nirvana", artistType: "Group", country: "US" },
        { musicBrainzArtistId: "30751300-0000-4000-8000-000000000001", name: "Nirvana", artistType: "Group", country: "GB" }
    ];
    const details = [
        { ...candidates[0], externalUrls: [{ relationshipType: "streaming", url: "https://open.spotify.com/artist/6olE6TJLqED3rqDCT0FyPh" }, { relationshipType: "discogs", url: "https://www.discogs.com/artist/125246" }] },
        { ...candidates[1], externalUrls: [{ relationshipType: "streaming", url: "https://open.spotify.com/artist/COMPETINGSPOTIFY00001" }, { relationshipType: "discogs", url: "https://www.discogs.com/artist/307513" }] }
    ];
    const audit = auditSameNameMusicBrainzEntities(candidates[0].musicBrainzArtistId, candidates, details);
    assert.equal(audit.sameNameAmbiguity, "multiple_exact_display_name_entities");
    assert.equal(audit.competingEntityCount, 1);
    assert.deepEqual(audit.competingEntities[0].discogsArtistIds, ["307513"]);
});
