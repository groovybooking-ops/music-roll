const test = require("node:test");
const assert = require("node:assert/strict");
const { lookupMusicBrainzArtistsByExactUrl } = require("../lib/musicbrainz-client");
const { lookupWikidataByExactTicketmasterId, normalizeTicketmasterBridge } = require("../lib/wikidata-client");

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });

test("MusicBrainz reverse-resolves only the exact supplied Ticketmaster URL", async () => {
    const resource = "https://www.ticketmaster.com/example-tickets/artist/12345";
    let requested;
    const result = await lookupMusicBrainzArtistsByExactUrl(resource, { maxRetries: 0, fetchImpl: async url => {
        requested = String(url);
        return response(200, { relations: [{ "target-type": "artist", type: "official homepage", direction: "backward", artist: { id: "11111111-1111-4111-8111-111111111111", name: "Different Display Name", type: "Group" } }] });
    } });
    assert.equal(new URL(requested).searchParams.get("resource"), resource);
    assert.equal(result.resource, resource);
    assert.equal(result.candidates[0].musicBrainzArtistId, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.candidates[0].name, "Different Display Name");
    await assert.rejects(() => lookupMusicBrainzArtistsByExactUrl("http://example.test", { fetchImpl: async () => response(404, {}) }), /HTTPS/);
});

test("Wikidata Ticketmaster lookup uses fixture-defined exact property semantics", async () => {
    let requested;
    const raw = { results: { bindings: [{
        item: { value: "http://www.wikidata.org/entity/Q123" },
        statementRank: { value: "http://wikiba.se/ontology#NormalRank" },
        spotifyArtistId: { value: "AAAAAAAAAAAAAAAAAAAAAA" },
        musicBrainzArtistId: { value: "11111111-1111-4111-8111-111111111111" },
        entityType: { value: "http://www.wikidata.org/entity/Q215380" },
        referenceUrl: { value: "https://reference.test/exact" }
    }] } };
    const result = await lookupWikidataByExactTicketmasterId("K8vZFixture", { propertyId: "P9999", fetchImpl: async url => { requested = new URL(String(url)).searchParams.get("query"); return response(200, raw); } });
    assert.match(requested, /p:P9999/);
    assert.match(requested, /ps:P9999 "K8vZFixture"/);
    assert.equal(result.bridge.candidates[0].wikidataQid, "Q123");
    assert.deepEqual(result.bridge.candidates[0].statementRanks, ["normal"]);
    assert.deepEqual(result.bridge.candidates[0].spotifyArtistIds, ["AAAAAAAAAAAAAAAAAAAAAA"]);
    await assert.rejects(() => lookupWikidataByExactTicketmasterId("K8vZFixture", { propertyId: "ticketmaster", fetchImpl: async () => response(200, raw) }), /fixture-defined/);
});

test("Wikidata normalization preserves multiple QIDs and deprecated statements", () => {
    const bridge = normalizeTicketmasterBridge({ results: { bindings: [
        { item: { value: "http://www.wikidata.org/entity/Q1" }, statementRank: { value: "http://wikiba.se/ontology#DeprecatedRank" }, spotifyArtistId: { value: "AAAAAAAAAAAAAAAAAAAAAA" } },
        { item: { value: "http://www.wikidata.org/entity/Q2" }, statementRank: { value: "http://wikiba.se/ontology#PreferredRank" }, spotifyArtistId: { value: "BBBBBBBBBBBBBBBBBBBBBB" } }
    ] } }, "12345", "P9999");
    assert.deepEqual(bridge.candidates.map(item => item.wikidataQid), ["Q1", "Q2"]);
    assert.deepEqual(bridge.candidates.map(item => item.statementRanks[0]), ["deprecated", "preferred"]);
});
