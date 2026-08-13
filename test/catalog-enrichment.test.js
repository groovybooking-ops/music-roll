const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeCatalog, deduplicateReleases, parsePartialDate } = require("../lib/catalog-enrichment");
const { fetchArtistAlbumsPaginated, fetchJsonWithRetry } = require("../lib/spotify-catalog-client");

function release(id, name, date, precision, type = "album", tracks = 10) {
    return { id, name, release_date: date, release_date_precision: precision, album_type: type, total_tracks: tracks, external_urls: { spotify: `https://open.spotify.com/album/${id}` } };
}

test("fetches every pagination page", async () => {
    const pages = [
        { items: [release("a", "First", "2020", "year")], next: "https://next" },
        { items: [release("b", "Second", "2021", "year")], next: null }
    ];
    const urls = [];
    const result = await fetchArtistAlbumsPaginated("artist", "token", {
        fetchImpl: async url => ({ ok: true, json: async () => pages[urls.push(url) - 1] }),
        baseUrl: "https://test"
    });
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.items.map(item => item.id), ["a", "b"]);
    assert.match(urls[0], /limit=10/);
});

test("preserves partial-date precision and bounded dates", () => {
    const year = parsePartialDate("1981", "year");
    const month = parsePartialDate("2024-02", "month");
    assert.equal(year.precision, "year");
    assert.equal(year.start.toISOString().slice(0, 10), "1981-01-01");
    assert.equal(year.end.toISOString().slice(0, 10), "1981-12-31");
    assert.equal(month.end.toISOString().slice(0, 10), "2024-02-29");
});

test("flags conservative deluxe and remaster duplicates", () => {
    const result = deduplicateReleases([
        release("a", "Night Drive", "2020-01-01", "day", "album", 10),
        release("b", "Night Drive (Deluxe Edition)", "2020-10-01", "day", "album", 15),
        release("c", "Old Soul", "1970", "year", "album", 9),
        release("d", "Old Soul (2020 Remaster)", "1970", "year", "album", 9)
    ]);
    assert.equal(result.included.length, 2);
    assert.equal(result.suspectedVariants.length, 2);
});

test("handles an empty catalog", () => {
    const result = analyzeCatalog([], { now: "2026-08-12T00:00:00Z" });
    assert.equal(result.metrics.earliestRelease, null);
    assert.equal(result.metrics.albumCount, 0);
    assert.equal(result.metrics.daysSinceLatestRelease, null);
    assert.equal(result.metrics.dataConfidenceScore, 25);
});

test("retries a 429 using Retry-After", async () => {
    let calls = 0;
    const waits = [];
    const data = await fetchJsonWithRetry("https://test", {
        fetchImpl: async () => {
            calls += 1;
            if (calls === 1) return { ok: false, status: 429, headers: { get: () => "2" } };
            return { ok: true, json: async () => ({ ok: true }) };
        },
        waitImpl: async milliseconds => waits.push(milliseconds)
    });
    assert.deepEqual(data, { ok: true });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [2000]);
});

test("derives catalog metrics without changing editorial tier", () => {
    const result = analyzeCatalog([
        release("a", "Debut", "2020", "year", "album", 12),
        release("b", "New Song", "2026-08-01", "day", "single", 1)
    ], { now: "2026-08-12T00:00:00Z" });
    assert.equal(result.metrics.albumCount, 1);
    assert.equal(result.metrics.singleAndEpCount, 1);
    assert.equal(result.metrics.approximateTrackCount, 13);
    assert.equal(result.metrics.releasesLast90Days, 1);
    assert.ok(result.reasons.some(reason => reason.includes("editorial")));
});
