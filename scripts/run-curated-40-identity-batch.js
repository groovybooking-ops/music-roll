const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { getWikidataIdentityBridge } = require("../lib/wikidata-client");
const { getMusicBrainzArtist, searchMusicBrainzArtistsByExactName } = require("../lib/musicbrainz-client");
const { getDiscogsArtist } = require("../lib/discogs-client");
const { blockedCohortFromAccounting, buildArtistEvidenceReport, buildBatchReview, cacheRelativePath } = require("../lib/batch-identity-corroboration");

const root = path.join(__dirname, "..");
const cacheRoot = path.join(root, "data", "identity-experiments", "provider-cache", "v1");
const experimentRoot = path.join(root, "data", "identity-experiments", "curated-40-batch");
const accountingPath = path.join(root, "data", "artists-46-v2.accounting.preview.json");
const protectedPaths = [path.join(root, "data", "artists.json"), path.join(root, "data", "artist-id-registry.json")];
const allowNetwork = process.argv.includes("--allow-network");
const maxNameEntities = 10;
dotenv.config({ path: path.join(root, ".env"), quiet: true });

function sleep(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
function timestampId() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function slug(value) { return String(value).normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "artist"; }
async function sha256(filePath) { return crypto.createHash("sha256").update(await fs.readFile(filePath)).digest("hex"); }

async function writeJsonExclusive(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

function createMetrics() {
    return { cacheHits: 0, liveRequests: 0, totalRequestCount: 0, retries: 0, byProvider: { wikidata: { cacheHits: 0, liveRequests: 0 }, musicbrainz: { cacheHits: 0, liveRequests: 0 }, discogs: { cacheHits: 0, liveRequests: 0 } } };
}

function createProviderFetch(provider, minimumSpacingMs, metrics) {
    let lastStartedAt = 0;
    return async (url, options = {}) => {
        if (!allowNetwork) throw new Error("Live identity acquisition requires explicit --allow-network approval.");
        for (let attempt = 0; attempt <= 3; attempt += 1) {
            const delay = Math.max(0, minimumSpacingMs - (Date.now() - lastStartedAt));
            if (delay) await sleep(delay);
            lastStartedAt = Date.now();
            metrics.liveRequests += 1;
            metrics.totalRequestCount += 1;
            metrics.byProvider[provider].liveRequests += 1;
            let response;
            try { response = await fetch(url, options); } catch (error) {
                if (attempt === 3) throw error;
                metrics.retries += 1;
                await sleep(1000 * (2 ** attempt) + Math.floor(Math.random() * 250));
                continue;
            }
            if (![429, 502, 503, 504].includes(response.status) || attempt === 3) return response;
            metrics.retries += 1;
            const retryAfter = Number(response.headers?.get?.("retry-after"));
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** attempt) + Math.floor(Math.random() * 250));
        }
    };
}

async function cached(provider, identifier, operation, metrics, acquire) {
    const cachePath = path.join(cacheRoot, cacheRelativePath(provider, identifier, operation));
    try {
        const envelope = JSON.parse(await fs.readFile(cachePath, "utf8"));
        metrics.cacheHits += 1;
        metrics.byProvider[provider].cacheHits += 1;
        return envelope.value;
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const value = await acquire();
    await writeJsonExclusive(cachePath, { schemaVersion: 1, provider, operation, identifier, retrievedAt: new Date().toISOString(), value });
    return value;
}

async function legacyNirvanaEvidence(candidate, metrics) {
    if (candidate.spotifyArtistId !== "6olE6TJLqED3rqDCT0FyPh") return null;
    const reviewPath = path.join(root, "data", "identity-experiments", "nirvana-three-source-stress-test", "review.json");
    try {
        const review = JSON.parse(await fs.readFile(reviewPath, "utf8"));
        metrics.cacheHits += 10;
        metrics.byProvider.wikidata.cacheHits += 1;
        metrics.byProvider.discogs.cacheHits += 1;
        metrics.byProvider.musicbrainz.cacheHits += 8;
        const entities = review.sameNameAudit.allExactNameEntities;
        return {
            providerErrors: [],
            wikidata: review.sourceResults.wikidata,
            musicBrainz: review.sourceResults.musicBrainz,
            discogs: review.sourceResults.discogs,
            nameCandidates: entities.map(({ spotifyArtistIds, discogsArtistIds, selectedExactEntity, ...entity }) => entity),
            nameCandidateDetails: entities.map(entity => ({
                ...entity,
                externalUrls: [
                    ...(entity.spotifyArtistIds || []).map(id => ({ relationshipType: "spotify", url: `https://open.spotify.com/artist/${id}` })),
                    ...(entity.discogsArtistIds || []).map(id => ({ relationshipType: "discogs", url: `https://www.discogs.com/artist/${id}` }))
                ]
            }))
        };
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function acquireArtist(candidate, clients, metrics) {
    const legacy = await legacyNirvanaEvidence(candidate, metrics);
    if (legacy) return legacy;
    const evidence = { providerErrors: [] };
    try {
        const result = await cached("wikidata", candidate.spotifyArtistId, "spotify-bridge", metrics, () => getWikidataIdentityBridge(candidate.spotifyArtistId, { fetchImpl: clients.wikidata }));
        evidence.wikidata = result.bridge;
    } catch (error) {
        evidence.providerErrors.push({ provider: "wikidata", operation: "spotify_bridge", statusCode: error.statusCode || null, message: error.message });
        return evidence;
    }
    if (evidence.wikidata.musicBrainzArtistId) {
        try {
            const result = await cached("musicbrainz", evidence.wikidata.musicBrainzArtistId, "artist", metrics, () => getMusicBrainzArtist(evidence.wikidata.musicBrainzArtistId, { fetchImpl: clients.musicbrainz, maxRetries: 0 }));
            evidence.musicBrainz = result.artist;
        } catch (error) {
            evidence.providerErrors.push({ provider: "musicbrainz", operation: "artist", identifier: evidence.wikidata.musicBrainzArtistId, statusCode: error.statusCode || null, message: error.message });
        }
    }
    if (evidence.wikidata.discogsArtistId) {
        try {
            const result = await cached("discogs", evidence.wikidata.discogsArtistId, "artist", metrics, () => getDiscogsArtist(evidence.wikidata.discogsArtistId, { fetchImpl: clients.discogs }));
            evidence.discogs = result.artist;
        } catch (error) {
            evidence.providerErrors.push({ provider: "discogs", operation: "artist", identifier: evidence.wikidata.discogsArtistId, statusCode: error.statusCode || null, message: error.message });
        }
    }
    if (evidence.musicBrainz) {
        try {
            const normalizedNameKey = crypto.createHash("sha256").update(evidence.musicBrainz.name.normalize("NFKC").toLowerCase()).digest("hex").slice(0, 24);
            const search = await cached("musicbrainz", normalizedNameKey, "exact-name", metrics, () => searchMusicBrainzArtistsByExactName(evidence.musicBrainz.name, { fetchImpl: clients.musicbrainz, limit: 25 }));
            evidence.nameCandidates = search.exactMatches.slice(0, maxNameEntities);
            evidence.nameCandidateDetails = [];
            for (const entity of evidence.nameCandidates) {
                if (entity.musicBrainzArtistId === evidence.musicBrainz.musicBrainzArtistId) {
                    evidence.nameCandidateDetails.push(evidence.musicBrainz);
                    continue;
                }
                try {
                    const detail = await cached("musicbrainz", entity.musicBrainzArtistId, "artist", metrics, () => getMusicBrainzArtist(entity.musicBrainzArtistId, { fetchImpl: clients.musicbrainz, maxRetries: 0 }));
                    evidence.nameCandidateDetails.push(detail.artist);
                } catch (error) {
                    evidence.providerErrors.push({ provider: "musicbrainz", operation: "same_name_competitor", identifier: entity.musicBrainzArtistId, statusCode: error.statusCode || null, message: error.message });
                }
            }
        } catch (error) {
            evidence.providerErrors.push({ provider: "musicbrainz", operation: "exact_name_audit", statusCode: error.statusCode || null, message: error.message });
        }
    }
    return evidence;
}

async function main() {
    if (!allowNetwork) throw new Error("Refusing to run: pass --allow-network only after explicit approval.");
    const protectedBefore = Object.fromEntries(await Promise.all(protectedPaths.map(async filePath => [path.relative(root, filePath), await sha256(filePath)])));
    const accounting = JSON.parse(await fs.readFile(accountingPath, "utf8"));
    const candidates = blockedCohortFromAccounting(accounting);
    if (candidates.length !== 40) throw new Error(`Expected 40 blocked candidates; found ${candidates.length}.`);
    if (new Set(candidates.map(candidate => candidate.spotifyArtistId)).size !== candidates.length) throw new Error("Blocked cohort contains duplicate Spotify IDs.");
    const runId = `curated-40-${timestampId()}`;
    const runDir = path.join(experimentRoot, runId);
    const metrics = createMetrics();
    const clients = {
        wikidata: createProviderFetch("wikidata", 250, metrics),
        musicbrainz: createProviderFetch("musicbrainz", 1100, metrics),
        discogs: createProviderFetch("discogs", 1000, metrics)
    };
    const evidenceBySpotifyId = {};
    const reports = [];
    for (const [index, candidate] of candidates.entries()) {
        console.log(`[${index + 1}/40] ${candidate.displayName}`);
        const evidence = await acquireArtist(candidate, clients, metrics);
        evidenceBySpotifyId[candidate.spotifyArtistId] = evidence;
        let report = buildArtistEvidenceReport(candidate, evidence);
        if (evidence.providerErrors.length && report.conflictingIdentifiers.length) report = { ...report, outcome: "conflicting_identity" };
        reports.push(report);
        await writeJsonExclusive(path.join(runDir, "artists", `${String(index + 1).padStart(2, "0")}-${slug(candidate.displayName)}-${candidate.spotifyArtistId}.review.json`), report);
    }
    const batch = buildBatchReview(candidates, evidenceBySpotifyId);
    batch.reports = reports;
    batch.summary.countsByOutcome = Object.fromEntries(Object.keys(batch.summary.countsByOutcome).map(outcome => [outcome, reports.filter(report => report.outcome === outcome).length]));
    batch.summary.needsInvestigation = reports.filter(report => !report.outcome.startsWith("coherent_identity")).map(report => ({ displayName: report.candidate.displayName, spotifyArtistId: report.candidate.spotifyArtistId, outcome: report.outcome }));
    batch.runId = runId;
    batch.generatedAt = new Date().toISOString();
    batch.metrics = metrics;
    batch.providerErrors = reports.flatMap(report => report.providerErrors.map(error => ({ displayName: report.candidate.displayName, spotifyArtistId: report.candidate.spotifyArtistId, ...error })));
    batch.protectedFiles = { before: protectedBefore, after: Object.fromEntries(await Promise.all(protectedPaths.map(async filePath => [path.relative(root, filePath), await sha256(filePath)]))) };
    batch.protectedFiles.unchanged = Object.keys(protectedBefore).every(key => protectedBefore[key] === batch.protectedFiles.after[key]);
    await writeJsonExclusive(path.join(runDir, "cohort-summary.review.json"), batch);
    console.log(`RUN_DIR=${path.relative(root, runDir)}`);
    console.log(JSON.stringify({ countsByOutcome: batch.summary.countsByOutcome, providerErrors: batch.providerErrors.length, metrics, protectedFilesUnchanged: batch.protectedFiles.unchanged }));
}

main().catch(error => { console.error("Curated 40 identity batch stopped: " + (error.stack || error.message)); process.exitCode = 1; });
