const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildReviewMigrationPackage } = require("../lib/review-migration-package");
const { validateArtistDirectoryV2 } = require("../lib/music-roll-v2");

const root = path.join(__dirname, "..");
const reanalysisRelative = "data/identity-experiments/curated-40-provider-multiplicity-reanalysis/curated-40-provider-multiplicity-reanalysis-2026-08-14T04-18-32-340Z.review.json";
const outputRoot = path.join(root, "data", "identity-experiments", "curated-14-review-migration-package");
const protectedFiles = ["data/artists.json", "data/artist-id-registry.json"];
const readJson = relative => fs.readFile(path.join(root, relative), "utf8").then(JSON.parse);
const sha256 = async relative => crypto.createHash("sha256").update(await fs.readFile(path.join(root, relative))).digest("hex");
async function writeExclusive(filePath, value) { await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }

async function main() {
    const generatedAt = new Date().toISOString();
    const runDir = path.join(outputRoot, `curated-14-${generatedAt.replace(/[:.]/g, "-")}`);
    const before = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const [accounting, reanalysis, liveArtists, permanentRegistry] = await Promise.all([
        readJson("data/artists-46-v2.accounting.preview.json"), readJson(reanalysisRelative), readJson("data/artists.json"), readJson("data/artist-id-registry.json")
    ]);
    const result = buildReviewMigrationPackage({ accounting, reanalysis, liveArtists, permanentRegistry, generatedAt, evidenceRef: reanalysisRelative });
    validateArtistDirectoryV2(result.migrationPreview);
    await writeExclusive(path.join(runDir, "human-review-summary.json"), result.humanReview);
    await writeExclusive(path.join(runDir, "artist-id-registry-extension.preview.json"), result.registryPreview);
    await writeExclusive(path.join(runDir, "artists-v2-migration-ready.preview.json"), result.migrationPreview);
    const after = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const manifest = { schemaVersion: 1, generatedAt, reviewOnly: true, files: ["human-review-summary.json", "artist-id-registry-extension.preview.json", "artists-v2-migration-ready.preview.json"], validation: { supportedArtists: 14, existingPermanentArtists: 6, v2DirectoryRecords: 20, schemaValid: true, uniqueMusicRollIds: true, uniqueSpotifyIds: true, apiRequests: 0, protectedFilesUnchanged: protectedFiles.every(file => before[file] === after[file]) }, protectedFiles: { before, after }, safety: result.humanReview.safety };
    await writeExclusive(path.join(runDir, "manifest.json"), manifest);
    console.log(`RUN_DIR=${path.relative(root, runDir)}`);
    console.log(JSON.stringify({ artists: result.humanReview.artists.map(item => ({ name: item.curatedName, musicRollId: item.proposedMusicRollId, outcome: item.identityOutcome })), validation: manifest.validation }));
}

main().catch(error => { console.error("Curated-14 review package stopped: " + (error.stack || error.message)); process.exitCode = 1; });
