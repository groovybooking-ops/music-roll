const GENERIC_RELEASE_TITLES = new Set([
    "album", "best of", "greatest hits", "live", "remixes", "the album"
]);

function clamp(value, minimum = 0, maximum = 100) {
    return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function normalizeTitle(value) {
    return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[\[(].*?\b(deluxe|expanded|remaster(?:ed)?|anniversary|edition|bonus)\b.*?[\])]/g, "")
        .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function distinctiveTitleOverlap(spotifyTitles = [], musicBrainzTitles = []) {
    const spotify = new Set(spotifyTitles.map(normalizeTitle).filter(title => title && !GENERIC_RELEASE_TITLES.has(title)));
    const musicBrainz = new Set(musicBrainzTitles.map(normalizeTitle).filter(title => title && !GENERIC_RELEASE_TITLES.has(title)));
    return [...spotify].filter(title => musicBrainz.has(title));
}

function evidenceClass(name, score, strength, evidence) {
    return { class: name, score, strength, evidence };
}

function assessCorroboration(firstStage, fixture, context = {}) {
    const evidenceClasses = [];
    const conflicts = [];

    const verifiedExisting = firstStage.status === "verified_existing";
    evidenceClasses.push(evidenceClass(
        "music_roll_authority",
        verifiedExisting ? 100 : 0,
        verifiedExisting ? "authoritative" : "not_available",
        [{ type: "existing_verified_spotify_id", result: verifiedExisting ? "match" : "not_available" }]
    ));

    const identifiers = fixture.crossDatabaseIdentifiers || {};
    let identifierScore = 0;
    if (identifiers.musicBrainzSpotifyUrl === "match") identifierScore = Math.max(identifierScore, 35);
    if (identifiers.musicRollVerifiedExternalId === "match") identifierScore = Math.max(identifierScore, 40);
    if (identifiers.spotifyUrl === "conflict" || identifiers.externalId === "conflict") {
        conflicts.push({ type: "external_identifier_conflict" });
    }
    evidenceClasses.push(evidenceClass(
        "cross_database_identifiers",
        identifierScore,
        identifierScore >= 30 ? "strong" : identifierScore ? "moderate" : "not_available",
        [
            { type: "musicbrainz_spotify_url", result: identifiers.musicBrainzSpotifyUrl || "not_available" },
            { type: "musicroll_verified_external_id", result: identifiers.musicRollVerifiedExternalId || "not_available" }
        ]
    ));

    const metadata = fixture.crossDatabaseEntityMetadata || {};
    let metadataScore = 0;
    if (metadata.alias === "match") metadataScore += 7;
    if (metadata.artistType === "compatible") metadataScore += 5;
    if (metadata.area === "compatible") metadataScore += 4;
    if (metadata.activeDates === "compatible") metadataScore += 4;
    if (metadata.artistType === "conflict") conflicts.push({ type: "artist_type_conflict" });
    evidenceClasses.push(evidenceClass(
        "cross_database_entity_metadata",
        Math.min(metadataScore, 20),
        metadataScore >= 10 ? "moderate" : metadataScore ? "weak" : "not_available",
        [
            { type: "alias", result: metadata.alias || "not_available" },
            { type: "artist_type", result: metadata.artistType || "not_available" },
            { type: "area", result: metadata.area || "not_available" },
            { type: "active_dates", result: metadata.activeDates || "not_available" }
        ]
    ));

    const catalog = fixture.catalogFingerprint || {};
    const overlaps = distinctiveTitleOverlap(catalog.spotifyReleaseTitles, catalog.musicBrainzReleaseTitles);
    let catalogScore = overlaps.length >= 3 ? 30 : overlaps.length === 2 ? 20 : overlaps.length === 1 ? 7 : 0;
    if (catalog.chronology === "compatible") catalogScore += 5;
    if (catalog.primaryCoherent === true && catalog.emptyAlternativeCount > 0) catalogScore += 15;
    if (catalog.chronology === "conflict") conflicts.push({ type: "chronology_conflict" });
    if (catalog.multiplePlausibleSameNameCatalogs === true) conflicts.push({ type: "multiple_plausible_same_name_catalogs" });
    if (catalog.complete === false) conflicts.push({ type: "incomplete_catalog_evidence" });
    evidenceClasses.push(evidenceClass(
        "catalog_fingerprint",
        Math.min(catalogScore, 40),
        catalogScore >= 30 ? "strong" : catalogScore >= 10 ? "moderate" : catalogScore ? "weak" : "not_available",
        [
            { type: "distinctive_release_title_overlap", result: overlaps, count: overlaps.length },
            { type: "chronology", result: catalog.chronology || "not_available" },
            { type: "coherent_primary_profile", result: catalog.primaryCoherent ?? "not_evaluated" },
            { type: "empty_alternative_count", result: catalog.emptyAlternativeCount || 0 },
            { type: "catalog_complete", result: catalog.complete ?? "not_evaluated" },
            { type: "partial_date_precisions", result: catalog.partialDatePrecisions || [] },
            { type: "posthumous_or_reissue_activity", result: Boolean(catalog.posthumousOrReissueActivity), note: "Does not imply current artist activity." }
        ]
    ));

    const weak = fixture.weakPresentationEvidence || {};
    let weakScore = 0;
    if (weak.imageAvailable) weakScore += 2;
    if (weak.punctuationOrCaseAgreement) weakScore += 2;
    if (weak.hasRelease) weakScore += 3;
    evidenceClasses.push(evidenceClass(
        "weak_presentation_evidence",
        weakScore,
        weakScore ? "weak" : "not_available",
        [
            { type: "image_available", result: Boolean(weak.imageAvailable) },
            { type: "punctuation_or_case_agreement", result: Boolean(weak.punctuationOrCaseAgreement) },
            { type: "has_release", result: Boolean(weak.hasRelease) }
        ]
    ));

    if (context.duplicateSpotifyId) conflicts.push({ type: "duplicate_spotify_id", detail: context.duplicateSpotifyId });
    const independent = evidenceClasses.filter(item => !["music_roll_authority", "weak_presentation_evidence"].includes(item.class));
    const strongClasses = independent.filter(item => item.strength === "strong").map(item => item.class);
    const moderateClasses = independent.filter(item => ["moderate", "strong"].includes(item.strength)).map(item => item.class);
    const independentCorroborationSatisfied = strongClasses.length >= 1 || moderateClasses.length >= 2;
    const corroborationScore = clamp(evidenceClasses
        .filter(item => item.class !== "music_roll_authority")
        .reduce((sum, item) => sum + item.score, 0));

    let status = firstStage.status;
    let requiresHumanReview = firstStage.requiresHumanReview;
    let confidence = firstStage.confidence;
    if (verifiedExisting) {
        status = "verified_existing";
        confidence = 100;
        requiresHumanReview = false;
    } else if (conflicts.length) {
        status = "conflicting_identity";
        confidence = Math.min(firstStage.confidence, 49);
        requiresHumanReview = true;
    } else if (firstStage.status === "manual_review_required" && independentCorroborationSatisfied) {
        status = "high_confidence_candidate";
        confidence = Math.min(95, firstStage.confidence + Math.round(corroborationScore / 3));
        requiresHumanReview = false;
    }

    return {
        status,
        firstStageConfidence: firstStage.confidence,
        corroborationScore,
        confidence,
        evidenceClasses,
        independentCorroboration: {
            satisfied: independentCorroborationSatisfied,
            strongClasses,
            moderateClasses
        },
        conflicts,
        requiresHumanReview,
        inferredIdentityMarkedVerified: false
    };
}

module.exports = { assessCorroboration, distinctiveTitleOverlap, normalizeTitle };
