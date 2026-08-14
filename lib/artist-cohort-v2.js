const crypto = require("crypto");
const { validateArtistDirectoryV2, validateRegistry } = require("./music-roll-v2");
const { adaptArtistDirectory } = require("../artist-model-adapter");

const ALLOWED_GENRES = new Set(["rnb", "hiphop", "pop", "rock", "dance"]);
const ALLOWED_STAGES = new Set(["underground", "emerging", "mainstream", "legacy", "classic"]);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function proposedChecksum(mappings) {
    return crypto.createHash("sha256").update(JSON.stringify(mappings.map(item => ({
        musicRollId: item.musicRollId,
        spotifyId: item.spotifyId,
        approvalState: item.approvalState
    })))).digest("hex");
}

function identityStatus(source, enriched, existing) {
    if (existing) return { status: "verified_existing", confidence: 100, concerns: [] };
    if (!enriched?.spotifyId) return { status: "unresolved", confidence: 0, concerns: ["missing_stored_spotify_candidate"] };
    if (enriched.name !== source.name) return { status: "conflicting_identity", confidence: 49, concerns: ["stored_returned_name_difference"] };
    const singleToken = source.name.trim().split(/\s+/).length === 1 || source.name.trim().length <= 4;
    const punctuationRisk = /[^\p{L}\p{N}\s]/u.test(source.name);
    const concerns = [];
    if (singleToken) concerns.push("short_or_single_token_name");
    if (punctuationRisk) concerns.push("punctuation_or_symbol_risk");
    if (singleToken || punctuationRisk) {
        concerns.push("stored_enrichment_does_not_preserve_alternate_exact_candidates");
        return { status: "manual_review_required", confidence: 75, concerns };
    }
    return {
        status: "high_confidence_candidate",
        confidence: 95,
        concerns: ["exact_name_candidate_is_review_only", "stored_enrichment_does_not_preserve_alternate_exact_candidates"]
    };
}

function buildV2Artist(source, enriched, musicRollId, identity, timestamp) {
    return {
        musicRollId,
        schemaVersion: 2,
        name: source.name,
        displayName: source.name,
        identity: {
            status: identity.status,
            confidence: identity.confidence,
            verificationBasis: identity.status === "verified_existing" ? "existing_verified_spotify_id" : "stored_spotify_exact_name_candidate",
            evidenceRefs: []
        },
        externalIds: { spotify: enriched.spotifyId },
        externalUrls: { spotify: enriched.spotifyUrl },
        editorial: { stage: source.tier, stageConfidence: null, stageReason: "Existing Music Roll editorial classification; confidence not yet assessed." },
        genres: [source.genre],
        primaryGenre: source.genre,
        geography: {
            home: { city: null, region: null, country: null, coordinates: null },
            confidence: "unknown", evidenceRefs: [], sceneAssociations: [], currentTouringMarkets: [], upcomingEventMarkets: []
        },
        evidence: { identity: [], mainstream: [], catalog: [], geographic: [], userEngagement: [] },
        media: { primaryImageUrl: enriched.imageUrl, imageSource: "spotify" },
        socialUrls: { instagram: null, tiktok: null },
        status: { directory: "candidate", profileClaim: "unclaimed", submissionSource: "editorial" },
        createdAt: timestamp,
        updatedAt: timestamp,
        genre: source.genre,
        tier: source.tier,
        spotifyId: enriched.spotifyId,
        spotify: enriched.spotifyUrl,
        image: enriched.imageUrl,
        instagram: null,
        tiktok: null
    };
}

function buildCohortReview({ sourceArtists, enrichedArtists, liveArtists, registry, generatedAt }) {
    assert(sourceArtists.length === 46, `Expected 46 curated artists; found ${sourceArtists.length}.`);
    assert(enrichedArtists.length === 46, `Expected 46 enriched artists; found ${enrichedArtists.length}.`);
    validateRegistry(registry, liveArtists);
    validateArtistDirectoryV2(liveArtists);
    const sourceNames = sourceArtists.map(item => item.name);
    assert(new Set(sourceNames).size === 46, "Duplicate curated artist names detected.");
    const enrichedByName = new Map(enrichedArtists.map(item => [item.name, item]));
    assert(enrichedByName.size === 46, "Duplicate enriched artist names detected.");
    const liveBySpotify = new Map(liveArtists.map(item => [item.spotifyId, item]));
    const registryBySpotify = new Map(registry.mappings.map(item => [item.spotifyId, item]));
    let nextId = 7;
    const records = sourceArtists.map(source => {
        assert(ALLOWED_GENRES.has(source.genre), `Invalid genre for ${source.name}: ${source.genre}.`);
        assert(ALLOWED_STAGES.has(source.tier), `Invalid stage for ${source.name}: ${source.tier}.`);
        const enriched = enrichedByName.get(source.name);
        assert(enriched, `Missing stored enrichment for ${source.name}.`);
        assert(enriched.genre === source.genre && enriched.tier === source.tier, `Stored classification drift for ${source.name}.`);
        const existingLive = liveBySpotify.get(enriched.spotifyId) || null;
        const existingMapping = registryBySpotify.get(enriched.spotifyId) || null;
        if (existingLive || existingMapping) {
            assert(existingLive && existingMapping, `Incomplete existing registry/live binding for ${source.name}.`);
            assert(existingLive.name === source.name, `Existing Spotify binding resolves to a different artist for ${source.name}.`);
            assert(existingLive.genre === source.genre && existingLive.tier === source.tier, `Existing classification changed for ${source.name}.`);
        }
        const proposedMusicRollId = existingMapping?.musicRollId || `mr_artist_${String(nextId++).padStart(6, "0")}`;
        const identity = identityStatus(source, enriched, existingLive);
        const eligible = identity.status === "verified_existing";
        return {
            name: source.name, genre: source.genre, stage: source.tier,
            proposedMusicRollId,
            spotify: { id: enriched.spotifyId, url: enriched.spotifyUrl, image: enriched.imageUrl },
            identity,
            migrationDecision: {
                eligible,
                decision: eligible ? "approved_existing_live" : "blocked_pending_identity_approval",
                reasons: eligible ? [] : [identity.status, ...identity.concerns]
            },
            existingLive: Boolean(existingLive)
        };
    });
    assert(nextId === 47, "Expected exactly 40 new sequential ID proposals.");
    const ids = records.map(item => item.proposedMusicRollId);
    const spotifyIds = records.map(item => item.spotify.id);
    assert(new Set(ids).size === 46, "Proposed Music Roll ID collision detected.");
    assert(new Set(spotifyIds).size === 46, "Duplicate Spotify ID detected in curated cohort.");
    for (const mapping of registry.mappings) {
        const record = records.find(item => item.spotify.id === mapping.spotifyId);
        assert(record?.proposedMusicRollId === mapping.musicRollId, `Existing mapping changed: ${mapping.musicRollId}.`);
    }
    const proposedMappings = records.map(item => ({
        musicRollId: item.proposedMusicRollId,
        spotifyId: item.spotify.id,
        displayNameAtProposal: item.name,
        approvalState: item.existingLive ? "permanent_existing" : "proposed_not_permanent",
        identityStatus: item.identity.status,
        migrationEligible: item.migrationDecision.eligible
    }));
    const eligibleSpotifyIds = new Set(records.filter(item => item.migrationDecision.eligible).map(item => item.spotify.id));
    const migrationReady = liveArtists.filter(item => eligibleSpotifyIds.has(item.spotifyId)).map(item => structuredClone(item));
    validateArtistDirectoryV2(migrationReady);
    assert(JSON.stringify(adaptArtistDirectory(migrationReady)) === JSON.stringify(adaptArtistDirectory(liveArtists)), "Migration-ready subset changed live compatibility output.");
    return {
        accounting: {
            schemaVersion: 1, reportId: "curated-46-v2-migration-accounting", generatedAt,
            reviewOnly: true, totalArtists: records.length, records,
            summary: {
                identityStatusCounts: Object.fromEntries(["verified_existing", "high_confidence_candidate", "manual_review_required", "conflicting_identity", "unresolved"].map(status => [status, records.filter(item => item.identity.status === status).length])),
                migrationEligible: migrationReady.length,
                migrationBlocked: records.length - migrationReady.length
            },
            validation: { all46AccountedFor: true, uniqueMusicRollIds: true, uniqueSpotifyIds: true, classificationsPreserved: true, liveDirectoryModified: false, apiRequests: 0 }
        },
        registryPreview: {
            schemaVersion: 1, reviewOnly: true, permanentRegistryModified: false,
            generatedAt, existingMappingsPreserved: true, mappingsSha256: proposedChecksum(proposedMappings), mappings: proposedMappings
        },
        migrationReady
    };
}

module.exports = { buildCohortReview, identityStatus, proposedChecksum };
