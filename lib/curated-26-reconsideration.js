const { auditSameNameMusicBrainzEntities, compareIdentifierClaims } = require("./identity-evidence-comparison");
const { assessMechanicallyClosedProviderMultiplicity, generalizedProviderMultiplicity } = require("./identity-conflict-resolution");

const OUTCOMES = Object.freeze([
    "coherent_identity_evidence",
    "coherent_identity_with_same_name_ambiguity",
    "provider_profile_multiplicity",
    "insufficient_corroboration",
    "semantic_identity_conflict",
    "unresolved_identity"
]);

const URL_PATTERNS = Object.freeze({
    spotifyArtistId: /^https:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]{22})(?:[/?#]|$)/,
    discogsArtistId: /^https?:\/\/(?:www\.)?discogs\.com\/(?:[a-z]{2}\/)?artist\/([1-9][0-9]*)(?:[-/?#]|$)/i,
    wikidataQid: /^https?:\/\/www\.wikidata\.org\/wiki\/(Q[1-9][0-9]*)(?:[/?#]|$)/i
});

function uniqueClaims(claims) {
    return [...new Map(claims.filter(claim => claim?.identifierType && claim?.value != null).map(claim => {
        const normalized = { ...claim, value: String(claim.value) };
        return [[normalized.identifierType, normalized.value, normalized.source, normalized.path, normalized.assertedByIdentifier || ""].join("\u0000"), normalized];
    })).values()];
}

function musicBrainzRelationshipClaims(artist) {
    if (!artist?.musicBrainzArtistId) return [];
    const mbid = artist.musicBrainzArtistId;
    const claims = [{ identifierType: "musicBrainzArtistId", value: mbid, source: "musicbrainz", path: "artist.id", independentOrigin: "musicbrainz", assertedByIdentifier: mbid }];
    for (const relationship of artist.externalUrls || []) {
        for (const [identifierType, pattern] of Object.entries(URL_PATTERNS)) {
            const value = String(relationship.url || "").match(pattern)?.[1];
            if (value) claims.push({ identifierType, value, source: "musicbrainz", path: `artist.url-rels:${relationship.relationshipType || "unknown"}`, independentOrigin: "musicbrainz", assertedByIdentifier: mbid });
        }
    }
    return claims;
}

function discogsRecordClaims(artist) {
    if (!artist?.discogsArtistId) return [];
    return [{ identifierType: "discogsArtistId", value: artist.discogsArtistId, source: "discogs", path: "artist.id", independentOrigin: "discogs", assertedByIdentifier: artist.discogsArtistId }];
}

function selectExactSpotifyUrlCandidate(lookup) {
    const candidates = [...new Map((lookup?.candidates || []).filter(item => item?.musicBrainzArtistId).map(item => [item.musicBrainzArtistId, item])).values()];
    if (candidates.length === 1) return { status: "unique_exact_url_relationship", selectedMbid: candidates[0].musicBrainzArtistId, candidates };
    if (candidates.length > 1) return { status: "multiple_exact_url_relationships", selectedMbid: null, candidates };
    return { status: lookup?.exactUrlFound === false ? "exact_url_not_found" : "no_artist_relationship", selectedMbid: null, candidates: [] };
}

function identifierValues(claims, type) {
    return [...new Set(claims.filter(claim => claim.identifierType === type).map(claim => String(claim.value)))];
}

function buildReconsiderationReport(input) {
    const candidate = input?.candidate;
    if (!candidate?.displayName || !/^[A-Za-z0-9]{22}$/.test(candidate.spotifyArtistId || "")) throw new Error("A named stored Spotify candidate is required.");
    const exactUrlSelection = selectExactSpotifyUrlCandidate(input.exactSpotifyUrlLookup);
    const claims = uniqueClaims([
        { identifierType: "spotifyArtistId", value: candidate.spotifyArtistId, source: "music_roll_input", path: "stored_spotify_candidate", independentOrigin: "music_roll" },
        ...(input.priorClaims || []),
        ...(input.wikidataClaims || []),
        ...Object.values(input.musicBrainzRecords || {}).flatMap(record => musicBrainzRelationshipClaims(record?.artist || record)),
        ...Object.values(input.discogsRecords || {}).flatMap(record => discogsRecordClaims(record?.artist || record))
    ]);
    if (exactUrlSelection.selectedMbid) claims.push({ identifierType: "musicBrainzArtistId", value: exactUrlSelection.selectedMbid, source: "musicbrainz", path: "url.exact_spotify_artist_relationship", independentOrigin: "musicbrainz", assertedByIdentifier: exactUrlSelection.selectedMbid });
    const provenanceClaims = uniqueClaims(claims);
    const comparison = compareIdentifierClaims(provenanceClaims);
    const mbids = identifierValues(provenanceClaims, "musicBrainzArtistId");
    const discogsIds = identifierValues(provenanceClaims, "discogsArtistId");
    const qids = identifierValues(provenanceClaims, "wikidataQid");
    const expectedMbid = mbids.length === 1 ? mbids[0] : exactUrlSelection.selectedMbid;
    const sameNameAudit = expectedMbid && Array.isArray(input.nameCandidates) && Array.isArray(input.nameCandidateDetails)
        ? auditSameNameMusicBrainzEntities(expectedMbid, input.nameCandidates, input.nameCandidateDetails)
        : { sameNameAmbiguity: "not_evaluated", competingEntities: [] };
    const resolution = generalizedProviderMultiplicity({
        claims: provenanceClaims,
        musicBrainzRecords: input.musicBrainzRecords,
        discogsRecords: input.discogsRecords,
        musicBrainzFingerprints: input.musicBrainzFingerprints,
        deprecatedIdentifiers: input.deprecatedIdentifiers,
        redirectedIdentifiers: input.redirectedIdentifiers
    });
    const spotifyConfirmedByMusicBrainz = provenanceClaims.some(claim => claim.identifierType === "spotifyArtistId" && claim.value === candidate.spotifyArtistId && claim.source === "musicbrainz");
    const musicBrainzRecordsComplete = mbids.length > 0 && mbids.every(id => (input.musicBrainzRecords || {})[id]?.artist || (input.musicBrainzRecords || {})[id]?.musicBrainzArtistId);
    const exactRecordsComplete = musicBrainzRecordsComplete
        && discogsIds.length > 0 && discogsIds.every(id => (input.discogsRecords || {})[id]?.artist || (input.discogsRecords || {})[id]?.discogsArtistId);
    const wikidataAssertsStoredSpotify = provenanceClaims.some(claim => claim.identifierType === "spotifyArtistId" && claim.value === candidate.spotifyArtistId && claim.source === "wikidata");
    const wikidataQidUnique = qids.length === 1 && provenanceClaims.some(claim => claim.identifierType === "wikidataQid" && claim.value === qids[0] && claim.source === "wikidata");
    const sameNameSpotifyConflicts = (sameNameAudit.competingEntities || []).flatMap(entity => entity.spotifyArtistIds || []).filter(id => id !== candidate.spotifyArtistId);
    const resolutionSignals = resolution.interpretation?.signals || {};
    const discogsOptionalCoherence = {
        qualifies: discogsIds.length === 0
            && wikidataAssertsStoredSpotify
            && wikidataQidUnique
            && mbids.length === 1
            && musicBrainzRecordsComplete
            && spotifyConfirmedByMusicBrainz
            && sameNameAudit.sameNameAmbiguity !== "not_evaluated"
            && sameNameSpotifyConflicts.length === 0
            && comparison.conflicts.length === 0
            && !(resolutionSignals.semanticContradictions || []).length
            && !(resolutionSignals.unresolvedIdentifiers || []).length
            && !(input.providerErrors || []).length,
        absenceRemainsMissingEvidence: discogsIds.length === 0,
        sameNameSpotifyConflicts,
        providerEvidenceComplete: !(input.providerErrors || []).length,
        automaticApprovalAllowed: false
    };
    const mechanicalClosure = assessMechanicallyClosedProviderMultiplicity({
        claims: provenanceClaims,
        musicBrainzRecords: input.musicBrainzRecords,
        discogsRecords: input.discogsRecords,
        resolution,
        sameNameAudit,
        providerErrors: input.providerErrors || [],
        storedSpotifyArtistId: candidate.spotifyArtistId,
        spotifyConfirmedByMusicBrainz,
        legalNameRelationshipEvidence: input.legalNameRelationshipEvidence || []
    });
    let outcome;
    if (exactUrlSelection.status === "multiple_exact_url_relationships") outcome = "unresolved_identity";
    else if (resolution.interpretation.conflictType === "semantic_identity_conflict") outcome = "semantic_identity_conflict";
    else if ((mbids.length > 1 || discogsIds.length > 1 || qids.length > 1 || comparison.conflicts.length) && resolution.qualifiesAsProviderMultiplicity) outcome = "provider_profile_multiplicity";
    else if (mbids.length > 1 || discogsIds.length > 1 || qids.length > 1 || comparison.conflicts.length) outcome = "unresolved_identity";
    else if (!mbids.length && !qids.length) outcome = "unresolved_identity";
    else if (!spotifyConfirmedByMusicBrainz || (!exactRecordsComplete && !discogsOptionalCoherence.qualifies) || sameNameAudit.sameNameAmbiguity === "not_evaluated") outcome = "insufficient_corroboration";
    else outcome = sameNameAudit.sameNameAmbiguity === "multiple_exact_display_name_entities" ? "coherent_identity_with_same_name_ambiguity" : "coherent_identity_evidence";

    const missingEvidence = [
        !qids.length && "wikidata_qid",
        !mbids.length && "musicbrainz_artist_id",
        mbids.length > 0 && !spotifyConfirmedByMusicBrainz && "musicbrainz_spotify_relationship",
        !discogsIds.length && "discogs_artist_id",
        mbids.some(id => !(input.musicBrainzRecords || {})[id]) && "musicbrainz_exact_record",
        discogsIds.some(id => !(input.discogsRecords || {})[id]) && "discogs_exact_record",
        sameNameAudit.sameNameAmbiguity === "not_evaluated" && "musicbrainz_same_name_audit"
    ].filter(Boolean);
    return {
        schemaVersion: 1,
        reviewOnly: true,
        candidate,
        outcome,
        exactSpotifyUrlFallback: exactUrlSelection,
        provenanceClaims,
        identifierAgreement: comparison.identifierComparison,
        conflictingIdentifiers: comparison.conflicts,
        sameNameAmbiguity: sameNameAudit,
        conflictResolution: { ...resolution, mechanicalClosure },
        discogsOptionalCoherence,
        missingEvidence,
        providerErrors: input.providerErrors || [],
        safety: { identityVerified: false, identityApproved: false, confidenceScoreCalculated: false, migrationEligibilityChanged: false, migrationPerformed: false, registryModified: false, liveDirectoryModified: false }
    };
}

module.exports = { OUTCOMES, buildReconsiderationReport, discogsRecordClaims, musicBrainzRelationshipClaims, selectExactSpotifyUrlCandidate, uniqueClaims };
