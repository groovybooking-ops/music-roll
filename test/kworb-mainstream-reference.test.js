const test = require("node:test");
const assert = require("node:assert/strict");
const { buildKworbSnapshot, collisionReport, parseKworbHtml } = require("../lib/kworb-mainstream-reference");

function fixtureHtml(overrides = {}) {
    const rows = [];
    for (let rank = 1; rank <= 205; rank += 1) {
        const item = overrides[rank] || {};
        rows.push(`<tr><td>${item.rank ?? rank}</td><td><a>Artist ${item.name ?? rank}</a></td><td>${(100000000 - rank).toLocaleString("en-US")}</td><td>${rank % 2 ? "-1,234" : "2,345"}</td><td>${Math.min(rank, 99)}</td><td>120,000,000</td></tr>`);
    }
    return `<html><table><tr><th>#</th><th>Artist</th><th>Listeners</th><th>Daily +/-</th><th>Peak</th><th>PkListeners</th></tr>${rows.join("")}</table></html>`;
}

test("extracts only ranks 1 through 200 with all available metrics", () => {
    const records = parseKworbHtml(fixtureHtml({ 1: { name: "Beyoncé &amp; Friends" } }));
    assert.equal(records.length, 200);
    assert.deepEqual(records[0], {
        rank: 1,
        artistNameRaw: "Artist Beyoncé & Friends",
        monthlyListeners: 99999999,
        dailyListenerChange: -1234,
        peakRank: 1,
        peakMonthlyListeners: 120000000,
        sourceRow: 2,
        artistNameNormalized: "artist beyoncé & friends"
    });
    assert.equal(records.at(-1).rank, 200);
});

test("fails closed when expected columns change", () => {
    assert.throws(() => parseKworbHtml("<table><tr><th>Name</th></tr></table>"), /expected Kworb/);
});

test("rejects missing or duplicate top-200 ranks", () => {
    assert.throws(() => parseKworbHtml(fixtureHtml({ 200: { rank: 199 } })), /Expected exactly 200|Invalid ranks/);
});

test("flags normalized duplicates and short or single-token names", () => {
    const report = collisionReport([
        { rank: 1, artistNameRaw: "SZA", artistNameNormalized: "sza" },
        { rank: 2, artistNameRaw: " SZA ", artistNameNormalized: "sza" },
        { rank: 3, artistNameRaw: "Long Artist Name", artistNameNormalized: "long artist name" }
    ]);
    assert.equal(report.duplicateNormalizedNames.length, 1);
    assert.equal(report.suspiciousNames.length, 2);
});

test("reports existing Music Roll metadata without changing it", () => {
    const htmlBuffer = Buffer.from(fixtureHtml({ 1: { name: "SZA" } }));
    const records = parseKworbHtml(htmlBuffer.toString("utf8"));
    const snapshot = buildKworbSnapshot({
        htmlBuffer,
        records,
        retrievedAt: "2026-08-12T15:00:00Z",
        musicRollArtists: [{ name: "Artist SZA", genre: "rnb", tier: "mainstream" }]
    });
    assert.equal(snapshot.snapshotId, "kworb-spotify-monthly-listeners-2026-08-12");
    assert.deepEqual(snapshot.document.records[0].musicRoll, {
        exists: true,
        matchedName: "Artist SZA",
        genre: "rnb",
        tier: "mainstream",
        matchMethod: "exact_normalized_name_review_only"
    });
    assert.equal(snapshot.document.records[0].spotifyIdentityReview.status, "not_started");
    assert.equal(snapshot.document.records[0].mainstreamEvidence.sourceClass, "third_party");
});
