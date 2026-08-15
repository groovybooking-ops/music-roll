const { normalizeArtistName } = require("./candidate-schema");

const INACTIVE_QUEUE_STATES = new Set(["duplicate", "migrated", "rejected"]);

function warning(code, detail = {}) {
    return { code, ...detail };
}

function duplicatePayload(status, details = {}) {
    return {
        status,
        duplicateOfCandidateId: details.duplicateOfCandidateId || null,
        existingMusicRollId: details.existingMusicRollId || null,
        matchedBy: details.matchedBy || [],
        evidenceRefs: details.evidenceRefs || []
    };
}

function duplicatePreflight({ candidate, candidates = [], permanentRegistry, liveArtists = [] }) {
    if (!candidate?.candidateId) throw new Error("Duplicate preflight requires a candidate.");
    if (permanentRegistry?.schemaVersion !== 1 || !Array.isArray(permanentRegistry.mappings)) throw new Error("Duplicate preflight requires the permanent registry.");
    if (!Array.isArray(liveArtists)) throw new Error("Duplicate preflight live artists must be an array.");

    const spotifyId = candidate.candidateIdentifiers.spotifyArtistId;
    const assertedMusicRollId = candidate.candidateIdentifiers.assertedMusicRollId;
    const byMusicRollId = new Map(permanentRegistry.mappings.map(mapping => [mapping.musicRollId, mapping]));
    const bySpotifyId = new Map(permanentRegistry.mappings.map(mapping => [mapping.spotifyId, mapping]));
    const evidenceRefs = ["data/artist-id-registry.json"];

    if (assertedMusicRollId) {
        const binding = byMusicRollId.get(assertedMusicRollId);
        if (!binding) {
            return {
                nextState: "needs_review",
                reasonCode: "asserted_music_roll_id_not_found",
                duplicate: null,
                warnings: [warning("asserted_music_roll_id_not_found", { assertedMusicRollId })],
                evidenceRefs
            };
        }
        if (spotifyId && binding.spotifyId !== spotifyId) {
            return {
                nextState: "needs_review",
                reasonCode: "existing_music_roll_binding_conflict",
                duplicate: null,
                warnings: [warning("existing_music_roll_binding_conflict", { assertedMusicRollId, registrySpotifyId: binding.spotifyId, candidateSpotifyId: spotifyId })],
                evidenceRefs
            };
        }
        return {
            nextState: "duplicate",
            reasonCode: "existing_music_roll_binding_reused",
            duplicate: duplicatePayload("existing_live_artist", {
                existingMusicRollId: binding.musicRollId,
                matchedBy: ["exact_music_roll_id", ...(spotifyId ? ["exact_spotify_id"] : [])],
                evidenceRefs
            }),
            warnings: [],
            evidenceRefs
        };
    }

    const existingBinding = spotifyId ? bySpotifyId.get(spotifyId) : null;
    if (existingBinding) {
        return {
            nextState: "duplicate",
            reasonCode: "existing_live_spotify_binding_reused",
            duplicate: duplicatePayload("existing_live_artist", {
                existingMusicRollId: existingBinding.musicRollId,
                matchedBy: ["exact_spotify_id"],
                evidenceRefs
            }),
            warnings: [],
            evidenceRefs
        };
    }

    const activeCandidates = candidates.filter(item =>
        item.candidateId !== candidate.candidateId && !INACTIVE_QUEUE_STATES.has(item.state)
    );
    const queuedDuplicate = spotifyId
        ? activeCandidates.find(item => item.candidateIdentifiers?.spotifyArtistId === spotifyId)
        : null;
    if (queuedDuplicate) {
        return {
            nextState: "duplicate",
            reasonCode: "queued_spotify_duplicate_detected",
            duplicate: duplicatePayload("queued_candidate", {
                duplicateOfCandidateId: queuedDuplicate.candidateId,
                matchedBy: ["exact_spotify_id"],
                evidenceRefs: [`candidate:${queuedDuplicate.candidateId}`]
            }),
            warnings: [],
            evidenceRefs: [`candidate:${queuedDuplicate.candidateId}`]
        };
    }

    const normalizedName = candidate.name.normalized;
    const sameNameLive = liveArtists.filter(artist =>
        normalizeArtistName(artist.name || artist.displayName) === normalizedName &&
        (!spotifyId || (artist.externalIds?.spotify || artist.spotifyId) !== spotifyId)
    ).map(artist => ({ musicRollId: artist.musicRollId, spotifyArtistId: artist.externalIds?.spotify || artist.spotifyId || null }));
    const sameNameQueued = activeCandidates.filter(item =>
        item.name?.normalized === normalizedName &&
        (!spotifyId || item.candidateIdentifiers?.spotifyArtistId !== spotifyId)
    ).map(item => ({ candidateId: item.candidateId, spotifyArtistId: item.candidateIdentifiers?.spotifyArtistId || null }));
    const warnings = [];
    if (sameNameLive.length || sameNameQueued.length) {
        warnings.push(warning("normalized_name_collision_warning", {
            note: "Normalized-name agreement is not identity proof and did not trigger a duplicate.",
            liveMatches: sameNameLive,
            queuedMatches: sameNameQueued
        }));
    }
    const nextState = spotifyId ? "identity_pending" : "identity_discovery_pending";
    return {
        nextState,
        reasonCode: spotifyId
            ? (warnings.length ? "identity_queued_with_name_warning" : "identity_queued")
            : (warnings.length ? "identity_discovery_queued_with_name_warning" : "identity_discovery_queued"),
        duplicate: null,
        warnings,
        evidenceRefs: warnings.length ? ["data/artists.json"] : []
    };
}

module.exports = { INACTIVE_QUEUE_STATES, duplicatePreflight };
