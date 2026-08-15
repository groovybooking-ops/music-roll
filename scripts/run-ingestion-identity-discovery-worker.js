const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { CANDIDATE_ID_PATTERN } = require("../lib/ingestion/candidate-schema");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { IdentityDiscoveryEvidenceStore } = require("../lib/ingestion/identity-discovery-evidence-store");
const { IdentityDiscoveryResolver } = require("../lib/ingestion/identity-discovery-resolver");
const { IdentityDiscoveryWorker } = require("../lib/ingestion/identity-discovery-worker");
const { DiscoveryStore } = require("../lib/discovery/discovery-store");

const root = path.join(__dirname, "..");
const protectedFiles = ["data/artists.json", "data/artist-id-registry.json"];

function parseArguments(argv) {
    const args = { allowNetwork: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--allow-network") { args.allowNetwork = true; continue; }
        if (argument === "--help") { args.help = true; continue; }
        if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}.`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
        args[argument.slice(2)] = value;
    }
    return args;
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function checksum(file) { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }

function createBoundedMusicBrainzFetch(metrics, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const waitImpl = options.waitImpl || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const maximumRequests = options.maximumRequests ?? 4;
    const minimumSpacingMs = options.minimumSpacingMs ?? 1100;
    let lastStartedAt = 0;
    return async (url, requestOptions = {}) => {
        for (let attempt = 0; attempt <= 1; attempt += 1) {
            if (metrics.liveRequests >= maximumRequests) throw Object.assign(new Error(`Identity-discovery MusicBrainz request cap of ${maximumRequests} reached.`), { retryable: true, operation: "request_cap" });
            const delay = Math.max(0, minimumSpacingMs - (Date.now() - lastStartedAt));
            if (delay) await waitImpl(delay);
            lastStartedAt = Date.now();
            metrics.liveRequests += 1;
            metrics.byProvider.musicbrainz ||= { cacheHits: 0, cacheMisses: 0, liveRequests: 0 };
            metrics.byProvider.musicbrainz.liveRequests += 1;
            let response;
            try { response = await fetchImpl(url, requestOptions); }
            catch (error) {
                if (attempt === 0 && metrics.liveRequests < maximumRequests) { metrics.retries += 1; await waitImpl(1000); continue; }
                throw error;
            }
            if (![429, 502, 503, 504].includes(response.status) || attempt === 1 || metrics.liveRequests >= maximumRequests) return response;
            metrics.retries += 1;
            const retryAfter = Number(response.headers?.get?.("retry-after"));
            await waitImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000);
        }
    };
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) {
        console.log("Usage: node scripts/run-ingestion-identity-discovery-worker.js [--store-root path] [--limit 1-1000] [--candidate-id id] [--allow-network]\nNetwork is OFF by default; --allow-network enables only bounded exact bridge requests.");
        return;
    }
    const limit = args.limit == null ? 25 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("--limit must be an integer from 1 to 1000.");
    if (args["candidate-id"] && !CANDIDATE_ID_PATTERN.test(args["candidate-id"])) throw new Error("--candidate-id is invalid.");
    const storeRoot = path.resolve(process.cwd(), args["store-root"] || "data/ingestion/v1");
    const before = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await checksum(path.join(root, file))])));
    const store = new CandidateStore(storeRoot);
    const discoveryStore = new DiscoveryStore(storeRoot);
    const metrics = { cacheHits: 0, cacheMisses: 0, liveRequests: 0, retries: 0, immutableEvidenceWrites: 0, immutableEvidenceReuses: 0, byProvider: {} };
    const evidenceStore = new IdentityDiscoveryEvidenceStore(storeRoot, { allowNetwork: args.allowNetwork, metrics });
    const resolver = new IdentityDiscoveryResolver({
        evidenceStore,
        discoveryStore,
        wikidataPropertySemantics: {},
        fetchers: { musicbrainz: createBoundedMusicBrainzFetch(metrics, { maximumRequests: 4, minimumSpacingMs: 1100 }) }
    });
    const permanentRegistry = await readJson(path.join(root, "data", "artist-id-registry.json"));
    const liveArtists = await readJson(path.join(root, "data", "artists.json"));
    const worker = new IdentityDiscoveryWorker({ store, resolver, evidenceStore, permanentRegistry, liveArtists });
    const run = await worker.run({ limit, candidateId: args["candidate-id"] || null });
    const after = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await checksum(path.join(root, file))])));
    if (protectedFiles.some(file => before[file] !== after[file])) throw new Error("Protected live files changed during identity discovery.");
    console.log(JSON.stringify({
        schemaVersion: 1,
        worker: "identity_discovery_worker_v1",
        cacheOnly: !args.allowNetwork,
        networkAllowed: args.allowNetwork,
        requestLimits: { musicbrainz: 4, wikidata: 0 },
        exactStrategies: { localOccurrenceBridges: true, musicBrainzExactTicketmasterUrl: true, musicBrainzExactMbid: true, wikidataExactTicketmasterId: false, wikidataReason: "production_ticketmaster_property_semantics_not_confirmed" },
        storeRoot,
        metrics: evidenceStore.metrics,
        ...run,
        protectedFiles: { before, after, unchanged: true },
        safety: { identityVerified: false, identityApproved: false, migrationPerformed: false, stage3Run: false, musicRollIdReserved: false }
    }, null, 2));
}

if (require.main === module) {
    main().catch(error => {
        console.error("Identity-discovery worker stopped: " + (error.stack || error.message));
        process.exitCode = 1;
    });
}

module.exports = { createBoundedMusicBrainzFetch, parseArguments };
