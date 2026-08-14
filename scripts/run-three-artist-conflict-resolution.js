const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const dotenv = require("dotenv");
const { normalizeArtist: normalizeMusicBrainz } = require("../lib/musicbrainz-client");
const { normalizeArtist: normalizeDiscogs } = require("../lib/discogs-client");
const { cacheRelativePath } = require("../lib/batch-identity-corroboration");
const { assessAuthorityMultiplicity, catalogFingerprint, compareCatalogFingerprints, interpretConflict } = require("../lib/identity-conflict-resolution");

const root = path.join(__dirname, "..");
const cacheRoot = path.join(root, "data", "identity-experiments", "provider-cache", "v1");
const batchRoot = path.join(root, "data", "identity-experiments", "curated-40-batch", "curated-40-2026-08-14T03-58-27-597Z", "artists");
const outputRoot = path.join(root, "data", "identity-experiments", "three-artist-conflict-resolution");
const allowNetwork = process.argv.includes("--allow-network");
const protectedPaths = ["data/artists.json", "data/artist-id-registry.json"];
const targets = [
    { slug: "beyonce", report: "05-beyonce-6vWDO969PvNqNYHIOW5v0m.review.json" },
    { slug: "marvin-gaye", report: "06-marvin-gaye-3koiLjNrgRTNbOwViDipeA.review.json" },
    { slug: "little-simz", report: "10-little-simz-6eXZu6O7nAUA5z6vLV8NKI.review.json" }
];
dotenv.config({ path: path.join(root, ".env"), quiet: true });

const metrics = { cacheHits: 0, liveRequests: 0, retries: 0, apiErrors: [], byProvider: {} };
const lastRequestAt = new Map();
const spacing = { spotify: 100, wikidata: 250, musicbrainz: 1100, discogs: 1000 };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nowId = () => new Date().toISOString().replace(/[:.]/g, "-");
const sha256 = async relative => crypto.createHash("sha256").update(await fs.readFile(path.join(root, relative))).digest("hex");

async function writeExclusive(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function providerFetch(provider, url, options = {}) {
    if (!allowNetwork) throw new Error("Pass --allow-network only after explicit approval.");
    for (let attempt = 0; attempt <= 3; attempt += 1) {
        const delay = Math.max(0, spacing[provider] - (Date.now() - (lastRequestAt.get(provider) || 0)));
        if (delay) await sleep(delay);
        lastRequestAt.set(provider, Date.now());
        metrics.liveRequests += 1;
        metrics.byProvider[provider] ||= { cacheHits: 0, liveRequests: 0 };
        metrics.byProvider[provider].liveRequests += 1;
        let response;
        try { response = await fetch(url, options); } catch (error) {
            if (attempt === 3) throw error;
            metrics.retries += 1;
            await sleep(1000 * 2 ** attempt);
            continue;
        }
        if (![429, 502, 503, 504].includes(response.status) || attempt === 3) return response;
        metrics.retries += 1;
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
}

async function cached(provider, identifier, operation, acquire) {
    const filePath = path.join(cacheRoot, cacheRelativePath(provider, identifier, operation));
    try {
        const envelope = JSON.parse(await fs.readFile(filePath, "utf8"));
        metrics.cacheHits += 1;
        metrics.byProvider[provider] ||= { cacheHits: 0, liveRequests: 0 };
        metrics.byProvider[provider].cacheHits += 1;
        return envelope.value;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const value = await acquire();
    await writeExclusive(filePath, { schemaVersion: 1, provider, operation, identifier, retrievedAt: new Date().toISOString(), value });
    return value;
}

async function spotifyToken() {
    const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString("base64");
    const response = await providerFetch("spotify", "https://accounts.spotify.com/api/token", { method: "POST", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials" }) });
    const raw = await response.json();
    if (!response.ok) throw Object.assign(new Error("Spotify token request failed."), { statusCode: response.status });
    return raw.access_token;
}

async function spotifyProfile(id, token) {
    return cached("spotify", id, "profile", async () => {
        const response = await providerFetch("spotify", `https://api.spotify.com/v1/artists/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        const raw = await response.json();
        if (response.status === 404) return { state: "not_found", statusCode: 404, raw };
        if (!response.ok) throw Object.assign(new Error(`Spotify profile ${id} failed.`), { statusCode: response.status });
        return { state: "active", statusCode: response.status, raw };
    });
}

async function spotifyCatalog(id, token) {
    return cached("spotify", id, "catalog", async () => {
        let url = `https://api.spotify.com/v1/artists/${id}/albums?` + new URLSearchParams({ include_groups: "album,single", market: "US", limit: "10", offset: "0" });
        const pages = [];
        while (url) {
            const response = await providerFetch("spotify", url, { headers: { Authorization: `Bearer ${token}` } });
            const raw = await response.json();
            if (response.status === 404) return { state: "not_found", statusCode: 404, pages };
            if (!response.ok) throw Object.assign(new Error(`Spotify catalog ${id} failed.`), { statusCode: response.status });
            pages.push(raw);
            url = raw.next;
        }
        return { state: "active", statusCode: 200, pages, releases: pages.flatMap(page => page.items || []) };
    });
}

async function musicBrainzArtist(id) {
    return cached("musicbrainz", id, "artist", async () => {
        const url = `https://musicbrainz.org/ws/2/artist/${id}?inc=aliases+url-rels&fmt=json`;
        const response = await providerFetch("musicbrainz", url, { redirect: "manual", headers: { Accept: "application/json", "User-Agent": "MusicRollConflictReview/1.0" } });
        if ([301, 302, 307, 308].includes(response.status)) return { state: "redirected", statusCode: response.status, location: response.headers.get("location"), raw: null };
        const raw = await response.json().catch(() => null);
        if (response.status === 404) return { state: "not_found", statusCode: 404, raw };
        if (!response.ok) throw Object.assign(new Error(`MusicBrainz artist ${id} failed.`), { statusCode: response.status });
        return { artist: normalizeMusicBrainz(raw, id), raw, state: "active", statusCode: response.status };
    });
}

async function musicBrainzReleaseGroups(id) {
    return cached("musicbrainz", id, "release-groups", async () => {
        const pages = [];
        let offset = 0;
        while (true) {
            const url = `https://musicbrainz.org/ws/2/release-group?artist=${id}&limit=100&offset=${offset}&fmt=json`;
            const response = await providerFetch("musicbrainz", url, { headers: { Accept: "application/json", "User-Agent": "MusicRollConflictReview/1.0" } });
            const raw = await response.json().catch(() => null);
            if (!response.ok) throw Object.assign(new Error(`MusicBrainz release groups ${id} failed.`), { statusCode: response.status });
            pages.push(raw);
            const groups = raw["release-groups"] || [];
            offset += groups.length;
            if (!groups.length || offset >= raw["release-group-count"]) break;
        }
        return { state: "active", pages, releases: pages.flatMap(page => page["release-groups"] || []) };
    });
}

async function discogsArtist(id) {
    return cached("discogs", id, "artist", async () => {
        const headers = { Accept: "application/vnd.discogs.v2.discogs+json", "User-Agent": "MusicRollConflictReview/1.0" };
        if (process.env.DISCOGS_TOKEN) headers.Authorization = `Discogs token=${process.env.DISCOGS_TOKEN}`;
        const response = await providerFetch("discogs", `https://api.discogs.com/artists/${id}`, { headers, redirect: "manual" });
        if ([301, 302, 307, 308].includes(response.status)) return { state: "redirected", statusCode: response.status, location: response.headers.get("location"), raw: null };
        const raw = await response.json().catch(() => null);
        if (response.status === 404) return { state: "not_found", statusCode: 404, raw };
        if (!response.ok) throw Object.assign(new Error(`Discogs artist ${id} failed.`), { statusCode: response.status });
        return { artist: normalizeDiscogs(raw, String(id)), raw, state: "active", statusCode: response.status };
    });
}

async function wikidataStatements(qid) {
    return cached("wikidata", qid, "entity-statements", async () => {
        const response = await providerFetch("wikidata", `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, { headers: { Accept: "application/json", "User-Agent": "MusicRollConflictReview/1.0" } });
        const raw = await response.json();
        if (!response.ok) throw Object.assign(new Error(`Wikidata entity ${qid} failed.`), { statusCode: response.status });
        return { state: "active", raw };
    });
}

function idsFromReport(report, type) { return report.identifierAgreement[type]?.observedValues || []; }
function claimValue(claim) { return claim?.mainsnak?.datavalue?.value || null; }
function statementDetails(entityRaw, qid, property, ids) {
    const claims = entityRaw?.entities?.[qid]?.claims?.[property] || [];
    return ids.map(id => {
        const matches = claims.filter(claim => String(claimValue(claim)) === String(id));
        return { identifier: id, assertions: matches.map(claim => ({ id: claim.id, rank: claim.rank, qualifiers: claim.qualifiers || {}, references: claim.references || [] })), state: matches.some(claim => claim.rank === "deprecated") ? "deprecated" : matches.length ? "asserted" : "not_present" };
    });
}

function authorityMetadata(records) {
    return Object.fromEntries(Object.entries(records).map(([id, value]) => [id, value?.artist ? { state: value.state, name: value.artist.name, artistType: value.artist.artistType, country: value.artist.country, lifeSpan: value.artist.lifeSpan, isni: value.artist.isni, officialUrls: value.artist.externalUrls.filter(item => ["official homepage", "wikidata", "discogs", "free streaming"].includes(item.relationshipType)) } : { state: value?.state || "error", location: value?.location || null }]));
}

function pairwiseFingerprints(fingerprints) {
    const entries = Object.entries(fingerprints);
    const comparisons = [];
    for (let left = 0; left < entries.length; left += 1) for (let right = left + 1; right < entries.length; right += 1) comparisons.push({ left: entries[left][0], right: entries[right][0], ...compareCatalogFingerprints(entries[left][1], entries[right][1]) });
    return comparisons;
}

function buildSignals({ spotify, spotifyCatalogs, musicBrainz, releaseGroups, discogs, statementMetadata, spotifyComparisons }) {
    const redirectedIdentifiers = [];
    const deprecatedIdentifiers = statementMetadata.flatMap(group => group.values.filter(value => value.state === "deprecated").map(value => `${group.property}:${value.identifier}`));
    const unresolvedIdentifiers = [];
    const semanticContradictions = [];
    const providerMultiplicityEvidence = [];
    for (const [provider, records] of Object.entries({ spotify, musicbrainz: musicBrainz, discogs })) for (const [id, record] of Object.entries(records)) {
        if (record?.state === "redirected") redirectedIdentifiers.push(`${provider}:${id}->${record.location}`);
        if (!record || record.state === "error") unresolvedIdentifiers.push(`${provider}:${id}`);
        if (record?.state === "not_found") deprecatedIdentifiers.push(`${provider}:${id}:not_found`);
    }
    for (const [kind, records] of Object.entries({ spotify_catalog: spotifyCatalogs, musicbrainz_release_groups: releaseGroups })) for (const [id, record] of Object.entries(records)) {
        if (!record || record.state === "error") unresolvedIdentifiers.push(`${kind}:${id}`);
    }
    const authorityAssessment = assessAuthorityMultiplicity(musicBrainz, discogs);
    semanticContradictions.push(...authorityAssessment.contradictions);
    providerMultiplicityEvidence.push(...authorityAssessment.multiplicityEvidence);
    const overlaps = spotifyComparisons.filter(comparison => comparison.overlapCount >= 2);
    if (overlaps.length) providerMultiplicityEvidence.push(...overlaps.map(comparison => `spotify_catalog_overlap:${comparison.left}:${comparison.right}:${comparison.overlapCount}`));
    if (Object.keys(spotify).length > 1 && Object.keys(musicBrainz).length === 1) providerMultiplicityEvidence.push("multiple_spotify_profiles_asserted_by_one_musicbrainz_entity");
    if (Object.keys(discogs).length > 1 && Object.keys(musicBrainz).length === 1) providerMultiplicityEvidence.push("multiple_discogs_profiles_asserted_by_one_musicbrainz_entity");
    return { semanticContradictions, redirectedIdentifiers, deprecatedIdentifiers, providerMultiplicityEvidence, unresolvedIdentifiers };
}

async function safely(provider, operation, identifier, task) {
    try { return await task(); } catch (error) {
        const item = { provider, operation, identifier, statusCode: error.statusCode || null, message: error.message };
        metrics.apiErrors.push(item);
        return { state: "error", error: item };
    }
}

async function main() {
    if (!allowNetwork) throw new Error("Pass --allow-network only after explicit approval.");
    const protectedBefore = Object.fromEntries(await Promise.all(protectedPaths.map(async file => [file, await sha256(file)])));
    const runDir = path.join(outputRoot, `three-artists-${nowId()}`);
    const token = await spotifyToken();
    const reviews = [];
    for (const target of targets) {
        console.log(`Resolving ${target.slug}...`);
        const sourceReport = JSON.parse(await fs.readFile(path.join(batchRoot, target.report), "utf8"));
        const spotifyIds = idsFromReport(sourceReport, "spotifyArtistId");
        const mbids = idsFromReport(sourceReport, "musicBrainzArtistId");
        const discogsIds = idsFromReport(sourceReport, "discogsArtistId");
        const qids = idsFromReport(sourceReport, "wikidataQid");
        const spotify = {}; const spotifyCatalogs = {}; const musicBrainz = {}; const releaseGroups = {}; const discogs = {};
        for (const id of spotifyIds) {
            spotify[id] = await safely("spotify", "profile", id, () => spotifyProfile(id, token));
            spotifyCatalogs[id] = await safely("spotify", "catalog", id, () => spotifyCatalog(id, token));
        }
        for (const id of mbids) {
            musicBrainz[id] = await safely("musicbrainz", "artist", id, () => musicBrainzArtist(id));
            releaseGroups[id] = await safely("musicbrainz", "release_groups", id, () => musicBrainzReleaseGroups(id));
        }
        for (const id of discogsIds) discogs[id] = await safely("discogs", "artist", id, () => discogsArtist(id));
        const statements = {};
        for (const qid of qids) statements[qid] = await safely("wikidata", "entity_statements", qid, () => wikidataStatements(qid));
        const statementMetadata = qids.flatMap(qid => [
            { qid, property: "P1902", values: statementDetails(statements[qid]?.raw, qid, "P1902", spotifyIds) },
            { qid, property: "P434", values: statementDetails(statements[qid]?.raw, qid, "P434", mbids) },
            { qid, property: "P1953", values: statementDetails(statements[qid]?.raw, qid, "P1953", discogsIds) }
        ]);
        const spotifyFingerprints = Object.fromEntries(Object.entries(spotifyCatalogs).map(([id, value]) => [id, catalogFingerprint(value.releases || [])]));
        const musicBrainzFingerprints = Object.fromEntries(Object.entries(releaseGroups).map(([id, value]) => [id, catalogFingerprint(value.releases || [])]));
        const spotifyComparisons = pairwiseFingerprints(spotifyFingerprints);
        const signals = buildSignals({ spotify, spotifyCatalogs, musicBrainz, releaseGroups, discogs, statementMetadata, spotifyComparisons });
        const interpretation = interpretConflict(signals);
        const claims = ["spotifyArtistId", "wikidataQid", "musicBrainzArtistId", "discogsArtistId"].flatMap(type => sourceReport.identifierAgreement[type]?.claims || []);
        const review = {
            schemaVersion: 1, reviewOnly: true, artist: sourceReport.candidate, sourceConflictReport: target.report,
            competingIdentifiers: { spotifyArtistIds: spotifyIds, wikidataQids: qids, musicBrainzArtistIds: mbids, discogsArtistIds: discogsIds },
            provenanceClaims: claims,
            identifierStates: { spotify: Object.fromEntries(Object.entries(spotify).map(([id, value]) => [id, { state: value.state, statusCode: value.statusCode, name: value.raw?.name || null }])), musicBrainz: authorityMetadata(musicBrainz), discogs: Object.fromEntries(Object.entries(discogs).map(([id, value]) => [id, value.artist ? { state: value.state, name: value.artist.name, realName: value.artist.realName, aliases: value.artist.aliases, urls: value.artist.artistUrls } : { state: value.state, location: value.location || null }])) },
            wikidataStatements: statementMetadata,
            catalogFingerprints: { spotify: spotifyFingerprints, musicBrainz: musicBrainzFingerprints },
            catalogFingerprintComparisons: { spotify: spotifyComparisons, musicBrainz: pairwiseFingerprints(musicBrainzFingerprints) },
            authorityMetadataComparison: authorityMetadata(musicBrainz),
            chronologyComparison: { spotify: Object.fromEntries(Object.entries(spotifyFingerprints).map(([id, value]) => [id, { earliestYear: value.earliestYear, latestYear: value.latestYear }])), musicBrainz: Object.fromEntries(Object.entries(musicBrainzFingerprints).map(([id, value]) => [id, { earliestYear: value.earliestYear, latestYear: value.latestYear }])) },
            finalConflictInterpretation: interpretation,
            remainingUncertainty: interpretation.conflictType === "unresolved_multiplicity" ? interpretation.signals.unresolvedIdentifiers : [],
            safety: { identityVerified: false, confidenceScoreCalculated: false, migrationEligibilityChanged: false, registryModified: false, liveDirectoryModified: false }
        };
        reviews.push(review);
        await writeExclusive(path.join(runDir, `${target.slug}.review.json`), review);
    }
    const protectedAfter = Object.fromEntries(await Promise.all(protectedPaths.map(async file => [file, await sha256(file)])));
    const summary = { schemaVersion: 1, reviewOnly: true, generatedAt: new Date().toISOString(), reports: reviews.map(review => ({ artist: review.artist.displayName, interpretation: review.finalConflictInterpretation, remainingUncertainty: review.remainingUncertainty })), metrics, protectedFiles: { before: protectedBefore, after: protectedAfter, unchanged: protectedPaths.every(file => protectedBefore[file] === protectedAfter[file]) }, safety: { identitiesVerified: 0, confidenceScoresCalculated: 0, migrationsPerformed: 0 } };
    await writeExclusive(path.join(runDir, "summary.review.json"), summary);
    console.log(`RUN_DIR=${path.relative(root, runDir)}`);
    console.log(JSON.stringify({ reports: summary.reports, metrics, protectedFilesUnchanged: summary.protectedFiles.unchanged }));
}

main().catch(error => { console.error("Three-artist conflict resolution stopped: " + (error.stack || error.message)); process.exitCode = 1; });
