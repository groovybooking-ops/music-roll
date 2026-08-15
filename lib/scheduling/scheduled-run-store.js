const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const {
    PHASES,
    RUN_ID_PATTERN,
    createRunEventId,
    createRunId,
    stableConfigurationHash,
    validateChecksums,
    validateManifest
} = require("./scheduled-run-schema");
const { assertConfiguration, buildEvent, firstIncompletePhase, replayRun } = require("./scheduled-run-journal");
const { emptyBudgetConsumption, validateBudgetConsumption } = require("./scheduled-budget-policy");

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, "utf8"));
}

async function checksumFiles(projectRoot, relativePaths = ["data/artists.json", "data/artist-id-registry.json"]) {
    return Object.fromEntries(await Promise.all(relativePaths.map(async relative => [
        relative,
        crypto.createHash("sha256").update(await fs.readFile(path.join(projectRoot, relative))).digest("hex")
    ])));
}

class ScheduledRunStore {
    constructor(root, options = {}) {
        if (!root) throw new Error("Scheduled-run store root is required.");
        this.root = path.resolve(root);
        this.runsRoot = path.join(this.root, "runs");
        this.ingestionStoreRoot = path.join(this.root, "store");
        this.lockPath = path.join(this.root, ".scheduled-run-writer.lock");
        this.clock = options.clock || (() => new Date().toISOString());
        this.runIdGenerator = options.runIdGenerator || (() => createRunId());
        this.eventIdGenerator = options.eventIdGenerator || (() => createRunEventId());
        this.writerOwned = false;
    }

    runDirectory(runId) {
        if (!RUN_ID_PATTERN.test(runId || "")) throw new Error("Invalid scheduled-run ID path.");
        return path.join(this.runsRoot, runId);
    }

    manifestPath(runId) { return path.join(this.runDirectory(runId), "manifest.json"); }
    eventsDirectory(runId) { return path.join(this.runDirectory(runId), "events"); }

    async withWriterLock(operation) {
        if (this.writerOwned) return operation();
        await fs.mkdir(this.root, { recursive: true });
        let handle;
        try {
            handle = await fs.open(this.lockPath, "wx");
            await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: this.clock() }) + "\n");
        } catch (error) {
            if (error.code === "EEXIST") throw new Error(`Scheduled-run store already has an active writer: ${this.lockPath}`);
            throw error;
        }
        this.writerOwned = true;
        try { return await operation(); }
        finally {
            this.writerOwned = false;
            await handle.close();
            await fs.unlink(this.lockPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        }
    }

    async writeExclusive(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    }

    async writeAtomic(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${this.eventIdGenerator()}.tmp`);
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        try { await fs.rename(temporary, file); }
        catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    }

    async appendEvent(event, manifest) {
        const file = path.join(this.eventsDirectory(event.runId), `${String(event.runRevision).padStart(6, "0")}-${event.eventId}.json`);
        await this.writeExclusive(file, event);
        await this.writeAtomic(this.manifestPath(event.runId), manifest);
    }

    async createRun(input) {
        return this.withWriterLock(async () => {
            const runId = input.runId || this.runIdGenerator();
            const occurredAt = input.occurredAt || this.clock();
            const configuration = structuredClone(input.configuration || {});
            const hash = stableConfigurationHash(configuration);
            if (input.stableConfigurationHash && input.stableConfigurationHash !== hash) throw new Error("Supplied scheduled-run configuration hash does not match configuration.");
            validateChecksums(input.protectedChecksums, "initial protected checksums");
            const event = buildEvent({
                runId,
                eventType: "run_created",
                previousRevision: 0,
                phase: "created",
                disposition: "completed",
                occurredAt,
                actor: input.actor || { type: "command", id: "scheduled_discovery_coordinator" },
                payload: {
                    networkAllowed: input.networkAllowed === true,
                    stableConfigurationHash: hash,
                    configuration,
                    budgets: structuredClone(input.budgets),
                    budgetConsumption: structuredClone(input.budgetConsumption || emptyBudgetConsumption()),
                    protectedChecksums: structuredClone(input.protectedChecksums)
                }
            }, { eventIdGenerator: this.eventIdGenerator });
            const manifest = replayRun([event]);
            await this.appendEvent(event, manifest);
            return manifest;
        });
    }

    async readEvents(runId) {
        const names = await fs.readdir(this.eventsDirectory(runId)).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
        return Promise.all(names.filter(name => name.endsWith(".json")).sort().map(name => readJson(path.join(this.eventsDirectory(runId), name))));
    }

    async replay(runId) { return replayRun(await this.readEvents(runId)); }

    async readManifest(runId) {
        const manifest = await readJson(this.manifestPath(runId));
        validateManifest(manifest);
        return manifest;
    }

    async verifyManifest(runId) {
        const [manifest, replayed] = await Promise.all([this.readManifest(runId), this.replay(runId)]);
        if (JSON.stringify(manifest) !== JSON.stringify(replayed)) throw new Error(`Scheduled-run manifest does not match event replay: ${runId}.`);
        return true;
    }

    async completePhase(runId, input) {
        return this.withWriterLock(async () => {
            const manifest = await this.replay(runId);
            if (input.expectedRevision !== manifest.revision) throw new Error(`Stale scheduled-run revision: expected current ${manifest.revision}, received ${input.expectedRevision}.`);
            assertConfiguration(manifest, input.configuration);
            const expected = firstIncompletePhase(manifest);
            if (manifest.phaseStatuses[input.phase]?.status !== "pending") {
                const current = manifest.phaseStatuses[input.phase];
                const refs = [...new Set((input.checkpointRefs || []).map(String))].sort();
                if (current.disposition === (input.disposition || "completed") && JSON.stringify(current.checkpointRefs) === JSON.stringify(refs)) {
                    return { manifest, completed: false, idempotent: true, nextPhase: expected };
                }
                throw new Error(`Scheduled-run phase ${input.phase} was already completed with different evidence.`);
            }
            if (input.phase !== expected) throw new Error(`Illegal scheduled-run phase transition: expected ${expected}, received ${input.phase}.`);
            if (manifest.control.status !== "running") throw new Error(`Scheduled run is ${manifest.control.status}; phase advancement is disabled.`);
            const consumption = input.budgetConsumption || manifest.budgetConsumption;
            validateBudgetConsumption(consumption);
            const payload = { checkpointRefs: [...new Set(input.checkpointRefs || [])].sort(), budgetConsumption: structuredClone(consumption) };
            if (input.phase === "summary_complete") {
                validateChecksums(input.protectedChecksums, "final protected checksums");
                if (stableConfigurationHash(input.protectedChecksums) !== stableConfigurationHash(manifest.protectedChecksums.before)) throw new Error("Protected live-data checksums changed during scheduled run.");
                payload.protectedChecksums = structuredClone(input.protectedChecksums);
            }
            const event = buildEvent({
                runId,
                eventType: "phase_completed",
                previousRevision: manifest.revision,
                phase: input.phase,
                disposition: input.disposition || "completed",
                occurredAt: input.occurredAt || this.clock(),
                actor: input.actor || { type: "system", id: "scheduled_discovery_coordinator" },
                payload
            }, { eventIdGenerator: this.eventIdGenerator });
            const next = replayRun([...(await this.readEvents(runId)), event]);
            await this.appendEvent(event, next);
            return { manifest: next, completed: true, idempotent: false, nextPhase: firstIncompletePhase(next) };
        });
    }

    async controlRun(runId, input) {
        return this.withWriterLock(async () => {
            const manifest = await this.replay(runId);
            if (input.expectedRevision !== manifest.revision) throw new Error(`Stale scheduled-run revision: expected current ${manifest.revision}, received ${input.expectedRevision}.`);
            assertConfiguration(manifest, input.configuration);
            const type = input.action === "pause" ? "run_paused" : input.action === "resume" ? "run_resumed" : input.action === "stop" ? "run_stopped" : null;
            if (!type) throw new Error("Scheduled-run control action is invalid.");
            const event = buildEvent({
                runId,
                eventType: type,
                previousRevision: manifest.revision,
                occurredAt: input.occurredAt || this.clock(),
                actor: input.actor || { type: "command", id: "scheduled_discovery_coordinator" },
                payload: {
                    reason: input.reason,
                    checkpointRefs: [...new Set(input.checkpointRefs || [])].sort(),
                    budgetConsumption: structuredClone(input.budgetConsumption || manifest.budgetConsumption)
                }
            }, { eventIdGenerator: this.eventIdGenerator });
            const next = replayRun([...(await this.readEvents(runId)), event]);
            await this.appendEvent(event, next);
            return next;
        });
    }

    async recordProviderExecution(runId, input) {
        return this.withWriterLock(async () => {
            const manifest = await this.replay(runId);
            if (input.expectedRevision !== manifest.revision) throw new Error(`Stale scheduled-run revision: expected current ${manifest.revision}, received ${input.expectedRevision}.`);
            assertConfiguration(manifest, input.configuration);
            const event = buildEvent({
                runId,
                eventType: "provider_execution_recorded",
                previousRevision: manifest.revision,
                occurredAt: input.occurredAt || this.clock(),
                actor: input.actor || { type: "system", id: "scheduled_provider_controller_v1" },
                payload: {
                    provider: input.provider,
                    metrics: structuredClone(input.metrics),
                    circuitBreaker: structuredClone(input.circuitBreaker),
                    stopReason: input.stopReason || null
                }
            }, { eventIdGenerator: this.eventIdGenerator });
            const next = replayRun([...(await this.readEvents(runId)), event]);
            await this.appendEvent(event, next);
            return next;
        });
    }

    async resumeRun(runId, input) {
        const replayed = await this.replay(runId);
        assertConfiguration(replayed, input.configuration);
        const manifestExists = await fs.access(this.manifestPath(runId)).then(() => true, () => false);
        if (!manifestExists || !(await this.verifyManifest(runId).catch(() => false))) await this.writeAtomic(this.manifestPath(runId), replayed);
        return {
            manifest: replayed,
            nextPhase: firstIncompletePhase(replayed),
            completedPhases: PHASES.filter(phase => replayed.phaseStatuses[phase].status !== "pending")
        };
    }
}

module.exports = { ScheduledRunStore, checksumFiles };
