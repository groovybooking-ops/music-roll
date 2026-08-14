const fs = require("node:fs/promises");
const path = require("node:path");
const { getWikidataIdentityBridge } = require("../lib/wikidata-client");
const { getDiscogsArtist } = require("../lib/discogs-client");
const { getMusicBrainzArtist } = require("../lib/musicbrainz-client");
const { compareIdentityEvidence } = require("../lib/identity-evidence-comparison");

const root = path.join(__dirname, "..");
const spotifyArtistId = "7tYKF4w9nC0nq9CsPZTHyP";
const outputDir = path.join(root, "data", "identity-experiments", "sza-three-source-comparison");

async function writeExclusive(name, value) {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function main() {
    const wikidataResult = await getWikidataIdentityBridge(spotifyArtistId);
    if (!wikidataResult.bridge.discogsArtistId || !wikidataResult.bridge.musicBrainzArtistId) throw new Error("Wikidata bridge lacks the Discogs or MusicBrainz ID required for this lesson.");
    const discogsResult = await getDiscogsArtist(wikidataResult.bridge.discogsArtistId);
    const musicBrainzResult = await getMusicBrainzArtist(wikidataResult.bridge.musicBrainzArtistId);
    const comparison = compareIdentityEvidence({ spotifyArtistId, wikidata: wikidataResult.bridge, discogs: discogsResult.artist, musicBrainz: musicBrainzResult.artist });
    const review = {
        experiment: "sza-wikidata-discogs-musicbrainz-identity-comparison",
        retrievedAt: new Date().toISOString(), reviewOnly: true,
        startingIdentifier: { type: "spotifyArtistId", value: spotifyArtistId, verificationStatus: "verified_existing" },
        retrievalChain: [
            { source: "wikidata", input: { spotifyArtistId }, output: { wikidataQid: wikidataResult.bridge.wikidataQid, discogsArtistId: wikidataResult.bridge.discogsArtistId, musicBrainzArtistId: wikidataResult.bridge.musicBrainzArtistId } },
            { source: "discogs", input: { discogsArtistId: wikidataResult.bridge.discogsArtistId } },
            { source: "musicbrainz", input: { musicBrainzArtistId: wikidataResult.bridge.musicBrainzArtistId } }
        ],
        sourceClaims: { wikidata: wikidataResult.bridge, discogs: discogsResult.artist, musicBrainz: musicBrainzResult.artist },
        comparison,
        automaticIdentityApprovalPerformed: false,
        liveDataModified: false
    };
    await writeExclusive("wikidata.raw.json", wikidataResult.raw);
    await writeExclusive("discogs.raw.json", discogsResult.raw);
    await writeExclusive("musicbrainz.raw.json", musicBrainzResult.raw);
    await writeExclusive("review.json", review);
    console.log(JSON.stringify(review, null, 2));
}

main().catch(error => {
    console.error("SZA identity comparison stopped: " + error.message);
    process.exitCode = 1;
});
