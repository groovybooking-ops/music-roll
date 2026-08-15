const fs = require("fs/promises");
const path = require("path");
const {
    CANDIDATE_ID_PATTERN,
    createCandidateId,
    createEventId,
    validateCandidate
} = require("./candidate-schema");
const {
    buildCandidateEvent,
    reduceCandidate,
    replayCandidate
} = require("./candidate-state-machine");

const REVIEW_STATES = new Set(["needs_review", "conflicting_identity", "failed_match", "failed"]);

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, "utf8"));
}

class CandidateStore {
    constructor(root, options = {}) {
        if (!root) throw new Error("Candidate store root is required.");
        this.root = path.resolve(root);
        this.candidatesDir = path.join(this.root, "candidates");
        this.eventsDir = path.join(this.root, "events");
        this.indexesDir = path.join(this.root, "indexes");
        this.lockPath = path.join(this.root, ".candidate-writer.lock");
        this.clock = options.clock || (() => new Date().toISOString());
        this.candidateIdGenerator = options.candidateIdGenerator || (() => createCandidateId());
        this.eventIdGenerator = options.eventIdGenerator || (() => createEventId());
        this.writerOwned = false;
    }

    candidatePath(candidateId) {
        if (!CANDIDATE_ID_PATTERN.test(candidateId || "")) throw new Error("Invalid candidate ID path.");
        return path.join(this.candidatesDir, `${candidateId}.json`);
    }

    eventDirectory(candidateId) {
        if (!CANDIDATE_ID_PATTERN.test(candidateId || "")) throw new Error("Invalid candidate event path.");
        return path.join(this.eventsDir, candidateId);
    }

    async withWriterLock(operation) {
        if (this.writerOwned) return operation();
        await fs.mkdir(this.root, { recursive: true });
        let handle;
        try {
            handle = await fs.open(this.lockPath, "wx");
            await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: this.clock() }) + "\n");
        } catch (error) {
            if (error.code === "EEXIST") throw new Error(`Candidate store already has an active writer lock: ${this.lockPath}`);
            throw error;
        }
        this.writerOwned = true;
        try {
            return await operation();
        } finally {
            this.writerOwned = false;
            await handle.close();
            await fs.unlink(this.lockPath).catch(error => {
                if (error.code !== "ENOENT") throw error;
            });
        }
    }

    assertWriterLock() {
        if (!this.writerOwned) throw new Error("Candidate mutation requires the single-writer lock.");
    }

    async writeJsonExclusive(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    }

    async writeJsonAtomic(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${createEventId()}.tmp`);
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        try {
            await fs.rename(temporary, file);
        } catch (error) {
            await fs.unlink(temporary).catch(() => {});
            throw error;
        }
    }

    async createCandidate(discovery, options = {}) {
        return this.withWriterLock(() => this.createCandidateLocked(discovery, options));
    }

    async createCandidateLocked(discovery, options = {}) {
        this.assertWriterLock();
        const candidateId = options.candidateId || this.candidateIdGenerator();
        const event = buildCandidateEvent({
            candidateId,
            eventType: "candidate_discovered",
            previousState: null,
            nextState: "discovered",
            previousRevision: 0,
            reasonCode: options.reasonCode || "discovery_intake_created",
            actor: options.actor || { type: "command", id: "manual_discovery_intake" },
            occurredAt: options.occurredAt || this.clock(),
            evidenceRefs: options.evidenceRefs || [],
            payload: { discovery }
        }, { eventIdGenerator: this.eventIdGenerator });
        const candidate = reduceCandidate(null, event);
        const eventFile = path.join(this.eventDirectory(candidateId), `${String(event.candidateRevision).padStart(6, "0")}-${event.eventId}.json`);
        await this.writeJsonExclusive(eventFile, event);
        await this.writeJsonAtomic(this.candidatePath(candidateId), candidate);
        return candidate;
    }

    async transitionCandidate(candidateId, input) {
        return this.withWriterLock(() => this.transitionCandidateLocked(candidateId, input));
    }

    async transitionCandidateLocked(candidateId, input) {
        this.assertWriterLock();
        const candidate = await this.replay(candidateId);
        if (candidate.revision !== input.expectedRevision) {
            throw new Error(`Stale candidate revision: expected current ${candidate.revision}, received ${input.expectedRevision}.`);
        }
        const event = buildCandidateEvent({
            candidateId,
            eventType: "state_transition",
            previousState: candidate.state,
            nextState: input.nextState,
            previousRevision: input.expectedRevision,
            reasonCode: input.reasonCode,
            actor: input.actor,
            occurredAt: input.occurredAt || this.clock(),
            evidenceRefs: input.evidenceRefs || [],
            payload: input.payload || {}
        }, { eventIdGenerator: this.eventIdGenerator });
        const next = reduceCandidate(candidate, event);
        const eventFile = path.join(this.eventDirectory(candidateId), `${String(event.candidateRevision).padStart(6, "0")}-${event.eventId}.json`);
        await this.writeJsonExclusive(eventFile, event);
        await this.writeJsonAtomic(this.candidatePath(candidateId), next);
        return next;
    }

    async attachDiscovery(candidateId, input) {
        return this.withWriterLock(() => this.attachDiscoveryLocked(candidateId, input));
    }

    async attachDiscoveryLocked(candidateId, input) {
        this.assertWriterLock();
        const candidate = await this.replay(candidateId);
        if (candidate.revision !== input.expectedRevision) {
            throw new Error(`Stale candidate revision: expected current ${candidate.revision}, received ${input.expectedRevision}.`);
        }
        const occurrenceId = input.discoveryAssociation?.occurrenceId;
        if ((candidate.discoveryAssociations || []).some(item => item.occurrenceId === occurrenceId)) {
            return { candidate, attached: false, idempotent: true };
        }
        const event = buildCandidateEvent({
            candidateId,
            eventType: "discovery_attached",
            previousState: candidate.state,
            nextState: candidate.state,
            previousRevision: input.expectedRevision,
            reasonCode: input.reasonCode || "discovery_occurrence_attached",
            actor: input.actor || { type: "system", id: "discovery_convergence_v1" },
            occurredAt: input.occurredAt || this.clock(),
            evidenceRefs: input.evidenceRefs || [],
            payload: {
                discovery: input.discovery,
                discoveryAssociation: input.discoveryAssociation
            }
        }, { eventIdGenerator: this.eventIdGenerator });
        const next = reduceCandidate(candidate, event);
        const eventFile = path.join(this.eventDirectory(candidateId), `${String(event.candidateRevision).padStart(6, "0")}-${event.eventId}.json`);
        await this.writeJsonExclusive(eventFile, event);
        await this.writeJsonAtomic(this.candidatePath(candidateId), next);
        return { candidate: next, attached: true, idempotent: false };
    }

    async attachIdentifier(candidateId, input) {
        return this.withWriterLock(() => this.attachIdentifierLocked(candidateId, input));
    }

    async attachIdentifierLocked(candidateId, input) {
        this.assertWriterLock();
        const candidate = await this.replay(candidateId);
        if (candidate.revision !== input.expectedRevision) {
            throw new Error(`Stale candidate revision: expected current ${candidate.revision}, received ${input.expectedRevision}.`);
        }
        const identifier = input.identifier;
        const existingSpotifyId = candidate.candidateIdentifiers.spotifyArtistId;
        if (existingSpotifyId && existingSpotifyId !== identifier?.value) {
            throw new Error(`Identifier attachment would overwrite Spotify ID ${existingSpotifyId} with ${identifier?.value || "missing"}.`);
        }
        if ((candidate.identifierAttachments || []).some(item => item.provider === identifier?.provider && item.entityType === identifier?.entityType && item.value === identifier?.value)) {
            return { candidate, attached: false, idempotent: true };
        }
        const event = buildCandidateEvent({
            candidateId,
            eventType: "candidate_identifier_attached",
            previousState: candidate.state,
            nextState: candidate.state,
            previousRevision: input.expectedRevision,
            reasonCode: input.reasonCode || "exact_spotify_bridge_discovered",
            actor: input.actor || { type: "worker", id: "identity_discovery_worker_v1" },
            occurredAt: input.occurredAt || this.clock(),
            evidenceRefs: input.evidenceRefs || [],
            payload: { identifier }
        }, { eventIdGenerator: this.eventIdGenerator });
        const next = reduceCandidate(candidate, event);
        const eventFile = path.join(this.eventDirectory(candidateId), `${String(event.candidateRevision).padStart(6, "0")}-${event.eventId}.json`);
        await this.writeJsonExclusive(eventFile, event);
        await this.writeJsonAtomic(this.candidatePath(candidateId), next);
        return { candidate: next, attached: true, idempotent: false };
    }

    async readCandidate(candidateId) {
        const candidate = await readJson(this.candidatePath(candidateId));
        validateCandidate(candidate);
        return candidate;
    }

    async listCandidateIds() {
        const candidateNames = await fs.readdir(this.candidatesDir).catch(error => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        const eventNames = await fs.readdir(this.eventsDir, { withFileTypes: true }).catch(error => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        return [...new Set([
            ...candidateNames.filter(name => name.endsWith(".json"))
            .map(name => name.slice(0, -5))
            .filter(candidateId => CANDIDATE_ID_PATTERN.test(candidateId)),
            ...eventNames.filter(entry => entry.isDirectory() && CANDIDATE_ID_PATTERN.test(entry.name)).map(entry => entry.name)
        ])].sort();
    }

    async listCandidates() {
        const ids = await this.listCandidateIds();
        return Promise.all(ids.map(candidateId => this.replay(candidateId)));
    }

    async findByDiscoveryId(discoveryId) {
        const candidates = await this.listCandidates();
        return candidates.find(candidate => candidate.discoveries.some(discovery => discovery.discoveryId === discoveryId)) || null;
    }

    async readEvents(candidateId) {
        const directory = this.eventDirectory(candidateId);
        const names = await fs.readdir(directory).catch(error => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        const events = [];
        for (const name of names.filter(value => value.endsWith(".json")).sort()) events.push(await readJson(path.join(directory, name)));
        return events;
    }

    async replay(candidateId) {
        return replayCandidate(await this.readEvents(candidateId));
    }

    async verifySnapshot(candidateId) {
        const [snapshot, replayed] = await Promise.all([this.readCandidate(candidateId), this.replay(candidateId)]);
        if (JSON.stringify(snapshot) !== JSON.stringify(replayed)) throw new Error(`Candidate snapshot does not match event replay: ${candidateId}.`);
        return true;
    }

    buildIndexes(candidates, generatedAt = this.clock()) {
        const entry = candidate => ({
            candidateId: candidate.candidateId,
            revision: candidate.revision,
            state: candidate.state,
            rawArtistName: candidate.name.raw,
            normalizedArtistName: candidate.name.normalized,
            spotifyArtistId: candidate.candidateIdentifiers.spotifyArtistId,
            existingMusicRollId: candidate.duplicate.existingMusicRollId,
            updatedAt: candidate.updatedAt
        });
        const countsByState = Object.fromEntries([...new Set(candidates.map(candidate => candidate.state))].sort()
            .map(state => [state, candidates.filter(candidate => candidate.state === state).length]));
        return {
            queue: { schemaVersion: 1, generatedAt, rebuildable: true, candidateCount: candidates.length, countsByState, candidates: candidates.map(entry) },
            review: { schemaVersion: 1, generatedAt, rebuildable: true, candidateCount: candidates.filter(candidate => REVIEW_STATES.has(candidate.state)).length, candidates: candidates.filter(candidate => REVIEW_STATES.has(candidate.state)).map(entry) }
        };
    }

    async rebuildIndexes() {
        return this.withWriterLock(() => this.rebuildIndexesLocked());
    }

    async rebuildIndexesLocked() {
        this.assertWriterLock();
        const indexes = this.buildIndexes(await this.listCandidates());
        await this.writeJsonAtomic(path.join(this.indexesDir, "queue.json"), indexes.queue);
        await this.writeJsonAtomic(path.join(this.indexesDir, "review.json"), indexes.review);
        return indexes;
    }
}

module.exports = { CandidateStore, REVIEW_STATES };
