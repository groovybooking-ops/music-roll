const { validateArtistDirectoryV2 } = require("./music-roll-v2");
const { proposedChecksum } = require("./artist-cohort-v2");

const SUPPORTED_OUTCOMES = new Set(["coherent_identity_evidence", "provider_profile_multiplicity"]);

function assert(condition, message) { if (!condition) throw new Error(message); }

function evidenceSummary(record) {
    if (record.outcome === "provider_profile_multiplicity") return "Exact identifiers resolve to a coherent underlying entity; alternate provider profiles are preserved as review-only multiplicity with no semantic contradiction in the acquired evidence.";
    return "Exact Spotify, Wikidata, MusicBrainz, and Discogs evidence is internally coherent, with no identifier conflict or same-name ambiguity observed in the bounded audit.";
}

function multiplicityNotes(record) {
    if (record.outcome !== "provider_profile_multiplicity") return [];
    return record.conflictResolution?.finalConflictInterpretation?.signals?.providerMultiplicityEvidence || [];
}

function candidateV2(accounting, generatedAt, evidenceRef) {
    return {
        musicRollId: accounting.proposedMusicRollId,
        schemaVersion: 2,
        name: accounting.name,
        displayName: accounting.name,
        identity: { status: "review_only_candidate", confidence: null, verificationBasis: "multi_source_identity_corroboration_review_only", evidenceRefs: [evidenceRef] },
        externalIds: { spotify: accounting.spotify.id },
        externalUrls: { spotify: accounting.spotify.url },
        editorial: { stage: accounting.stage, stageConfidence: null, stageReason: "Existing Music Roll editorial classification; unchanged by identity review." },
        genres: [accounting.genre],
        primaryGenre: accounting.genre,
        geography: { home: { city: null, region: null, country: null, coordinates: null }, confidence: "unknown", evidenceRefs: [], sceneAssociations: [], currentTouringMarkets: [], upcomingEventMarkets: [] },
        evidence: { identity: [evidenceRef], mainstream: [], catalog: [], geographic: [], userEngagement: [] },
        media: { primaryImageUrl: accounting.spotify.image, imageSource: "spotify" },
        socialUrls: { instagram: null, tiktok: null },
        status: { directory: "candidate", profileClaim: "unclaimed", submissionSource: "editorial" },
        createdAt: generatedAt,
        updatedAt: generatedAt,
        genre: accounting.genre,
        tier: accounting.stage,
        spotifyId: accounting.spotify.id,
        spotify: accounting.spotify.url,
        image: accounting.spotify.image,
        instagram: null,
        tiktok: null
    };
}

function buildReviewMigrationPackage({ accounting, reanalysis, liveArtists, permanentRegistry, generatedAt, evidenceRef }) {
    assert(accounting?.reviewOnly === true && accounting.records?.length === 46, "The curated-46 review-only accounting preview is required.");
    assert(reanalysis?.reviewOnly === true && reanalysis.records?.length === 40, "The curated-40 review-only reanalysis is required.");
    const selected = reanalysis.records.filter(record => SUPPORTED_OUTCOMES.has(record.outcome));
    assert(selected.length === 14, `Expected 14 supported migration-review candidates; found ${selected.length}.`);
    const accountingBySpotify = new Map(accounting.records.map(record => [record.spotify.id, record]));
    const permanentBySpotify = new Map(permanentRegistry.mappings.map(mapping => [mapping.spotifyId, mapping]));
    assert(liveArtists.length === 6 && permanentRegistry.mappings.length === 6, "Expected six existing permanent artists.");
    const candidates = selected.map(record => {
        const source = accountingBySpotify.get(record.artist.spotifyArtistId);
        assert(source && !source.existingLive, `Missing blocked accounting record for ${record.artist.displayName}.`);
        return candidateV2(source, generatedAt, evidenceRef);
    });
    const migrationPreview = [...liveArtists.map(item => structuredClone(item)), ...candidates];
    validateArtistDirectoryV2(migrationPreview);
    assert(new Set(migrationPreview.map(item => item.spotifyId)).size === 20, "Migration preview contains duplicate Spotify IDs.");
    assert(candidates.every(item => item.identity.status === "review_only_candidate" && item.identity.confidence === null && item.status.directory === "candidate"), "A proposed artist escaped review-only candidate state.");
    const newMappings = selected.map(record => {
        const source = accountingBySpotify.get(record.artist.spotifyArtistId);
        return { musicRollId: source.proposedMusicRollId, spotifyId: source.spotify.id, displayNameAtProposal: source.name, approvalState: "proposed_not_permanent", identityOutcome: record.outcome, humanApprovalRequired: true, migrationEligible: false };
    });
    const existingMappings = permanentRegistry.mappings.map(mapping => ({ ...mapping, displayNameAtProposal: liveArtists.find(item => item.spotifyId === mapping.spotifyId)?.name, approvalState: "permanent_existing", identityOutcome: "verified_existing", humanApprovalRequired: false, migrationEligible: true }));
    for (const mapping of existingMappings) assert(permanentBySpotify.get(mapping.spotifyId)?.musicRollId === mapping.musicRollId, `Permanent mapping changed: ${mapping.spotifyId}.`);
    const mappings = [...existingMappings, ...newMappings];
    assert(new Set(mappings.map(item => item.musicRollId)).size === 20, "Registry preview contains duplicate Music Roll IDs.");
    const reviewArtists = selected.map(record => {
        const source = accountingBySpotify.get(record.artist.spotifyArtistId);
        return { proposedMusicRollId: source.proposedMusicRollId, curatedName: source.name, genre: source.genre, stage: source.stage, spotifyId: source.spotify.id, spotifyUrl: source.spotify.url, image: source.spotify.image, identityOutcome: record.outcome, evidenceSummary: evidenceSummary(record), providerProfileMultiplicityNotes: multiplicityNotes(record), humanApprovalStatus: "pending" };
    });
    return {
        humanReview: { schemaVersion: 1, generatedAt, reviewOnly: true, artistCount: 14, existingPermanentArtistCount: 6, proposedDirectorySize: 20, artists: reviewArtists, safety: { identitiesApproved: 0, identitiesVerified: 0, migrationsPerformed: 0, liveDirectoryModified: false, permanentRegistryModified: false, apiRequests: 0 } },
        registryPreview: { schemaVersion: 1, generatedAt, reviewOnly: true, permanentRegistryModified: false, existingMappingsPreserved: true, proposedMappingCount: 14, mappingsSha256: proposedChecksum(mappings), mappings },
        migrationPreview
    };
}

module.exports = { SUPPORTED_OUTCOMES, buildReviewMigrationPackage, evidenceSummary, multiplicityNotes };
