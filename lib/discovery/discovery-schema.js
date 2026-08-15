const crypto = require("crypto");
const {
    CANDIDATE_ID_PATTERN,
    MUSIC_ROLL_ID_PATTERN,
    SOURCE_TYPES,
    SPOTIFY_ID_PATTERN,
    normalizeArtistName,
    spotifyIdFromUrl
} = require("../ingestion/candidate-schema");

const OCCURRENCE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ASSOCIATION_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ENTITY_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    return value;
}

function digest(value) {
    return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function optionalString(value) {
    return value == null || value === "" ? null : String(value).trim() || null;
}

function validTimestamp(value) {
    return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function occurrenceIdentity(occurrence) {
    return {
        provider: occurrence.provider,
        sourceType: occurrence.sourceType,
        sourceName: occurrence.sourceName,
        sourceRecordId: occurrence.sourceRecordId,
        sourceUrl: occurrence.sourceUrl,
        providerEntity: {
            type: occurrence.providerEntity.type,
            id: occurrence.providerEntity.id
        }
    };
}

function occurrenceIdFor(occurrence) {
    return `sha256:${digest(occurrenceIdentity(occurrence))}`;
}

function normalizeBridge(bridge) {
    const normalized = {
        targetProvider: String(bridge?.targetProvider || "").trim().toLocaleLowerCase(),
        targetEntityType: String(bridge?.targetEntityType || "").trim().toLocaleLowerCase(),
        targetId: String(bridge?.targetId || "").trim(),
        relationshipType: String(bridge?.relationshipType || "").trim(),
        assertedByProvider: String(bridge?.assertedByProvider || "").trim().toLocaleLowerCase(),
        evidenceRef: String(bridge?.evidenceRef || "").trim()
    };
    assert(PROVIDER_PATTERN.test(normalized.targetProvider), "Discovery bridge target provider is invalid.");
    assert(ENTITY_PART_PATTERN.test(normalized.targetEntityType), "Discovery bridge target entity type is invalid.");
    assert(ENTITY_PART_PATTERN.test(normalized.targetId), "Discovery bridge target ID is invalid.");
    assert(/^[a-z][a-z0-9_]*$/.test(normalized.relationshipType), "Discovery bridge relationship type is invalid.");
    assert(PROVIDER_PATTERN.test(normalized.assertedByProvider), "Discovery bridge asserting provider is invalid.");
    assert(normalized.evidenceRef, "Discovery bridge evidence reference is required.");
    if (normalized.targetProvider === "spotify" && normalized.targetEntityType === "artist") {
        assert(SPOTIFY_ID_PATTERN.test(normalized.targetId), "Discovery bridge Spotify artist ID is invalid.");
    }
    return normalized;
}

function normalizeDiscoveryOccurrence(input, options = {}) {
    assert(input && typeof input === "object" && !Array.isArray(input), "Discovery occurrence must be an object.");
    const provider = String(input.provider || input.sourceProvider || "").trim().toLocaleLowerCase();
    const sourceType = String(input.sourceType || "").trim();
    const sourceName = String(input.sourceName || "").trim();
    const sourceRecordId = String(input.sourceRecordId || "").trim();
    const rawArtistName = String(input.rawArtistName || input.artistName || "");
    assert(PROVIDER_PATTERN.test(provider), "Discovery occurrence provider is invalid.");
    assert(SOURCE_TYPES.includes(sourceType), `Unsupported discovery occurrence source type: ${sourceType || "missing"}.`);
    assert(sourceName, "Discovery occurrence source name is required.");
    assert(sourceRecordId, "Discovery occurrence source record ID is required.");
    assert(rawArtistName.trim(), "Discovery occurrence artist name is required.");

    const entity = input.providerEntity || {};
    const entityType = String(entity.type || "").trim().toLocaleLowerCase();
    const entityId = String(entity.id || "").trim();
    assert(ENTITY_PART_PATTERN.test(entityType), "Discovery provider entity type is invalid.");
    assert(ENTITY_PART_PATTERN.test(entityId), "Discovery provider entity ID is invalid.");
    const legacyIds = [...new Set((entity.legacyIds || []).map(value => String(value).trim()).filter(Boolean))];
    assert(legacyIds.every(value => ENTITY_PART_PATTERN.test(value)), "Discovery provider legacy ID is invalid.");

    const trusted = input.trustedIdentifiers || {};
    const spotifyArtistId = optionalString(trusted.spotifyArtistId);
    const spotifyArtistUrl = optionalString(trusted.spotifyArtistUrl);
    const assertedMusicRollId = optionalString(trusted.musicRollId || trusted.assertedMusicRollId);
    if (spotifyArtistId) assert(SPOTIFY_ID_PATTERN.test(spotifyArtistId), "Discovery occurrence Spotify artist ID is invalid.");
    if (spotifyArtistUrl) {
        const urlId = spotifyIdFromUrl(spotifyArtistUrl);
        assert(urlId, "Discovery occurrence Spotify artist URL is invalid.");
        assert(!spotifyArtistId || urlId === spotifyArtistId, "Discovery occurrence Spotify ID and URL disagree.");
    }
    if (assertedMusicRollId) assert(MUSIC_ROLL_ID_PATTERN.test(assertedMusicRollId), "Discovery occurrence Music Roll ID is invalid.");
    const discoveredAt = input.discoveredAt || options.clock?.() || new Date().toISOString();
    assert(validTimestamp(discoveredAt), "Discovery occurrence timestamp is invalid.");

    const occurrence = {
        schemaVersion: 1,
        occurrenceId: null,
        provider,
        sourceType,
        sourceName,
        sourceRecordId,
        sourceUrl: optionalString(input.sourceUrl),
        artist: {
            rawName: rawArtistName,
            normalizedName: normalizeArtistName(rawArtistName)
        },
        providerEntity: {
            provider,
            type: entityType,
            id: entityId,
            url: optionalString(entity.url),
            legacyIds
        },
        trustedIdentifiers: {
            spotifyArtistId: spotifyArtistId || spotifyIdFromUrl(spotifyArtistUrl),
            spotifyArtistUrl,
            assertedMusicRollId
        },
        exactIdentityBridges: (input.exactIdentityBridges || []).map(normalizeBridge),
        sourceContext: structuredClone(input.sourceContext || {}),
        rawEvidenceRef: optionalString(input.rawEvidenceRef),
        discoveredAt: new Date(discoveredAt).toISOString(),
        reviewOnly: true
    };
    occurrence.occurrenceId = occurrenceIdFor(occurrence);
    validateDiscoveryOccurrence(occurrence);
    return occurrence;
}

function validateDiscoveryOccurrence(occurrence) {
    assert(occurrence?.schemaVersion === 1, "Discovery occurrence schemaVersion must be 1.");
    assert(OCCURRENCE_ID_PATTERN.test(occurrence.occurrenceId || ""), "Discovery occurrence ID is invalid.");
    assert(PROVIDER_PATTERN.test(occurrence.provider || ""), "Discovery occurrence provider is invalid.");
    assert(SOURCE_TYPES.includes(occurrence.sourceType), "Discovery occurrence source type is invalid.");
    assert(typeof occurrence.sourceName === "string" && occurrence.sourceName.trim(), "Discovery occurrence source name is required.");
    assert(typeof occurrence.sourceRecordId === "string" && occurrence.sourceRecordId.trim(), "Discovery occurrence source record ID is required.");
    assert(occurrence.artist?.normalizedName === normalizeArtistName(occurrence.artist?.rawName), "Discovery occurrence normalized artist name drifted.");
    assert(occurrence.providerEntity?.provider === occurrence.provider, "Discovery provider entity provider drifted.");
    assert(ENTITY_PART_PATTERN.test(occurrence.providerEntity?.type || "") && ENTITY_PART_PATTERN.test(occurrence.providerEntity?.id || ""), "Discovery provider entity is invalid.");
    assert(Array.isArray(occurrence.providerEntity.legacyIds), "Discovery provider legacy IDs must be an array.");
    if (occurrence.trustedIdentifiers?.spotifyArtistId) assert(SPOTIFY_ID_PATTERN.test(occurrence.trustedIdentifiers.spotifyArtistId), "Discovery occurrence Spotify ID is invalid.");
    if (occurrence.trustedIdentifiers?.assertedMusicRollId) assert(MUSIC_ROLL_ID_PATTERN.test(occurrence.trustedIdentifiers.assertedMusicRollId), "Discovery occurrence Music Roll ID is invalid.");
    assert(Array.isArray(occurrence.exactIdentityBridges), "Discovery exact bridges must be an array.");
    occurrence.exactIdentityBridges.forEach(normalizeBridge);
    assert(occurrence.sourceContext && typeof occurrence.sourceContext === "object" && !Array.isArray(occurrence.sourceContext), "Discovery source context is invalid.");
    assert(validTimestamp(occurrence.discoveredAt), "Discovery occurrence timestamp is invalid.");
    assert(occurrence.reviewOnly === true, "Discovery occurrences must remain review-only.");
    assert(occurrence.occurrenceId === occurrenceIdFor(occurrence), "Discovery occurrence ID does not match its stable source identity.");
    return true;
}

function providerEntityKey(occurrence) {
    validateDiscoveryOccurrence(occurrence);
    return `${occurrence.provider}:${occurrence.providerEntity.type}:${occurrence.providerEntity.id}`;
}

function associationIdFor({ occurrenceId, targetType, targetId }) {
    return `sha256:${digest({ occurrenceId, targetType, targetId })}`;
}

function createDiscoveryAssociation(input, options = {}) {
    const targetType = String(input.targetType || "").trim();
    const targetId = String(input.targetId || "").trim();
    assert(["candidate", "live_artist"].includes(targetType), "Discovery association target type is invalid.");
    assert(targetType === "candidate" ? CANDIDATE_ID_PATTERN.test(targetId) : MUSIC_ROLL_ID_PATTERN.test(targetId), "Discovery association target ID is invalid.");
    assert(OCCURRENCE_ID_PATTERN.test(input.occurrenceId || ""), "Discovery association occurrence ID is invalid.");
    const createdAt = input.createdAt || options.clock?.() || new Date().toISOString();
    assert(validTimestamp(createdAt), "Discovery association timestamp is invalid.");
    const association = {
        schemaVersion: 1,
        associationId: associationIdFor({ occurrenceId: input.occurrenceId, targetType, targetId }),
        occurrenceId: input.occurrenceId,
        targetType,
        targetId,
        matchedBy: [...new Set((input.matchedBy || []).map(String).filter(Boolean))],
        evidenceRefs: [...new Set((input.evidenceRefs || []).map(String).filter(Boolean))],
        createdAt: new Date(createdAt).toISOString(),
        reviewOnly: true
    };
    validateDiscoveryAssociation(association);
    return association;
}

function validateDiscoveryAssociation(association) {
    assert(association?.schemaVersion === 1, "Discovery association schemaVersion must be 1.");
    assert(ASSOCIATION_ID_PATTERN.test(association.associationId || ""), "Discovery association ID is invalid.");
    assert(OCCURRENCE_ID_PATTERN.test(association.occurrenceId || ""), "Discovery association occurrence ID is invalid.");
    assert(["candidate", "live_artist"].includes(association.targetType), "Discovery association target type is invalid.");
    assert(association.targetType === "candidate" ? CANDIDATE_ID_PATTERN.test(association.targetId) : MUSIC_ROLL_ID_PATTERN.test(association.targetId), "Discovery association target ID is invalid.");
    assert(Array.isArray(association.matchedBy) && Array.isArray(association.evidenceRefs), "Discovery association provenance is invalid.");
    assert(validTimestamp(association.createdAt), "Discovery association timestamp is invalid.");
    assert(association.reviewOnly === true, "Discovery association must remain review-only.");
    assert(association.associationId === associationIdFor(association), "Discovery association ID drifted.");
    return true;
}

module.exports = {
    ASSOCIATION_ID_PATTERN,
    OCCURRENCE_ID_PATTERN,
    associationIdFor,
    createDiscoveryAssociation,
    normalizeDiscoveryOccurrence,
    occurrenceIdFor,
    providerEntityKey,
    validateDiscoveryAssociation,
    validateDiscoveryOccurrence
};
