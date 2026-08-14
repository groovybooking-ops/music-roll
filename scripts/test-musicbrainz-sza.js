const fs = require("node:fs/promises");
const path = require("node:path");
const { getMusicBrainzArtist } = require("../lib/musicbrainz-client");

const root = path.join(__dirname, "..");
const mbid = "272989c8-5535-492d-a25c-9f58803e027f";
const outputDir = path.join(root, "data", "identity-experiments", "musicbrainz", `sza-${mbid}`);

async function main() {
    const result = await getMusicBrainzArtist(mbid);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "raw.json"), JSON.stringify(result.raw, null, 2) + "\n", { flag: "wx" });
    const review = {
        experiment: "musicbrainz-exact-artist-id-lesson",
        retrievedAt: new Date().toISOString(), reviewOnly: true,
        source: { publisher: "MusicBrainz", sourceClass: "community_database", endpoint: `https://musicbrainz.org/ws/2/artist/${mbid}?inc=aliases+url-rels&fmt=json` },
        authenticationRequired: false,
        artist: result.artist,
        releaseCatalogRequested: false,
        confidenceScoringPerformed: false,
        liveDataModified: false
    };
    await fs.writeFile(path.join(outputDir, "review.json"), JSON.stringify(review, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify(review, null, 2));
}

main().catch(error => {
    console.error("MusicBrainz SZA lesson stopped: " + error.message);
    process.exitCode = 1;
});
