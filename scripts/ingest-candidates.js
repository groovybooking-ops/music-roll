const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { validateArtistDirectoryV2, validateRegistry } = require("../lib/music-roll-v2");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { intakeDiscoveries, loadDiscoveryFile } = require("../lib/ingestion/discovery-intake");

const root = path.join(__dirname, "..");
const livePath = path.join(root, "data", "artists.json");
const registryPath = path.join(root, "data", "artist-id-registry.json");

function parseArguments(argv) {
    const result = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--help") return { help: true };
        if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}.`);
        const key = argument.slice(2);
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
        result[key] = value;
        index += 1;
    }
    return result;
}

function usage() {
    return [
        "Usage:",
        "  node scripts/ingest-candidates.js --input discoveries.json [options]",
        "  node scripts/ingest-candidates.js --input discoveries.csv [options]",
        "",
        "Options:",
        "  --format json|csv",
        "  --source-type manual_curated_list|playlist|chart|festival_lineup|venue_calendar|ticketmaster_event|public_music_database|related_artist|local_scene_submission",
        "  --source-name <name>",
        "  --discovered-at <ISO-8601>",
        "  --store-root <path>  (default: data/ingestion/v1)",
        "",
        "The command performs no network requests and never modifies live artists or the permanent registry."
    ].join("\n");
}

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
        console.log(usage());
        return;
    }
    if (!args.input) throw new Error("--input is required.\n" + usage());
    const inputPath = path.resolve(process.cwd(), args.input);
    const storeRoot = path.resolve(process.cwd(), args["store-root"] || path.join("data", "ingestion", "v1"));
    const [liveBytes, registryBytes, loaded] = await Promise.all([
        fs.readFile(livePath),
        fs.readFile(registryPath),
        loadDiscoveryFile(inputPath, { format: args.format })
    ]);
    const liveArtists = JSON.parse(liveBytes);
    const permanentRegistry = JSON.parse(registryBytes);
    validateArtistDirectoryV2(liveArtists);
    validateRegistry(permanentRegistry, liveArtists);
    const protectedBefore = { artists: sha256(liveBytes), registry: sha256(registryBytes) };
    const store = new CandidateStore(storeRoot);
    const intake = await intakeDiscoveries({
        store,
        records: loaded.records,
        permanentRegistry,
        liveArtists,
        defaults: {
            sourceType: args["source-type"],
            sourceName: args["source-name"],
            discoveredAt: args["discovered-at"]
        },
        actor: { type: "command", id: "manual_discovery_intake" },
        evidenceRefs: [`input:${inputPath}`]
    });
    const [liveAfter, registryAfter] = await Promise.all([fs.readFile(livePath), fs.readFile(registryPath)]);
    const protectedAfter = { artists: sha256(liveAfter), registry: sha256(registryAfter) };
    if (protectedBefore.artists !== protectedAfter.artists || protectedBefore.registry !== protectedAfter.registry) {
        throw new Error("Protected live files changed during discovery intake.");
    }
    console.log(JSON.stringify({
        schemaVersion: 1,
        networkRequests: 0,
        input: inputPath,
        format: loaded.format,
        storeRoot,
        processed: intake.results.length,
        created: intake.results.filter(result => result.created).length,
        idempotent: intake.results.filter(result => result.idempotent).length,
        countsByState: intake.indexes.queue.countsByState,
        results: intake.results,
        protectedFilesUnchanged: true
    }, null, 2));
}

main().catch(error => {
    console.error("Candidate intake stopped: " + (error.stack || error.message));
    process.exitCode = 1;
});
