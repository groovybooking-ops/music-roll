const crypto = require("crypto");

const CANDIDATE_ID_PATTERN = /^mr_candidate_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_ID_PATTERN = /^mr_candidate_event_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SPOTIFY_ID_PATTERN = /^[A-Za-z0-9]{22}$/;
const MUSIC_ROLL_ID_PATTERN = /^mr_artist_[0-9]{6}$/;

const LIFECYCLE_STATES = Object.freeze([
    "discovered",
    "identity_discovery_pending",
    "identity_discovering",
    "identity_pending",
    "identity_resolving",
    "identity_coherent",
    "enrichment_pending",
    "enriching",
    "validation_pending",
    "needs_review",
    "conflicting_identity",
    "failed_match",
    "duplicate",
    "retry_wait",
    "ready_for_live",
    "approved",
    "migration_pending",
    "migrated",
    "rejected",
    "failed"
]);

const SOURCE_TYPES = Object.freeze([
    "manual_curated_list",
    "playlist",
    "chart",
    "festival_lineup",
    "venue_calendar",
    "ticketmaster_event",
    "public_music_database",
    "related_artist",
    "local_scene_submission"
]);

const ACTOR_TYPES = Object.freeze(["system", "command", "worker", "human"]);
const EVENT_TYPES = Object.freeze(["candidate_discovered", "state_transition", "discovery_attached", "candidate_identifier_attached"]);
const IDENTITY_OUTCOMES = Object.freeze([
    "coherent_identity_evidence",
    "coherent_identity_with_same_name_ambiguity",
    "provider_profile_multiplicity",
    "insufficient_corroboration",
    "semantic_identity_conflict",
    "unresolved_identity"
]);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function validTimestamp(value) {
    return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function normalizeArtistName(value) {
    return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function spotifyIdFromUrl(value) {
    if (value == null || value === "") return null;
    const match = String(value).match(/^https:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]{22})(?:[/?#].*)?$/);
    return match?.[1] || null;
}

function uuidV7(now = Date.now(), randomBytes = crypto.randomBytes(10)) {
    assert(Number.isInteger(now) && now >= 0 && now <= 0xffffffffffff, "UUIDv7 timestamp is out of range.");
    assert(Buffer.isBuffer(randomBytes) && randomBytes.length >= 10, "UUIDv7 requires ten random bytes.");
    const bytes = Buffer.alloc(16);
    let timestamp = BigInt(now);
    for (let index = 5; index >= 0; index -= 1) {
        bytes[index] = Number(timestamp & 0xffn);
        timestamp >>= 8n;
    }
    bytes[6] = 0x70 | (randomBytes[0] & 0x0f);
    bytes[7] = randomBytes[1];
    bytes[8] = 0x80 | (randomBytes[2] & 0x3f);
    randomBytes.copy(bytes, 9, 3, 10);
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createCandidateId(options = {}) {
    return `mr_candidate_${uuidV7(options.now ?? Date.now(), options.randomBytes)}`;
}

function createEventId(options = {}) {
    return `mr_candidate_event_${uuidV7(options.now ?? Date.now(), options.randomBytes)}`;
}

function discoveryIdFor(discovery) {
    const identity = {
        sourceType: discovery.sourceType,
        sourceName: discovery.sourceName,
        sourceRecordId: discovery.sourceRecordId || null,
        sourceUrl: discovery.sourceUrl || null,
        rawArtistName: discovery.rawArtistName,
        spotifyArtistId: discovery.spotifyArtistId || null,
        spotifyArtistUrl: discovery.spotifyArtistUrl || null,
        assertedMusicRollId: discovery.assertedMusicRollId || null
    };
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

function normalizeDiscovery(input, options = {}) {
    assert(input && typeof input === "object" && !Array.isArray(input), "Discovery must be an object.");
    const sourceType = String(input.sourceType || options.sourceType || "").trim();
    const sourceName = String(input.sourceName || options.sourceName || "").trim();
    const rawArtistName = String(input.rawArtistName || input.artistName || "");
    assert(SOURCE_TYPES.includes(sourceType), `Unsupported discovery source type: ${sourceType || "missing"}.`);
    assert(sourceName, "Discovery source name is required.");
    assert(rawArtistName.trim(), "Discovery raw artist name is required.");

    const suppliedSpotifyId = input.spotifyArtistId == null || input.spotifyArtistId === "" ? null : String(input.spotifyArtistId).trim();
    const suppliedSpotifyUrl = input.spotifyArtistUrl == null || input.spotifyArtistUrl === "" ? null : String(input.spotifyArtistUrl).trim();
    if (suppliedSpotifyId) assert(SPOTIFY_ID_PATTERN.test(suppliedSpotifyId), `Invalid Spotify artist ID: ${suppliedSpotifyId}.`);
    const urlSpotifyId = spotifyIdFromUrl(suppliedSpotifyUrl);
    if (suppliedSpotifyUrl) assert(urlSpotifyId, `Invalid Spotify artist URL: ${suppliedSpotifyUrl}.`);
    if (suppliedSpotifyId && urlSpotifyId) assert(suppliedSpotifyId === urlSpotifyId, "Spotify artist ID and URL disagree.");

    const assertedMusicRollId = input.assertedMusicRollId || input.musicRollId || null;
    if (assertedMusicRollId != null && assertedMusicRollId !== "") {
        assert(MUSIC_ROLL_ID_PATTERN.test(String(assertedMusicRollId)), `Invalid asserted Music Roll ID: ${assertedMusicRollId}.`);
    }
    const discoveredAt = input.discoveredAt || options.discoveredAt || new Date().toISOString();
    assert(validTimestamp(discoveredAt), "Discovery timestamp must be valid ISO-8601.");
    const normalized = {
        discoveryId: null,
        sourceType,
        sourceName,
        sourceRecordId: input.sourceRecordId == null || input.sourceRecordId === "" ? null : String(input.sourceRecordId),
        sourceUrl: input.sourceUrl == null || input.sourceUrl === "" ? null : String(input.sourceUrl),
        rawArtistName,
        normalizedArtistName: normalizeArtistName(rawArtistName),
        spotifyArtistId: suppliedSpotifyId || urlSpotifyId,
        spotifyArtistUrl: suppliedSpotifyUrl,
        assertedMusicRollId: assertedMusicRollId ? String(assertedMusicRollId) : null,
        discoveredAt: new Date(discoveredAt).toISOString()
    };
    normalized.discoveryId = discoveryIdFor(normalized);
    return normalized;
}

function validateDiscovery(discovery) {
    assert(discovery && typeof discovery === "object", "Candidate discovery is required.");
    assert(/^sha256:[0-9a-f]{64}$/.test(discovery.discoveryId || ""), "Invalid discovery ID.");
    assert(SOURCE_TYPES.includes(discovery.sourceType), "Invalid discovery source type.");
    assert(typeof discovery.sourceName === "string" && discovery.sourceName.trim(), "Discovery source name is required.");
    assert(typeof discovery.rawArtistName === "string" && discovery.rawArtistName.trim(), "Discovery raw artist name is required.");
    assert(discovery.normalizedArtistName === normalizeArtistName(discovery.rawArtistName), "Discovery normalized artist name drifted.");
    assert(validTimestamp(discovery.discoveredAt), "Discovery timestamp is invalid.");
    if (discovery.spotifyArtistId != null) assert(SPOTIFY_ID_PATTERN.test(discovery.spotifyArtistId), "Discovery Spotify ID is invalid.");
    if (discovery.spotifyArtistUrl != null) {
        const urlId = spotifyIdFromUrl(discovery.spotifyArtistUrl);
        assert(urlId, "Discovery Spotify URL is invalid.");
        assert(!discovery.spotifyArtistId || urlId === discovery.spotifyArtistId, "Discovery Spotify ID and URL disagree.");
    }
    if (discovery.assertedMusicRollId != null) assert(MUSIC_ROLL_ID_PATTERN.test(discovery.assertedMusicRollId), "Discovery Music Roll ID is invalid.");
    assert(discovery.discoveryId === discoveryIdFor(discovery), "Discovery idempotency key does not match its source fields.");
    return true;
}

function validateConfidence(dimension, label) {
    assert(dimension && typeof dimension === "object", `${label} confidence is required.`);
    assert(dimension.value == null || (Number.isFinite(dimension.value) && dimension.value >= 0 && dimension.value <= 100), `${label} confidence must be null or 0-100.`);
    assert(Array.isArray(dimension.evidenceRefs), `${label} confidence evidenceRefs must be an array.`);
}

function validateIdentifierAttachment(attachment) {
    assert(attachment && typeof attachment === "object" && !Array.isArray(attachment), "Candidate identifier attachment is invalid.");
    assert(attachment.provider === "spotify" && attachment.entityType === "artist", "Only Spotify artist identifier attachments are supported.");
    assert(SPOTIFY_ID_PATTERN.test(attachment.value || ""), "Attached Spotify artist ID is invalid.");
    assert(spotifyIdFromUrl(attachment.url) === attachment.value, "Attached Spotify artist URL and ID disagree.");
    assert(/^sha256:[0-9a-f]{64}$/.test(attachment.bridgeEvidenceId || ""), "Identifier attachment bridge evidence ID is invalid.");
    if (attachment.attachedAt != null) assert(validTimestamp(attachment.attachedAt), "Identifier attachment timestamp is invalid.");
    if (attachment.actor != null) assert(ACTOR_TYPES.includes(attachment.actor.type) && typeof attachment.actor.id === "string" && attachment.actor.id.trim(), "Identifier attachment actor is invalid.");
    if (attachment.evidenceRefs != null) assert(Array.isArray(attachment.evidenceRefs) && attachment.evidenceRefs.every(value => typeof value === "string" && value.trim()), "Identifier attachment evidence references are invalid.");
    return true;
}

function validateCandidate(candidate) {
    assert(candidate?.schemaVersion === 1, "Candidate schemaVersion must be 1.");
    assert(CANDIDATE_ID_PATTERN.test(candidate.candidateId || ""), "Invalid durable candidate ID.");
    assert(Number.isInteger(candidate.revision) && candidate.revision >= 1, "Candidate revision must be a positive integer.");
    assert(LIFECYCLE_STATES.includes(candidate.state), `Invalid candidate lifecycle state: ${candidate.state}.`);
    assert(validTimestamp(candidate.createdAt) && validTimestamp(candidate.updatedAt) && validTimestamp(candidate.stateEnteredAt), "Candidate timestamps are invalid.");
    assert(candidate.name?.normalized === normalizeArtistName(candidate.name?.raw), "Candidate normalized name drifted.");
    assert(Array.isArray(candidate.discoveries) && candidate.discoveries.length > 0, "Candidate requires at least one discovery.");
    candidate.discoveries.forEach(validateDiscovery);
    assert(new Set(candidate.discoveries.map(item => item.discoveryId)).size === candidate.discoveries.length, "Candidate contains duplicate discovery occurrences.");
    assert(candidate.discoveryAssociations == null || Array.isArray(candidate.discoveryAssociations), "Candidate discoveryAssociations must be an array when supplied.");
    for (const association of candidate.discoveryAssociations || []) {
        assert(/^sha256:[0-9a-f]{64}$/.test(association.occurrenceId || ""), "Candidate discovery occurrence ID is invalid.");
        assert(typeof association.evidenceRef === "string" && association.evidenceRef.trim(), "Candidate discovery association evidence reference is required.");
        assert(/^[a-z][a-z0-9_]*$/.test(association.provider || ""), "Candidate discovery association provider is invalid.");
        assert(typeof association.providerEntityKey === "string" && association.providerEntityKey.trim(), "Candidate discovery provider entity key is required.");
    }
    assert(new Set((candidate.discoveryAssociations || []).map(item => item.occurrenceId)).size === (candidate.discoveryAssociations || []).length, "Candidate contains duplicate discovery association occurrences.");
    const spotifyId = candidate.candidateIdentifiers?.spotifyArtistId;
    if (spotifyId != null) assert(SPOTIFY_ID_PATTERN.test(spotifyId), "Candidate Spotify ID is invalid.");
    if (candidate.candidateIdentifiers?.assertedMusicRollId != null) assert(MUSIC_ROLL_ID_PATTERN.test(candidate.candidateIdentifiers.assertedMusicRollId), "Candidate asserted Music Roll ID is invalid.");
    if (candidate.identifierAttachments != null) {
        assert(Array.isArray(candidate.identifierAttachments), "Candidate identifierAttachments must be an array.");
        candidate.identifierAttachments.forEach(validateIdentifierAttachment);
        assert(new Set(candidate.identifierAttachments.map(item => `${item.provider}:${item.entityType}:${item.value}`)).size === candidate.identifierAttachments.length, "Candidate contains duplicate identifier attachments.");
    }
    if (candidate.identityDiscovery != null) {
        assert(candidate.identityDiscovery && typeof candidate.identityDiscovery === "object" && !Array.isArray(candidate.identityDiscovery), "Candidate identityDiscovery metadata is invalid.");
        assert(typeof candidate.identityDiscovery.outcome === "string" && candidate.identityDiscovery.outcome.trim(), "Candidate identityDiscovery outcome is required.");
        assert(Array.isArray(candidate.identityDiscovery.evidenceRefs), "Candidate identityDiscovery evidenceRefs must be an array.");
        assert(Array.isArray(candidate.identityDiscovery.providerErrors), "Candidate identityDiscovery providerErrors must be an array.");
        if (candidate.identityDiscovery.resolvedAt != null) assert(validTimestamp(candidate.identityDiscovery.resolvedAt), "Candidate identityDiscovery resolvedAt is invalid.");
    }
    validateConfidence(candidate.resolvedIdentity?.identityConfidence, "Identity");
    validateConfidence(candidate.editorial?.stageConfidence, "Stage");
    validateConfidence(candidate.geography?.geoConfidence, "Geography");
    assert(Array.isArray(candidate.resolvedIdentity.evidenceRefs), "Identity evidenceRefs must be an array.");
    assert(IDENTITY_OUTCOMES.includes(candidate.resolvedIdentity.outcome), "Candidate identity outcome is invalid.");
    assert(Array.isArray(candidate.resolvedIdentity.provenanceClaims), "Candidate identity provenanceClaims must be an array.");
    assert(Array.isArray(candidate.resolvedIdentity.providerErrors), "Candidate identity providerErrors must be an array.");
    if (candidate.resolvedIdentity.resolvedAt != null) assert(validTimestamp(candidate.resolvedIdentity.resolvedAt), "Candidate identity resolvedAt is invalid.");
    assert(Array.isArray(candidate.warnings), "Candidate warnings must be an array.");
    assert(["not_duplicate", "existing_live_artist", "queued_candidate"].includes(candidate.duplicate?.status), "Candidate duplicate status is invalid.");
    if (candidate.duplicate.duplicateOfCandidateId != null) assert(CANDIDATE_ID_PATTERN.test(candidate.duplicate.duplicateOfCandidateId), "Candidate duplicate reference is invalid.");
    if (candidate.duplicate.existingMusicRollId != null) assert(MUSIC_ROLL_ID_PATTERN.test(candidate.duplicate.existingMusicRollId), "Candidate existing Music Roll reference is invalid.");
    if (candidate.state === "duplicate") assert(candidate.duplicate.status !== "not_duplicate", "Duplicate state requires exact duplicate evidence.");
    assert(["not_approved", "approved"].includes(candidate.approval?.status), "Candidate approval status is invalid.");
    if (["approved", "migration_pending", "migrated"].includes(candidate.state)) assert(candidate.approval.status === "approved", `${candidate.state} requires an approval decision.`);
    assert(["not_reserved", "reserved", "promoted", "released"].includes(candidate.musicRollIdReservation?.status), "Candidate Music Roll ID reservation status is invalid.");
    if (candidate.musicRollIdReservation.proposedMusicRollId != null) assert(MUSIC_ROLL_ID_PATTERN.test(candidate.musicRollIdReservation.proposedMusicRollId), "Candidate proposed Music Roll ID is invalid.");
    assert(candidate.processing?.attemptsByStep && typeof candidate.processing.attemptsByStep === "object", "Candidate processing attempts are invalid.");
    assert(Object.values(candidate.processing.attemptsByStep).every(value => Number.isInteger(value) && value >= 0), "Candidate processing attempt counts must be non-negative integers.");
    if (candidate.processing.lease != null) {
        assert(EVENT_ID_PATTERN.test(candidate.processing.lease.leaseId || ""), "Candidate processing lease ID is invalid.");
        assert(typeof candidate.processing.lease.workerId === "string" && candidate.processing.lease.workerId.trim(), "Candidate processing lease worker is invalid.");
        assert(validTimestamp(candidate.processing.lease.acquiredAt) && validTimestamp(candidate.processing.lease.expiresAt), "Candidate processing lease timestamps are invalid.");
        assert(Number.isInteger(candidate.processing.lease.startingRevision) && candidate.processing.lease.startingRevision >= 1, "Candidate processing lease revision is invalid.");
    }
    if (candidate.processing.retryAt != null) assert(validTimestamp(candidate.processing.retryAt), "Candidate retryAt is invalid.");
    assert(EVENT_ID_PATTERN.test(candidate.lastEventId || ""), "Candidate lastEventId is invalid.");
    return true;
}

function validateCandidateEvent(event) {
    assert(event?.schemaVersion === 1, "Candidate event schemaVersion must be 1.");
    assert(EVENT_ID_PATTERN.test(event.eventId || ""), "Invalid candidate event ID.");
    assert(CANDIDATE_ID_PATTERN.test(event.candidateId || ""), "Candidate event has an invalid candidate ID.");
    assert(EVENT_TYPES.includes(event.eventType), `Invalid candidate event type: ${event.eventType}.`);
    assert(event.previousState == null || LIFECYCLE_STATES.includes(event.previousState), "Candidate event previousState is invalid.");
    assert(LIFECYCLE_STATES.includes(event.nextState), "Candidate event nextState is invalid.");
    assert(Number.isInteger(event.previousRevision) && event.previousRevision >= 0, "Candidate event previousRevision is invalid.");
    assert(event.candidateRevision === event.previousRevision + 1, "Candidate event revision is not sequential.");
    assert(/^[a-z0-9_]+$/.test(event.reasonCode || ""), "Candidate event reasonCode is invalid.");
    assert(ACTOR_TYPES.includes(event.actor?.type) && typeof event.actor.id === "string" && event.actor.id.trim(), "Candidate event actor is invalid.");
    assert(validTimestamp(event.occurredAt), "Candidate event timestamp is invalid.");
    assert(Array.isArray(event.evidenceRefs) && event.evidenceRefs.every(value => typeof value === "string" && value.trim()), "Candidate event evidenceRefs are invalid.");
    assert(event.payload && typeof event.payload === "object" && !Array.isArray(event.payload), "Candidate event payload must be an object.");
    if (event.eventType === "candidate_discovered") {
        assert(event.previousState === null && event.previousRevision === 0 && event.nextState === "discovered", "Initial candidate event must transition null to discovered at revision 1.");
        validateDiscovery(event.payload.discovery);
    } else if (event.eventType === "discovery_attached") {
        assert(event.previousState === event.nextState, "Discovery attachment must not change lifecycle state.");
        validateDiscovery(event.payload.discovery);
        assert(/^sha256:[0-9a-f]{64}$/.test(event.payload.discoveryAssociation?.occurrenceId || ""), "Discovery attachment occurrence ID is invalid.");
        assert(typeof event.payload.discoveryAssociation?.evidenceRef === "string" && event.payload.discoveryAssociation.evidenceRef.trim(), "Discovery attachment evidence reference is required.");
    } else if (event.eventType === "candidate_identifier_attached") {
        assert(event.previousState === event.nextState, "Identifier attachment must not change lifecycle state.");
        validateIdentifierAttachment(event.payload.identifier);
    } else {
        assert(event.previousState != null, "State transition events require a previous state.");
    }
    return true;
}

module.exports = {
    ACTOR_TYPES,
    CANDIDATE_ID_PATTERN,
    EVENT_ID_PATTERN,
    EVENT_TYPES,
    IDENTITY_OUTCOMES,
    LIFECYCLE_STATES,
    MUSIC_ROLL_ID_PATTERN,
    SOURCE_TYPES,
    SPOTIFY_ID_PATTERN,
    createCandidateId,
    createEventId,
    discoveryIdFor,
    normalizeArtistName,
    normalizeDiscovery,
    spotifyIdFromUrl,
    uuidV7,
    validateCandidate,
    validateCandidateEvent,
    validateDiscovery,
    validateIdentifierAttachment
};
