const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { TicketmasterApiError, getTicketmasterAttraction, getUpcomingEventsForAttraction, normalizeEvent } = require("../lib/ticketmaster-client");

const readFixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ticketmaster", name), "utf8"));
const attractionFixture = readFixture("sza-attraction.json");
const eventsFixture = readFixture("sza-events.json");
const response = (status, body = {}, retryAfter = null) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter }, json: async () => body });

test("fetches and normalizes an attraction by exact Ticketmaster ID", async () => {
    let request;
    const result = await getTicketmasterAttraction("1858419", { apiKey: "fixture-key", fetchImpl: async (url, options) => { request = { url: String(url), options }; return response(200, attractionFixture); } });
    const parsed = new URL(request.url);
    assert.equal(parsed.pathname, "/discovery/v2/attractions/1858419.json");
    assert.equal(parsed.searchParams.get("apikey"), "fixture-key");
    assert.equal(result.attraction.attractionId, "1858419");
    assert.equal(result.attraction.name, "SZA");
    assert.equal(result.attraction.imageUrl, "https://example.test/sza-wide.jpg");
    assert.equal(result.attraction.classifications[0].genre.name, "R&B");
    assert.equal(result.attraction.upcomingEventCount, 4);
});

test("fetches a bounded upcoming-event sample using only the exact attraction ID", async () => {
    let requestedUrl;
    const result = await getUpcomingEventsForAttraction("1858419", { apiKey: "fixture-key", size: 3, now: "2026-08-14T00:00:00Z", fetchImpl: async url => { requestedUrl = String(url); return response(200, eventsFixture); } });
    const parsed = new URL(requestedUrl);
    assert.equal(parsed.pathname, "/discovery/v2/events.json");
    assert.equal(parsed.searchParams.get("attractionId"), "1858419");
    assert.equal(parsed.searchParams.get("keyword"), null);
    assert.equal(parsed.searchParams.get("size"), "3");
    assert.equal(parsed.searchParams.get("startDateTime"), "2026-08-14T00:00:00Z");
    assert.equal(result.totalUpcomingEvents, 4);
    assert.deepEqual(result.events[0], { eventId: "event-one", name: "SZA: Grand National Tour", dateTime: { localDate: "2026-09-01", localTime: "20:00:00", utcDateTime: "2026-09-02T00:00:00Z" }, venue: "Example Arena", city: "New York", region: "NY", country: "US", latitude: 40.7505, longitude: -73.9934, ticketUrl: "https://www.ticketmaster.com/event-one" });
    assert.equal(result.events[1].venue, null);
});

test("optional event and attraction metadata normalize safely", async () => {
    assert.deepEqual(normalizeEvent({ id: "minimal", name: "Minimal event" }), { eventId: "minimal", name: "Minimal event", dateTime: { localDate: null, localTime: null, utcDateTime: null }, venue: null, city: null, region: null, country: null, latitude: null, longitude: null, ticketUrl: null });
    const minimal = await getTicketmasterAttraction("abc-123", { apiKey: "fixture-key", fetchImpl: async () => response(200, { id: "abc-123", name: "Minimal" }) });
    assert.deepEqual(minimal.attraction.classifications, []);
    assert.equal(minimal.attraction.imageUrl, null);
    assert.equal(minimal.attraction.upcomingEventCount, null);
});

test("a missing exact path may use only a unique exact-ID filter fallback", async () => {
    const requests = [];
    const result = await getTicketmasterAttraction("1858419", { apiKey: "fixture-key", fetchImpl: async url => {
        requests.push(String(url));
        return requests.length === 1 ? response(404, { errors: [{ detail: "not found" }] }) : response(200, { _embedded: { attractions: [attractionFixture] } });
    } });
    assert.equal(result.lookupMethod, "exact_id_filter");
    assert.equal(new URL(requests[1]).searchParams.get("id"), "1858419");
    assert.ok(!requests[1].includes("keyword"));
});

test("a legacy numeric attraction ID may bridge through its exact Ticketmaster page without name search", async () => {
    const discoveryId = "K8vZ917o6G0"; let apiCalls = 0;
    const discovery = { ...attractionFixture, id: discoveryId, url: "https://www.ticketmaster.com/sza-tickets/artist/1858419" };
    const result = await getTicketmasterAttraction("1858419", {
        apiKey: "fixture-key",
        fetchImpl: async () => { apiCalls += 1; return apiCalls === 1 ? response(404, {}) : apiCalls === 2 ? response(200, { _embedded: { attractions: [] } }) : response(200, discovery); },
        pageFetchImpl: async () => ({ ok: true, status: 200, url: "https://www.ticketmaster.com/sza-tickets/artist/1858419", text: async () => `<script>"attractionId":"${discoveryId}"</script>` })
    });
    assert.equal(result.lookupMethod, "exact_legacy_page_bridge");
    assert.equal(result.requestedAttractionId, "1858419");
    assert.equal(result.discoveryAttractionId, discoveryId);
    assert.equal(result.legacyAttractionId, "1858419");
    assert.equal(result.attraction.attractionId, discoveryId);
});

test("handles missing credentials, exact-ID mismatch, provider errors, and retries safely", async () => {
    await assert.rejects(() => getTicketmasterAttraction("1858419", { apiKey: "", fetchImpl: async () => response(200, attractionFixture) }), error => error instanceof TicketmasterApiError && /Missing/.test(error.message));
    await assert.rejects(() => getTicketmasterAttraction("1858419", { apiKey: "fixture-key", fetchImpl: async () => response(200, { ...attractionFixture, id: "other" }) }), /unexpected attraction ID/);
    await assert.rejects(() => getTicketmasterAttraction("1858419", { apiKey: "bad", maxRetries: 0, fetchImpl: async () => response(401, { fault: { faultstring: "Invalid ApiKey" } }) }), error => error instanceof TicketmasterApiError && error.statusCode === 401 && error.message === "Invalid ApiKey");
    let calls = 0; const waits = [];
    const result = await getTicketmasterAttraction("1858419", { apiKey: "fixture-key", fetchImpl: async () => ++calls === 1 ? response(429, {}, "2") : response(200, attractionFixture), waitImpl: async milliseconds => waits.push(milliseconds) });
    assert.equal(result.attraction.name, "SZA");
    assert.deepEqual(waits, [2000]);
});

test("rejects unsafe IDs and unbounded event samples", async () => {
    await assert.rejects(() => getTicketmasterAttraction("../events", { apiKey: "fixture-key" }), /invalid/);
    await assert.rejects(() => getUpcomingEventsForAttraction("1858419", { apiKey: "fixture-key", size: 25 }), /1 to 10/);
});
