const test = require("node:test");
const assert = require("node:assert/strict");
const { assessIdentity, reviewPriority } = require("../lib/identity-confidence");

function record(options = {}) {
    const name = options.name || "Safe Artist";
    return {
        rank: options.rank || 1,
        monthlyListeners: options.monthlyListeners || 1,
        artistNameRaw: name,
        spotifyIdentityReview: {
            candidateMatch: options.noCandidate ? null : {
                returnedArtistName: options.returnedName || name,
                spotifyArtistId: options.spotifyId || "candidate-id",
                imageUrl: options.image === false ? "" : "image"
            },
            alternateExactMatches: options.alternates || [],
            ambiguityReasons: options.ambiguityReasons || [],
            existingMusicRollSpotifyIdOverlap: { exists: options.verified === true }
        }
    };
}

test("existing verified ID is authoritative despite short name", () => {
    const assessment = assessIdentity(record({ name: "SZA", verified: true, ambiguityReasons: ["short_or_single_token_name"] }));
    assert.equal(assessment.status, "verified_existing");
    assert.equal(assessment.confidence, 100);
    assert.equal(assessment.requiresHumanReview, false);
    assert.deepEqual(assessment.reviewReasons, []);
});

test("unique exact multi-word candidate can be high confidence but not verified", () => {
    const assessment = assessIdentity(record());
    assert.equal(assessment.status, "high_confidence_candidate");
    assert.equal(assessment.confidence, 95);
    assert.equal(assessment.requiresHumanReview, false);
});

test("genuine name risks remain in manual review even with a high raw score", () => {
    const assessment = assessIdentity(record({ name: "Future", ambiguityReasons: ["short_or_single_token_name"] }));
    assert.equal(assessment.status, "manual_review_required");
    assert.equal(assessment.confidence, 79);
    assert.equal(assessment.requiresHumanReview, true);
});

test("multiple exact candidates remain in manual review", () => {
    const assessment = assessIdentity(record({
        name: "Disney",
        alternates: [{ spotifyArtistId: "alternate" }],
        ambiguityReasons: ["multiple_normalized_exact_matches"]
    }));
    assert.equal(assessment.status, "manual_review_required");
    assert.ok(assessment.reviewReasons.includes("multiple_exact_name_profiles"));
});

test("conflicting evidence cannot produce high confidence", () => {
    const assessment = assessIdentity(record(), { duplicateSpotifyId: { alsoUsedBy: "Another Artist" } });
    assert.equal(assessment.status, "conflicting_identity");
    assert.ok(assessment.confidence <= 49);
    assert.equal(reviewPriority(assessment), 100);
});

test("unresolved identities remain unresolved", () => {
    const assessment = assessIdentity(record({ noCandidate: true }));
    assert.equal(assessment.status, "unresolved");
    assert.equal(assessment.confidence, 0);
});

test("rank and monthly listeners do not affect identity confidence", () => {
    const first = assessIdentity(record({ rank: 1, monthlyListeners: 100000000 }));
    const second = assessIdentity(record({ rank: 200, monthlyListeners: 1000 }));
    assert.equal(first.confidence, second.confidence);
    assert.equal(first.status, second.status);
    assert.ok(first.evidence.some(item => item.type === "monthly_listener_rank" && item.points === 0));
});
