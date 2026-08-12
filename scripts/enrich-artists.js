const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { searchArtistByExactName } = require("../lib/spotify-client");

const projectRoot = path.join(__dirname, "..");
const sourcePath = path.join(projectRoot, "data", "artists-source.json");
const outputPath = path.join(
    projectRoot,
    "data",
    "artists-enriched.preview.json"
);
const temporaryOutputPath = outputPath + ".tmp";

dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

function validateArtists(artists) {
    if (!Array.isArray(artists)) {
        throw new Error("artists-source.json must contain a JSON array.");
    }

    artists.forEach(function(artist, index) {
        for (const field of ["name", "genre", "tier"]) {
            if (typeof artist[field] !== "string" || !artist[field].trim()) {
                throw new Error(
                    `Artist ${index + 1} needs a non-empty ${field} value.`
                );
            }
        }
    });
}

function formatPossibleMatch(artist) {
    return {
        name: artist.name,
        spotifyId: artist.id,
        spotifyUrl: artist.spotifyUrl,
        imageUrl: artist.imageUrl
    };
}

async function writePreview(preview) {
    const json = JSON.stringify(preview, null, 2) + "\n";
    await fs.writeFile(temporaryOutputPath, json, "utf8");
    await fs.rename(temporaryOutputPath, outputPath);
}

async function enrichArtists() {
    const sourceText = await fs.readFile(sourcePath, "utf8");
    const sourceArtists = JSON.parse(sourceText);
    validateArtists(sourceArtists);

    const enrichedArtists = [];
    const unresolvedArtists = [];

    for (const sourceArtist of sourceArtists) {
        console.log(`Looking up ${sourceArtist.name}...`);

        const searchResult = await searchArtistByExactName(sourceArtist.name);

        if (searchResult.exactMatch) {
            enrichedArtists.push({
                name: sourceArtist.name,
                genre: sourceArtist.genre,
                tier: sourceArtist.tier,
                spotifyId: searchResult.exactMatch.id,
                spotifyUrl: searchResult.exactMatch.spotifyUrl,
                imageUrl: searchResult.exactMatch.imageUrl
            });
            continue;
        }

        unresolvedArtists.push({
            name: sourceArtist.name,
            genre: sourceArtist.genre,
            tier: sourceArtist.tier,
            reason: "No exact normalized Spotify artist-name match was found.",
            possibleMatches: searchResult.possibleMatches.map(formatPossibleMatch)
        });
    }

    await writePreview({
        generatedAt: new Date().toISOString(),
        artists: enrichedArtists,
        unresolved: unresolvedArtists
    });

    console.log(
        `Preview complete: ${enrichedArtists.length} enriched, ` +
        `${unresolvedArtists.length} unresolved.`
    );
    console.log("Review data/artists-enriched.preview.json before using it.");
}

enrichArtists().catch(function(error) {
    console.error("Enrichment stopped: " + error.message);
    process.exitCode = 1;
});
