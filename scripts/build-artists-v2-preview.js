const fs = require("fs/promises");
const path = require("path");
const { validateArtistDirectoryV2, validateRegistry } = require("../lib/music-roll-v2");

const root = path.join(__dirname, "..");
const livePath = path.join(root, "data", "artists.json");
const registryPath = path.join(root, "data", "artist-id-registry.json");
const outputPath = path.join(root, "data", "artists-v2.preview.json");

async function main() {
    const liveArtists = JSON.parse(await fs.readFile(livePath, "utf8"));
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    validateRegistry(registry, liveArtists);
    const mappingBySpotifyId = new Map(registry.mappings.map(mapping => [mapping.spotifyId, mapping]));
    const timestamps = registry.registryCreatedAt;
    const preview = liveArtists.map(artist => {
        const mapping = mappingBySpotifyId.get(artist.spotifyId);
        if (!mapping) throw new Error(`No verified Spotify registry binding for live artist ${artist.spotifyId}.`);
        return {
            musicRollId: mapping.musicRollId,
            schemaVersion: 2,
            name: artist.name,
            displayName: artist.name,
            identity: {
                status: "verified_existing",
                confidence: 100,
                verificationBasis: "existing_verified_spotify_id",
                evidenceRefs: []
            },
            externalIds: { spotify: artist.spotifyId },
            externalUrls: { spotify: artist.spotify },
            editorial: {
                stage: artist.tier,
                stageConfidence: null,
                stageReason: "Existing Music Roll editorial classification; confidence not yet assessed."
            },
            genres: [artist.genre],
            primaryGenre: artist.genre,
            geography: {
                home: { city: null, region: null, country: null, coordinates: null },
                confidence: "unknown",
                evidenceRefs: [],
                sceneAssociations: [],
                currentTouringMarkets: [],
                upcomingEventMarkets: []
            },
            evidence: {
                identity: [],
                mainstream: [],
                catalog: [],
                geographic: [],
                userEngagement: []
            },
            media: {
                primaryImageUrl: artist.image,
                imageSource: "spotify"
            },
            socialUrls: {
                instagram: artist.instagram,
                tiktok: artist.tiktok
            },
            status: {
                directory: "active",
                profileClaim: "unclaimed",
                submissionSource: "editorial"
            },
            createdAt: timestamps,
            updatedAt: timestamps,
            genre: artist.genre,
            tier: artist.tier,
            spotifyId: artist.spotifyId,
            spotify: artist.spotify,
            image: artist.image,
            instagram: artist.instagram,
            tiktok: artist.tiktok
        };
    });
    validateArtistDirectoryV2(preview);
    for (let index = 0; index < liveArtists.length; index += 1) {
        const before = liveArtists[index];
        const after = preview[index];
        for (const field of ["name", "genre", "tier", "spotifyId", "spotify", "image", "instagram", "tiktok"]) {
            if (before[field] !== after[field]) throw new Error(`Migration changed ${field} for ${before.name}.`);
        }
        if (Object.keys(after.externalIds).some(provider => provider !== "spotify")) throw new Error(`Unverified provider ID added for ${before.name}.`);
        if (after.geography.home.city !== null || after.geography.home.region !== null || after.geography.home.country !== null || after.geography.home.coordinates !== null) {
            throw new Error(`Unverified geography added for ${before.name}.`);
        }
    }
    await fs.writeFile(outputPath, JSON.stringify(preview, null, 2) + "\n", { flag: "wx" });
    console.log(`Artist v2 migration preview written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("Artist v2 preview stopped: " + error.message);
    process.exitCode = 1;
});
