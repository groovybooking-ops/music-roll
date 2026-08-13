const crypto = require("crypto");

const ARTIST_ID_PATTERN = /^mr_artist_[0-9]{6}$/;
const EVENT_ID_PATTERN = /^mr_event_[0-9]{6}$/;
const EVIDENCE_ID_PATTERN = /^mr_evidence_[0-9]{6}$/;
const ALLOWED_STAGES = new Set(["underground", "emerging", "mainstream", "legacy", "classic"]);
const GEOGRAPHY_CONFIDENCE = new Set(["unknown", "reported", "corroborated", "verified", "conflicting"]);
const EVIDENCE_TYPES = new Set(["identity", "mainstream", "catalog", "geographic", "user_engagement"]);
const EXTERNAL_PROVIDERS = new Set(["spotify", "musicbrainz", "ticketmaster", "bandsintown", "appleMusic"]);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function canonicalMappings(mappings) {
    return mappings.map(({ musicRollId, spotifyId }) => ({ musicRollId, spotifyId }));
}

function mappingsChecksum(mappings) {
    return crypto.createHash("sha256").update(JSON.stringify(canonicalMappings(mappings))).digest("hex");
}

function validateRegistry(registry, liveArtists = []) {
    assert(registry?.schemaVersion === 1 && Array.isArray(registry.mappings), "Invalid artist ID registry.");
    const ids = new Set();
    const spotifyIds = new Set();
    for (const mapping of registry.mappings) {
        assert(ARTIST_ID_PATTERN.test(mapping.musicRollId), `Invalid Music Roll ID: ${mapping.musicRollId}.`);
        assert(typeof mapping.spotifyId === "string" && mapping.spotifyId, `Registry ${mapping.musicRollId} lacks its verified Spotify binding.`);
        assert(!ids.has(mapping.musicRollId), `Duplicate Music Roll ID: ${mapping.musicRollId}.`);
        assert(!spotifyIds.has(mapping.spotifyId), `Spotify ID maps to multiple Music Roll IDs: ${mapping.spotifyId}.`);
        ids.add(mapping.musicRollId);
        spotifyIds.add(mapping.spotifyId);
    }
    assert(mappingsChecksum(registry.mappings) === registry.mappingsSha256, "Artist ID registry mapping checksum changed unexpectedly.");
    if (liveArtists.length) {
        assert(liveArtists.length === registry.mappings.length, "Registry and live artist counts differ.");
        const liveSpotifyIds = new Set(liveArtists.map(artist => artist.spotifyId));
        for (const mapping of registry.mappings) {
            assert(liveSpotifyIds.has(mapping.spotifyId), `Registry Spotify binding is absent from live data: ${mapping.spotifyId}.`);
        }
    }
    return true;
}

function validateExternalIds(externalIds) {
    assert(externalIds && typeof externalIds === "object" && !Array.isArray(externalIds), "externalIds must be an object.");
    for (const [provider, value] of Object.entries(externalIds)) {
        assert(EXTERNAL_PROVIDERS.has(provider), `Unknown external ID provider: ${provider}.`);
        assert(typeof value === "string" && value.trim(), `Unknown ${provider} IDs must be omitted, not blank or null.`);
    }
}

function validateCoordinates(home) {
    if (home.coordinates == null) return;
    assert(home.city && home.country, "Coordinates require an identified city and country.");
    const { latitude, longitude } = home.coordinates;
    assert(Number.isFinite(latitude) && latitude >= -90 && latitude <= 90, "Invalid geographic latitude.");
    assert(Number.isFinite(longitude) && longitude >= -180 && longitude <= 180, "Invalid geographic longitude.");
}

function validTimestamp(value) {
    return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function validateArtistV2(artist) {
    assert(artist?.schemaVersion === 2, "Artist schemaVersion must be 2.");
    assert(ARTIST_ID_PATTERN.test(artist.musicRollId), `Invalid Music Roll ID: ${artist.musicRollId}.`);
    assert(ALLOWED_STAGES.has(artist.editorial?.stage), `Invalid artist stage: ${artist.editorial?.stage}.`);
    assert(artist.editorial.stageConfidence == null || (Number.isFinite(artist.editorial.stageConfidence) && artist.editorial.stageConfidence >= 0 && artist.editorial.stageConfidence <= 100), "stageConfidence must be null or 0-100.");
    assert(Array.isArray(artist.genres) && artist.genres.length > 0 && artist.genres.every(value => typeof value === "string" && value.trim()), "genres must be a non-empty string array.");
    assert(new Set(artist.genres).size === artist.genres.length, "genres must not contain duplicates.");
    assert(artist.genre === artist.primaryGenre, "Compatibility invariant failed: genre !== primaryGenre.");
    assert(artist.genres[0] === artist.primaryGenre, "Compatibility invariant failed: genres[0] !== primaryGenre.");
    assert(artist.tier === artist.editorial.stage, "Compatibility invariant failed: tier !== editorial.stage.");
    validateExternalIds(artist.externalIds);
    if (Object.keys(artist.externalIds).some(provider => provider !== "spotify")) {
        assert(Array.isArray(artist.evidence?.identity) && artist.evidence.identity.length > 0, "Non-Spotify provider IDs require identity evidence references.");
    }
    assert(artist.externalIds.spotify && artist.spotifyId === artist.externalIds.spotify, "Compatibility invariant failed: spotifyId !== externalIds.spotify.");
    assert(artist.spotify === artist.externalUrls?.spotify, "Compatibility invariant failed: spotify !== externalUrls.spotify.");
    assert(artist.image === artist.media?.primaryImageUrl, "Compatibility invariant failed: image !== media.primaryImageUrl.");
    assert(GEOGRAPHY_CONFIDENCE.has(artist.geography?.confidence), `Invalid geography confidence: ${artist.geography?.confidence}.`);
    validateCoordinates(artist.geography.home || {});
    if (artist.geography.home?.coordinates != null) {
        assert(["corroborated", "verified"].includes(artist.geography.confidence), "Coordinates require corroborated or verified geographic confidence.");
        assert(Array.isArray(artist.geography.evidenceRefs) && artist.geography.evidenceRefs.length > 0, "Coordinates require geographic provenance.");
    }
    assert(Array.isArray(artist.geography.sceneAssociations), "sceneAssociations must be an array.");
    return true;
}

function validateArtistDirectoryV2(artists) {
    assert(Array.isArray(artists) && artists.length > 0, "Artist v2 directory must be a non-empty array.");
    const ids = new Set();
    for (const artist of artists) {
        validateArtistV2(artist);
        assert(!ids.has(artist.musicRollId), `Duplicate Music Roll ID: ${artist.musicRollId}.`);
        ids.add(artist.musicRollId);
    }
    return true;
}

function validateEventV1(event) {
    assert(event?.schemaVersion === 1 && EVENT_ID_PATTERN.test(event.musicRollEventId), "Invalid event identity or schema version.");
    assert(Array.isArray(event.musicRollArtistIds) && event.musicRollArtistIds.length > 0, "Event must reference at least one artist.");
    assert(event.musicRollArtistIds.every(id => ARTIST_ID_PATTERN.test(id)), "Event contains an invalid Music Roll artist ID.");
    assert(typeof event.provider === "string" && event.provider.trim(), "Event provider is required.");
    assert(typeof event.externalEventId === "string" && event.externalEventId.trim(), "Unknown external event IDs must be omitted; imported events require the known provider ID.");
    assert(validTimestamp(event.startsAt), "Event startsAt must be a valid timestamp.");
    assert(validTimestamp(event.retrievedAt), "Event retrievedAt must be a valid timestamp.");
    assert(event.sourceProvenance && typeof event.sourceProvenance === "object", "Event source provenance is required.");
    validateCoordinates(event.location || {});
    return true;
}

function validateEvidenceV1(record) {
    assert(record?.schemaVersion === 1 && EVIDENCE_ID_PATTERN.test(record.evidenceId), "Invalid evidence identity or schema version.");
    assert(ARTIST_ID_PATTERN.test(record.musicRollArtistId), "Evidence contains an invalid Music Roll artist ID.");
    assert(EVIDENCE_TYPES.has(record.evidenceType), `Invalid evidence type: ${record.evidenceType}.`);
    assert(typeof record.sourceClass === "string" && record.sourceClass.trim(), "Evidence sourceClass is required.");
    assert(validTimestamp(record.observedAt), "Evidence observedAt must be a valid timestamp.");
    assert(record.payload && typeof record.payload === "object" && !Array.isArray(record.payload), "Evidence payload must be an object.");
    assert(["review_only", "reviewed", "verified", "conflicting", "rejected"].includes(record.reviewStatus), "Invalid evidence reviewStatus.");
    return true;
}

module.exports = {
    ALLOWED_STAGES, EVIDENCE_TYPES, EXTERNAL_PROVIDERS, GEOGRAPHY_CONFIDENCE,
    mappingsChecksum, validateArtistDirectoryV2, validateArtistV2, validateEventV1,
    validateEvidenceV1, validateRegistry
};
