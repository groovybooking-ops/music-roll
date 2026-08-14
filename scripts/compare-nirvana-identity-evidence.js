const fs = require("node:fs/promises");
const path = require("node:path");
const { getWikidataIdentityBridge } = require("../lib/wikidata-client");
const { getDiscogsArtist } = require("../lib/discogs-client");
const { getMusicBrainzArtist, searchMusicBrainzArtistsByExactName } = require("../lib/musicbrainz-client");
const { auditSameNameMusicBrainzEntities, compareIdentityEvidence } = require("../lib/identity-evidence-comparison");

const root = path.join(__dirname, "..");
const spotifyArtistId = "6olE6TJLqED3rqDCT0FyPh";
const outputDir = path.join(root, "data", "identity-experiments", "nirvana-three-source-stress-test");
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function writeExclusive(name, value) {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function main() {
    const wikidata = await getWikidataIdentityBridge(spotifyArtistId);
    const bridge = wikidata.bridge;
    if (!bridge.musicBrainzArtistId || !bridge.discogsArtistId) throw new Error("Wikidata bridge lacks required exact IDs.");
    const discogs = await getDiscogsArtist(bridge.discogsArtistId);
    const selectedMusicBrainz = await getMusicBrainzArtist(bridge.musicBrainzArtistId);
    await wait(1100);
    const nameSearch = await searchMusicBrainzArtistsByExactName(selectedMusicBrainz.artist.name);
    const detailedArtists = [];
    for (const candidate of nameSearch.exactMatches.slice(0, 10)) {
        if (candidate.musicBrainzArtistId === selectedMusicBrainz.artist.musicBrainzArtistId) {
            detailedArtists.push(selectedMusicBrainz.artist);
        } else {
            await wait(1100);
            detailedArtists.push((await getMusicBrainzArtist(candidate.musicBrainzArtistId)).artist);
        }
    }
    const identifierComparison = compareIdentityEvidence({ spotifyArtistId, wikidata: bridge, discogs: discogs.artist, musicBrainz: selectedMusicBrainz.artist });
    const sameNameAudit = auditSameNameMusicBrainzEntities(bridge.musicBrainzArtistId, nameSearch.exactMatches, detailedArtists);
    const review = {
        experiment: "nirvana-three-source-identity-stress-test", retrievedAt: new Date().toISOString(), reviewOnly: true,
        startingSpotifyId: spotifyArtistId,
        sourceResults: { wikidata: bridge, musicBrainz: selectedMusicBrainz.artist, discogs: discogs.artist },
        identifierAgreement: identifierComparison.identifierComparison,
        conflictingIdentifiers: identifierComparison.conflicts,
        sameNameAudit,
        supportingMetadata: identifierComparison.supportingMetadata,
        comparisonWithSza: {
            safer: "The selected exact-ID chain can be internally consistent across Wikidata, MusicBrainz, and Discogs.",
            riskier: sameNameAudit.competingEntityCount ? `MusicBrainz contains ${sameNameAudit.competingEntityCount} other exact-display-name entities, so name agreement is substantially less discriminating than for the SZA lesson.` : "No other exact display-name MusicBrainz entity was observed in this bounded search.",
            conclusion: "Exact-ID agreement and same-name ambiguity coexist; this report does not approve the identity."
        },
        confidenceScoreCalculated: false, automaticIdentityApprovalPerformed: false, liveDataModified: false
    };
    await writeExclusive("wikidata.raw.json", wikidata.raw);
    await writeExclusive("discogs.raw.json", discogs.raw);
    await writeExclusive("musicbrainz-selected.raw.json", selectedMusicBrainz.raw);
    await writeExclusive("musicbrainz-name-search.raw.json", nameSearch.raw);
    await writeExclusive("review.json", review);
    console.log(JSON.stringify(review, null, 2));
}

main().catch(error => { console.error("Nirvana identity stress test stopped: " + error.message); process.exitCode = 1; });
