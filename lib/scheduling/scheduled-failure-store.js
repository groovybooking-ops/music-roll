const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { validateCircuitBreaker } = require("./provider-failure-policy");
const { retryRecordKey, validateRetryRecord } = require("./candidate-retry-policy");

function safeProvider(provider) {
    if (!/^[a-z0-9_-]+$/.test(provider || "")) throw new Error("Invalid provider failure-store key.");
    return provider;
}
function retryDigest(record) { return crypto.createHash("sha256").update(retryRecordKey(record.candidateId, record.provider, record.operation)).digest("hex"); }

class ScheduledFailureStore {
    constructor(root) { if (!root) throw new Error("Scheduled failure-store root is required."); this.root = path.resolve(root); }
    breakerSnapshot(provider) { return path.join(this.root, "provider-breakers", `${safeProvider(provider)}.json`); }
    breakerHistory(provider, revision) { return path.join(this.root, "provider-breakers", "history", safeProvider(provider), `${String(revision).padStart(6, "0")}.json`); }
    retrySnapshot(record) { return path.join(this.root, "candidate-retries", `${retryDigest(record)}.json`); }
    retryHistory(record) { return path.join(this.root, "candidate-retries", "history", retryDigest(record), `${String(record.attemptCount).padStart(6, "0")}.json`); }
    async read(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
    async readBreaker(provider) { return this.read(this.breakerSnapshot(provider)).catch(error => error.code === "ENOENT" ? null : Promise.reject(error)); }
    async readRetry(record) { return this.read(this.retrySnapshot(record)).catch(error => error.code === "ENOENT" ? null : Promise.reject(error)); }
    async writeAtomic(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        try { await fs.rename(temporary, file); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    }
    async persistBreaker(record, expectedRevision) {
        validateCircuitBreaker(record);
        const current = await this.readBreaker(record.provider);
        const currentRevision = current?.revision ?? -1;
        if (currentRevision !== expectedRevision) throw new Error(`Stale circuit-breaker revision: expected current ${currentRevision}, received ${expectedRevision}.`);
        const history = this.breakerHistory(record.provider, record.revision);
        await fs.mkdir(path.dirname(history), { recursive: true });
        await fs.writeFile(history, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
        await this.writeAtomic(this.breakerSnapshot(record.provider), record);
        return record;
    }
    async persistRetry(record, expectedAttemptCount) {
        validateRetryRecord(record);
        const current = await this.readRetry(record);
        const currentAttempt = current?.attemptCount ?? 0;
        if (currentAttempt !== expectedAttemptCount) throw new Error(`Stale retry attempt count: expected current ${currentAttempt}, received ${expectedAttemptCount}.`);
        const history = this.retryHistory(record);
        await fs.mkdir(path.dirname(history), { recursive: true });
        await fs.writeFile(history, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
        await this.writeAtomic(this.retrySnapshot(record), record);
        return record;
    }
}
module.exports = { ScheduledFailureStore };
