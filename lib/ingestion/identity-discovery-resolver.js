const crypto = require("crypto");
const { getMusicBrainzArtist, lookupMusicBrainzArtistsByExactUrl } = require("../musicbrainz-client");
const { lookupWikidataByExactTicketmasterId } = require("../wikidata-client");
const { OfflineCacheMissError } = require("./identity-evidence-store");

const SPOTIFY_URL_PATTERN = /^https:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]{22})(?:[/?#]|$)/;

class TemporaryIdentityDiscoveryError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "TemporaryIdentityDiscoveryError";
        this.retryable = true;
        Object.assign(this, details);
    }
}

function unique(values) {
    return [...new Set(values.filter(Boolean).map(String))];
}

function cacheIdentifier(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function spotifyIdsFromArtist(artist) {
    return unique((artist?.externalUrls || []).map(item => String(item?.url || "").match(SPOTIFY_URL_PATTERN)?.[1]));
}

function normalizedMbType(value) {
    const type = String(value || "").toLowerCase();
    if (["person", "character"].includes(type)) return "person";
    if (["group", "orchestra", "choir"].includes(type)) return "group";
    if (["other"].includes(type)) return "project";
    return null;
}

function report(candidate, acquisition, decision, details = {}) {
    return {
        schemaVersion: 1,
        candidateId: candidate.candidateId,
        candidateName: candidate.name.raw,
        reviewOnly: true,
        decision,
        resultingSpotifyArtistId: details.spotifyArtistId || null,
        inputProviderEntities: acquisition.inputProviderEntities,
        attemptedPaths: acquisition.attemptedPaths,
        bridgePaths: acquisition.bridgePaths,
        spotifyCandidates: unique(acquisition.spotifyCandidates),
        unresolvedAlternates: acquisition.unresolvedAlternates,
        contradictions: acquisition.contradictions,
        providerErrors: acquisition.providerErrors,
        provenanceClaims: acquisition.provenanceClaims,
        safety: {
            identityVerified: false,
            identityApproved: false,
            confidenceScoreCalculated: false,
            stage3Run: false,
            migrationPerformed: false
        }
    };
}

function classifyAcquisition(candidate, acquisition) {
    const candidates = unique(acquisition.spotifyCandidates);
    const origins = new Map();
    for (const path of acquisition.bridgePaths) {
        for (const origin of unique(path.independentOrigins || [path.source])) {
            origins.set(origin, unique([...(origins.get(origin) || []), path.resultingSpotifyArtistId]));
        }
    }
    const independentSingletons = [...origins.values()].filter(values => values.length === 1).map(values => values[0]);
    const independentDisagreement = new Set(independentSingletons).size > 1;
    if (acquisition.contradictions.length || independentDisagreement) {
        if (independentDisagreement) acquisition.contradictions.push({ code: "independent_exact_paths_disagree", byOrigin: Object.fromEntries(origins) });
        return { status: "conflicting_identity", report: report(candidate, acquisition, "semantic_or_exact_bridge_conflict") };
    }
    if (acquisition.unresolvedAlternates.length || candidates.length > 1) {
        return { status: "needs_review", report: report(candidate, acquisition, "multiple_or_unresolved_exact_bridges") };
    }
    if (candidates.length === 1) {
        return { status: "unique_exact_bridge", spotifyArtistId: candidates[0], report: report(candidate, acquisition, "unique_exact_spotify_bridge", { spotifyArtistId: candidates[0] }) };
    }
    return { status: "needs_review", report: report(candidate, acquisition, "completed_without_safe_exact_bridge") };
}

class IdentityDiscoveryResolver {
    constructor({ evidenceStore, discoveryStore, wikidataPropertySemantics = {}, entityTypeSemantics = {}, fetchers = {} }) {
        if (!evidenceStore || !discoveryStore) throw new Error("Identity discovery resolver requires evidence and discovery stores.");
        this.evidenceStore = evidenceStore;
        this.discoveryStore = discoveryStore;
        this.wikidataPropertySemantics = wikidataPropertySemantics;
        this.entityTypeSemantics = entityTypeSemantics;
        this.fetchers = { musicbrainz: fetchers.musicbrainz || fetch, wikidata: fetchers.wikidata || fetch };
        this.networkAllowed = evidenceStore.allowNetwork === true;
    }

    async cached(provider, identifier, operation, provenanceRefs, acquire) {
        const result = await this.evidenceStore.getOrAcquire({ provider, identifier, operation, acquire });
        provenanceRefs.push(result.evidenceRef);
        return result.value;
    }

    temporary(error, provider, operation, identifier) {
        if (error instanceof OfflineCacheMissError) throw error;
        if (error.retryable === true || [401, 403, 408, 425, 429, 500, 502, 503, 504].includes(error.statusCode) || (error.statusCode == null && /network|fetch|before receiving/i.test(error.message || ""))) {
            throw new TemporaryIdentityDiscoveryError(`${provider} ${operation} is temporarily unavailable: ${error.message}`, { provider, operation, identifier, statusCode: error.statusCode || null, evidenceRef: error.evidenceRef || null });
        }
        return { provider, operation, identifier, statusCode: error.statusCode || null, message: error.message, evidenceRef: error.evidenceRef || null };
    }

    async resolve(candidate) {
        const provenanceRefs = [];
        const occurrences = [];
        for (const association of candidate.discoveryAssociations || []) {
            const occurrence = await this.discoveryStore.findOccurrenceById(association.occurrenceId);
            if (occurrence) occurrences.push(occurrence);
        }
        const ticketmasterOccurrences = occurrences.filter(item => item.provider === "ticketmaster" && item.providerEntity.type === "attraction");
        const acquisition = {
            inputProviderEntities: ticketmasterOccurrences.map(item => ({ provider: "ticketmaster", type: "attraction", id: item.providerEntity.id, legacyIds: item.providerEntity.legacyIds, occurrenceId: item.occurrenceId })),
            attemptedPaths: [],
            bridgePaths: [],
            spotifyCandidates: [],
            unresolvedAlternates: [],
            contradictions: [],
            providerErrors: [],
            provenanceClaims: []
        };
        if (!ticketmasterOccurrences.length) {
            acquisition.unresolvedAlternates.push({ code: "missing_ticketmaster_attraction_occurrence" });
            return { ...classifyAcquisition(candidate, acquisition), acquisition, provenanceRefs };
        }

        for (const occurrence of ticketmasterOccurrences) {
            for (const bridge of occurrence.exactIdentityBridges || []) {
                if (bridge.targetProvider !== "spotify" || bridge.targetEntityType !== "artist") continue;
                acquisition.spotifyCandidates.push(bridge.targetId);
                acquisition.bridgePaths.push({ source: bridge.assertedByProvider, independentOrigins: [bridge.assertedByProvider], relationshipType: bridge.relationshipType, steps: [{ sourceEntity: `${occurrence.providerEntity.provider}:${occurrence.providerEntity.id}`, target: bridge.targetId, evidenceRef: bridge.evidenceRef }], resultingSpotifyArtistId: bridge.targetId });
                acquisition.provenanceClaims.push({ source: bridge.assertedByProvider, independentOrigin: bridge.assertedByProvider, identifierType: "spotifyArtistId", value: bridge.targetId, evidenceRef: bridge.evidenceRef });
                provenanceRefs.push(bridge.evidenceRef);
            }
        }
        if (acquisition.bridgePaths.length) {
            const classified = classifyAcquisition(candidate, acquisition);
            return { ...classified, acquisition, provenanceRefs: unique(provenanceRefs) };
        }

        const mbids = new Set();
        const wdSemanticTypes = new Set();
        for (const occurrence of ticketmasterOccurrences) {
            const typedIds = [
                { kind: "discovery", value: occurrence.providerEntity.id },
                ...(occurrence.providerEntity.legacyIds || []).map(value => ({ kind: "legacy", value }))
            ];
            for (const typed of typedIds) {
                const propertyId = this.wikidataPropertySemantics[typed.kind];
                if (!propertyId) continue;
                const identifier = cacheIdentifier(`${propertyId}:${typed.value}`);
                acquisition.attemptedPaths.push({ source: "wikidata", operation: "exact_ticketmaster_id", ticketmasterId: typed.value, propertyId });
                let result;
                try {
                    result = await this.cached("wikidata", identifier, "ticketmaster-id-bridge", provenanceRefs, () => lookupWikidataByExactTicketmasterId(typed.value, { propertyId, fetchImpl: this.fetchers.wikidata }));
                } catch (error) {
                    const providerError = this.temporary(error, "wikidata", "ticketmaster-id-bridge", identifier);
                    acquisition.providerErrors.push(providerError);
                    if (providerError.evidenceRef) provenanceRefs.push(providerError.evidenceRef);
                    continue;
                }
                const active = (result?.bridge?.candidates || result?.candidates || []).filter(item => !(item.statementRanks || []).every(rank => rank === "deprecated"));
                if (active.length > 1) acquisition.unresolvedAlternates.push({ code: "multiple_wikidata_qids", ticketmasterId: typed.value, qids: active.map(item => item.wikidataQid) });
                for (const item of active) {
                    for (const entityType of item.entityTypes || []) if (this.entityTypeSemantics[entityType]) wdSemanticTypes.add(this.entityTypeSemantics[entityType]);
                    for (const mbid of item.musicBrainzArtistIds || []) mbids.add(mbid);
                    for (const spotifyArtistId of item.spotifyArtistIds || []) {
                        acquisition.spotifyCandidates.push(spotifyArtistId);
                        acquisition.bridgePaths.push({ source: "wikidata", independentOrigins: ["wikidata"], relationshipType: "exact_ticketmaster_id_to_spotify_claim", steps: [{ sourceEntity: item.wikidataQid, target: spotifyArtistId, propertyId: "P1902" }], resultingSpotifyArtistId: spotifyArtistId });
                        acquisition.provenanceClaims.push({ source: "wikidata", independentOrigin: "wikidata", identifierType: "spotifyArtistId", value: spotifyArtistId, assertedByIdentifier: item.wikidataQid });
                    }
                }
            }

            const urls = unique([occurrence.providerEntity.url, occurrence.sourceContext?.attractionUrl]);
            for (const url of urls.slice(0, 2)) {
                acquisition.attemptedPaths.push({ source: "musicbrainz", operation: "exact_provider_url", resource: url });
                let lookup;
                const identifier = cacheIdentifier(url);
                try {
                    lookup = await this.cached("musicbrainz", identifier, "exact-provider-url", provenanceRefs, () => lookupMusicBrainzArtistsByExactUrl(url, { fetchImpl: this.fetchers.musicbrainz, maxRetries: 0 }));
                } catch (error) {
                    const providerError = this.temporary(error, "musicbrainz", "exact-provider-url", identifier);
                    acquisition.providerErrors.push(providerError);
                    if (providerError.evidenceRef) provenanceRefs.push(providerError.evidenceRef);
                    continue;
                }
                const candidates = lookup?.candidates || [];
                if (candidates.length > 1) acquisition.unresolvedAlternates.push({ code: "multiple_mbids_for_exact_ticketmaster_url", resource: url, mbids: candidates.map(item => item.musicBrainzArtistId) });
                for (const item of candidates) mbids.add(item.musicBrainzArtistId);
            }
        }

        const mbTypes = new Set();
        if (mbids.size > 1) {
            acquisition.unresolvedAlternates.push({ code: "multiple_unresolved_mbids", mbids: [...mbids] });
            const classified = classifyAcquisition(candidate, acquisition);
            return { ...classified, acquisition, provenanceRefs: unique(provenanceRefs) };
        }
        for (const mbid of mbids) {
            acquisition.attemptedPaths.push({ source: "musicbrainz", operation: "exact_mbid", mbid });
            let record;
            try {
                record = await this.cached("musicbrainz", mbid, "artist", provenanceRefs, () => getMusicBrainzArtist(mbid, { fetchImpl: this.fetchers.musicbrainz, maxRetries: 0 }));
            } catch (error) {
                const providerError = this.temporary(error, "musicbrainz", "artist", mbid);
                acquisition.providerErrors.push(providerError);
                acquisition.unresolvedAlternates.push({ code: "unresolved_exact_mbid_record", mbid });
                if (providerError.evidenceRef) provenanceRefs.push(providerError.evidenceRef);
                continue;
            }
            const artist = record?.artist || record;
            const spotifyIds = spotifyIdsFromArtist(artist);
            const type = normalizedMbType(artist?.artistType);
            if (type) mbTypes.add(type);
            if (spotifyIds.length > 1) acquisition.unresolvedAlternates.push({ code: "multiple_spotify_urls_on_mbid", mbid, spotifyArtistIds: spotifyIds });
            for (const spotifyArtistId of spotifyIds) {
                acquisition.spotifyCandidates.push(spotifyArtistId);
                acquisition.bridgePaths.push({ source: "musicbrainz", independentOrigins: ["musicbrainz"], relationshipType: "exact_ticketmaster_url_via_mbid_to_spotify", steps: [{ sourceEntity: mbid, target: spotifyArtistId }], resultingSpotifyArtistId: spotifyArtistId });
                acquisition.provenanceClaims.push({ source: "musicbrainz", independentOrigin: "musicbrainz", identifierType: "spotifyArtistId", value: spotifyArtistId, assertedByIdentifier: mbid });
            }
        }
        if ((wdSemanticTypes.has("person") && (mbTypes.has("group") || mbTypes.has("project"))) || (mbTypes.has("person") && (wdSemanticTypes.has("group") || wdSemanticTypes.has("project")))) {
            acquisition.contradictions.push({ code: "person_group_project_mismatch", wikidataTypes: [...wdSemanticTypes], musicBrainzTypes: [...mbTypes] });
        }
        const classified = classifyAcquisition(candidate, acquisition);
        return { ...classified, acquisition, provenanceRefs: unique(provenanceRefs) };
    }
}

class FixtureIdentityDiscoveryResolver {
    constructor(scenarios) {
        this.scenarios = scenarios;
        this.calls = [];
    }

    async resolve(candidate) {
        this.calls.push(candidate.candidateId);
        const scenario = this.scenarios[candidate.name.raw];
        if (!scenario) throw new OfflineCacheMissError("musicbrainz", "exact-provider-url", "fixture-missing");
        if (scenario.cacheMiss) throw new OfflineCacheMissError(scenario.cacheMiss.provider, scenario.cacheMiss.operation, scenario.cacheMiss.identifier);
        if (scenario.temporaryFailure) throw new TemporaryIdentityDiscoveryError(scenario.temporaryFailure.message, scenario.temporaryFailure);
        const acquisition = structuredClone(scenario.acquisition || { inputProviderEntities: [], attemptedPaths: [], bridgePaths: [], spotifyCandidates: [], unresolvedAlternates: [], contradictions: [], providerErrors: [], provenanceClaims: [] });
        const classified = classifyAcquisition(candidate, acquisition);
        return { ...classified, acquisition, provenanceRefs: [scenario.evidenceRef || "fixture:identity-discovery"] };
    }
}

module.exports = { FixtureIdentityDiscoveryResolver, IdentityDiscoveryResolver, TemporaryIdentityDiscoveryError, cacheIdentifier, classifyAcquisition, normalizedMbType, spotifyIdsFromArtist };
