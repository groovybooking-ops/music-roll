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

test("Wikidata separates repeated rows for one entity from conflicting linked IDs", async () => {
    const raw = structuredClone(qidRaw);
    raw.results.bindings.push(structuredClone(raw.results.bindings[0]));
    raw.results.bindings[1].musicBrainzArtistId.value = "00000000-0000-4000-8000-000000000001";
    const result = await getWikidataIdentityBridge(spotifyId, { fetchImpl: async () => ({ ok: true, status: 200, json: async () => raw }) });
    assert.equal(result.bridge.wikidataQid, "Q16210722");
    assert.equal(result.bridge.musicBrainzArtistId, null);
    assert.deepEqual(result.bridge.musicBrainzArtistIds, ["272989c8-5535-492d-a25c-9f58803e027f", "00000000-0000-4000-8000-000000000001"]);
    const comparison = compareIdentityEvidence({ spotifyArtistId: spotifyId, wikidata: result.bridge, musicBrainz: { externalUrls: [] }, discogs: { artistUrls: [] } });
    assert.equal(comparison.identifierComparison.musicBrainzArtistId.status, "conflict");
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
    const { expectedMbid, candidates, detailedArtists } = fixture("musicbrainz-exact/nirvana-ambiguity.json");
    const audit = auditSameNameMusicBrainzEntities(expectedMbid, candidates, detailedArtists);
    assert.equal(audit.sameNameAmbiguity, "multiple_exact_display_name_entities");
    assert.equal(audit.competingEntityCount, 1);
    assert.deepEqual(audit.competingEntities[0].spotifyArtistIds, ["0QTestCompetingArtist1"]);
    assert.deepEqual(audit.competingEntities[0].discogsArtistIds, ["307513"]);
});
