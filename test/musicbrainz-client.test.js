const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MusicBrainzApiError, getMusicBrainzArtist, searchMusicBrainzArtistsByExactName } = require("../lib/musicbrainz-client");

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
