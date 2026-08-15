const { normalizeDiscovery } = require("../ingestion/candidate-schema");
const { duplicatePreflight } = require("../ingestion/duplicate-preflight");
const {
    createDiscoveryAssociation,
    providerEntityKey,
    validateDiscoveryOccurrence
} = require("./discovery-schema");

function unique(values) {
    return [...new Set(values.filter(Boolean).map(String))];
}

function exactSpotifyIds(occurrence) {
    return unique([
        occurrence.trustedIdentifiers.spotifyArtistId,
        ...occurrence.exactIdentityBridges
            .filter(bridge => bridge.targetProvider === "spotify" && bridge.targetEntityType === "artist")
            .map(bridge => bridge.targetId)
    ]);
}

function bridgeEvidenceRefs(occurrence) {
    return unique(occurrence.exactIdentityBridges.map(bridge => bridge.evidenceRef));
}

function candidateDiscovery(occurrence, spotifyArtistId = null) {
    return normalizeDiscovery({
        sourceType: occurrence.sourceType,
        sourceName: occurrence.sourceName,
        sourceRecordId: occurrence.sourceRecordId,
        sourceUrl: occurrence.sourceUrl,
        rawArtistName: occurrence.artist.rawName,
        spotifyArtistId,
        spotifyArtistUrl: spotifyArtistId ? `https://open.spotify.com/artist/${spotifyArtistId}` : null,
        assertedMusicRollId: occurrence.trustedIdentifiers.assertedMusicRollId,
        discoveredAt: occurrence.discoveredAt
    });
}

function associationReference(occurrence, associationRef) {
    return {
        occurrenceId: occurrence.occurrenceId,
        evidenceRef: associationRef,
        provider: occurrence.provider,
        providerEntityKey: providerEntityKey(occurrence)
    };
}

function targetKey(target) {
    return `${target.targetType}:${target.targetId}`;
}

function uniqueTargets(targets) {
    return [...new Map(targets.map(target => [targetKey(target), target])).values()];
}

class DiscoveryConvergence {
    constructor({ candidateStore, discoveryStore, permanentRegistry, liveArtists = [], clock }) {
        if (!candidateStore || !discoveryStore) throw new Error("Discovery convergence requires candidate and discovery stores.");
        if (permanentRegistry?.schemaVersion !== 1 || !Array.isArray(permanentRegistry.mappings)) throw new Error("Discovery convergence requires the permanent registry.");
        if (!Array.isArray(liveArtists)) throw new Error("Discovery convergence live artists must be an array.");
        this.candidateStore = candidateStore;
        this.discoveryStore = discoveryStore;
        this.permanentRegistry = permanentRegistry;
        this.liveArtists = liveArtists;
        this.clock = clock || (() => new Date().toISOString());
    }

    async candidateTargetsBySpotify(candidates, spotifyId) {
        return candidates.filter(candidate => candidate.candidateIdentifiers?.spotifyArtistId === spotifyId)
            .map(candidate => ({ targetType: "candidate", targetId: candidate.candidateId, matchedBy: ["exact_spotify_id"] }));
    }

    registryTargets(occurrence, spotifyIds) {
        const bySpotify = new Map(this.permanentRegistry.mappings.map(mapping => [mapping.spotifyId, mapping]));
        const byMusicRoll = new Map(this.permanentRegistry.mappings.map(mapping => [mapping.musicRollId, mapping]));
        const targets = [];
        for (const spotifyId of spotifyIds) {
            const binding = bySpotify.get(spotifyId);
            if (binding) targets.push({ targetType: "live_artist", targetId: binding.musicRollId, matchedBy: ["exact_spotify_id", "permanent_registry_binding"] });
        }
        const assertedMusicRollId = occurrence.trustedIdentifiers.assertedMusicRollId;
        if (assertedMusicRollId) {
            const binding = byMusicRoll.get(assertedMusicRollId);
            if (binding) targets.push({ targetType: "live_artist", targetId: binding.musicRollId, matchedBy: ["exact_music_roll_id", "permanent_registry_binding"] });
            else targets.push({ targetType: "unresolved", targetId: assertedMusicRollId, matchedBy: ["unknown_asserted_music_roll_id"] });
        }
        return targets;
    }

    async persistAssociation(occurrence, target, occurrenceRef, matchedBy = []) {
        return this.discoveryStore.persistAssociation(createDiscoveryAssociation({
            occurrenceId: occurrence.occurrenceId,
            targetType: target.targetType,
            targetId: target.targetId,
            matchedBy: unique([...(target.matchedBy || []), ...matchedBy]),
            evidenceRefs: unique([occurrenceRef, occurrence.rawEvidenceRef, ...bridgeEvidenceRefs(occurrence)]),
            createdAt: this.clock()
        }));
    }

    async attachCandidateLocked(occurrence, candidate, occurrenceRef, matchedBy = []) {
        const associationResult = await this.persistAssociation(occurrence, { targetType: "candidate", targetId: candidate.candidateId, matchedBy }, occurrenceRef, matchedBy);
        const spotifyIds = exactSpotifyIds(occurrence);
        const spotifyArtistId = spotifyIds.length === 1 ? spotifyIds[0] : candidate.candidateIdentifiers.spotifyArtistId;
        const attachment = await this.candidateStore.attachDiscoveryLocked(candidate.candidateId, {
            expectedRevision: candidate.revision,
            discovery: candidateDiscovery(occurrence, spotifyArtistId || null),
            discoveryAssociation: associationReference(occurrence, associationResult.evidenceRef),
            evidenceRefs: unique([occurrenceRef, associationResult.evidenceRef, occurrence.rawEvidenceRef, ...bridgeEvidenceRefs(occurrence)]),
            actor: { type: "system", id: "discovery_convergence_v1" }
        });
        return { candidate: attachment.candidate, associationResult, attached: attachment.attached, idempotent: attachment.idempotent };
    }

    async createCandidateLocked(occurrence, occurrenceRef, options = {}) {
        const spotifyArtistId = options.spotifyArtistId || null;
        let candidate = await this.candidateStore.createCandidateLocked(candidateDiscovery(occurrence, spotifyArtistId), {
            actor: { type: "system", id: "discovery_convergence_v1" },
            reasonCode: "discovery_occurrence_created_candidate",
            evidenceRefs: unique([occurrenceRef, occurrence.rawEvidenceRef, ...bridgeEvidenceRefs(occurrence)])
        });
        const attached = await this.attachCandidateLocked(occurrence, candidate, occurrenceRef, options.matchedBy || ["new_discovery_candidate"]);
        candidate = attached.candidate;
        if (options.ambiguous) {
            candidate = await this.candidateStore.transitionCandidateLocked(candidate.candidateId, {
                expectedRevision: candidate.revision,
                nextState: "needs_review",
                reasonCode: "discovery_exact_convergence_ambiguous",
                actor: { type: "system", id: "discovery_convergence_v1" },
                evidenceRefs: unique([occurrenceRef, attached.associationResult.evidenceRef, ...bridgeEvidenceRefs(occurrence)]),
                payload: {
                    warnings: [{
                        code: "ambiguous_exact_discovery_convergence",
                        note: "Multiple incompatible exact targets were preserved for human review; no canonical identity was selected.",
                        exactSpotifyArtistIds: options.exactSpotifyArtistIds || [],
                        targetKeys: options.targetKeys || []
                    }]
                }
            });
        } else {
            const candidates = await this.candidateStore.listCandidates();
            const preflight = duplicatePreflight({ candidate, candidates, permanentRegistry: this.permanentRegistry, liveArtists: this.liveArtists });
            candidate = await this.candidateStore.transitionCandidateLocked(candidate.candidateId, {
                expectedRevision: candidate.revision,
                nextState: preflight.nextState,
                reasonCode: preflight.reasonCode,
                actor: { type: "system", id: "duplicate_preflight_v1" },
                evidenceRefs: preflight.evidenceRefs,
                payload: {
                    ...(preflight.duplicate ? { duplicate: preflight.duplicate } : {}),
                    warnings: preflight.warnings
                }
            });
        }
        return { candidate, associationResult: attached.associationResult };
    }

    async converge(occurrence) {
        validateDiscoveryOccurrence(occurrence);
        const persisted = await this.discoveryStore.persistOccurrence(occurrence);
        occurrence = persisted.occurrence;
        const occurrenceRef = persisted.evidenceRef;
        return this.candidateStore.withWriterLock(async () => {
            const exactOccurrenceAssociations = await this.discoveryStore.findAssociationsByOccurrenceId(occurrence.occurrenceId);
            if (exactOccurrenceAssociations.length === 1) {
                const association = exactOccurrenceAssociations[0];
                if (association.targetType === "candidate") {
                    const candidate = await this.candidateStore.replay(association.targetId);
                    const attached = await this.attachCandidateLocked(occurrence, candidate, occurrenceRef, association.matchedBy);
                    return { action: "idempotent_existing_occurrence", occurrenceId: occurrence.occurrenceId, targetType: "candidate", targetId: candidate.candidateId, candidate: attached.candidate, occurrenceCreated: persisted.created };
                }
                return { action: "idempotent_existing_occurrence", occurrenceId: occurrence.occurrenceId, targetType: association.targetType, targetId: association.targetId, occurrenceCreated: persisted.created };
            }
            if (exactOccurrenceAssociations.length > 1) throw new Error(`Discovery occurrence has multiple persisted targets: ${occurrence.occurrenceId}`);

            const candidates = await this.candidateStore.listCandidates();
            const spotifyIds = exactSpotifyIds(occurrence);
            const providerTargets = await this.discoveryStore.findTargetsByProviderEntity(providerEntityKey(occurrence));
            const candidateSpotifyTargets = (await Promise.all(spotifyIds.map(id => this.candidateTargetsBySpotify(candidates, id)))).flat();
            const registryTargets = this.registryTargets(occurrence, spotifyIds);
            const unresolvedRegistryTargets = registryTargets.filter(target => target.targetType === "unresolved");
            const exactTargets = uniqueTargets([
                ...providerTargets.map(target => ({ targetType: target.targetType, targetId: target.targetId, matchedBy: ["exact_provider_entity_id"] })),
                ...candidateSpotifyTargets,
                ...registryTargets.filter(target => target.targetType !== "unresolved")
            ]);
            const incompatible = spotifyIds.length > 1 || exactTargets.length > 1 || unresolvedRegistryTargets.length > 0;

            if (incompatible) {
                const created = await this.createCandidateLocked(occurrence, occurrenceRef, {
                    ambiguous: true,
                    exactSpotifyArtistIds: spotifyIds,
                    targetKeys: [...exactTargets.map(targetKey), ...unresolvedRegistryTargets.map(targetKey)],
                    matchedBy: ["ambiguous_exact_convergence"]
                });
                await Promise.all([this.discoveryStore.rebuildIndexes(), this.candidateStore.rebuildIndexesLocked()]);
                return { action: "route_ambiguous_exact_convergence_to_review", occurrenceId: occurrence.occurrenceId, targetType: "candidate", targetId: created.candidate.candidateId, candidate: created.candidate, occurrenceCreated: persisted.created };
            }

            if (exactTargets.length === 1) {
                const target = exactTargets[0];
                if (target.targetType === "live_artist") {
                    const association = await this.persistAssociation(occurrence, target, occurrenceRef, target.matchedBy);
                    await this.discoveryStore.rebuildIndexes();
                    return { action: "associate_existing_live_artist", occurrenceId: occurrence.occurrenceId, targetType: "live_artist", targetId: target.targetId, association: association.association, occurrenceCreated: persisted.created };
                }
                const candidate = candidates.find(item => item.candidateId === target.targetId);
                const attached = await this.attachCandidateLocked(occurrence, candidate, occurrenceRef, target.matchedBy);
                await Promise.all([this.discoveryStore.rebuildIndexes(), this.candidateStore.rebuildIndexesLocked()]);
                return { action: "attach_existing_candidate", occurrenceId: occurrence.occurrenceId, targetType: "candidate", targetId: candidate.candidateId, candidate: attached.candidate, occurrenceCreated: persisted.created };
            }

            const created = await this.createCandidateLocked(occurrence, occurrenceRef, {
                spotifyArtistId: spotifyIds.length === 1 ? spotifyIds[0] : null,
                matchedBy: spotifyIds.length === 1 ? ["new_exact_spotify_discovery"] : ["new_provider_only_discovery"]
            });
            await Promise.all([this.discoveryStore.rebuildIndexes(), this.candidateStore.rebuildIndexesLocked()]);
            return {
                action: spotifyIds.length === 1 ? "create_new_candidate" : "create_identity_discovery_candidate",
                occurrenceId: occurrence.occurrenceId,
                targetType: "candidate",
                targetId: created.candidate.candidateId,
                candidate: created.candidate,
                occurrenceCreated: persisted.created
            };
        });
    }
}

module.exports = { DiscoveryConvergence, candidateDiscovery, exactSpotifyIds };
