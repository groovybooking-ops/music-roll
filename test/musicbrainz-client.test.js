const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MusicBrainzApiError, getMusicBrainzArtist, getMusicBrainzArtistResolution, lookupMusicBrainzArtistsByExactSpotifyUrl, searchMusicBrainzArtistsByExactName } = require("../lib/musicbrainz-client");

const mbid = "272989c8-5535-492d-a25c-9f58803e027f";
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "musicbrainz-exact", "sza-artist.json"), "utf8"));
const response = (status, body = {}, retryAfter = null) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter }, json: async () => body });

test("retrieves an exact MBID with aliases and URL relationships", async () => {
    let request;
    const result = await getMusicBrainzArtist(mbid, { fetchImpl: async (url, options) => { request = { url, options }; return response(200, fixture); } });
    assert.equal(request.url, `https://musicbrainz.org/ws/2/artist/${mbid}?inc=aliases+url-rels&fmt=json`);
    assert.match(request.options.headers["User-Agent"], /MusicRollIdentityLesson\/1\.0 \(.+\)/);
    assert.equal(result.artist.musicBrainzArtistId, mbid);
    assert.equal(result.artist.name, "SZA");
    assert.equal(result.artist.aliases[0].name, "Solána Rowe");
    assert.equal(result.artist.isni[0], "0000000466394958");
    assert.equal(result.artist.externalUrls[0].relationshipType, "discogs");
});

test("reports a missing MusicBrainz artist", async () => {
    await assert.rejects(() => getMusicBrainzArtist(mbid, { fetchImpl: async () => response(404) }), error => error instanceof MusicBrainzApiError && error.statusCode === 404);
});

test("rejects malformed and mismatched artist responses", async () => {
    await assert.rejects(() => getMusicBrainzArtist(mbid, { fetchImpl: async () => response(200, { id: mbid }) }), /missing a name/);
    await assert.rejects(() => getMusicBrainzArtist(mbid, { fetchImpl: async () => response(200, { id: "5b11f4ce-a62d-471e-81fc-a69a8278c7da", name: "Other" }) }), /unexpected artist MBID/);
});

test("wraps request failure and retries 503 no faster than one second", async () => {
    await assert.rejects(() => getMusicBrainzArtist(mbid, { fetchImpl: async () => { throw new Error("offline"); } }), error => error instanceof MusicBrainzApiError && error.cause?.message === "offline");
    let calls = 0;
    const waits = [];
    const result = await getMusicBrainzArtist(mbid, {
        fetchImpl: async () => ++calls === 1 ? response(503) : response(200, fixture),
        waitImpl: async milliseconds => waits.push(milliseconds)
    });
    assert.equal(result.artist.name, "SZA");
    assert.deepEqual(waits, [1000]);
});

test("same-name audit returns only exact normalized display names", async () => {
    const searchFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "musicbrainz-exact", "nirvana-search.json"), "utf8"));
    const result = await searchMusicBrainzArtistsByExactName("Nirvana", { fetchImpl: async () => response(200, searchFixture) });
    assert.equal(result.exactMatches.length, 2);
    assert.ok(result.exactMatches.every(artist => artist.name === "Nirvana"));
});

test("exact Spotify-URL lookup returns only directly related MusicBrainz artists", async () => {
    const spotifyUrl = "https://open.spotify.com/artist/1234567890123456789012";
    let requestedUrl;
    const result = await lookupMusicBrainzArtistsByExactSpotifyUrl(spotifyUrl, { fetchImpl: async url => {
        requestedUrl = String(url);
        return response(200, { relations: [{ "target-type": "artist", type: "streaming music", direction: "backward", artist: { id: "11111111-1111-4111-8111-111111111111", name: "Exact Artist", type: "Person" } }, { "target-type": "label", label: { id: "ignored" } }] });
    } });
    assert.match(requestedUrl, /resource=https%3A%2F%2Fopen\.spotify\.com%2Fartist%2F1234567890123456789012/);
    assert.deepEqual(result.candidates.map(item => item.musicBrainzArtistId), ["11111111-1111-4111-8111-111111111111"]);
});

test("exact Spotify-URL lookup preserves multiple MBIDs and treats 404 as absence", async () => {
    const spotifyUrl = "https://open.spotify.com/artist/2234567890123456789012";
    const many = await lookupMusicBrainzArtistsByExactSpotifyUrl(spotifyUrl, { fetchImpl: async () => response(200, { relations: [
        { "target-type": "artist", artist: { id: "22222222-2222-4222-8222-222222222222", name: "One" } },
        { "target-type": "artist", artist: { id: "33333333-3333-4333-8333-333333333333", name: "Two" } }
    ] }) });
    assert.equal(many.candidates.length, 2);
    const missing = await lookupMusicBrainzArtistsByExactSpotifyUrl(spotifyUrl, { fetchImpl: async () => response(404, {}) });
    assert.equal(missing.exactUrlFound, false);
    assert.deepEqual(missing.candidates, []);
});

test("exact artist resolution preserves an exposed MusicBrainz redirect", async () => {
    const oldMbid = "11111111-1111-4111-8111-111111111111";
    const redirectedFixture = { ...fixture, id: mbid };
    const result = await getMusicBrainzArtistResolution(oldMbid, { fetchImpl: async () => ({ ...response(200, redirectedFixture), url: `https://musicbrainz.org/ws/2/artist/${mbid}?inc=aliases+url-rels&fmt=json` }) });
    assert.equal(result.state, "redirected");
    assert.equal(result.requestedMbid, oldMbid);
    assert.equal(result.resolvedMbid, mbid);
});
