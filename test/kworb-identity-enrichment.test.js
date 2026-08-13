const test = require("node:test");
const assert = require("node:assert/strict");
const { duplicateSpotifyIds, enrichRecord, musicRollIdMap, validatePreservation } = require("../lib/kworb-identity-enrichment");

function record(rank, name = `Artist ${rank}`) {
    return { rank, artistNameRaw: name, monthlyListeners: 1000 - rank, dailyListenerChange: rank, peakRank: rank, peakMonthlyListeners: 2000, mainstreamEvidence: { present: true } };
}

function artist(name, id, imageUrl = "image") {
    return { name, id, spotifyUrl: `https://open.spotify.com/artist/${id}`, imageUrl };
}

test("treats normalized exact matches as unverified candidates", () => {
    const result = enrichRecord(record(1, "Artist Name"), {
        exactMatches: [artist("Artist Name", "one")], possibleMatches: []
    }, new Map());
    assert.equal(result.spotifyIdentityReview.status, "candidate");
    assert.equal(result.spotifyIdentityReview.finalIdentityVerified, false);
    assert.equal(result.artistNameRaw, "Artist Name");
});

test("flags short, punctuation-different, and multiple exact identities", () => {
    const result = enrichRecord(record(1, "P!nk"), {
        exactMatches: [artist("P!nk", "one"), artist("P!NK", "two")], possibleMatches: []
    }, new Map());
    assert.equal(result.spotifyIdentityReview.status, "ambiguous_candidate");
    assert.deepEqual(result.spotifyIdentityReview.ambiguityReasons, [
        "short_or_single_token_name",
        "punctuation_or_symbol_difference_risk",
        "multiple_normalized_exact_matches"
    ]);
});

test("preserves unresolved possible matches without selecting one", () => {
    const result = enrichRecord(record(1, "JAŸ-Z"), {
        exactMatches: [], possibleMatches: [artist("JAY-Z", "jay")]
    }, new Map());
    assert.equal(result.spotifyIdentityReview.status, "unresolved");
    assert.equal(result.spotifyIdentityReview.candidateMatch, null);
    assert.equal(result.spotifyIdentityReview.possibleMatches[0].returnedArtistName, "JAY-Z");
});

test("detects duplicate candidate Spotify IDs", () => {
    const first = enrichRecord(record(1, "First Artist"), { exactMatches: [artist("First Artist", "same")], possibleMatches: [] }, new Map());
    const second = enrichRecord(record(2, "Second Artist"), { exactMatches: [artist("Second Artist", "same")], possibleMatches: [] }, new Map());
    assert.equal(duplicateSpotifyIds([first, second]).length, 1);
});

test("reports existing Music Roll Spotify ID overlaps", () => {
    const existing = [{ name: "SZA", genre: "rnb", tier: "mainstream", spotifyId: "sza" }];
    const result = enrichRecord(record(1, "SZA"), { exactMatches: [artist("SZA", "sza")], possibleMatches: [] }, musicRollIdMap(existing));
    assert.equal(result.spotifyIdentityReview.existingMusicRollSpotifyIdOverlap.exists, true);
    assert.equal(result.spotifyIdentityReview.existingMusicRollSpotifyIdOverlap.tier, "mainstream");
});

test("validates preservation of all 200 ranks and ranking fields", () => {
    const source = Array.from({ length: 200 }, (_, index) => record(index + 1));
    const output = source.map(item => ({ ...item, spotifyIdentityReview: { status: "candidate" } }));
    assert.doesNotThrow(() => validatePreservation(source, output));
    output[41].monthlyListeners = 0;
    assert.throws(() => validatePreservation(source, output), /did not preserve monthlyListeners/);
});
