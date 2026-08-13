const fs = require("fs/promises");
const path = require("path");
const { assessIdentity, reviewPriority, SCORE_RULES, STATUS_THRESHOLDS } = require("../lib/identity-confidence");
const { duplicateSpotifyIds, validatePreservation } = require("../lib/kworb-identity-enrichment");

const root = path.join(__dirname, "..");
const snapshotId = "kworb-spotify-monthly-listeners-2026-08-12";
const inputPath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.identity-enriched.preview.json`);
const outputPath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.identity-confidence-full-200.preview.json`);

function stable(value) {
    return JSON.stringify(value);
}

async function main() {
    const input = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const duplicateGroups = duplicateSpotifyIds(input.records);
    const duplicateById = new Map(duplicateGroups.map(group => [group.spotifyArtistId, group]));
    const records = input.records.map(source => {
        const spotifyId = source.spotifyIdentityReview?.candidateMatch?.spotifyArtistId;
        const duplicate = spotifyId ? duplicateById.get(spotifyId) : null;
        return {
            ...source,
            identityAssessment: assessIdentity(source, {
                duplicateSpotifyId: duplicate || null
            })
        };
    });

    validatePreservation(input.records, records);
    const ranks = records.map(record => record.rank);
    if (new Set(ranks).size !== 200 || ranks.some((rank, index) => rank !== index + 1)) {
        throw new Error("Ranks 1-200 are not complete, unique, and ordered.");
    }
    const sourceKeys = input.records.map(record => `${record.rank}\u0000${record.artistNameRaw}`);
    if (new Set(sourceKeys).size !== 200) throw new Error("Duplicate source records detected.");
    for (let index = 0; index < 200; index += 1) {
        const before = input.records[index];
        const after = records[index];
        for (const field of ["monthlyListeners", "dailyListenerChange", "peakRank", "peakMonthlyListeners", "mainstreamEvidence", "spotifyIdentityReview", "musicRoll"]) {
            if (stable(before[field]) !== stable(after[field])) throw new Error(`Rank ${before.rank} did not preserve ${field}.`);
        }
    }

    const statusCounts = Object.fromEntries([
        "verified_existing", "high_confidence_candidate", "manual_review_required", "conflicting_identity", "unresolved"
    ].map(status => [status, records.filter(record => record.identityAssessment.status === status).length]));
    const reviewQueue = records.filter(record => record.identityAssessment.requiresHumanReview)
        .map(record => ({
            rank: record.rank,
            artistNameRaw: record.artistNameRaw,
            status: record.identityAssessment.status,
            priority: reviewPriority(record.identityAssessment),
            confidence: record.identityAssessment.confidence,
            ambiguityFlags: record.spotifyIdentityReview?.ambiguityReasons || [],
            reviewReasons: record.identityAssessment.reviewReasons || [],
            conflicts: record.identityAssessment.conflicts
        }))
        .sort((a, b) => b.priority - a.priority || a.rank - b.rank);
    const avoidsImmediateReview = records.filter(record => !record.identityAssessment.requiresHumanReview).length;
    const overlaps = records.filter(record => record.spotifyIdentityReview?.existingMusicRollSpotifyIdOverlap?.exists)
        .map(record => ({
            rank: record.rank,
            artistNameRaw: record.artistNameRaw,
            spotifyArtistId: record.spotifyIdentityReview.candidateMatch.spotifyArtistId,
            musicRoll: record.spotifyIdentityReview.existingMusicRollSpotifyIdOverlap
        }));
    const output = {
        schemaVersion: 1,
        reviewId: `${snapshotId}-identity-confidence-full-200`,
        generatedAt: new Date().toISOString(),
        reviewOnly: true,
        storedEvidenceOnly: true,
        sourceSnapshotId: input.snapshotId,
        sourceIdentityPreviewId: input.identityPreviewId,
        sourceRetrievedAt: input.sourceRetrievedAt,
        source: input.source,
        rankingImport: input.rankingImport,
        scoring: {
            rules: SCORE_RULES,
            thresholds: STATUS_THRESHOLDS,
            hardGates: [
                "Only an explicitly verified existing Music Roll Spotify ID may become verified_existing.",
                "Duplicate candidate Spotify IDs produce conflicting_identity for every affected record.",
                "Stored external-identifier conflicts produce conflicting_identity; one matching identifier cannot hide a competing identifier.",
                "Normalized-name mismatches produce conflicting_identity.",
                "Multiple exact candidates, punctuation risk, returned-name differences, and short/common names require review.",
                "Rank, listeners, fame, genre, and tier contribute zero identity points.",
                "No second-stage catalog or MusicBrainz evidence is inferred in this pass."
            ]
        },
        records,
        reviewQueue,
        summary: {
            totalRecords: records.length,
            statusCounts,
            avoidsImmediateManualReview: avoidsImmediateReview,
            avoidsImmediateManualReviewPercent: Number((avoidsImmediateReview / records.length * 100).toFixed(1)),
            duplicateSpotifyIdConflicts: duplicateGroups,
            existingMusicRollOverlaps: overlaps
        },
        validation: {
            expectedRecords: 200,
            actualRecords: records.length,
            ranksCompleteAndUnchanged: true,
            duplicateSourceRecords: 0,
            originalKworbMetricsUnchanged: true,
            sourceProvenancePreserved: true,
            existingMusicRollOverlapsPreserved: overlaps.length === input.records.filter(record => record.spotifyIdentityReview?.existingMusicRollSpotifyIdOverlap?.exists).length,
            duplicateCandidateSpotifyIdsDetected: duplicateGroups.length,
            inferredIdentitiesMarkedVerified: records.filter(record => record.identityAssessment.status === "verified_existing" && !record.spotifyIdentityReview?.existingMusicRollSpotifyIdOverlap?.exists).length,
            spotifyApiCalled: false,
            musicBrainzApiCalled: false,
            catalogApiCalled: false,
            liveMigrationPerformed: false
        }
    };
    if (output.validation.inferredIdentitiesMarkedVerified !== 0) throw new Error("An inferred identity was marked verified.");
    await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
    console.log(`Full identity-confidence review written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("Full identity-confidence review stopped: " + error.message);
    process.exitCode = 1;
});
