const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { getTicketmasterAttraction, getUpcomingEventsForAttraction } = require("../lib/ticketmaster-client");

const root = path.join(__dirname, "..");
const outputRoot = path.join(root, "data", "identity-experiments", "ticketmaster-sza-exact-attraction");
const protectedFiles = ["data/artists.json", "data/artist-id-registry.json"];
const attractionId = "1858419";
const allowNetwork = process.argv.includes("--allow-network");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

async function sha256(relative) { return crypto.createHash("sha256").update(await fs.readFile(path.join(root, relative))).digest("hex"); }
async function writeExclusive(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }

async function main() {
    if (!allowNetwork) throw new Error("Refusing to run: pass --allow-network only for an explicitly approved Ticketmaster review lookup.");
    if (!process.env.TICKETMASTER_API_KEY) throw new Error("TICKETMASTER_API_KEY is missing from .env.");
    const before = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const attractionResult = await getTicketmasterAttraction(attractionId, { apiKey: process.env.TICKETMASTER_API_KEY });
    const eventResult = await getUpcomingEventsForAttraction(attractionResult.discoveryAttractionId || attractionId, { apiKey: process.env.TICKETMASTER_API_KEY, size: 3 });
    const after = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const unchanged = protectedFiles.every(file => before[file] === after[file]);
    if (!unchanged) throw new Error("Protected Music Roll files changed during the Ticketmaster review lookup.");
    const retrievedAt = new Date().toISOString();
    const report = {
        schemaVersion: 1,
        experiment: "ticketmaster-sza-exact-attraction-review",
        retrievedAt,
        reviewOnly: true,
        requestedAttractionId: attractionId,
        attractionLookupMethod: attractionResult.lookupMethod,
        discoveryAttractionId: attractionResult.discoveryAttractionId,
        legacyAttractionId: attractionResult.legacyAttractionId,
        attraction: attractionResult.attraction,
        upcomingEvents: { totalUpcomingEvents: eventResult.totalUpcomingEvents, sampleSize: eventResult.sampleSize, events: eventResult.events },
        rawResponses: { attraction: attractionResult.raw, legacyBridge: attractionResult.bridgeRaw || null, events: eventResult.raw },
        protectedFiles: { before, after, unchanged },
        safety: { liveArtistDataModified: false, permanentRegistryModified: false, uiModified: false, recommendationLogicModified: false, genresOrStagesModified: false, identityApprovalChanged: false, ticketmasterIdsPersistedToLiveRecords: false, eventsPersistedToLiveRecords: false }
    };
    const runDir = path.join(outputRoot, `sza-${retrievedAt.replace(/[:.]/g, "-")}`);
    await writeExclusive(path.join(runDir, "review.json"), report);
    console.log(`REPORT=${path.relative(root, path.join(runDir, "review.json"))}`);
    console.log(JSON.stringify({ attraction: report.attraction, upcomingEvents: report.upcomingEvents, protectedFilesUnchanged: unchanged }));
}

main().catch(error => { console.error("Ticketmaster SZA review test stopped: " + (error.stack || error.message)); process.exitCode = 1; });
