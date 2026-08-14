const { mappingsChecksum, validateArtistDirectoryV2, validateRegistry } = require("./music-roll-v2");

const APPROVAL_OUTCOMES = Object.freeze([
    "coherent_identity_evidence",
    "coherent_identity_with_same_name_ambiguity",
    "provider_profile_multiplicity"
]);
const EXCLUDED_NAMES = Object.freeze(["Elmiene", "Navy Blue", "underscores", "Hotline TNT", "Frankie Knuckles"]);

function assert(condition, message) { if (!condition) throw new Error(message); }
function unique(values) { return new Set(values).size === values.length; }

function evidenceSummary(report) {
    if (report.outcome === "provider_profile_multiplicity") {
        if ((report.evidence?.redirectedIdentifiers || []).length) return "Exact provider records resolve an obsolete MusicBrainz profile to the active entity; compatible Spotify, Discogs, authority, and catalog evidence supports review-only provider-profile multiplicity without establishing verification.";
        return "The selected exact MusicBrainz entity links the competing Discogs profiles; compatible authority metadata and a positive catalog fingerprint support review-only provider-profile multiplicity with no semantic contradiction observed.";
    }
    const fallback = report.exactSpotifyUrlFallback?.status === "unique_exact_url_relationship";
    const base = fallback
        ? "The stored Spotify URL has one exact MusicBrainz artist relationship, followed by compatible exact MusicBrainz and Discogs records with no identifier conflict."
        : "The stored Spotify ID and its exact Wikidata, MusicBrainz, and Discogs relationships remain internally coherent with no identifier conflict.";
    return report.outcome === "coherent_identity_with_same_name_ambiguity" ? `${base} The bounded same-name audit remains a separate ambiguity warning.` : base;
}

function sameNameNote(report) {
    if (report.outcome !== "coherent_identity_with_same_name_ambiguity") return null;
    const audit = report.sameNameAmbiguity || {};
    const competitors = (audit.competingEntities || []).map(item => `${item.name || "unnamed"} (${item.musicBrainzArtistId})`);
    return { exactDisplayNameEntityCount: audit.exactDisplayNameEntityCount ?? null, competingEntityCount: audit.competingEntityCount ?? competitors.length, competingEntities: competitors, note: "Matching display names are not identity proof; exact-ID agreement remains separate." };
}

function multiplicityNote(report) {
    if (report.outcome !== "provider_profile_multiplicity") return null;
    const interpretation = report.conflictResolution?.interpretation || {};
    return {
        interpretation: interpretation.conflictType || "provider_profile_multiplicity",
        mechanicallyResolvableForReview: interpretation.mechanicallyResolvable === true,
        evidence: interpretation.signals?.providerMultiplicityEvidence || [],
        redirects: report.evidence?.redirectedIdentifiers || [],
        preservedCompetingIdentifiers: report.conflictingIdentifiers || [],
        note: "Multiplicity does not verify identity or grant migration eligibility; all alternate and historical identifiers remain preserved with provenance."
    };
}

function candidateV2(source, generatedAt, evidenceRef) {
    return {
        musicRollId: source.proposedMusicRollId,
        schemaVersion: 2,
        name: source.name,
        displayName: source.name,
        identity: { status: "not_approved", confidence: null, verificationBasis: "review_only_multi_source_corroboration", evidenceRefs: [evidenceRef] },
        migrationEligible: false,
        externalIds: { spotify: source.spotify.id },
        externalUrls: { spotify: source.spotify.url },
        editorial: { stage: source.stage, stageConfidence: null, stageReason: "Existing Music Roll editorial classification; unchanged by identity review." },
        genres: [source.genre],
        primaryGenre: source.genre,
        geography: { home: { city: null, region: null, country: null, coordinates: null }, confidence: "unknown", evidenceRefs: [], sceneAssociations: [], currentTouringMarkets: [], upcomingEventMarkets: [] },
        evidence: { identity: [evidenceRef], mainstream: [], catalog: [], geographic: [], userEngagement: [] },
        media: { primaryImageUrl: source.spotify.image, imageSource: "spotify" },
        socialUrls: { instagram: null, tiktok: null },
        status: { directory: "candidate", profileClaim: "unclaimed", submissionSource: "editorial" },
        createdAt: generatedAt,
        updatedAt: generatedAt,
        genre: source.genre,
        tier: source.stage,
        spotifyId: source.spotify.id,
        spotify: source.spotify.url,
        image: source.spotify.image,
        instagram: null,
        tiktok: null
    };
}

function buildCurated21ReviewPackage({ accounting, registryExtension, reconsideration, liveArtists, permanentRegistry, generatedAt, evidenceRef }) {
    assert(accounting?.reviewOnly === true && accounting.records?.length === 46, "The curated-46 accounting preview is required.");
    assert(registryExtension?.reviewOnly === true && registryExtension.mappings?.length === 46, "The curated-46 registry-extension preview is required.");
    assert(reconsideration?.reviewOnly === true && reconsideration.totalArtists === 26 && reconsideration.reports?.length === 26, "The latest curated-26 reconsideration report is required.");
    assert(Array.isArray(liveArtists) && liveArtists.length === 20, "Exactly 20 current live artists are required.");
    assert(permanentRegistry?.mappings?.length === 20, "Exactly 20 permanent mappings are required.");
    validateArtistDirectoryV2(liveArtists);
    validateRegistry(permanentRegistry, liveArtists);

    const selected = reconsideration.reports.filter(report => APPROVAL_OUTCOMES.includes(report.outcome));
    assert(selected.length === 21, `Expected 21 approval-review candidates; found ${selected.length}.`);
    assert(EXCLUDED_NAMES.every(name => !selected.some(report => report.candidate.displayName === name)), "An explicitly excluded artist entered the package.");
    assert(selected.filter(report => report.outcome === "coherent_identity_evidence").length === 6, "Expected six coherent candidates.");
    assert(selected.filter(report => report.outcome === "coherent_identity_with_same_name_ambiguity").length === 4, "Expected four same-name ambiguity candidates.");
    assert(selected.filter(report => report.outcome === "provider_profile_multiplicity").length === 11, "Expected eleven provider-multiplicity candidates.");

    const accountingBySpotify = new Map(accounting.records.map(record => [record.spotify.id, record]));
    const proposedBySpotify = new Map(registryExtension.mappings.map(mapping => [mapping.spotifyId, mapping]));
    const liveSpotify = new Set(liveArtists.map(artist => artist.spotifyId));
    const candidates = selected.map(report => {
        const source = accountingBySpotify.get(report.candidate.spotifyArtistId);
        assert(source && !liveSpotify.has(source.spotify.id), `Candidate is missing or already live: ${report.candidate.displayName}.`);
        assert(source.proposedMusicRollId === report.candidate.proposedMusicRollId, `Proposed Music Roll ID drift for ${source.name}.`);
        assert(proposedBySpotify.get(source.spotify.id)?.musicRollId === source.proposedMusicRollId, `Curated-46 registry-extension ID drift for ${source.name}.`);
        return candidateV2(source, generatedAt, evidenceRef);
    });
    const migrationPreview = [...liveArtists.map(artist => structuredClone(artist)), ...candidates];
    validateArtistDirectoryV2(migrationPreview);
    assert(unique(migrationPreview.map(artist => artist.musicRollId)), "Migration preview contains duplicate Music Roll IDs.");
    assert(unique(migrationPreview.map(artist => artist.spotifyId)), "Migration preview contains duplicate Spotify IDs.");
    assert(candidates.every(artist => artist.identity.status === "not_approved" && artist.identity.confidence === null && artist.migrationEligible === false), "A candidate escaped not-approved state.");

    const existingMappings = permanentRegistry.mappings.map(mapping => ({ ...structuredClone(mapping), approvalState: "permanent_existing", humanApprovalRequired: false, migrationEligible: true }));
    const proposedMappings = selected.map(report => {
        const source = accountingBySpotify.get(report.candidate.spotifyArtistId);
        return { musicRollId: source.proposedMusicRollId, spotifyId: source.spotify.id, displayNameAtProposal: source.name, approvalState: "not_approved", identityOutcome: report.outcome, humanApprovalRequired: true, migrationEligible: false };
    });
    const mappings = [...existingMappings, ...proposedMappings];
    const registryPreview = { schemaVersion: 1, generatedAt, reviewOnly: true, permanentRegistryModified: false, existingMappingsPreserved: true, existingPermanentMappingCount: 20, proposedMappingCount: 21, mappingsSha256: mappingsChecksum(mappings), mappings };
    validateRegistry(registryPreview, migrationPreview);
    for (const [index, mapping] of permanentRegistry.mappings.entries()) {
        const preview = existingMappings[index];
        assert(preview?.spotifyId === mapping.spotifyId && preview.musicRollId === mapping.musicRollId, `Existing permanent binding changed: ${mapping.spotifyId}.`);
    }

    const reviewArtists = selected.map(report => {
        const source = accountingBySpotify.get(report.candidate.spotifyArtistId);
        return { proposedMusicRollId: source.proposedMusicRollId, artistName: source.name, genre: source.genre, stage: source.stage, spotifyId: source.spotify.id, spotifyUrl: source.spotify.url, image: source.spotify.image, identityOutcome: report.outcome, evidenceSummary: evidenceSummary(report), sameNameAmbiguityNote: sameNameNote(report), providerProfileMultiplicityNote: multiplicityNote(report), approvalState: "not_approved", migrationEligible: false };
    });
    const humanReview = { schemaVersion: 1, generatedAt, reviewOnly: true, sourceEvidence: evidenceRef, candidateCount: 21, currentLiveArtistCount: 20, proposedDirectorySize: 41, countsByOutcome: Object.fromEntries(APPROVAL_OUTCOMES.map(outcome => [outcome, reviewArtists.filter(artist => artist.identityOutcome === outcome).length])), artists: reviewArtists, excludedArtists: [...EXCLUDED_NAMES], safety: { identitiesApproved: 0, identitiesVerified: 0, confidenceScoresCalculated: 0, migrationsPerformed: 0, migrationEligibilityChanged: false, liveDirectoryModified: false, permanentRegistryModified: false, apiRequests: 0 } };
    return { humanReview, registryPreview, migrationPreview };
}

module.exports = { APPROVAL_OUTCOMES, EXCLUDED_NAMES, buildCurated21ReviewPackage, candidateV2, evidenceSummary, multiplicityNote, sameNameNote };
