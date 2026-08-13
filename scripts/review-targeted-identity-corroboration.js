const fs = require("fs/promises");
const path = require("path");
const { assessCorroboration } = require("../lib/identity-corroboration");

const root = path.join(__dirname, "..");
const base = path.join(root, "data", "mainstream-reference", "experiments");
const inputPath = path.join(base, "targeted-identity-corroboration-2026-08-12", "review.preview.json");
const outputPath = path.join(base, "targeted-identity-corroboration-2026-08-12-v2", "review.preview.json");

async function main() {
    const output = JSON.parse(await fs.readFile(inputPath, "utf8"));
    output.experimentId = "targeted-identity-corroboration-2026-08-12-v2";
    output.generatedAt = new Date().toISOString();
    output.supersedes = "targeted-identity-corroboration-2026-08-12";
    output.reviewCorrection = "Exact-name MusicBrainz entities linking to other Spotify IDs are a hard conflict even when one entity links to the candidate.";
    for (const record of output.records) {
        const conflictingIds = record.evidence?.audit?.otherSpotifyIdsInExactMusicBrainzCandidates || [];
        if (!conflictingIds.length) continue;
        record.evidence.crossDatabaseIdentifiers.spotifyUrl = "conflict";
        record.evidence.catalogFingerprint.multiplePlausibleSameNameCatalogs = true;
        record.secondStageAssessment = assessCorroboration(record.firstStageAssessment, record.evidence);
    }
    output.summary.theoreticalPromotions = output.records.filter(record =>
        record.firstStageAssessment?.status === "manual_review_required" &&
        record.secondStageAssessment?.status === "high_confidence_candidate"
    ).map(record => record.artistNameRaw);
    output.summary.remainingManualOrConflicting = output.records.filter(record =>
        record.secondStageAssessment?.requiresHumanReview
    ).map(record => record.artistNameRaw);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
    console.log(`Corrected targeted review written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("Corrected targeted review stopped: " + error.message);
    process.exitCode = 1;
});
