const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildReconsiderationReport, musicBrainzRelationshipClaims, selectExactSpotifyUrlCandidate } = require("../lib/curated-26-reconsideration");

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/curated-26-reconsideration/scenarios.json"), "utf8"));
const fingerprint = { releaseCount: 2, distinctiveTitles: ["first", "second"], earliestYear: 2020, latestYear: 2022 };
function artist(id, name, urls = [], artistType = "Person", begin = "1990-01-01") { return { artist: { musicBrainzArtistId: id, name, artistType, lifeSpan: { begin }, externalUrls: urls.map(url => ({ relationshipType: url.includes("spotify") ? "streaming music" : "discogs", url })) } }; }
function candidate(displayName, spotifyArtistId) { return { displayName, spotifyArtistId, proposedMusicRollId: "mr_artist_test" }; }

test("MusicBrainz-derived Discogs links retain MusicBrainz provenance and support exact-ID corroboration", () => {
    const f = fixtures.musicBrainzDerivedDiscogs;
    const mb = artist(f.musicBrainzArtistId, "Fixture Artist", [`https://open.spotify.com/artist/${f.spotifyArtistId}`, `https://www.discogs.com/artist/${f.discogsArtistId}`]);
    const claims = musicBrainzRelationshipClaims(mb.artist);
    assert.ok(claims.some(claim => claim.identifierType === "discogsArtistId" && claim.source === "musicbrainz" && claim.assertedByIdentifier === f.musicBrainzArtistId));
    const report = buildReconsiderationReport({ candidate: candidate("Fixture Artist", f.spotifyArtistId), priorClaims: [{ identifierType: "wikidataQid", value: "Q101", source: "wikidata", path: "entity" }], musicBrainzRecords: { [f.musicBrainzArtistId]: mb }, discogsRecords: { [f.discogsArtistId]: { artist: { discogsArtistId: f.discogsArtistId, name: "Fixture Artist", aliases: [] } } }, musicBrainzFingerprints: { [f.musicBrainzArtistId]: fingerprint }, nameCandidates: [{ musicBrainzArtistId: f.musicBrainzArtistId, name: "Fixture Artist" }], nameCandidateDetails: [mb.artist] });
    assert.equal(report.outcome, "coherent_identity_evidence");
});

test("Wikidata 404 can continue only through a unique exact Spotify-URL relationship", () => {
    const f = fixtures.musicBrainzDerivedDiscogs;
    const selection = selectExactSpotifyUrlCandidate({ exactUrlFound: true, candidates: [{ musicBrainzArtistId: f.musicBrainzArtistId }] });
    assert.equal(selection.status, "unique_exact_url_relationship");
    assert.equal(selection.selectedMbid, f.musicBrainzArtistId);
    assert.equal(selectExactSpotifyUrlCandidate({ exactUrlFound: false, candidates: [] }).status, "exact_url_not_found");
});

test("multiple MBIDs from one exact Spotify URL are routed to unresolved review", () => {
    const f = fixtures.multipleMbid;
    const records = Object.fromEntries(f.musicBrainzArtistIds.map((id, index) => [id, artist(id, `Artist ${index + 1}`, [`https://open.spotify.com/artist/${f.spotifyArtistId}`])]));
    const report = buildReconsiderationReport({ candidate: candidate("Artist", f.spotifyArtistId), exactSpotifyUrlLookup: { exactUrlFound: true, candidates: f.musicBrainzArtistIds.map(musicBrainzArtistId => ({ musicBrainzArtistId })) }, musicBrainzRecords: records, musicBrainzFingerprints: Object.fromEntries(f.musicBrainzArtistIds.map(id => [id, fingerprint])) });
    assert.equal(report.outcome, "unresolved_identity");
    assert.equal(report.exactSpotifyUrlFallback.status, "multiple_exact_url_relationships");
});

test("multiple Discogs IDs can be interpreted as provider multiplicity but never verification", () => {
    const f = fixtures.multipleDiscogs;
    const urls = [`https://open.spotify.com/artist/${f.spotifyArtistId}`, ...f.discogsArtistIds.map(id => `https://www.discogs.com/artist/${id}`)];
    const mb = artist(f.musicBrainzArtistId, "Stage Name", urls);
    const discogsRecords = Object.fromEntries(f.discogsArtistIds.map(id => [id, { artist: { discogsArtistId: id, name: `Stage Name (${id})`, realName: "Same Legal Name", aliases: [] } }]));
    const report = buildReconsiderationReport({ candidate: candidate("Stage Name", f.spotifyArtistId), priorClaims: [{ identifierType: "wikidataQid", value: "Q202", source: "wikidata", path: "entity" }], musicBrainzRecords: { [f.musicBrainzArtistId]: mb }, discogsRecords, musicBrainzFingerprints: { [f.musicBrainzArtistId]: fingerprint }, nameCandidates: [{ musicBrainzArtistId: f.musicBrainzArtistId, name: "Stage Name" }], nameCandidateDetails: [mb.artist] });
    assert.equal(report.outcome, "provider_profile_multiplicity");
    assert.equal(report.safety.identityVerified, false);
});

test("multiple active QIDs remain unresolved", () => {
    const f = fixtures.musicBrainzDerivedDiscogs;
    const mb = artist(f.musicBrainzArtistId, "Fixture Artist", [`https://open.spotify.com/artist/${f.spotifyArtistId}`, `https://www.discogs.com/artist/${f.discogsArtistId}`]);
    const report = buildReconsiderationReport({ candidate: candidate("Fixture Artist", f.spotifyArtistId), priorClaims: [{ identifierType: "wikidataQid", value: "Q1", source: "wikidata", path: "entity" }, { identifierType: "wikidataQid", value: "Q2", source: "wikidata", path: "entity" }], musicBrainzRecords: { [f.musicBrainzArtistId]: mb }, discogsRecords: { [f.discogsArtistId]: { artist: { discogsArtistId: f.discogsArtistId, name: "Fixture Artist" } } }, musicBrainzFingerprints: { [f.musicBrainzArtistId]: fingerprint } });
    assert.equal(report.outcome, "unresolved_identity");
});

test("true person/group conflicts remain semantic conflicts", () => {
    const f = fixtures.multipleMbid;
    const records = { [f.musicBrainzArtistIds[0]]: artist(f.musicBrainzArtistIds[0], "Artist", [], "Person", "1990"), [f.musicBrainzArtistIds[1]]: artist(f.musicBrainzArtistIds[1], "Artist", [], "Group", "2015") };
    const report = buildReconsiderationReport({ candidate: candidate("Artist", f.spotifyArtistId), priorClaims: f.musicBrainzArtistIds.map(value => ({ identifierType: "musicBrainzArtistId", value, source: "wikidata", path: "P434" })), musicBrainzRecords: records, musicBrainzFingerprints: Object.fromEntries(f.musicBrainzArtistIds.map(id => [id, fingerprint])) });
    assert.equal(report.outcome, "semantic_identity_conflict");
});

test("merged MusicBrainz profiles remain preserved and may resolve only as provider multiplicity", () => {
    const f = fixtures.multipleMbid;
    const resolved = artist(f.musicBrainzArtistIds[0], "Artist", [`https://open.spotify.com/artist/${f.spotifyArtistId}`, "https://www.discogs.com/artist/303"]);
    const records = { [f.musicBrainzArtistIds[0]]: resolved, [f.musicBrainzArtistIds[1]]: { ...resolved, state: "redirected", requestedMbid: f.musicBrainzArtistIds[1], resolvedMbid: f.musicBrainzArtistIds[0] } };
    const claims = f.musicBrainzArtistIds.map(value => ({ identifierType: "musicBrainzArtistId", value, source: "wikidata", path: "P434" }));
    claims.push(...f.musicBrainzArtistIds.map(assertedByIdentifier => ({ identifierType: "spotifyArtistId", value: f.spotifyArtistId, source: "musicbrainz", path: "artist.url-rels", assertedByIdentifier })));
    const report = buildReconsiderationReport({ candidate: candidate("Artist", f.spotifyArtistId), priorClaims: claims, musicBrainzRecords: records, discogsRecords: { "303": { artist: { discogsArtistId: "303", name: "Artist" } } }, musicBrainzFingerprints: Object.fromEntries(f.musicBrainzArtistIds.map(id => [id, fingerprint])), redirectedIdentifiers: [`musicbrainz:${f.musicBrainzArtistIds[1]}->${f.musicBrainzArtistIds[0]}`] });
    assert.equal(report.outcome, "provider_profile_multiplicity");
    assert.ok(report.provenanceClaims.some(claim => claim.value === f.musicBrainzArtistIds[1]));
});
