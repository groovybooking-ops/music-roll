const { SPOTIFY_ID_PATTERN, SOURCE_TYPES } = require("../ingestion/candidate-schema");
const { createFixtureCheckpoint, advanceFixtureCheckpoint, validateFixtureCheckpoint } = require("./fixture-checkpoint");
const { createSpotifyFixtureDiscoveryAdapter } = require("./spotify-discovery-adapter");
const { defineDiscoverySourceAdapter } = require("./source-adapter");
const { createTicketmasterFixtureDiscoveryAdapter } = require("./ticketmaster-discovery-adapter");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function commonConfiguration(configuration, provider) {
    assert(configuration && typeof configuration === "object", `${provider} live discovery configuration is required.`);
    assert(SOURCE_TYPES.includes(configuration.sourceType), `${provider} live discovery source type is invalid.`);
    assert(typeof configuration.sourceName === "string" && configuration.sourceName.trim(), `${provider} live discovery source name is required.`);
    assert(typeof configuration.discoveredAt === "string" && !Number.isNaN(Date.parse(configuration.discoveredAt)), `${provider} live discovery timestamp is invalid.`);
}

function singlePageCheckpoint(adapter, configuration, checkpoint, page, consumedItems) {
    return advanceFixtureCheckpoint({
        checkpoint,
        configurationHash: adapter.canonicalConfigurationHash(configuration),
        pageItemCount: page.itemCount,
        consumedItems,
        hasNextPage: false
    });
}

function createSpotifyLiveDiscoveryAdapter({ cache, ledger, credentials }) {
    let adapter;
    function validateConfiguration(configuration) {
        commonConfiguration(configuration, "Spotify");
        assert(configuration.mode === "artist_search_results", "Spotify live pilot supports only bounded artist search.");
        assert(typeof configuration.query === "string" && configuration.query.trim(), "Spotify live search query is required.");
        assert(Number.isInteger(configuration.limit) && configuration.limit >= 1 && configuration.limit <= 5, "Spotify live search limit must be 1-5.");
        assert(/^[A-Z]{2}$/.test(configuration.market || ""), "Spotify live search market is invalid.");
        return true;
    }
    async function acquirePage({ configuration, checkpoint, networkAllowed = false }) {
        validateConfiguration(configuration);
        const configurationHash = adapter.canonicalConfigurationHash(configuration);
        checkpoint ||= createFixtureCheckpoint(configurationHash);
        validateFixtureCheckpoint(checkpoint, configurationHash);
        const cached = await cache.read("spotify", configurationHash);
        if (cached) return { configurationHash, checkpoint, providerPage: 0, raw: cached.artifact.raw, rawEvidenceRef: cached.evidenceRef, itemCount: cached.artifact.raw?.artists?.items?.length || 0, hasNextPage: false, exhausted: false, cacheHit: true, liveRequests: 0 };
        if (!networkAllowed) throw new Error("Spotify live discovery cache miss; pass --allow-network only after explicit approval.");
        assert(credentials?.clientId && credentials?.clientSecret, "Spotify live discovery credentials are missing.");
        const token = await ledger.json("spotify", "https://accounts.spotify.com/api/token", {
            method: "POST",
            headers: { Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "client_credentials" })
        }, { maxRetries: 0 });
        assert(typeof token.body?.access_token === "string", "Spotify token response omitted an access token.");
        const query = new URLSearchParams({ q: configuration.query, type: "artist", limit: String(configuration.limit), market: configuration.market });
        const listing = await ledger.json("spotify", `https://api.spotify.com/v1/search?${query}`, { headers: { Authorization: `Bearer ${token.body.access_token}` } }, { maxRetries: 1 });
        const raw = { ...listing.body, query: configuration.query, queryRecordId: configuration.queryRecordId };
        const saved = await cache.write("spotify", configurationHash, raw, { requestUrl: listing.url });
        return { configurationHash, checkpoint, providerPage: 0, raw, rawEvidenceRef: saved.evidenceRef, itemCount: raw?.artists?.items?.length || 0, hasNextPage: false, exhausted: false, cacheHit: false, liveRequests: 2 };
    }
    function normalizePage(page, { configuration }) {
        const fixtures = { live: { mode: "artist_search_results", pages: [{ raw: page.raw, rawEvidenceRef: page.rawEvidenceRef }] } };
        const fixtureAdapter = createSpotifyFixtureDiscoveryAdapter({ fixtures });
        return fixtureAdapter.normalizePage(page, { configuration: { ...configuration, fixtureKey: "live", mode: "artist_search_results" } });
    }
    adapter = defineDiscoverySourceAdapter({
        adapterId: "spotify_live_bounded_discovery_v1",
        provider: "spotify",
        adapterVersion: "v1",
        validateConfiguration,
        acquirePage,
        normalizePage,
        nextCheckpoint: input => singlePageCheckpoint(adapter, input.configuration, input.checkpoint, input.page, input.consumedItems)
    });
    return adapter;
}

function createTicketmasterLiveDiscoveryAdapter({ cache, ledger, apiKey }) {
    let adapter;
    function validateConfiguration(configuration) {
        commonConfiguration(configuration, "Ticketmaster");
        assert(configuration.mode === "event_attractions", "Ticketmaster live pilot supports only event-attraction discovery.");
        assert(Number.isInteger(configuration.size) && configuration.size >= 1 && configuration.size <= 3, "Ticketmaster live event size must be 1-3.");
        assert(/^[A-Z]{2}$/.test(configuration.stateCode || ""), "Ticketmaster state code is invalid.");
        assert(typeof configuration.startDateTime === "string" && typeof configuration.endDateTime === "string", "Ticketmaster date window is required.");
        const windowMs = Date.parse(configuration.endDateTime) - Date.parse(configuration.startDateTime);
        assert(Number.isFinite(windowMs) && windowMs > 0 && windowMs <= 7 * 24 * 60 * 60 * 1000, "Ticketmaster live date window must be at most seven days.");
        return true;
    }
    async function acquirePage({ configuration, checkpoint, networkAllowed = false }) {
        validateConfiguration(configuration);
        const configurationHash = adapter.canonicalConfigurationHash(configuration);
        checkpoint ||= createFixtureCheckpoint(configurationHash);
        validateFixtureCheckpoint(checkpoint, configurationHash);
        const cached = await cache.read("ticketmaster", configurationHash);
        if (cached) {
            const entries = cached.artifact.raw?._embedded?.events || [];
            return { configurationHash, checkpoint, providerPage: 0, raw: cached.artifact.raw, rawEvidenceRef: cached.evidenceRef, itemCount: entries.flatMap(event => event?._embedded?.attractions || []).length, hasNextPage: false, exhausted: false, cacheHit: true, liveRequests: 0 };
        }
        if (!networkAllowed) throw new Error("Ticketmaster live discovery cache miss; pass --allow-network only after explicit approval.");
        assert(apiKey, "Ticketmaster live discovery API key is missing.");
        const parameters = new URLSearchParams({
            apikey: apiKey,
            classificationName: "music",
            stateCode: configuration.stateCode,
            startDateTime: configuration.startDateTime,
            endDateTime: configuration.endDateTime,
            size: String(configuration.size),
            page: "0",
            sort: "date,asc"
        });
        const listing = await ledger.json("ticketmaster", `https://app.ticketmaster.com/discovery/v2/events.json?${parameters}`, { headers: { Accept: "application/json", "User-Agent": "MusicRollBoundedDiscoveryPilot/1.0" } }, { maxRetries: 1 });
        const saved = await cache.write("ticketmaster", configurationHash, listing.body, { requestUrl: listing.url.replace(apiKey, "REDACTED") });
        const entries = listing.body?._embedded?.events || [];
        return { configurationHash, checkpoint, providerPage: 0, raw: listing.body, rawEvidenceRef: saved.evidenceRef, itemCount: entries.flatMap(event => event?._embedded?.attractions || []).length, hasNextPage: false, exhausted: false, cacheHit: false, liveRequests: 1 };
    }
    function normalizePage(page, { configuration }) {
        const fixtures = { live: { mode: "event_attractions", pages: [{ raw: page.raw, rawEvidenceRef: page.rawEvidenceRef }] } };
        const fixtureAdapter = createTicketmasterFixtureDiscoveryAdapter({ fixtures });
        return fixtureAdapter.normalizePage(page, { configuration: { ...configuration, fixtureKey: "live", mode: "event_attractions" } });
    }
    adapter = defineDiscoverySourceAdapter({
        adapterId: "ticketmaster_live_bounded_discovery_v1",
        provider: "ticketmaster",
        adapterVersion: "v1",
        validateConfiguration,
        acquirePage,
        normalizePage,
        nextCheckpoint: input => singlePageCheckpoint(adapter, input.configuration, input.checkpoint, input.page, input.consumedItems)
    });
    return adapter;
}

module.exports = { createSpotifyLiveDiscoveryAdapter, createTicketmasterLiveDiscoveryAdapter };
