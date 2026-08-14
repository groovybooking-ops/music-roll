const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { blockedCohortFromAccounting, buildBatchReview, cacheRelativePath } = require("../lib/batch-identity-corroboration");

const readJson = relative => JSON.parse(fs.readFileSync(path.join(__dirname, relative), "utf8"));

test("accounting preview yields exactly the 40 blocked stored Spotify candidates", () => {
    const cohort = blockedCohortFromAccounting(readJson("../data/artists-46-v2.accounting.preview.json"));
    assert.equal(cohort.length, 40);
    assert.ok(cohort.every(candidate => /^[A-Za-z0-9]{22}$/.test(candidate.spotifyArtistId)));
    assert.equal(cohort.find(candidate => candidate.displayName === "Nirvana").spotifyArtistId, "6olE6TJLqED3rqDCT0FyPh");
});

test("fixture batch separates coherent, ambiguous, unresolved, and conflicting outcomes", () => {
    const fixture = readJson("fixtures/batch-identity-corroboration/scenarios.json");
    const batch = buildBatchReview(fixture.candidates, fixture.evidence);
    assert.deepEqual(batch.summary.countsByOutcome, { coherent_identity_evidence: 1, coherent_identity_with_same_name_ambiguity: 1, insufficient_corroboration: 0, conflicting_identity: 1, unresolved_identity: 1 });
    assert.equal(batch.reports.find(report => report.candidate.displayName === "Nirvana").sameNameAmbiguity.competingEntities[0].discogsArtistIds[0], "307513");
    assert.equal(batch.reports.find(report => report.candidate.displayName === "Conflict Artist").conflictingIdentifiers.length, 2);
    assert.deepEqual(batch.safety, { automaticVerificationPerformed: false, confidenceScoreCalculated: false, migrationPerformed: false });
});

test("missing linked IDs are insufficient evidence, not a conflict", () => {
    const candidate = { displayName: "Partial", spotifyArtistId: "0000000000000000000003" };
    const batch = buildBatchReview([candidate], { [candidate.spotifyArtistId]: { wikidata: { spotifyArtistId: candidate.spotifyArtistId, wikidataQid: "Q123", name: "Partial", musicBrainzArtistId: null, discogsArtistId: null } } });
    assert.equal(batch.reports[0].outcome, "insufficient_corroboration");
    assert.deepEqual(batch.reports[0].conflictingIdentifiers, []);
    assert.deepEqual(batch.reports[0].missingEvidence, ["wikidata_musicbrainz_id", "wikidata_discogs_id"]);
});

test("cache paths are provider and exact-identifier scoped", () => {
    assert.equal(cacheRelativePath("wikidata", "6olE6TJLqED3rqDCT0FyPh", "spotify-bridge"), path.join("wikidata", "spotify-bridge", "6olE6TJLqED3rqDCT0FyPh.json"));
    assert.throws(() => cacheRelativePath("musicbrainz", "../../escape", "artist"), /Unsafe/);
    assert.equal(cacheRelativePath("spotify", "artist-id", "profile"), path.join("spotify", "profile", "artist-id.json"));
});

test("live batch runner refuses to start without the explicit network gate", () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "../scripts/run-curated-40-identity-batch.js")], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pass --allow-network/);
});
