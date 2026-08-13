const fs = require("fs/promises");
const path = require("path");
const { assessIdentity, reviewPriority, SCORE_RULES, STATUS_THRESHOLDS } = require("../lib/identity-confidence");

const root = path.join(__dirname, "..");
const snapshotId = "kworb-spotify-monthly-listeners-2026-08-12";
const inputPath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.identity-enriched.preview.json`);
const outputPath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.identity-confidence-cohort-v2.preview.json`);
const cohortNames = [
    "Michael Jackson", "Drake", "SZA",
    "Future", "Queen", "Nirvana", "Dave", "Disney", "P!nk", "A$AP Rocky",
    "Bruno Mars", "The Weeknd", "Taylor Swift", "Bad Bunny", "Ariana Grande"
];

async function main() {
    const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const byName = new Map(input.records.map(record => [record.artistNameRaw, record]));
    const missing = cohortNames.filter(name => !byName.has(name));
    if (missing.length) throw new Error(`Cohort records missing: ${missing.join(", ")}`);
    const records = cohortNames.map(name => {
        const source = byName.get(name);
        return { ...source, identityAssessment: assessIdentity(source) };
    });
    const reviewQueue = records.filter(record => record.identityAssessment.requiresHumanReview)
        .map(record => ({
            artistNameRaw: record.artistNameRaw,
            rank: record.rank,
            priority: reviewPriority(record.identityAssessment),
            status: record.identityAssessment.status,
            reasons: record.identityAssessment.reviewReasons || [],
            conflicts: record.identityAssessment.conflicts
        })).sort((first, second) => second.priority - first.priority || first.rank - second.rank);
    const statusCounts = records.reduce((counts, record) => {
        const status = record.identityAssessment.status;
        counts[status] = (counts[status] || 0) + 1;
        return counts;
    }, {});
    const avoidManualReview = records.filter(record => !record.identityAssessment.requiresHumanReview).length;
    const output = {
        schemaVersion: 1,
        experiment: "identity-confidence-test-cohort",
        generatedAt: new Date().toISOString(),
        reviewOnly: true,
        sourceSnapshotId: input.snapshotId,
        sourceIdentityPreviewId: input.identityPreviewId,
        scoring: {
            rules: SCORE_RULES,
            thresholds: STATUS_THRESHOLDS,
            hardGates: [
                "Only an exact candidate Spotify ID already verified in Music Roll may become verified_existing.",
                "Conflicting or duplicate IDs cannot receive high confidence.",
                "Multiple exact candidates, punctuation risk, returned-name differences, and unresolved short/common names require review.",
                "Kworb rank, listeners, Music Roll tier/genre, and perceived fame contribute zero identity points."
            ]
        },
        records,
        reviewQueue,
        summary: {
            cohortSize: records.length,
            statusCounts,
            avoidsManualReview: avoidManualReview,
            avoidsManualReviewPercent: Math.round(avoidManualReview / records.length * 100)
        },
        validation: {
            liveDataChanged: false,
            spotifyApiCalled: false,
            catalogApiCalled: false,
            inferredIdentitiesMarkedVerified: 0
        }
    };
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
    console.log(`Cohort confidence preview written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("Identity confidence cohort stopped: " + error.message);
    process.exitCode = 1;
});
