const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { getSpotifyAccessToken } = require("../lib/spotify-client");
const { fetchArtistAlbumsPaginated } = require("../lib/spotify-catalog-client");
const { analyzeCatalog } = require("../lib/catalog-enrichment");

const root = path.join(__dirname, "..");
const sourcePath = path.join(root, "data", "catalog-experiment-source.json");
const identityPath = path.join(root, "data", "artists-enriched.preview.json");
const outputPath = path.join(root, "data", "artists-catalog-experiment.preview.json");
const temporaryPath = outputPath + ".tmp";
dotenv.config({ path: path.join(root, ".env"), quiet: true });

async function main() {
    const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    const identityPreview = JSON.parse(await fs.readFile(identityPath, "utf8"));
    const identityByName = new Map(identityPreview.artists.map(artist => [artist.name, artist]));
    const token = await getSpotifyAccessToken();
    const artists = [];
    const errors = [];

    for (const editorial of source) {
        const identity = identityByName.get(editorial.name);
        if (!identity) {
            errors.push({ name: editorial.name, stage: "identity", message: "No identity in the existing review preview." });
            continue;
        }
        console.log(`Fetching catalog for ${editorial.name}...`);
        try {
            const catalog = await fetchArtistAlbumsPaginated(identity.spotifyId, token, { market: "US" });
            const analysis = analyzeCatalog(catalog.items, {
                market: catalog.market,
                paginationComplete: catalog.paginationComplete
            });
            artists.push({
                name: editorial.name,
                genre: editorial.genre,
                existingTier: editorial.tier,
                spotify: {
                    artistId: identity.spotifyId,
                    artistUrl: identity.spotifyUrl,
                    imageUrl: identity.imageUrl,
                    identityStatus: "pending_review"
                },
                catalog: analysis.metrics,
                suggestedTierCandidates: analysis.suggestedTierCandidates,
                reasons: analysis.reasons,
                audit: { ...analysis.audit, pageCount: catalog.pageCount }
            });
        } catch (error) {
            errors.push({
                name: editorial.name,
                stage: "catalog",
                statusCode: error.statusCode || null,
                message: error.message
            });
        }
    }

    const preview = {
        generatedAt: new Date().toISOString(),
        schemaVersion: 1,
        experiment: "six-artist-catalog-signals",
        reviewOnly: true,
        artists,
        errors
    };
    await fs.writeFile(temporaryPath, JSON.stringify(preview, null, 2) + "\n", "utf8");
    await fs.rename(temporaryPath, outputPath);
    console.log(`Experiment complete: ${artists.length} enriched, ${errors.length} errors.`);
    console.log("Review data/artists-catalog-experiment.preview.json before any migration.");
}

main().catch(error => {
    console.error("Catalog experiment stopped: " + error.message);
    process.exitCode = 1;
});
