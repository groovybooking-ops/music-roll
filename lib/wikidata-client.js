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

function validateTicketmasterIdentifier(value) {
    const id = String(value ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Ticketmaster identifier is invalid.");
    return id;
}

function validateWikidataPropertyId(value) {
    const propertyId = String(value ?? "").trim();
    if (!/^P[1-9][0-9]*$/.test(propertyId)) throw new Error("A fixture-defined Wikidata property ID is required.");
    return propertyId;
}

function entityId(value) {
    return String(value || "").match(/\/entity\/(Q[1-9][0-9]*)$/)?.[1] || null;
}

function statementRank(value) {
    return String(value || "").match(/#(PreferredRank|NormalRank|DeprecatedRank)$/)?.[1]?.replace("Rank", "").toLowerCase() || "unknown";
}

function normalizeTicketmasterBridge(raw, ticketmasterId, propertyId) {
    const bindings = raw?.results?.bindings;
    if (!Array.isArray(bindings)) throw new Error("Wikidata returned a malformed Ticketmaster-ID SPARQL response.");
    const grouped = new Map();
    for (const row of bindings) {
        const qid = entityId(row.item?.value);
        if (!qid) continue;
        const candidate = grouped.get(qid) || {
            wikidataQid: qid,
            ticketmasterId,
            ticketmasterPropertyId: propertyId,
            statementRanks: [],
            spotifyArtistIds: [],
            musicBrainzArtistIds: [],
            discogsArtistIds: [],
            entityTypes: [],
            referenceUrls: []
        };
        candidate.statementRanks.push(statementRank(row.statementRank?.value));
        if (row.spotifyArtistId?.value) candidate.spotifyArtistIds.push(row.spotifyArtistId.value);
        if (row.musicBrainzArtistId?.value) candidate.musicBrainzArtistIds.push(row.musicBrainzArtistId.value);
        if (row.discogsArtistId?.value) candidate.discogsArtistIds.push(row.discogsArtistId.value);
        if (entityId(row.entityType?.value)) candidate.entityTypes.push(entityId(row.entityType.value));
        if (row.referenceUrl?.value) candidate.referenceUrls.push(row.referenceUrl.value);
        grouped.set(qid, candidate);
    }
    const unique = values => [...new Set(values.filter(Boolean))];
    const candidates = [...grouped.values()].map(candidate => Object.fromEntries(Object.entries(candidate).map(([key, value]) => [key, Array.isArray(value) ? unique(value) : value])));
    return { ticketmasterId, ticketmasterPropertyId: propertyId, exactIdFound: candidates.length > 0, candidates };
}

async function lookupWikidataByExactTicketmasterId(ticketmasterId, options = {}) {
    const id = validateTicketmasterIdentifier(ticketmasterId);
    const propertyId = validateWikidataPropertyId(options.propertyId);
    const fetchImpl = options.fetchImpl || fetch;
    const query = `SELECT ?item ?statementRank ?spotifyArtistId ?musicBrainzArtistId ?discogsArtistId ?entityType ?referenceUrl WHERE {\n` +
        `  ?item p:${propertyId} ?ticketmasterStatement.\n` +
        `  ?ticketmasterStatement ps:${propertyId} "${id}"; wikibase:rank ?statementRank.\n` +
        `  OPTIONAL { ?item wdt:P1902 ?spotifyArtistId. }\n` +
        `  OPTIONAL { ?item wdt:P434 ?musicBrainzArtistId. }\n` +
        `  OPTIONAL { ?item wdt:P1953 ?discogsArtistId. }\n` +
        `  OPTIONAL { ?item wdt:P31 ?entityType. }\n` +
        `  OPTIONAL { ?ticketmasterStatement prov:wasDerivedFrom ?reference. ?reference pr:P854 ?referenceUrl. }\n` +
        `}`;
    const url = "https://query.wikidata.org/sparql?" + new URLSearchParams({ query, format: "json" });
    let response;
    try {
        response = await fetchImpl(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": options.userAgent || "MusicRollIdentityDiscoveryFixture/1.0" } });
    } catch (error) {
        throw new WikidataApiError("Wikidata exact Ticketmaster-ID request failed before receiving a response.", null, error);
    }
    if (!response.ok) throw new WikidataApiError(`Wikidata exact Ticketmaster-ID request failed with status ${response.status}.`, response.status);
    let raw;
    try { raw = await response.json(); } catch (error) { throw new WikidataApiError("Wikidata exact Ticketmaster-ID lookup returned invalid JSON.", response.status, error); }
    return { bridge: normalizeTicketmasterBridge(raw, id, propertyId), raw };
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

module.exports = { WikidataApiError, getWikidataIdentityBridge, lookupWikidataByExactTicketmasterId, normalizeBridge, normalizeTicketmasterBridge, validateSpotifyArtistId, validateTicketmasterIdentifier, validateWikidataPropertyId };
