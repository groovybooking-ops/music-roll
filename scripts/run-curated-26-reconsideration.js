const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { cacheRelativePath } = require("../lib/batch-identity-corroboration");
const { catalogFingerprint } = require("../lib/identity-conflict-resolution");
const { OUTCOMES, buildReconsiderationReport, musicBrainzRelationshipClaims } = require("../lib/curated-26-reconsideration");
const { getMusicBrainzArtist, getMusicBrainzArtistResolution, lookupMusicBrainzArtistsByExactSpotifyUrl, searchMusicBrainzArtistsByExactName } = require("../lib/musicbrainz-client");
const { getDiscogsArtist } = require("../lib/discogs-client");

const root = path.join(__dirname, "..");
const cacheRoot = path.join(root, "data", "identity-experiments", "provider-cache", "v1");
const experimentRoot = path.join(root, "data", "identity-experiments", "curated-26-reconsideration");
const accountingPath = path.join(root, "data", "artists-46-v2.accounting.preview.json");
const priorPath = path.join(root, "data", "identity-experiments", "curated-40-provider-multiplicity-reanalysis", "curated-40-provider-multiplicity-reanalysis-2026-08-14T04-18-32-340Z.review.json");
const protectedPaths = [path.join(root, "data", "artists.json"), path.join(root, "data", "artist-id-registry.json")];
const allowNetwork = process.argv.includes("--allow-network");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function timestampId() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function slug(value) { return String(value).normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "artist"; }
async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function sha256(file) { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
async function writeJsonExclusive(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
function flattenClaims(report) { return Object.values(report?.identifierAgreement || {}).flatMap(item => item?.claims || []); }
function values(claims, type) { return [...new Set(claims.filter(claim => claim.identifierType === type && claim.value != null).map(claim => String(claim.value)))]; }

function metricsState() {
    return { cacheHits: 0, priorReportReuses: 0, liveRequests: 0, totalRequestCount: 0, retries: 0, byProvider: { musicbrainz: { cacheHits: 0, liveRequests: 0 }, discogs: { cacheHits: 0, liveRequests: 0 } } };
}

function providerFetch(provider, spacing, metrics) {
    let lastStart = 0;
    return async (url, options = {}) => {
        if (!allowNetwork) throw new Error("Live reconsideration acquisition requires explicit --allow-network approval.");
        for (let attempt = 0; attempt <= 3; attempt += 1) {
            const delay = Math.max(0, spacing - (Date.now() - lastStart));
            if (delay) await sleep(delay);
            lastStart = Date.now();
            metrics.liveRequests += 1; metrics.totalRequestCount += 1; metrics.byProvider[provider].liveRequests += 1;
            let response;
            try { response = await fetch(url, options); } catch (error) {
                if (attempt === 3) throw error;
                metrics.retries += 1; await sleep(1000 * (2 ** attempt)); continue;
            }
            if (![429, 502, 503, 504].includes(response.status) || attempt === 3) return response;
            metrics.retries += 1;
            const retryAfter = Number(response.headers?.get?.("retry-after"));
            await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** attempt));
        }
    };
}

async function cached(provider, identifier, operation, metrics, acquire) {
    const file = path.join(cacheRoot, cacheRelativePath(provider, identifier, operation));
    try {
        const envelope = await readJson(file);
        metrics.cacheHits += 1; metrics.byProvider[provider].cacheHits += 1;
        return envelope.value;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const value = await acquire();
    await writeJsonExclusive(file, { schemaVersion: 1, provider, operation, identifier, retrievedAt: new Date().toISOString(), value });
    return value;
}

async function getReleaseGroups(mbid, client, metrics) {
    return cached("musicbrainz", mbid, "release-groups", metrics, async () => {
        const pages = []; const releases = [];
        for (let offset = 0; ; offset += 100) {
            const url = `https://musicbrainz.org/ws/2/release-group?artist=${mbid}&limit=100&offset=${offset}&fmt=json`;
            const response = await client(url, { headers: { Accept: "application/json", "User-Agent": "MusicRollIdentityLesson/1.0 (https://github.com/music-roll)" } });
            if (!response.ok) throw Object.assign(new Error(`MusicBrainz release-group request failed with status ${response.status}.`), { statusCode: response.status });
            const raw = await response.json(); pages.push(raw);
            for (const item of raw["release-groups"] || []) releases.push(item);
            if (offset + (raw["release-groups"] || []).length >= (raw["release-group-count"] || 0) || !(raw["release-groups"] || []).length) break;
        }
        return { state: "active", pages, releases };
    });
}

function oldNameEvidence(report) {
    const all = report?.sameNameAmbiguity?.allExactNameEntities;
    if (!Array.isArray(all)) return null;
    return {
        candidates: all.map(({ spotifyArtistIds, discogsArtistIds, selectedExactEntity, ...item }) => item),
        details: all.map(item => ({ ...item, externalUrls: [...(item.spotifyArtistIds || []).map(id => ({ relationshipType: "streaming", url: `https://open.spotify.com/artist/${id}` })), ...(item.discogsArtistIds || []).map(id => ({ relationshipType: "discogs", url: `https://www.discogs.com/artist/${id}` }))] }))
    };
}

async function acquireNameAudit(record, clients, metrics, errors) {
    const name = record?.artist?.name;
    if (!name) return null;
    const key = crypto.createHash("sha256").update(name.normalize("NFKC").toLowerCase()).digest("hex").slice(0, 24);
    try {
        const search = await cached("musicbrainz", key, "exact-name", metrics, () => searchMusicBrainzArtistsByExactName(name, { fetchImpl: clients.musicbrainz, limit: 25 }));
        const candidates = search.exactMatches.slice(0, 10); const details = [];
        for (const candidate of candidates) {
            if (candidate.musicBrainzArtistId === record.artist.musicBrainzArtistId) { details.push(record.artist); continue; }
            try { details.push((await cached("musicbrainz", candidate.musicBrainzArtistId, "artist", metrics, () => getMusicBrainzArtist(candidate.musicBrainzArtistId, { fetchImpl: clients.musicbrainz, maxRetries: 0 }))).artist); }
            catch (error) { errors.push({ provider: "musicbrainz", operation: "same_name_competitor", identifier: candidate.musicBrainzArtistId, statusCode: error.statusCode || null, message: error.message }); }
        }
        return { candidates, details };
    } catch (error) { errors.push({ provider: "musicbrainz", operation: "exact_name_audit", statusCode: error.statusCode || null, message: error.message }); return null; }
}

async function acquireCandidate(candidate, priorRecord, rawPrior, clients, metrics) {
    const errors = []; const priorClaims = flattenClaims(rawPrior); metrics.priorReportReuses += 1;
    const spotifyArtistId = candidate.spotify.id;
    let mbids = values(priorClaims, "musicBrainzArtistId");
    let exactSpotifyUrlLookup = null;
    const wikidataMissing = !rawPrior?.sourceResults?.wikidata && rawPrior?.providerErrors?.some(error => error.provider === "wikidata" && error.statusCode === 404);
    if (!mbids.length && wikidataMissing) {
        try {
            exactSpotifyUrlLookup = await cached("musicbrainz", spotifyArtistId, "spotify-url", metrics, () => lookupMusicBrainzArtistsByExactSpotifyUrl(candidate.spotify.url, { fetchImpl: clients.musicbrainz, maxRetries: 0 }));
            if (exactSpotifyUrlLookup.candidates.length === 1) mbids = [exactSpotifyUrlLookup.candidates[0].musicBrainzArtistId];
            else if (exactSpotifyUrlLookup.candidates.length > 1) mbids = exactSpotifyUrlLookup.candidates.map(item => item.musicBrainzArtistId);
        } catch (error) { errors.push({ provider: "musicbrainz", operation: "exact_spotify_url", identifier: spotifyArtistId, statusCode: error.statusCode || null, message: error.message }); }
    }
    const musicBrainzRecords = {}; const redirectedIdentifiers = [];
    for (const mbid of mbids) {
        try { musicBrainzRecords[mbid] = await cached("musicbrainz", mbid, "artist", metrics, () => getMusicBrainzArtist(mbid, { fetchImpl: clients.musicbrainz, maxRetries: 0 })); }
        catch (error) {
            if (/unexpected artist MBID/.test(error.message)) {
                try {
                    const resolution = await cached("musicbrainz", mbid, "artist-resolution", metrics, () => getMusicBrainzArtistResolution(mbid, { fetchImpl: clients.musicbrainz }));
                    musicBrainzRecords[mbid] = resolution;
                    if (resolution.state === "redirected") redirectedIdentifiers.push(`musicbrainz:${mbid}->${resolution.resolvedMbid}`);
                    continue;
                } catch (resolutionError) { error = resolutionError; }
            }
            musicBrainzRecords[mbid] = { state: "unresolved" }; errors.push({ provider: "musicbrainz", operation: "artist", identifier: mbid, statusCode: error.statusCode || null, message: error.message });
        }
    }
    const discoveredClaims = Object.entries(musicBrainzRecords).flatMap(([requestedMbid, record]) => musicBrainzRelationshipClaims(record?.artist).map(claim => record.state === "redirected" ? { ...claim, path: `redirect_target:${claim.path}`, assertedByIdentifier: requestedMbid } : claim));
    const discogsIds = [...new Set([...values(priorClaims, "discogsArtistId"), ...values(discoveredClaims, "discogsArtistId")])];
    const discogsRecords = {};
    for (const id of discogsIds) {
        try { discogsRecords[id] = await cached("discogs", id, "artist", metrics, () => getDiscogsArtist(id, { fetchImpl: clients.discogs })); }
        catch (error) { discogsRecords[id] = { state: "unresolved" }; errors.push({ provider: "discogs", operation: "artist", identifier: id, statusCode: error.statusCode || null, message: error.message }); }
    }
    const allClaims = [...priorClaims, ...discoveredClaims];
    const hasMultiplicity = mbids.length > 1 || discogsIds.length > 1 || values(allClaims, "wikidataQid").length > 1;
    const musicBrainzFingerprints = {};
    if (hasMultiplicity) for (const mbid of mbids) {
        try { musicBrainzFingerprints[mbid] = catalogFingerprint((await getReleaseGroups(mbid, clients.musicbrainz, metrics)).releases); }
        catch (error) { errors.push({ provider: "musicbrainz", operation: "release_groups", identifier: mbid, statusCode: error.statusCode || null, message: error.message }); }
    }
    let nameEvidence = oldNameEvidence(rawPrior);
    if (!nameEvidence && mbids.length === 1 && musicBrainzRecords[mbids[0]]?.artist) nameEvidence = await acquireNameAudit(musicBrainzRecords[mbids[0]], clients, metrics, errors);
    let report = buildReconsiderationReport({ candidate: { displayName: candidate.name, proposedMusicRollId: candidate.proposedMusicRollId, spotifyArtistId: candidate.spotify.id }, priorClaims, exactSpotifyUrlLookup, musicBrainzRecords, discogsRecords, musicBrainzFingerprints, redirectedIdentifiers, nameCandidates: nameEvidence?.candidates, nameCandidateDetails: nameEvidence?.details, providerErrors: errors });
    if (errors.length && !["semantic_identity_conflict", "provider_profile_multiplicity"].includes(report.outcome)) report = { ...report, outcome: "unresolved_identity", conservativeFailureOverride: true };
    return { ...report, priorOutcome: priorRecord.outcome, changedOutcome: priorRecord.outcome !== report.outcome, changeEvidence: priorRecord.outcome === report.outcome ? [] : [exactSpotifyUrlLookup?.candidates?.length === 1 && "unique_musicbrainz_exact_spotify_url_relationship", ...discoveredClaims.filter(claim => claim.identifierType === "discogsArtistId").map(claim => `musicbrainz_derived_discogs:${claim.assertedByIdentifier}->${claim.value}`), ...redirectedIdentifiers.map(item => `provider_redirect:${item}`), report.outcome === "provider_profile_multiplicity" && "generalized_provider_profile_multiplicity"].filter(Boolean), evidence: { wikidata: rawPrior?.sourceResults?.wikidata || null, musicBrainzRecords, discogsRecords, musicBrainzFingerprints, redirectedIdentifiers } };
}

async function main() {
    if (!allowNetwork) throw new Error("Refusing to run: pass --allow-network only after explicit approval.");
    const before = Object.fromEntries(await Promise.all(protectedPaths.map(async file => [path.relative(root, file), await sha256(file)])));
    const [accounting, live, prior] = await Promise.all([readJson(accountingPath), readJson(path.join(root, "data", "artists.json")), readJson(priorPath)]);
    const liveSpotify = new Set(live.map(artist => artist.externalIds.spotify));
    const candidates = accounting.records.filter(record => !liveSpotify.has(record.spotify.id));
    if (candidates.length !== 26) throw new Error(`Expected exactly 26 curated non-live artists; found ${candidates.length}.`);
    if (new Set(candidates.map(item => item.spotify.id)).size !== 26) throw new Error("Curated-26 Spotify candidates are not unique.");
    const priorBySpotify = new Map(prior.records.map(record => [record.artist.spotifyArtistId, record]));
    const metrics = metricsState(); const clients = { musicbrainz: providerFetch("musicbrainz", 1100, metrics), discogs: providerFetch("discogs", 1000, metrics) };
    const runId = `curated-26-${timestampId()}`; const runDir = path.join(experimentRoot, runId); const reports = [];
    for (const [index, candidate] of candidates.entries()) {
        console.log(`[${index + 1}/26] ${candidate.name}`);
        const priorRecord = priorBySpotify.get(candidate.spotify.id);
        if (!priorRecord) throw new Error(`Missing prior curated-40 report for ${candidate.name}.`);
        const rawPrior = await readJson(path.join(root, priorRecord.sourceReport));
        const report = await acquireCandidate(candidate, priorRecord, rawPrior, clients, metrics); reports.push(report);
        await writeJsonExclusive(path.join(runDir, "artists", `${String(index + 1).padStart(2, "0")}-${slug(candidate.name)}-${candidate.spotify.id}.review.json`), report);
    }
    const countsByOutcome = Object.fromEntries(OUTCOMES.map(outcome => [outcome, reports.filter(report => report.outcome === outcome).length]));
    const artistsByOutcome = Object.fromEntries(OUTCOMES.map(outcome => [outcome, reports.filter(report => report.outcome === outcome).map(report => report.candidate.displayName)]));
    const after = Object.fromEntries(await Promise.all(protectedPaths.map(async file => [path.relative(root, file), await sha256(file)])));
    const summary = { schemaVersion: 1, reportId: runId, generatedAt: new Date().toISOString(), reviewOnly: true, priorReport: path.relative(root, priorPath), totalArtists: reports.length, countsByOutcome, artistsByOutcome, changedOutcomes: reports.filter(report => report.changedOutcome).map(report => ({ artist: report.candidate.displayName, previousOutcome: report.priorOutcome, outcome: report.outcome, newEvidence: report.changeEvidence })), strongHumanApprovalCandidates: reports.filter(report => ["coherent_identity_evidence", "coherent_identity_with_same_name_ambiguity", "provider_profile_multiplicity"].includes(report.outcome)).map(report => report.candidate.displayName), unresolvedCases: reports.filter(report => ["unresolved_identity", "semantic_identity_conflict", "insufficient_corroboration"].includes(report.outcome)).map(report => ({ artist: report.candidate.displayName, outcome: report.outcome, missingEvidence: report.missingEvidence })), providerErrors: reports.flatMap(report => report.providerErrors.map(error => ({ artist: report.candidate.displayName, ...error }))), metrics, protectedFiles: { before, after, unchanged: Object.keys(before).every(key => before[key] === after[key]) }, safety: { identitiesApproved: false, identitiesVerified: false, confidenceScoresCalculated: false, migrationEligibilityChanged: false, migrationPerformed: false, newArtistsSourced: false }, reports };
    await writeJsonExclusive(path.join(runDir, "cohort-summary.review.json"), summary);
    console.log(`RUN_DIR=${path.relative(root, runDir)}`);
    console.log(JSON.stringify({ countsByOutcome, changedOutcomes: summary.changedOutcomes.length, strongHumanApprovalCandidates: summary.strongHumanApprovalCandidates.length, providerErrors: summary.providerErrors.length, metrics, protectedFilesUnchanged: summary.protectedFiles.unchanged }));
}

main().catch(error => { console.error("Curated-26 reconsideration stopped: " + (error.stack || error.message)); process.exitCode = 1; });
