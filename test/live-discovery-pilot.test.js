const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createSpotifyLiveDiscoveryAdapter, createTicketmasterLiveDiscoveryAdapter } = require("../lib/discovery/live-discovery-adapters");
const { PILOT_LIMITS, normalizePilotLimits, runLiveDiscoveryPilot } = require("../lib/discovery/live-discovery-pilot");
const { BoundedRequestLedger, ImmutableListingCache } = require("../lib/discovery/live-pilot-support");

const projectRoot = path.join(__dirname, "..");
const discoveredAt = "2026-08-14T23:50:00.000Z";
const spotifyConfiguration = {
    mode: "artist_search_results",
    query: "SZA",
    queryRecordId: "bounded-query-sza",
    limit: 2,
    market: "US",
    sourceType: "public_music_database",
    sourceName: "Fixture bounded live pilot",
    discoveredAt
};
const ticketmasterConfiguration = {
    mode: "event_attractions",
    stateCode: "NY",
    startDateTime: "2026-08-15T00:00:00Z",
    endDateTime: "2026-08-22T00:00:00Z",
    size: 1,
    sourceType: "ticketmaster_event",
    sourceName: "Fixture bounded Ticketmaster pilot",
    discoveredAt
};
const spotifyRaw = {
    artists: {
        offset: 0,
        items: [
            { id: "7tYKF4w9nC0nq9CsPZTHyP", name: "SZA" },
            { id: "1111111111111111111111", name: "SZA Archive" }
        ]
    }
};
const ticketmasterRaw = {
    _embedded: {
        events: [{
            id: "event-live-fixture",
            name: "A title is not an artist",
            url: "https://ticketmaster.test/event-live-fixture",
            dates: { start: { localDate: "2026-08-16", localTime: "20:00:00", dateTime: "2026-08-17T00:00:00Z" } },
            _embedded: {
                attractions: [{ id: "K8vZLiveFixture", name: "Live Fixture Artist", url: "https://ticketmaster.test/artist/12345" }],
                venues: [{ id: "venue-live", name: "Live Hall", city: { name: "New York" }, state: { stateCode: "NY" }, country: { countryCode: "US" }, location: { latitude: "40.7", longitude: "-74.0" } }]
            }
        }]
    },
    page: { number: 0, totalPages: 1, totalElements: 1 }
};

function response(status, body) {
    return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body };
}

async function setup(t) {
    const pilotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-live-discovery-pilot-"));
    t.after(() => fs.rm(pilotRoot, { recursive: true, force: true }));
    return pilotRoot;
}

function providers(pilotRoot, fetchImpl) {
    const ledger = new BoundedRequestLedger({ fetchImpl, waitImpl: async () => {}, totalCap: 8, spotifyCap: 4, ticketmasterCap: 4 });
    const cache = new ImmutableListingCache(path.join(pilotRoot, "store"), { clock: () => discoveredAt, freshnessMs: 24 * 60 * 60 * 1000 });
    return {
        ledger,
        adapters: [
            { adapter: createSpotifyLiveDiscoveryAdapter({ cache, ledger, credentials: { clientId: "fixture", clientSecret: "fixture" } }), configuration: spotifyConfiguration },
            { adapter: createTicketmasterLiveDiscoveryAdapter({ cache, ledger, apiKey: "fixture-ticketmaster-key" }), configuration: ticketmasterConfiguration }
        ]
    };
}

test("live adapters require network on cache miss and enforce bounded configurations", async t => {
    const pilotRoot = await setup(t);
    const { adapters } = providers(pilotRoot, async () => { throw new Error("must not request"); });
    await assert.rejects(() => adapters[0].adapter.acquirePage({ configuration: spotifyConfiguration, networkAllowed: false }), /--allow-network/);
    await assert.rejects(() => adapters[1].adapter.acquirePage({ configuration: ticketmasterConfiguration, networkAllowed: false }), /--allow-network/);
    assert.throws(() => adapters[0].adapter.validateConfiguration({ ...spotifyConfiguration, limit: 6 }), /1-5/);
    assert.throws(() => adapters[1].adapter.validateConfiguration({ ...ticketmasterConfiguration, size: 4 }), /1-3/);
});

test("bounded live pilot converges once, then replays cached listings idempotently", async t => {
    const pilotRoot = await setup(t);
    let fetchCalls = 0;
    const fetchImpl = async url => {
        fetchCalls += 1;
        const value = String(url);
        if (value.includes("accounts.spotify.com")) return response(200, { access_token: "fixture-token" });
        if (value.includes("api.spotify.com")) return response(200, spotifyRaw);
        if (value.includes("ticketmaster.com")) return response(200, ticketmasterRaw);
        throw new Error(`Unexpected fixture URL: ${value}`);
    };
    const permanentRegistry = { schemaVersion: 1, mappings: [{ musicRollId: "mr_artist_000001", spotifyId: "7tYKF4w9nC0nq9CsPZTHyP" }] };
    const liveArtists = [{ musicRollId: "mr_artist_000001", name: "SZA", spotifyId: "7tYKF4w9nC0nq9CsPZTHyP" }];
    const firstProviders = providers(pilotRoot, fetchImpl);
    const first = await runLiveDiscoveryPilot({ projectRoot, pilotRoot, pilotId: "fixture-live", allowNetwork: true, ledger: firstProviders.ledger, adapters: firstProviders.adapters, permanentRegistry, liveArtists });
    assert.deepEqual(first.report.providerMetrics.requests, { total: 3, spotify: 2, ticketmaster: 1 });
    assert.equal(first.report.occurrenceMetrics.totalNormalized, 3);
    assert.equal(first.report.queueImpact.existingLiveAssociations, 1);
    assert.equal(first.report.queueImpact.newSpotifyCandidates, 1);
    assert.equal(first.report.queueImpact.newTicketmasterOnlyCandidates, 1);
    assert.equal(first.report.queueImpact.after, 2);
    assert.equal(first.report.occurrenceResults.find(item => item.provider === "ticketmaster").lifecycleState, "identity_discovery_pending");
    assert.equal(fetchCalls, 3);

    const secondProviders = providers(pilotRoot, async () => { throw new Error("fresh cache must prevent requests"); });
    const second = await runLiveDiscoveryPilot({ projectRoot, pilotRoot, pilotId: "fixture-live", allowNetwork: true, ledger: secondProviders.ledger, adapters: secondProviders.adapters, permanentRegistry, liveArtists });
    assert.deepEqual(second.report.providerMetrics.requests, { total: 0, spotify: 0, ticketmaster: 0 });
    assert.deepEqual(second.report.providerMetrics.cacheHits, { spotify: 1, ticketmaster: 1 });
    assert.equal(second.report.queueImpact.growth, 0);
    assert.equal(second.report.queueImpact.idempotentOccurrences, 3);
    assert.equal(second.report.occurrenceMetrics.created, 0);
    assert.equal(second.report.associations.created, 0);
    assert.equal(second.report.queueImpact.after, 2);
    assert.ok(Object.values(second.report.checkpoints).every(checkpoint => checkpoint.exhausted));
});

test("request ledger hard-stops before exceeding provider or total caps", async () => {
    const ledger = new BoundedRequestLedger({ fetchImpl: async () => response(200, {}), totalCap: 1, spotifyCap: 1, ticketmasterCap: 1 });
    await ledger.json("spotify", "https://example.test", {}, { maxRetries: 0 });
    await assert.rejects(() => ledger.json("ticketmaster", "https://example.test", {}, { maxRetries: 0 }), /cap reached/);
    assert.deepEqual(PILOT_LIMITS, { totalProviderRequests: 8, spotifyRequests: 4, ticketmasterRequests: 4, normalizedOccurrences: 20, newCandidates: 10, unresolvedQueueGrowth: 10 });
    assert.deepEqual(normalizePilotLimits({ totalProviderRequests: 12, spotifyRequests: 6, ticketmasterRequests: 6, normalizedOccurrences: 30, newCandidates: 15, unresolvedQueueGrowth: 15 }), { totalProviderRequests: 12, spotifyRequests: 6, ticketmasterRequests: 6, normalizedOccurrences: 30, newCandidates: 15, unresolvedQueueGrowth: 15 });
    assert.throws(() => normalizePilotLimits({ ...PILOT_LIMITS, unresolvedQueueGrowth: 11 }), /cannot exceed/);
});
