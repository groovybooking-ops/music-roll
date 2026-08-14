const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildCurated21ReviewPackage } = require("../lib/curated-21-review-package");
const { validateArtistDirectoryV2, validateRegistry } = require("../lib/music-roll-v2");

const root = path.join(__dirname, "..");
const reconsiderationRelative = "data/identity-experiments/curated-26-reconsideration/curated-26-2026-08-14T05-23-01-208Z/cohort-summary.review.json";
const outputRoot = path.join(root, "data", "identity-experiments", "curated-21-review-migration-package");
const protectedFiles = ["data/artists.json", "data/artist-id-registry.json"];
const readJson = relative => fs.readFile(path.join(root, relative), "utf8").then(JSON.parse);
const sha256 = async relative => crypto.createHash("sha256").update(await fs.readFile(path.join(root, relative))).digest("hex");
async function writeExclusive(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }

async function main() {
    const generatedAt = new Date().toISOString();
    const runDir = path.join(outputRoot, `curated-21-${generatedAt.replace(/[:.]/g, "-")}`);
    const before = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const [accounting, registryExtension, reconsideration, liveArtists, permanentRegistry] = await Promise.all([
        readJson("data/artists-46-v2.accounting.preview.json"), readJson("data/artist-id-registry-46.extension.preview.json"), readJson(reconsiderationRelative), readJson("data/artists.json"), readJson("data/artist-id-registry.json")
    ]);
    const result = buildCurated21ReviewPackage({ accounting, registryExtension, reconsideration, liveArtists, permanentRegistry, generatedAt, evidenceRef: reconsiderationRelative });
    validateArtistDirectoryV2(result.migrationPreview);
    validateRegistry(result.registryPreview, result.migrationPreview);
    await writeExclusive(path.join(runDir, "human-review-summary.json"), result.humanReview);
    await writeExclusive(path.join(runDir, "artist-id-registry-extension.preview.json"), result.registryPreview);
    await writeExclusive(path.join(runDir, "artists-v2-migration-ready.preview.json"), result.migrationPreview);
    const after = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const liveRecordsUnchanged = JSON.stringify(result.migrationPreview.slice(0, liveArtists.length)) === JSON.stringify(liveArtists);
    const manifest = {
        schemaVersion: 1, generatedAt, reviewOnly: true,
        files: ["human-review-summary.json", "artist-id-registry-extension.preview.json", "artists-v2-migration-ready.preview.json"],
        validation: { candidates: 21, existingPermanentArtists: 20, v2DirectoryRecords: 41, schemaValid: true, compatibilityFieldsValid: true, uniqueMusicRollIds: true, uniqueSpotifyIds: true, curatedGenresAndStagesUnchanged: true, currentLiveRecordsUnchanged: liveRecordsUnchanged, candidateApprovalState: "not_approved", candidatesMigrationEligible: false, apiRequests: 0, protectedFilesUnchanged: protectedFiles.every(file => before[file] === after[file]) },
        protectedFiles: { before, after }, safety: result.humanReview.safety
    };
    if (!liveRecordsUnchanged || !manifest.validation.protectedFilesUnchanged) throw new Error("Protected live state changed while creating the review package.");
    await writeExclusive(path.join(runDir, "manifest.json"), manifest);
    console.log(`RUN_DIR=${path.relative(root, runDir)}`);
    console.log(JSON.stringify({ countsByOutcome: result.humanReview.countsByOutcome, artists: result.humanReview.artists.map(artist => ({ musicRollId: artist.proposedMusicRollId, name: artist.artistName, outcome: artist.identityOutcome })), validation: manifest.validation }));
}

main().catch(error => { console.error("Curated-21 review package stopped: " + (error.stack || error.message)); process.exitCode = 1; });
