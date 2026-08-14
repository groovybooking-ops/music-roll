const fs = require("node:fs/promises");
const path = require("node:path");
const dotenv = require("dotenv");
const { getDiscogsArtist } = require("../lib/discogs-client");

const root = path.join(__dirname, "..");
const discogsArtistId = "3272791";
const outputDir = path.join(root, "data", "identity-experiments", "discogs", "sza-3272791");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

async function main() {
    const result = await getDiscogsArtist(discogsArtistId);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "raw.json"), JSON.stringify(result.raw, null, 2) + "\n", { flag: "wx" });
    const review = {
        experiment: "discogs-exact-artist-id-lesson",
        retrievedAt: new Date().toISOString(),
        reviewOnly: true,
        source: { publisher: "Discogs", sourceClass: "community_database", endpoint: `https://api.discogs.com/artists/${discogsArtistId}` },
        authenticationUsed: result.authenticationUsed,
        artist: result.artist,
        confidenceScoringPerformed: false,
        liveDataModified: false
    };
    await fs.writeFile(path.join(outputDir, "review.json"), JSON.stringify(review, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(review, null, 2));
}

main().catch(error => {
    console.error("Discogs SZA lesson stopped: " + error.message);
    process.exitCode = 1;
});
