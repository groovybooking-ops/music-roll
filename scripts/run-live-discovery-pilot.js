const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { createSpotifyLiveDiscoveryAdapter, createTicketmasterLiveDiscoveryAdapter } = require("../lib/discovery/live-discovery-adapters");
const { runLiveDiscoveryPilot } = require("../lib/discovery/live-discovery-pilot");
const { BoundedRequestLedger, ImmutableListingCache } = require("../lib/discovery/live-pilot-support");

const projectRoot = path.join(__dirname, "..");
function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? null : process.argv[index + 1];
}

const supportedPilotIds = new Set([
    "first-live-multisource-2026-08-14",
    "second-live-multisource-2026-08-14"
]);
const pilotId = argumentValue("--pilot-id") || "first-live-multisource-2026-08-14";
if (!supportedPilotIds.has(pilotId)) throw new Error(`Unsupported guarded live discovery pilot ID: ${pilotId}`);
const pilotRoot = path.join(projectRoot, "data", "ingestion", "pilots", pilotId);
const manifestFile = path.join(pilotRoot, "pilot-manifest.json");
const allowNetwork = process.argv.includes("--allow-network");
dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });

async function loadJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

async function loadOrCreateManifest() {
    try { return await loadJson(manifestFile); }
    catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const discoveredAt = new Date().toISOString();
    const secondPilot = pilotId === "second-live-multisource-2026-08-14";
    const manifest = {
        schemaVersion: 1,
        pilotId,
        reviewOnly: true,
        discoveredAt,
        freshnessPolicyHours: 24,
        limits: secondPilot ? {
            totalProviderRequests: 12,
            spotifyRequests: 6,
            ticketmasterRequests: 6,
            normalizedOccurrences: 30,
            newCandidates: 15,
            unresolvedQueueGrowth: 15
        } : undefined,
        spotify: {
            mode: "artist_search_results",
            query: secondPilot ? "Beyoncé" : "SZA",
            queryRecordId: secondPilot ? "bounded-query-beyonce" : "bounded-query-sza",
            limit: secondPilot ? 5 : 3,
            market: "US",
            sourceType: "public_music_database",
            sourceName: secondPilot ? "Music Roll second bounded live discovery pilot" : "Music Roll first bounded live discovery pilot"
        },
        ticketmaster: {
            mode: "event_attractions",
            stateCode: secondPilot ? "CA" : "NY",
            startDateTime: "2026-08-15T00:00:00Z",
            endDateTime: "2026-08-22T00:00:00Z",
            size: secondPilot ? 2 : 1,
            sourceType: "ticketmaster_event",
            sourceName: secondPilot ? "Music Roll second bounded CA Ticketmaster discovery pilot" : "Music Roll first bounded NY Ticketmaster discovery pilot"
        }
    };
    if (!manifest.limits) delete manifest.limits;
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    return manifest;
}

async function main() {
    if (!allowNetwork) throw new Error("Refusing live discovery: pass --allow-network only after explicit approval.");
    const manifest = await loadOrCreateManifest();
    const limits = manifest.limits;
    const cache = new ImmutableListingCache(path.join(pilotRoot, "store"), { freshnessMs: manifest.freshnessPolicyHours * 60 * 60 * 1000 });
    const ledger = new BoundedRequestLedger({
        totalCap: limits?.totalProviderRequests ?? 8,
        spotifyCap: limits?.spotifyRequests ?? 4,
        ticketmasterCap: limits?.ticketmasterRequests ?? 4
    });
    const spotifyConfiguration = { ...manifest.spotify, discoveredAt: manifest.discoveredAt };
    const ticketmasterConfiguration = { ...manifest.ticketmaster, discoveredAt: manifest.discoveredAt };
    const spotify = createSpotifyLiveDiscoveryAdapter({ cache, ledger, credentials: { clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET } });
    const ticketmaster = createTicketmasterLiveDiscoveryAdapter({ cache, ledger, apiKey: process.env.TICKETMASTER_API_KEY });
    const result = await runLiveDiscoveryPilot({
        projectRoot,
        pilotRoot,
        pilotId,
        limits,
        allowNetwork,
        ledger,
        adapters: [{ adapter: spotify, configuration: spotifyConfiguration }, { adapter: ticketmaster, configuration: ticketmasterConfiguration }],
        permanentRegistry: await loadJson(path.join(projectRoot, "data", "artist-id-registry.json")),
        liveArtists: await loadJson(path.join(projectRoot, "data", "artists.json"))
    });
    console.log(`REPORT=${path.relative(projectRoot, result.reportFile)}`);
    console.log(JSON.stringify(result.report));
}

main().catch(error => {
    console.error("Live discovery pilot stopped: " + (error.stack || error.message));
    process.exitCode = 1;
});
