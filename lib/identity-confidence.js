const { normalizeArtistName } = require("./spotify-client");

const SCORE_RULES = Object.freeze({
    exactNormalizedName: 60,
    singleExactCandidate: 25,
    exactDisplayedName: 10,
    imageAvailable: 5
});

const STATUS_THRESHOLDS = Object.freeze({
    highConfidenceCandidate: 90
});

function evidence(type, result, points = 0, note = null) {
    return { type, result, points, ...(note ? { note } : {}) };
}

function assessIdentity(record, context = {}) {
    const review = record.spotifyIdentityReview || {};
    const candidate = review.candidateMatch || null;
    const exactCandidateCount = candidate ? 1 + (review.alternateExactMatches || []).length : 0;
    const evidenceItems = [];
    const conflicts = [];
    let confidence = 0;

    if (!candidate) {
        evidenceItems.push(evidence("exact_normalized_name", "no_match", 0));
        return {
            status: "unresolved",
            confidence: 0,
            evidence: evidenceItems,
            conflicts,
            requiresHumanReview: true
        };
    }

    const verified = review.existingMusicRollSpotifyIdOverlap?.exists === true;
    evidenceItems.push(evidence(
        "existing_musicroll_spotify_id",
        verified ? "match" : "not_available",
        0,
        verified ? "Existing explicitly verified Music Roll ID is authoritative." : null
    ));

    const exactNormalized = normalizeArtistName(record.artistNameRaw) ===
        normalizeArtistName(candidate.returnedArtistName);
    if (exactNormalized) confidence += SCORE_RULES.exactNormalizedName;
    evidenceItems.push(evidence("exact_normalized_name", exactNormalized ? "match" : "mismatch", exactNormalized ? SCORE_RULES.exactNormalizedName : 0));

    if (exactCandidateCount === 1) confidence += SCORE_RULES.singleExactCandidate;
    evidenceItems.push(evidence("candidate_count", exactCandidateCount, exactCandidateCount === 1 ? SCORE_RULES.singleExactCandidate : 0));

    const exactDisplayed = record.artistNameRaw === candidate.returnedArtistName;
    if (exactDisplayed) confidence += SCORE_RULES.exactDisplayedName;
    evidenceItems.push(evidence("exact_displayed_name", exactDisplayed ? "match" : "difference", exactDisplayed ? SCORE_RULES.exactDisplayedName : 0));

    const hasImage = Boolean(candidate.imageUrl);
    if (hasImage) confidence += SCORE_RULES.imageAvailable;
    evidenceItems.push(evidence("candidate_image", hasImage ? "available" : "missing", hasImage ? SCORE_RULES.imageAvailable : 0, "Supporting completeness evidence only; never identity proof by itself."));
    evidenceItems.push(evidence("catalog_consistency", "not_evaluated", 0));
    evidenceItems.push(evidence("monthly_listener_rank", "excluded_from_identity_scoring", 0));

    if (context.duplicateSpotifyId) conflicts.push({ type: "duplicate_spotify_id", detail: context.duplicateSpotifyId });
    if (context.externalIdConflict) conflicts.push({ type: "external_id_conflict", detail: context.externalIdConflict });
    if (!exactNormalized) conflicts.push({ type: "normalized_name_mismatch" });

    const ambiguity = new Set(review.ambiguityReasons || []);
    const reviewReasons = [];
    if (exactCandidateCount > 1) reviewReasons.push("multiple_exact_name_profiles");
    if (ambiguity.has("punctuation_or_symbol_difference_risk")) reviewReasons.push("punctuation_or_symbol_risk");
    if (ambiguity.has("spotify_returned_name_differs") || !exactDisplayed) reviewReasons.push("returned_name_difference");
    if (ambiguity.has("short_or_single_token_name")) reviewReasons.push("short_or_common_name_without_verified_id");

    let status;
    let requiresHumanReview;
    if (verified) {
        status = "verified_existing";
        confidence = 100;
        requiresHumanReview = false;
        reviewReasons.length = 0;
    } else if (conflicts.length) {
        status = "conflicting_identity";
        confidence = Math.min(confidence, 49);
        requiresHumanReview = true;
    } else if (reviewReasons.length) {
        status = "manual_review_required";
        confidence = Math.min(confidence, 79);
        requiresHumanReview = true;
    } else if (confidence >= STATUS_THRESHOLDS.highConfidenceCandidate) {
        status = "high_confidence_candidate";
        confidence = Math.min(confidence, 95);
        requiresHumanReview = false;
    } else {
        status = "manual_review_required";
        requiresHumanReview = true;
        reviewReasons.push("insufficient_independent_evidence");
    }

    return {
        status,
        confidence,
        evidence: evidenceItems,
        conflicts,
        reviewReasons,
        requiresHumanReview
    };
}

function reviewPriority(assessment) {
    if (assessment.status === "conflicting_identity") return 100;
    if (assessment.status === "unresolved") return 95;
    let priority = assessment.requiresHumanReview ? 50 : 0;
    if (assessment.reviewReasons?.includes("multiple_exact_name_profiles")) priority += 30;
    if (assessment.reviewReasons?.includes("returned_name_difference")) priority += 15;
    if (assessment.reviewReasons?.includes("punctuation_or_symbol_risk")) priority += 10;
    if (assessment.reviewReasons?.includes("short_or_common_name_without_verified_id")) priority += 5;
    return Math.min(priority, 100);
}

module.exports = { SCORE_RULES, STATUS_THRESHOLDS, assessIdentity, reviewPriority };
