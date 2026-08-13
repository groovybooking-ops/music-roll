const { normalizeArtistName } = require("./spotify-client");

function formatCandidate(artist) {
    return {
        returnedArtistName: artist.name,
        spotifyArtistId: artist.id,
        spotifyArtistUrl: artist.spotifyUrl,
        imageUrl: artist.imageUrl
    };
}

function ambiguityReasons(record, exactMatches) {
    const reasons = [];
    const name = record.artistNameRaw;
    const words = name.trim().split(/\s+/);
    if (words.length === 1 || name.trim().length <= 4) reasons.push("short_or_single_token_name");
    if (/[^\p{L}\p{N}\s]/u.test(name)) reasons.push("punctuation_or_symbol_difference_risk");
    if (exactMatches.length > 1) reasons.push("multiple_normalized_exact_matches");
    if (exactMatches[0] && exactMatches[0].name !== name) reasons.push("spotify_returned_name_differs");
    return reasons;
}

function enrichRecord(record, searchResult, musicRollBySpotifyId) {
    const exactMatches = searchResult.exactMatches || [];
    if (!exactMatches.length) {
        return {
            ...record,
            spotifyIdentityReview: {
                status: "unresolved",
                candidateMatch: null,
                ambiguityReasons: ["no_normalized_exact_name_match"],
                possibleMatches: (searchResult.possibleMatches || []).slice(0, 10).map(formatCandidate)
            }
        };
    }
    const selected = exactMatches[0];
    const reasons = ambiguityReasons(record, exactMatches);
    const existing = musicRollBySpotifyId.get(selected.id);
    return {
        ...record,
        spotifyIdentityReview: {
            status: reasons.length ? "ambiguous_candidate" : "candidate",
            candidateMatch: formatCandidate(selected),
            normalizedExactMatch: true,
            finalIdentityVerified: false,
            ambiguityReasons: reasons,
            alternateExactMatches: exactMatches.slice(1).map(formatCandidate),
            existingMusicRollSpotifyIdOverlap: existing ? {
                exists: true,
                name: existing.name,
                genre: existing.genre,
                tier: existing.tier
            } : { exists: false, name: null, genre: null, tier: null }
        }
    };
}

function validatePreservation(sourceRecords, outputRecords) {
    if (sourceRecords.length !== 200 || outputRecords.length !== 200) {
        throw new Error("Identity preview must preserve exactly 200 ranking records.");
    }
    const preservedFields = ["rank", "artistNameRaw", "monthlyListeners", "dailyListenerChange", "peakRank", "peakMonthlyListeners"];
    for (let index = 0; index < 200; index += 1) {
        const source = sourceRecords[index];
        const output = outputRecords[index];
        if (source.rank !== index + 1 || output.rank !== index + 1) throw new Error(`Rank ${index + 1} is missing or reordered.`);
        for (const field of preservedFields) {
            if (source[field] !== output[field]) throw new Error(`Rank ${index + 1} did not preserve ${field}.`);
        }
    }
}

function duplicateSpotifyIds(records) {
    const groups = new Map();
    for (const record of records) {
        const id = record.spotifyIdentityReview?.candidateMatch?.spotifyArtistId;
        if (!id) continue;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push({ rank: record.rank, artistNameRaw: record.artistNameRaw });
    }
    return [...groups.entries()].filter(([, items]) => items.length > 1)
        .map(([spotifyArtistId, recordsWithId]) => ({ spotifyArtistId, records: recordsWithId }));
}

function musicRollIdMap(artists) {
    return new Map(artists.filter(artist => artist.spotifyId).map(artist => [artist.spotifyId, artist]));
}

module.exports = { duplicateSpotifyIds, enrichRecord, musicRollIdMap, validatePreservation };
