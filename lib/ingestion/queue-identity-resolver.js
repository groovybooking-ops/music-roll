const crypto = require("crypto");
const { getWikidataIdentityBridge, validateSpotifyArtistId } = require("../wikidata-client");
const {
    getMusicBrainzArtist,
    lookupMusicBrainzArtistsByExactSpotifyUrl,
    searchMusicBrainzArtistsByExactName
} = require("../musicbrainz-client");
const { getDiscogsArtist } = require("../discogs-client");
const { catalogFingerprint } = require("../identity-conflict-resolution");
const { buildReconsiderationReport, musicBrainzRelationshipClaims } = require("../curated-26-reconsideration");
const { spotifyIdFromUrl } = require("./candidate-schema");

const TEMPORARY_STATUS_CODES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

class TemporaryIdentityError extends Error {
    constructor(message, details = {}) {
        super(message, details.cause ? { cause: details.cause } : undefined);
        this.name = "TemporaryIdentityError";
        this.retryable = true;
        this.provider = details.provider || null;
        this.operation = details.operation || null;
        this.identifier = details.identifier || null;
        this.statusCode = details.statusCode || null;
    }
}

function isTemporaryProviderError(error) {
    return error?.retryable === true || TEMPORARY_STATUS_CODES.has(error?.statusCode) || (error?.statusCode == null && /request failed before receiving|network|fetch/i.test(error?.message || ""));
}

function providerError(error, provider, operation, identifier = null) {
    return {
        provider,
        operation,
        identifier,
        statusCode: error?.statusCode || null,
        message: error?.message || String(error)
    };
}

function temporary(error, provider, operation, identifier) {
    return new TemporaryIdentityError(`${provider} ${operation} is temporarily unavailable: ${error.message}`, {
        cause: error,
        provider,
        operation,
        identifier,
        statusCode: error.statusCode
    });
}

function wikidataClaims(bridge) {
    if (!bridge) return [];
    const claims = [
        { identifierType: "spotifyArtistId", value: bridge.spotifyArtistId, source: "wikidata", path: "P1902", independentOrigin: "wikidata" },
        { identifierType: "wikidataQid", value: bridge.wikidataQid, source: "wikidata", path: "entity", independentOrigin: "wikidata" }
    ];
    const mbids = [...new Set([bridge.musicBrainzArtistId, ...(bridge.musicBrainzArtistIds || [])].filter(Boolean))];
    const discogsIds = [...new Set([bridge.discogsArtistId, ...(bridge.discogsArtistIds || [])].filter(Boolean))];
    for (const value of mbids) claims.push({ identifierType: "musicBrainzArtistId", value, source: "wikidata", path: "P434", independentOrigin: "wikidata" });
    for (const value of discogsIds) claims.push({ identifierType: "discogsArtistId", value, source: "wikidata", path: "P1953", independentOrigin: "wikidata" });
    return claims.filter(claim => claim.value != null);
}

function identifierValues(claims, type) {
    return [...new Set((claims || []).filter(claim => claim.identifierType === type && claim.value != null).map(claim => String(claim.value)))];
}

function preserveErrorEvidence(error, provenanceRefs) {
    if (error?.evidenceRef) provenanceRefs.push(error.evidenceRef);
}

function unresolvedReport(candidate, providerErrors = [], reason = "missing_exact_spotify_artist_id") {
    return {
        schemaVersion: 1,
        reviewOnly: true,
        candidate: {
            displayName: candidate.name.raw,
            spotifyArtistId: candidate.candidateIdentifiers.spotifyArtistId
        },
        outcome: "unresolved_identity",
        exactSpotifyUrlFallback: { status: "not_evaluated", selectedMbid: null, candidates: [] },
        provenanceClaims: [],
        identifierAgreement: {},
        conflictingIdentifiers: [],
        sameNameAmbiguity: { sameNameAmbiguity: "not_evaluated", competingEntities: [] },
        conflictResolution: null,
        missingEvidence: [reason],
        providerErrors,
        safety: { identityVerified: false, identityApproved: false, confidenceScoreCalculated: false, migrationEligibilityChanged: false, migrationPerformed: false, registryModified: false, liveDirectoryModified: false }
    };
}

function resolveIdentityAcquisition(candidate, acquisition = {}) {
    const spotifyArtistId = candidate.candidateIdentifiers.spotifyArtistId;
    if (!spotifyArtistId) return unresolvedReport(candidate, acquisition.providerErrors || []);
    validateSpotifyArtistId(spotifyArtistId);
    const report = buildReconsiderationReport({
        candidate: { displayName: candidate.name.raw, spotifyArtistId },
        priorClaims: acquisition.priorClaims || [],
        wikidataClaims: acquisition.wikidataClaims || wikidataClaims(acquisition.wikidataBridge),
        exactSpotifyUrlLookup: acquisition.exactSpotifyUrlLookup,
        musicBrainzRecords: acquisition.musicBrainzRecords || {},
        discogsRecords: acquisition.discogsRecords || {},
        musicBrainzFingerprints: acquisition.musicBrainzFingerprints || {},
        deprecatedIdentifiers: acquisition.deprecatedIdentifiers || [],
        redirectedIdentifiers: acquisition.redirectedIdentifiers || [],
        nameCandidates: acquisition.nameCandidates,
        nameCandidateDetails: acquisition.nameCandidateDetails,
        providerErrors: acquisition.providerErrors || []
    });
    if (acquisition.blockingIdentityAmbiguity) {
        return {
            ...report,
            outcome: "unresolved_identity",
            missingEvidence: [...new Set([...(report.missingEvidence || []), acquisition.blockingIdentityAmbiguity])]
        };
    }
    return report;
}

function createRateLimitedFetch(provider, minimumSpacingMs, metrics, options = {}) {
    let lastStartedAt = 0;
    const fetchImpl = options.fetchImpl || fetch;
    const waitImpl = options.waitImpl || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    const nowImpl = options.nowImpl || Date.now;
    const maxRetries = options.maxRetries ?? 3;
    return async (url, requestOptions = {}) => {
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const delay = Math.max(0, minimumSpacingMs - (nowImpl() - lastStartedAt));
            if (delay) await waitImpl(delay);
            lastStartedAt = nowImpl();
            metrics.liveRequests += 1;
            metrics.byProvider[provider] ||= { cacheHits: 0, liveRequests: 0 };
            metrics.byProvider[provider].liveRequests += 1;
            let response;
            try {
                response = await fetchImpl(url, requestOptions);
            } catch (error) {
                if (attempt === maxRetries) throw error;
                metrics.retries += 1;
                await waitImpl(1000 * (2 ** attempt));
                continue;
            }
            if (![429, 502, 503, 504].includes(response.status) || attempt === maxRetries) return response;
            metrics.retries += 1;
            const retryAfter = Number(response.headers?.get?.("retry-after"));
            await waitImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** attempt));
        }
    };
}

class QueueIdentityResolver {
    constructor(evidenceStore, options = {}) {
        if (!evidenceStore) throw new Error("Queue identity resolver requires an evidence store.");
        this.evidenceStore = evidenceStore;
        this.metrics = evidenceStore.metrics;
        this.fetchers = options.fetchers || {
            wikidata: createRateLimitedFetch("wikidata", 250, this.metrics, options.fetchOptions),
            musicbrainz: createRateLimitedFetch("musicbrainz", 1100, this.metrics, options.fetchOptions),
            discogs: createRateLimitedFetch("discogs", 1000, this.metrics, options.fetchOptions)
        };
    }

    async cached(provider, identifier, operation, acquire, provenanceRefs) {
        const result = await this.evidenceStore.getOrAcquire({ provider, identifier, operation, acquire });
        provenanceRefs.push(result.evidenceRef);
        return result.value;
    }

    async releaseGroups(mbid, provenanceRefs) {
        return this.cached("musicbrainz", mbid, "release-groups", async () => {
            const releases = [];
            const pages = [];
            for (let offset = 0; ; offset += 100) {
                const url = `https://musicbrainz.org/ws/2/release-group?artist=${mbid}&limit=100&offset=${offset}&fmt=json`;
                const response = await this.fetchers.musicbrainz(url, { headers: { Accept: "application/json", "User-Agent": "MusicRollQueueIdentityWorker/1.0" } });
                if (!response.ok) throw Object.assign(new Error(`MusicBrainz release-group request failed with status ${response.status}.`), { statusCode: response.status });
                const page = await response.json();
                pages.push(page);
                releases.push(...(page["release-groups"] || []));
                if (offset + (page["release-groups"] || []).length >= (page["release-group-count"] || 0) || !(page["release-groups"] || []).length) break;
            }
            return { pages, releases };
        }, provenanceRefs);
    }

    async resolve(candidate) {
        const spotifyArtistId = candidate.candidateIdentifiers.spotifyArtistId;
        if (!spotifyArtistId) return { report: unresolvedReport(candidate), acquisition: {}, provenanceRefs: [] };
        validateSpotifyArtistId(spotifyArtistId);
        const canonicalSpotifyUrl = `https://open.spotify.com/artist/${spotifyArtistId}`;
        if (candidate.candidateIdentifiers.spotifyArtistUrl && spotifyIdFromUrl(candidate.candidateIdentifiers.spotifyArtistUrl) !== spotifyArtistId) {
            return { report: unresolvedReport(candidate, [], "stored_spotify_id_url_mismatch"), acquisition: {}, provenanceRefs: [] };
        }
        const acquisition = { providerErrors: [], musicBrainzRecords: {}, discogsRecords: {}, musicBrainzFingerprints: {} };
        const provenanceRefs = [];
        try {
            const wikidataResult = await this.cached("wikidata", spotifyArtistId, "spotify-bridge", () => getWikidataIdentityBridge(spotifyArtistId, { fetchImpl: this.fetchers.wikidata }), provenanceRefs);
            acquisition.wikidataBridge = wikidataResult.bridge;
        } catch (error) {
            preserveErrorEvidence(error, provenanceRefs);
            if (isTemporaryProviderError(error)) throw temporary(error, error.provider || "wikidata", error.operation || "spotify_bridge", spotifyArtistId);
            if (error.statusCode === 409) acquisition.blockingIdentityAmbiguity = "multiple_wikidata_entities_for_exact_spotify_id";
            acquisition.providerErrors.push(providerError(error, "wikidata", "spotify_bridge", spotifyArtistId));
        }
        acquisition.wikidataClaims = wikidataClaims(acquisition.wikidataBridge);
        let mbids = identifierValues(acquisition.wikidataClaims, "musicBrainzArtistId");
        if (!mbids.length) {
            try {
                acquisition.exactSpotifyUrlLookup = await this.cached("musicbrainz", spotifyArtistId, "spotify-url", () => lookupMusicBrainzArtistsByExactSpotifyUrl(canonicalSpotifyUrl, { fetchImpl: this.fetchers.musicbrainz, maxRetries: 0 }), provenanceRefs);
                mbids = [...new Set((acquisition.exactSpotifyUrlLookup.candidates || []).map(item => item.musicBrainzArtistId))];
            } catch (error) {
                preserveErrorEvidence(error, provenanceRefs);
                if (isTemporaryProviderError(error)) throw temporary(error, error.provider || "musicbrainz", error.operation || "exact_spotify_url", spotifyArtistId);
                acquisition.providerErrors.push(providerError(error, "musicbrainz", "exact_spotify_url", spotifyArtistId));
            }
        }
        for (const mbid of mbids) {
            try {
                acquisition.musicBrainzRecords[mbid] = await this.cached("musicbrainz", mbid, "artist", () => getMusicBrainzArtist(mbid, { fetchImpl: this.fetchers.musicbrainz, maxRetries: 0 }), provenanceRefs);
            } catch (error) {
                preserveErrorEvidence(error, provenanceRefs);
                if (isTemporaryProviderError(error)) throw temporary(error, error.provider || "musicbrainz", error.operation || "artist", mbid);
                acquisition.musicBrainzRecords[mbid] = { state: "unresolved" };
                acquisition.providerErrors.push(providerError(error, "musicbrainz", "artist", mbid));
            }
        }
        const relationshipClaims = Object.values(acquisition.musicBrainzRecords).flatMap(record => musicBrainzRelationshipClaims(record?.artist));
        const discogsIds = [...new Set([
            ...identifierValues(acquisition.wikidataClaims, "discogsArtistId"),
            ...identifierValues(relationshipClaims, "discogsArtistId")
        ])];
        for (const discogsId of discogsIds) {
            try {
                acquisition.discogsRecords[discogsId] = await this.cached("discogs", discogsId, "artist", () => getDiscogsArtist(discogsId, { fetchImpl: this.fetchers.discogs }), provenanceRefs);
            } catch (error) {
                preserveErrorEvidence(error, provenanceRefs);
                if (isTemporaryProviderError(error)) throw temporary(error, error.provider || "discogs", error.operation || "artist", discogsId);
                acquisition.discogsRecords[discogsId] = { state: "unresolved" };
                acquisition.providerErrors.push(providerError(error, "discogs", "artist", discogsId));
            }
        }
        if (mbids.length === 1 && acquisition.musicBrainzRecords[mbids[0]]?.artist) {
            const selected = acquisition.musicBrainzRecords[mbids[0]].artist;
            const nameKey = crypto.createHash("sha256").update(selected.name.normalize("NFKC").toLowerCase()).digest("hex").slice(0, 24);
            try {
                const audit = await this.cached("musicbrainz", nameKey, "exact-name", () => searchMusicBrainzArtistsByExactName(selected.name, { fetchImpl: this.fetchers.musicbrainz, limit: 25 }), provenanceRefs);
                acquisition.nameCandidates = audit.exactMatches.slice(0, 10);
                acquisition.nameCandidateDetails = [];
                for (const entity of acquisition.nameCandidates) {
                    if (entity.musicBrainzArtistId === mbids[0]) acquisition.nameCandidateDetails.push(selected);
                    else acquisition.nameCandidateDetails.push((await this.cached("musicbrainz", entity.musicBrainzArtistId, "artist", () => getMusicBrainzArtist(entity.musicBrainzArtistId, { fetchImpl: this.fetchers.musicbrainz, maxRetries: 0 }), provenanceRefs)).artist);
                }
            } catch (error) {
                preserveErrorEvidence(error, provenanceRefs);
                if (isTemporaryProviderError(error)) throw temporary(error, error.provider || "musicbrainz", error.operation || "exact_name_audit", mbids[0]);
                acquisition.providerErrors.push(providerError(error, "musicbrainz", "exact_name_audit", mbids[0]));
            }
        }
        if (mbids.length > 1 || discogsIds.length > 1 || identifierValues(acquisition.wikidataClaims, "wikidataQid").length > 1) {
            for (const mbid of mbids) {
                try {
                    const groups = await this.releaseGroups(mbid, provenanceRefs);
                    acquisition.musicBrainzFingerprints[mbid] = catalogFingerprint(groups.releases);
                } catch (error) {
                    preserveErrorEvidence(error, provenanceRefs);
                    if (isTemporaryProviderError(error)) throw temporary(error, error.provider || "musicbrainz", error.operation || "release_groups", mbid);
                    acquisition.providerErrors.push(providerError(error, "musicbrainz", "release_groups", mbid));
                }
            }
        }
        const report = resolveIdentityAcquisition(candidate, acquisition);
        return { report, acquisition, provenanceRefs };
    }
}

class FixtureIdentityResolver {
    constructor(scenarios, options = {}) {
        this.scenarios = scenarios;
        this.fixtureRef = options.fixtureRef || "fixture:queue-identity-worker";
        this.calls = [];
    }

    async resolve(candidate) {
        const spotifyArtistId = candidate.candidateIdentifiers.spotifyArtistId;
        const scenario = this.scenarios[spotifyArtistId] || this.scenarios[candidate.name.raw];
        this.calls.push(candidate.candidateId);
        if (!scenario) return { report: unresolvedReport(candidate), acquisition: {}, provenanceRefs: [this.fixtureRef] };
        if (scenario.temporaryFailure) throw new TemporaryIdentityError(scenario.temporaryFailure.message, scenario.temporaryFailure);
        const acquisition = structuredClone(scenario.acquisition || {});
        return { report: resolveIdentityAcquisition(candidate, acquisition), acquisition, provenanceRefs: [this.fixtureRef] };
    }
}

module.exports = {
    FixtureIdentityResolver,
    QueueIdentityResolver,
    TemporaryIdentityError,
    createRateLimitedFetch,
    isTemporaryProviderError,
    resolveIdentityAcquisition,
    unresolvedReport,
    wikidataClaims
};
