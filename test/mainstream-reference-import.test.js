const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSnapshot, parseAndValidateCsv, parseCsv, sha256 } = require("../lib/mainstream-reference-import");

function csvWithRows(overrides = {}) {
    const rows = ["rank,artist_name,monthly_listeners"];
    for (let rank = 1; rank <= 200; rank += 1) {
        const item = overrides[rank] || {};
        rows.push(`${item.rank ?? rank},"${item.name ?? `Artist ${rank}`}",${item.value ?? 1000000 - rank}`);
    }
    return rows.join("\n") + "\n";
}

test("parses quoted CSV fields", () => {
    assert.deepEqual(parseCsv('rank,artist_name\n1,"Artist, The"\n'), [
        ["rank", "artist_name"],
        ["1", "Artist, The"]
    ]);
});

test("accepts exactly ranks 1 through 200 and preserves source values", () => {
    const parsed = parseAndValidateCsv(csvWithRows({ 1: { name: "  Beyoncé  ", value: "123456" } }));
    assert.equal(parsed.records.length, 200);
    assert.deepEqual(parsed.records[0], {
        rank: 1,
        artistNameRaw: "  Beyoncé  ",
        artistNameNormalized: "beyoncé",
        rankingValueRaw: "123456",
        sourceRow: 2
    });
});

test("keeps ranking values null when no value column exists", () => {
    const csv = ["rank,artist", ...Array.from({ length: 200 }, (_, index) => `${index + 1},Artist ${index + 1}`)].join("\n");
    const parsed = parseAndValidateCsv(csv);
    assert.equal(parsed.records[0].rankingValueRaw, null);
    assert.equal(parsed.columns.value, null);
});

test("rejects the wrong record count", () => {
    assert.throws(() => parseAndValidateCsv("rank,artist\n1,Only Artist\n"), /exactly 200/);
});

test("rejects duplicate and missing ranks", () => {
    assert.throws(() => parseAndValidateCsv(csvWithRows({ 200: { rank: 199 } })), /Duplicate: \[199\].*missing: \[200\]/);
});

test("rejects blank artist names", () => {
    assert.throws(() => parseAndValidateCsv(csvWithRows({ 7: { name: "   " } })), /blank artist name/);
});

test("records exact input checksum and source metadata", () => {
    const inputBuffer = Buffer.from(csvWithRows());
    const parsed = parseAndValidateCsv(inputBuffer.toString("utf8"));
    const snapshot = buildSnapshot({
        inputPath: "/imports/ranking.csv",
        inputBuffer,
        parsed,
        metadata: {
            publisher: "Authorized Provider",
            rankingName: "Global Top 200",
            rankingType: "spotify_monthly_listeners",
            territory: "global",
            retrievedAt: "2026-08-12T12:00:00Z",
            sourceUrl: "https://provider.example/ranking",
            methodologyUrl: "https://provider.example/methodology",
            licenseNotes: "Authorized internal export"
        }
    });
    assert.equal(snapshot.document.source.rawSha256, sha256(inputBuffer));
    assert.equal(snapshot.document.source.originalFilename, "ranking.csv");
    assert.equal(snapshot.document.import.identityEnrichmentPerformed, false);
    assert.equal(snapshot.document.import.musicRollComparisonPerformed, false);
});
