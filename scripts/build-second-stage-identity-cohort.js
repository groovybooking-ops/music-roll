const fs = require("fs/promises");
const path = require("path");
const { readFixtureJson } = require("../lib/cached-fixture-reader");
const { assessCorroboration } = require("../lib/identity-corroboration");
const { assessIdentity } = require("../lib/identity-confidence");

const root = path.join(__dirname, "..");
const snapshotId = "kworb-spotify-monthly-listeners-2026-08-12";
const inputPath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.identity-enriched.preview.json`);
const outputPath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.second-stage-fixture-cohort.preview.json`);
const fixtureRoot = path.join(root, "test", "fixtures", "identity-corroboration");
const ambiguousNames = ["Future", "Queen", "Nirvana", "Dave", "Disney", "P!nk", "A$AP Rocky"];
const controlNames = ["Michael Jackson", "Drake", "SZA", "Bruno Mars", "The Weeknd", "Taylor Swift", "Bad Bunny", "Ariana Grande"];

function mergeFixture(spotify = {}, musicBrainz = {}) {
    return {
        ...spotify,
        ...musicBrainz,
        crossDatabaseIdentifiers: { ...(spotify.crossDatabaseIdentifiers || {}), ...(musicBrainz.crossDatabaseIdentifiers || {}) },
        crossDatabaseEntityMetadata: { ...(spotify.crossDatabaseEntityMetadata || {}), ...(musicBrainz.crossDatabaseEntityMetadata || {}) },
        catalogFingerprint: { ...(spotify.catalogFingerprint || {}), ...(musicBrainz.catalogFingerprint || {}) },
        weakPresentationEvidence: { ...(spotify.weakPresentationEvidence || {}), ...(musicBrainz.weakPresentationEvidence || {}) }
    };
}

async function main() {
    const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const spotifyFixtures = await readFixtureJson(fixtureRoot, "spotify", "scenarios.json");
    const musicBrainzFixtures = await readFixtureJson(fixtureRoot, "musicbrainz", "scenarios.json");
    const byName = new Map(input.records.map(record => [record.artistNameRaw, record]));
    const records = [...ambiguousNames, ...controlNames].map(name => {
        const source = byName.get(name);
        if (!source) throw new Error(`Missing stored identity record for ${name}.`);
        const firstStage = assessIdentity(source);
        const fixture = ambiguousNames.includes(name)
            ? mergeFixture(spotifyFixtures[name], musicBrainzFixtures[name])
            : {};
        return {
            artistNameRaw: source.artistNameRaw,
            rank: source.rank,
            cohortRole: ambiguousNames.includes(name) ? "ambiguous_fixture_experiment" : "stored_evidence_regression_control",
            candidateSpotifyArtistId: source.spotifyIdentityReview.candidateMatch?.spotifyArtistId || null,
            firstStageAssessment: firstStage,
            secondStageAssessment: assessCorroboration(firstStage, fixture),
            fixtureEvidence: ambiguousNames.includes(name) ? fixture : null
        };
    });
    const output = {
        schemaVersion: 1,
        experiment: "second-stage-identity-confidence-fixtures",
        generatedAt: new Date().toISOString(),
        reviewOnly: true,
        syntheticFixtureEvidence: true,
        sourceIdentityPreviewId: input.identityPreviewId,
        records,
        summary: records.reduce((summary, record) => {
            const status = record.secondStageAssessment.status;
            summary.statusCounts[status] = (summary.statusCounts[status] || 0) + 1;
            if (record.firstStageAssessment.status === "manual_review_required" && status === "high_confidence_candidate") {
                summary.theoreticalPromotions.push(record.artistNameRaw);
            }
            if (record.secondStageAssessment.requiresHumanReview) summary.remainingReview.push(record.artistNameRaw);
            return summary;
        }, { statusCounts: {}, theoreticalPromotions: [], remainingReview: [] }),
        validation: {
            liveApiRequests: 0,
            inferredIdentitiesMarkedVerified: records.filter(record =>
                record.firstStageAssessment.status !== "verified_existing" &&
                record.secondStageAssessment.status === "verified_existing"
            ).length,
            liveMigrationPerformed: false
        }
    };
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
    console.log(`Second-stage fixture preview written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("Second-stage fixture cohort stopped: " + error.message);
    process.exitCode = 1;
});
