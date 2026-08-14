const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DiscogsApiError, getDiscogsArtist } = require("../lib/discogs-client");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "discogs", "sza-artist.json"), "utf8"));
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("retrieves an exact Discogs ID and normalizes useful identity evidence", async () => {
    let request;
    const result = await getDiscogsArtist(3272791, { fetchImpl: async (url, options) => {
        request = { url, options };
        return response(200, fixture);
    }});
    assert.equal(request.url, "https://api.discogs.com/artists/3272791");
    assert.match(request.options.headers["User-Agent"], /MusicRoll/);
    assert.equal(request.options.headers.Authorization, undefined);
    assert.deepEqual(result.artist, {
        discogsArtistId: "3272791", name: "SZA (2)", realName: "Solána Imani Rowe",
        profile: "American singer and songwriter.", artistUrls: ["https://szactrl.com/"],
        aliases: [{ discogsArtistId: "123456", name: "Example Alias" }], nameVariations: ["SZA", "Sza"],
        discogsResourceUrl: "https://api.discogs.com/artists/3272791",
        discogsWebUrl: "https://www.discogs.com/artist/3272791-SZA-2", dataQuality: "Correct"
    });
    assert.equal(result.authenticationUsed, false);
    assert.equal(result.raw, fixture);
});

test("reports a missing Discogs artist", async () => {
    await assert.rejects(() => getDiscogsArtist("999", { fetchImpl: async () => response(404) }), error => error instanceof DiscogsApiError && error.statusCode === 404);
});

test("rejects a malformed Discogs artist response", async () => {
    await assert.rejects(() => getDiscogsArtist("3272791", { fetchImpl: async () => response(200, { id: 3272791 }) }), /missing a name/);
});

test("wraps a Discogs request failure", async () => {
    await assert.rejects(() => getDiscogsArtist("3272791", { fetchImpl: async () => { throw new Error("offline"); } }), error => error instanceof DiscogsApiError && error.cause?.message === "offline");
});
