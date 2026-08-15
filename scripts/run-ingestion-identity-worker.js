const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { CANDIDATE_ID_PATTERN } = require("../lib/ingestion/candidate-schema");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { IdentityEvidenceStore } = require("../lib/ingestion/identity-evidence-store");
const { QueueIdentityResolver } = require("../lib/ingestion/queue-identity-resolver");
const { IdentityQueueWorker } = require("../lib/ingestion/identity-worker");

const root = path.join(__dirname, "..");
const protectedPaths = [path.join(root, "data", "artists.json"), path.join(root, "data", "artist-id-registry.json")];

function parseArguments(argv) {
    const result = { allowNetwork: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--allow-network") { result.allowNetwork = true; continue; }
        if (argument === "--help") { result.help = true; continue; }
        if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}.`);
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
        result[argument.slice(2)] = value;
        index += 1;
    }
    return result;
}

function usage() {
    return [
        "Usage: node scripts/run-ingestion-identity-worker.js [options]",
        "",
        "  --store-root <path>    Candidate store (default: data/ingestion/v1)",
        "  --limit <1-1000>       Maximum candidates for this run (default: 25)",
        "  --candidate-id <id>    Process one durable candidate ID",
        "  --allow-network        Permit cache misses to call providers",
        "",
        "Network mode is OFF by default. Name search is used only for the bounded MusicBrainz ambiguity audit, never to choose Spotify identity."
    ].join("\n");
}

async function checksum(file) {
    return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function protectedChecksums() {
    return Object.fromEntries(await Promise.all(protectedPaths.map(async file => [path.relative(root, file), await checksum(file)])));
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) { console.log(usage()); return; }
    const limit = args.limit == null ? 25 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be an integer from 1 to 1000.");
    if (args["candidate-id"] && !CANDIDATE_ID_PATTERN.test(args["candidate-id"])) throw new Error("--candidate-id must be a durable mr_candidate_<uuidv7> ID.");
    if (args.allowNetwork) dotenv.config({ path: path.join(root, ".env"), quiet: true });
    const storeRoot = path.resolve(process.cwd(), args["store-root"] || path.join("data", "ingestion", "v1"));
    const before = await protectedChecksums();
    const metrics = { cacheHits: 0, liveRequests: 0, retries: 0, immutableEvidenceReuses: 0, immutableEvidenceWrites: 0, byProvider: {} };
    const store = new CandidateStore(storeRoot);
    const evidenceStore = new IdentityEvidenceStore(storeRoot, { allowNetwork: args.allowNetwork, metrics });
    const resolver = new QueueIdentityResolver(evidenceStore);
    const worker = new IdentityQueueWorker({ store, resolver, evidenceStore });
    const run = await worker.run({ limit, candidateId: args["candidate-id"] || null });
    const after = await protectedChecksums();
    const protectedFilesUnchanged = Object.keys(before).every(file => before[file] === after[file]);
    if (!protectedFilesUnchanged) throw new Error("Protected live files changed during identity worker execution.");
    console.log(JSON.stringify({
        schemaVersion: 1,
        worker: "queue_identity_resolver_v1",
        storeRoot,
        networkAllowed: args.allowNetwork,
        metrics,
        ...run,
        protectedFiles: { before, after, unchanged: true },
        safety: { approvalPerformed: false, migrationPerformed: false, confidenceScoreCalculated: false }
    }, null, 2));
}

main().catch(error => {
    console.error("Ingestion identity worker stopped: " + (error.stack || error.message));
    process.exitCode = 1;
});
