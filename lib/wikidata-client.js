class WikidataApiError extends Error {
    constructor(message, statusCode = null, cause = null) {
        super(message, cause ? { cause } : undefined);
        this.name = "WikidataApiError";
        this.statusCode = statusCode;
    }
}

function validateSpotifyArtistId(value) {
    const id = String(value ?? "").trim();
    if (!/^[A-Za-z0-9]{22}$/.test(id)) throw new Error("Spotify artist ID must contain exactly 22 letters or digits.");
    return id;
}

function normalizeBridge(raw, spotifyArtistId) {
    const bindings = raw?.results?.bindings;
    if (!Array.isArray(bindings)) throw new Error("Wikidata returned a malformed SPARQL response.");
    if (bindings.length === 0) throw new WikidataApiError(`Wikidata has no artist bridge for Spotify ID ${spotifyArtistId}.`, 404);
    const qids = [...new Set(bindings.map(row => row.item?.value?.match(/\/entity\/(Q[1-9][0-9]*)$/)?.[1]).filter(Boolean))];
    if (qids.length !== 1) throw new WikidataApiError(`Wikidata returned multiple entities for Spotify ID ${spotifyArtistId}.`, 409);
    const musicBrainzArtistIds = [...new Set(bindings.map(row => row.musicBrainzArtistId?.value).filter(Boolean))];
    const discogsArtistIds = [...new Set(bindings.map(row => row.discogsArtistId?.value).filter(Boolean))];
    const bridge = {
        spotifyArtistId,
        wikidataQid: qids[0],
        name: bindings.find(row => row.itemLabel?.value)?.itemLabel.value || null,
        musicBrainzArtistId: musicBrainzArtistIds.length === 1 ? musicBrainzArtistIds[0] : null,
        discogsArtistId: discogsArtistIds.length === 1 ? discogsArtistIds[0] : null
    };
    if (musicBrainzArtistIds.length > 1) bridge.musicBrainzArtistIds = musicBrainzArtistIds;
    if (discogsArtistIds.length > 1) bridge.discogsArtistIds = discogsArtistIds;
    return bridge;
}

async function getWikidataIdentityBridge(spotifyArtistId, options = {}) {
    const id = validateSpotifyArtistId(spotifyArtistId);
    const fetchImpl = options.fetchImpl || fetch;
    const query = `SELECT ?item ?itemLabel ?musicBrainzArtistId ?discogsArtistId WHERE {\n` +
        `  ?item wdt:P1902 "${id}".\n` +
        `  OPTIONAL { ?item wdt:P434 ?musicBrainzArtistId. }\n` +
        `  OPTIONAL { ?item wdt:P1953 ?discogsArtistId. }\n` +
        `  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }\n}`;
    const url = "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" });
    let response;
    try {
        response = await fetchImpl(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": options.userAgent || "MusicRollIdentityLesson/1.0 (https://github.com/music-roll)" } });
    } catch (error) {
        throw new WikidataApiError("Wikidata identity bridge request failed before receiving a response.", null, error);
    }
    if (!response.ok) throw new WikidataApiError(`Wikidata identity bridge request failed with status ${response.status}.`, response.status);
    let raw;
    try { raw = await response.json(); } catch (error) { throw new WikidataApiError("Wikidata returned invalid JSON.", response.status, error); }
    return { bridge: normalizeBridge(raw, id), raw };
}

module.exports = { WikidataApiError, getWikidataIdentityBridge, normalizeBridge, validateSpotifyArtistId };
