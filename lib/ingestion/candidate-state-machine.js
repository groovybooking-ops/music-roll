const {
    LIFECYCLE_STATES,
    createEventId,
    normalizeArtistName,
    validateCandidate,
    validateCandidateEvent
} = require("./candidate-schema");

const LEGAL_TRANSITIONS = Object.freeze({
    discovered: ["identity_discovery_pending", "identity_pending", "duplicate", "needs_review", "failed"],
    identity_discovery_pending: ["identity_discovering", "duplicate", "needs_review", "rejected"],
    identity_discovering: ["identity_pending", "needs_review", "conflicting_identity", "duplicate", "retry_wait", "failed"],
    identity_pending: ["identity_resolving", "duplicate", "needs_review", "rejected"],
    identity_resolving: ["identity_coherent", "needs_review", "conflicting_identity", "failed_match", "retry_wait", "failed"],
    identity_coherent: ["enrichment_pending", "validation_pending", "needs_review", "duplicate"],
    enrichment_pending: ["enriching", "validation_pending", "needs_review", "retry_wait"],
    enriching: ["validation_pending", "needs_review", "retry_wait", "failed"],
    validation_pending: ["ready_for_live", "needs_review", "duplicate", "failed"],
    needs_review: ["identity_discovery_pending", "identity_pending", "identity_coherent", "validation_pending", "approved", "duplicate", "rejected"],
    conflicting_identity: ["identity_pending", "needs_review", "rejected"],
    failed_match: ["identity_pending", "needs_review", "rejected"],
    duplicate: ["needs_review", "rejected"],
    retry_wait: ["identity_discovery_pending", "identity_pending", "enrichment_pending", "enriching", "validation_pending", "needs_review"],
    ready_for_live: ["approved", "needs_review", "duplicate"],
    approved: ["migration_pending", "needs_review"],
    migration_pending: ["migrated", "approved", "failed"],
    migrated: [],
    rejected: [],
    failed: ["identity_discovery_pending", "identity_pending", "enrichment_pending", "validation_pending", "rejected"]
});

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function legalTransition(previousState, nextState) {
    return previousState === null
        ? nextState === "discovered"
        : (LEGAL_TRANSITIONS[previousState] || []).includes(nextState);
}

function createInitialCandidate(discovery, event) {
    return {
        schemaVersion: 1,
        candidateId: event.candidateId,
        revision: event.candidateRevision,
        state: event.nextState,
        stateEnteredAt: event.occurredAt,
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        name: {
            raw: discovery.rawArtistName,
            normalized: normalizeArtistName(discovery.rawArtistName)
        },
        discoveries: [discovery],
        candidateIdentifiers: {
            spotifyArtistId: discovery.spotifyArtistId,
            spotifyArtistUrl: discovery.spotifyArtistUrl || (discovery.spotifyArtistId ? `https://open.spotify.com/artist/${discovery.spotifyArtistId}` : null),
            assertedMusicRollId: discovery.assertedMusicRollId
        },
        resolvedIdentity: {
            outcome: "unresolved_identity",
            selectedSpotifyArtistId: null,
            wikidataQids: [],
            musicBrainzArtistIds: [],
            discogsArtistIds: [],
            identityConfidence: { value: null, band: "unknown", methodVersion: null, evidenceRefs: [] },
            evidenceRefs: [],
            conflicts: [],
            sameNameAmbiguity: null,
            providerMultiplicity: null,
            provenanceClaims: [],
            providerErrors: [],
            resolverVersion: null,
            resolvedAt: null
        },
        editorial: {
            proposedGenres: [],
            proposedStage: null,
            stageConfidence: { value: null, methodVersion: null, evidenceRefs: [] }
        },
        geography: {
            geoConfidence: { value: null, methodVersion: null, evidenceRefs: [] },
            claims: []
        },
        enrichment: {
            identity: "not_started",
            catalog: "not_started",
            stage: "not_started",
            geography: "not_started",
            momentum: "not_started",
            scene: "not_started"
        },
        duplicate: {
            status: "not_duplicate",
            duplicateOfCandidateId: null,
            existingMusicRollId: null,
            matchedBy: [],
            evidenceRefs: []
        },
        musicRollIdReservation: {
            proposedMusicRollId: null,
            status: "not_reserved",
            reservedAt: null,
            reservationRef: null
        },
        processing: {
            attemptsByStep: {},
            lease: null,
            retryAt: null,
            resumeState: null,
            lastFailure: null
        },
        approval: {
            status: "not_approved",
            method: null,
            policyVersion: null,
            actor: null,
            approvedAt: null,
            decisionEvidenceRefs: []
        },
        warnings: [],
        failureReason: null,
        lastEventId: event.eventId
    };
}

function applyTransitionPayload(candidate, event) {
    const payload = event.payload || {};
    const next = structuredClone(candidate);
    if (payload.duplicate) {
        next.duplicate = {
            status: payload.duplicate.status,
            duplicateOfCandidateId: payload.duplicate.duplicateOfCandidateId || null,
            existingMusicRollId: payload.duplicate.existingMusicRollId || null,
            matchedBy: [...new Set(payload.duplicate.matchedBy || [])],
            evidenceRefs: [...new Set(payload.duplicate.evidenceRefs || event.evidenceRefs || [])]
        };
    }
    if (Array.isArray(payload.warnings)) {
        next.warnings = [...new Map([...next.warnings, ...payload.warnings].map(warning => [JSON.stringify(warning), warning])).values()];
    }
    if (Object.prototype.hasOwnProperty.call(payload, "failureReason")) next.failureReason = payload.failureReason;
    if (Object.prototype.hasOwnProperty.call(payload, "resumeState")) next.processing.resumeState = payload.resumeState;
    if (payload.processing) next.processing = { ...next.processing, ...structuredClone(payload.processing) };
    if (payload.resolvedIdentity) next.resolvedIdentity = structuredClone(payload.resolvedIdentity);
    if (payload.identityDiscovery) next.identityDiscovery = structuredClone(payload.identityDiscovery);
    if (payload.enrichment) next.enrichment = { ...next.enrichment, ...structuredClone(payload.enrichment) };
    if (payload.approval) next.approval = structuredClone(payload.approval);
    if (payload.musicRollIdReservation) next.musicRollIdReservation = structuredClone(payload.musicRollIdReservation);
    return next;
}

function reduceCandidate(candidate, event) {
    validateCandidateEvent(event);
    if (candidate == null) {
        assert(event.eventType === "candidate_discovered", "The first candidate event must be candidate_discovered.");
        const created = createInitialCandidate(event.payload.discovery, event);
        validateCandidate(created);
        return created;
    }
    validateCandidate(candidate);
    assert(event.candidateId === candidate.candidateId, "Candidate event targets a different candidate.");
    assert(event.previousRevision === candidate.revision, `Stale candidate revision: expected ${candidate.revision}, received ${event.previousRevision}.`);
    assert(event.previousState === candidate.state, `Candidate event previous state drifted: expected ${candidate.state}, received ${event.previousState}.`);
    assert(["state_transition", "discovery_attached", "candidate_identifier_attached"].includes(event.eventType), "Unsupported candidate event after discovery.");
    if (event.eventType === "state_transition") assert(legalTransition(candidate.state, event.nextState), `Illegal candidate transition: ${candidate.state} -> ${event.nextState}.`);
    if (event.eventType === "discovery_attached") {
        assert(event.nextState === candidate.state, "Discovery attachment cannot change candidate lifecycle state.");
        assert(!(candidate.discoveryAssociations || []).some(item => item.occurrenceId === event.payload.discoveryAssociation.occurrenceId), "Discovery occurrence is already attached to this candidate.");
    }
    if (event.eventType === "candidate_identifier_attached") {
        assert(event.nextState === candidate.state, "Identifier attachment cannot change candidate lifecycle state.");
        const identifier = event.payload.identifier;
        const currentSpotifyId = candidate.candidateIdentifiers.spotifyArtistId;
        assert(currentSpotifyId == null || currentSpotifyId === identifier.value, "Attached Spotify ID would overwrite an existing candidate identifier.");
        assert(!(candidate.identifierAttachments || []).some(item => item.provider === identifier.provider && item.entityType === identifier.entityType && item.value === identifier.value), "Candidate identifier is already attached.");
    }
    let next = applyTransitionPayload(candidate, event);
    if (event.eventType === "discovery_attached") {
        if (!next.discoveries.some(item => item.discoveryId === event.payload.discovery.discoveryId)) next.discoveries.push(structuredClone(event.payload.discovery));
        next.discoveryAssociations ||= [];
        next.discoveryAssociations.push(structuredClone(event.payload.discoveryAssociation));
    }
    if (event.eventType === "candidate_identifier_attached") {
        const identifier = structuredClone(event.payload.identifier);
        next.candidateIdentifiers.spotifyArtistId = identifier.value;
        next.candidateIdentifiers.spotifyArtistUrl = identifier.url;
        next.identifierAttachments ||= [];
        next.identifierAttachments.push({
            ...identifier,
            attachedAt: event.occurredAt,
            actor: structuredClone(event.actor),
            reasonCode: event.reasonCode,
            evidenceRefs: [...event.evidenceRefs]
        });
    }
    next.revision = event.candidateRevision;
    next.state = event.nextState;
    next.stateEnteredAt = event.occurredAt;
    next.updatedAt = event.occurredAt;
    next.lastEventId = event.eventId;
    validateCandidate(next);
    return next;
}

function buildCandidateEvent(input, options = {}) {
    const occurredAt = input.occurredAt || options.clock?.() || new Date().toISOString();
    const event = {
        schemaVersion: 1,
        eventId: input.eventId || options.eventIdGenerator?.() || createEventId(),
        candidateId: input.candidateId,
        eventType: input.eventType,
        previousState: input.previousState,
        nextState: input.nextState,
        previousRevision: input.previousRevision,
        candidateRevision: input.previousRevision + 1,
        reasonCode: input.reasonCode,
        actor: input.actor,
        occurredAt: new Date(occurredAt).toISOString(),
        evidenceRefs: [...new Set(input.evidenceRefs || [])],
        payload: input.payload || {}
    };
    validateCandidateEvent(event);
    if (event.eventType === "state_transition" || event.eventType === "candidate_discovered") {
        assert(legalTransition(event.previousState, event.nextState), `Illegal candidate transition: ${event.previousState} -> ${event.nextState}.`);
    } else {
        assert(["discovery_attached", "candidate_identifier_attached"].includes(event.eventType) && event.previousState === event.nextState, "Append-only attachment events must preserve lifecycle state.");
    }
    return event;
}

function replayCandidate(events) {
    assert(Array.isArray(events) && events.length > 0, "Candidate replay requires events.");
    const ordered = [...events].sort((left, right) => left.candidateRevision - right.candidateRevision);
    let candidate = null;
    for (const event of ordered) candidate = reduceCandidate(candidate, event);
    return candidate;
}

function validateLifecycleDefinition() {
    const defined = new Set(LIFECYCLE_STATES);
    assert(Object.keys(LEGAL_TRANSITIONS).every(state => defined.has(state)), "Transition table contains an unknown state.");
    assert(Object.values(LEGAL_TRANSITIONS).flat().every(state => defined.has(state)), "Transition table targets an unknown state.");
    return true;
}

validateLifecycleDefinition();

module.exports = {
    LEGAL_TRANSITIONS,
    buildCandidateEvent,
    legalTransition,
    reduceCandidate,
    replayCandidate,
    validateLifecycleDefinition
};
