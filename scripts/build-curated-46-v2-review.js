const fs = require("fs/promises");
const path = require("path");
const { buildCohortReview } = require("../lib/artist-cohort-v2");

const root = path.join(__dirname, "..");
const outputs = {
    accounting: path.join(root, "data", "artists-46-v2.accounting.preview.json"),
    registryPreview: path.join(root, "data", "artist-id-registry-46.extension.preview.json"),
    migrationReady: path.join(root, "data", "artists-46-v2.migration-ready.preview.json")
};

async function readJson(relative) {
    return JSON.parse(await fs.readFile(path.join(root, relative), "utf8"));
}

async function main() {
    const sourceArtists = await readJson("data/artists-source.json");
    const enrichment = await readJson("data/artists-enriched.preview.json");
    const liveArtists = await readJson("data/artists.json");
    const registry = await readJson("data/artist-id-registry.json");
    const result = buildCohortReview({ sourceArtists, enrichedArtists: enrichment.artists, liveArtists, registry, generatedAt: new Date().toISOString() });
    for (const [key, outputPath] of Object.entries(outputs)) {
        await fs.writeFile(outputPath, JSON.stringify(result[key], null, 2) + "\n", { flag: "wx" });
        console.log(`Written: ${path.relative(root, outputPath)}`);
    }
}

main().catch(error => {
    console.error("Curated 46 v2 review stopped: " + error.message);
    process.exitCode = 1;
});
