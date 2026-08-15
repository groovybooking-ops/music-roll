const fs = require("fs/promises");
const path = require("path");
const {
    checkpointIdFor,
    stableSourceConfigurationHash,
    validateCheckpoint
} = require("./provider-checkpoint-schema");

async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
function safeHash(value) { return String(value).replace(/^sha256:/, ""); }

class ProviderCheckpointStore {
    constructor(root, options = {}) {
        if (!root) throw new Error("Provider checkpoint store root is required.");
        this.root = path.resolve(root);
        this.checkpointsRoot = path.join(this.root, "checkpoints");
        this.lockPath = path.join(this.root, ".provider-checkpoint-writer.lock");
        this.clock = options.clock || (() => new Date().toISOString());
        this.writerOwned = false;
    }

    directory(checkpoint) {
        validateCheckpoint(checkpoint);
        return path.join(this.checkpointsRoot, checkpoint.provider, checkpoint.adapterId, checkpoint.adapterVersion, safeHash(checkpoint.checkpointId));
    }

    latestPath(checkpoint) { return path.join(this.directory(checkpoint), "latest.json"); }
    historyPath(checkpoint) { return path.join(this.directory(checkpoint), "history", `${String(checkpoint.revision).padStart(6, "0")}.json`); }
    relative(file) { return path.relative(this.root, file).split(path.sep).join("/"); }

    async withWriterLock(operation) {
        if (this.writerOwned) return operation();
        await fs.mkdir(this.root, { recursive: true });
        let handle;
        try {
            handle = await fs.open(this.lockPath, "wx");
            await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: this.clock() }) + "\n");
        } catch (error) {
            if (error.code === "EEXIST") throw new Error(`Provider checkpoint store already has an active writer: ${this.lockPath}`);
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
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${value.revision}.tmp`);
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        try { await fs.rename(temporary, file); }
        catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    }

    async persist(checkpoint) {
        validateCheckpoint(checkpoint);
        const history = this.historyPath(checkpoint);
        await this.writeExclusive(history, checkpoint);
        await this.writeAtomic(this.latestPath(checkpoint), checkpoint);
        return { checkpoint, checkpointRef: this.relative(history), latestRef: this.relative(this.latestPath(checkpoint)) };
    }

    async createCheckpoint(input) {
        return this.withWriterLock(async () => {
            const stableHash = stableSourceConfigurationHash(input.sourceConfiguration);
            const now = input.createdAt || this.clock();
            const checkpoint = {
                schemaVersion: 1,
                checkpointId: checkpointIdFor({ provider: input.provider, adapterId: input.adapterId, adapterVersion: input.adapterVersion, stableConfigurationHash: stableHash }),
                provider: input.provider,
                adapterId: input.adapterId,
                adapterVersion: input.adapterVersion,
                stableConfigurationHash: stableHash,
                revision: 1,
                position: { providerPage: 0, cursor: null, itemOffset: 0 },
                rollingWindowIdentity: structuredClone(input.rollingWindowIdentity || null),
                exhausted: false,
                lastCompletedRunId: null,
                latestRawPageEvidenceRef: null,
                createdAt: now,
                updatedAt: now
            };
            validateCheckpoint(checkpoint);
            try { return await this.persist(checkpoint); }
            catch (error) {
                if (error.code !== "EEXIST") throw error;
                throw new Error(`Provider checkpoint namespace already exists: ${checkpoint.checkpointId}.`);
            }
        });
    }

    async readLatest(reference) {
        validateCheckpoint(reference);
        const checkpoint = await readJson(this.latestPath(reference));
        validateCheckpoint(checkpoint);
        return checkpoint;
    }

    assertConfiguration(checkpoint, input) {
        validateCheckpoint(checkpoint);
        const hash = stableSourceConfigurationHash(input.sourceConfiguration);
        if (checkpoint.provider !== input.provider || checkpoint.adapterId !== input.adapterId || checkpoint.adapterVersion !== input.adapterVersion || checkpoint.stableConfigurationHash !== hash) {
            throw new Error("Provider checkpoint configuration drift; create a new checkpoint namespace explicitly.");
        }
        return true;
    }

    async resumeCheckpoint(reference, input) {
        this.assertConfiguration(reference, input);
        const latest = await this.readLatest(reference);
        this.assertConfiguration(latest, input);
        return latest;
    }

    async updateCheckpoint(reference, input) {
        return this.withWriterLock(async () => {
            this.assertConfiguration(reference, input);
            const current = await this.readLatest(reference);
            this.assertConfiguration(current, input);
            if (input.expectedRevision !== current.revision) throw new Error(`Stale provider checkpoint revision: expected current ${current.revision}, received ${input.expectedRevision}.`);
            const position = structuredClone(input.position || current.position);
            if (position.providerPage < current.position.providerPage || (position.providerPage === current.position.providerPage && position.itemOffset < current.position.itemOffset)) {
                throw new Error("Provider checkpoint position cannot move backward.");
            }
            const next = {
                ...current,
                revision: current.revision + 1,
                position,
                rollingWindowIdentity: input.rollingWindowIdentity === undefined ? current.rollingWindowIdentity : structuredClone(input.rollingWindowIdentity),
                exhausted: input.exhausted === undefined ? current.exhausted : input.exhausted,
                lastCompletedRunId: input.lastCompletedRunId === undefined ? current.lastCompletedRunId : input.lastCompletedRunId,
                latestRawPageEvidenceRef: input.latestRawPageEvidenceRef === undefined ? current.latestRawPageEvidenceRef : input.latestRawPageEvidenceRef,
                updatedAt: input.updatedAt || this.clock()
            };
            validateCheckpoint(next);
            return this.persist(next);
        });
    }
}

module.exports = { ProviderCheckpointStore };
