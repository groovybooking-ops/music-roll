const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { searchArtistCandidatesByName } = require("../lib/spotify-client");
const { duplicateSpotifyIds, enrichRecord, musicRollIdMap, validatePreservation } = require("../lib/kworb-identity-enrichment");

const root = path.join(__dirname, "..");
const snapshotId = "kworb-spotify-monthly-listeners-2026-08-12";
const sourcePath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.preview.json`);
const outputPath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.identity-enriched.preview.json`);
dotenv.config({ path: path.join(root, ".env"), quiet: true });

async function main() {
    const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    const musicRollArtists = JSON.parse(await fs.readFile(path.join(root, "data", "artists.json"), "utf8"));
    if (source.snapshotId !== snapshotId) throw new Error("Unexpected source snapshot ID.");
    if (source.records.length !== 200) throw new Error("Source snapshot does not contain exactly 200 records.");
    const existingById = musicRollIdMap(musicRollArtists);
    const records = [];
    const apiErrors = [];

    for (const sourceRecord of source.records) {
        console.log(`[${sourceRecord.rank}/200] Searching ${sourceRecord.artistNameRaw}...`);
        try {
            const result = await searchArtistCandidatesByName(sourceRecord.artistNameRaw);
            records.push(enrichRecord(sourceRecord, result, existingById));
        } catch (error) {
            apiErrors.push({
                rank: sourceRecord.rank,
                artistNameRaw: sourceRecord.artistNameRaw,
                statusCode: error.statusCode || null,
                reason: error.reason || null,
                message: error.message
            });
            records.push({
                ...sourceRecord,
                spotifyIdentityReview: {
                    status: "api_error",
                    candidateMatch: null,
                    finalIdentityVerified: false,
                    ambiguityReasons: [],
                    possibleMatches: []
                }
            });
        }
    }

    validatePreservation(source.records, records);
    const duplicateIds = duplicateSpotifyIds(records);
    const preview = {
        schemaVersion: 1,
        snapshotId: source.snapshotId,
        identityPreviewId: `${source.snapshotId}-spotify-identity-review`,
        generatedAt: new Date().toISOString(),
        reviewOnly: true,
        sourceRetrievedAt: source.retrievedAt,
        source: source.source,
        rankingImport: source.import,
        records,
        reviewSummary: {
            totalRecords: records.length,
            matchedCandidates: records.filter(record => ["candidate", "ambiguous_candidate"].includes(record.spotifyIdentityReview.status)).length,
            unresolved: records.filter(record => record.spotifyIdentityReview.status === "unresolved").length,
            ambiguous: records.filter(record => record.spotifyIdentityReview.status === "ambiguous_candidate").length,
            missingImages: records.filter(record => {
                const match = record.spotifyIdentityReview.candidateMatch;
                return match && !match.imageUrl;
            }).length,
            existingMusicRollIdOverlaps: records.filter(record => record.spotifyIdentityReview.existingMusicRollSpotifyIdOverlap?.exists).length,
            duplicateSpotifyIds: duplicateIds,
            apiErrors
        },
        validation: {
            expectedRecords: 200,
            actualRecords: records.length,
            ranksPreserved: true,
            sourceFieldsPreserved: true,
            originalArtistNamesAltered: 0,
            finalIdentitiesVerified: 0,
            liveMigrationPerformed: false,
            catalogEnrichmentPerformed: false
        }
    };
    await fs.writeFile(outputPath, JSON.stringify(preview, null, 2) + "\n", { flag: "wx" });
    console.log(`Identity review preview written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("Kworb identity enrichment stopped: " + error.message);
    process.exitCode = 1;
});
