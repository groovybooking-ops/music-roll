const fs = require("fs/promises");
const path = require("path");
const { cacheRelativePath } = require("../batch-identity-corroboration");
const { CANDIDATE_ID_PATTERN } = require("./candidate-schema");
const { OfflineCacheMissError, sha256 } = require("./identity-evidence-store");

class IdentityDiscoveryEvidenceStore {
    constructor(storeRoot, options = {}) {
        this.storeRoot = path.resolve(storeRoot);
        this.cacheRoot = path.join(this.storeRoot, "provider-cache", "v1");
        this.evidenceRoot = path.join(this.storeRoot, "evidence", "identity-discovery");
        this.clock = options.clock || (() => new Date().toISOString());
        this.fixtureMode = options.fixtureMode === true;
        this.allowNetwork = options.allowNetwork === true;
        this.metrics = options.metrics || { cacheHits: 0, cacheMisses: 0, liveRequests: 0, retries: 0, immutableEvidenceWrites: 0, immutableEvidenceReuses: 0, byProvider: {} };
    }

    relative(file) {
        return path.relative(this.storeRoot, file).split(path.sep).join("/");
    }

    cacheFile(provider, identifier, operation) {
        return path.join(this.cacheRoot, cacheRelativePath(provider, identifier, operation));
    }

    async readJson(file) {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }

    async writeExclusive(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    }

    async getCached({ provider, identifier, operation }) {
        const file = this.cacheFile(provider, identifier, operation);
        let envelope;
        try { envelope = await this.readJson(file); }
        catch (error) {
            if (error.code !== "ENOENT") throw error;
            this.metrics.cacheMisses += 1;
            throw new OfflineCacheMissError(provider, operation, identifier);
        }
        this.metrics.cacheHits += 1;
        this.metrics.byProvider[provider] ||= { cacheHits: 0, cacheMisses: 0 };
        this.metrics.byProvider[provider].cacheHits += 1;
        if (envelope.error) {
            const error = new Error(envelope.error.message);
            error.name = envelope.error.name || "CachedProviderError";
            error.statusCode = envelope.error.statusCode || null;
            error.retryable = envelope.error.retryable === true;
            error.provider = provider;
            error.operation = operation;
            error.identifier = identifier;
            error.evidenceRef = this.relative(file);
            throw error;
        }
        return { value: envelope.value, evidenceRef: this.relative(file), cacheHit: true };
    }

    async getOrAcquire({ provider, identifier, operation, acquire }) {
        try { return await this.getCached({ provider, identifier, operation }); }
        catch (error) {
            if (!(error instanceof OfflineCacheMissError)) throw error;
            if (!this.allowNetwork) throw error;
        }
        if (typeof acquire !== "function") throw new Error("Identity-discovery acquisition callback is required for a cache miss.");
        const file = this.cacheFile(provider, identifier, operation);
        let value;
        try { value = await acquire(); }
        catch (error) {
            if (![400, 404, 409, 410, 422].includes(error.statusCode)) throw error;
            const envelope = { schemaVersion: 1, provider, operation, identifier: String(identifier), retrievedAt: this.clock(), value: null, error: { name: error.name, message: error.message, statusCode: error.statusCode, retryable: false } };
            try { await this.writeExclusive(file, envelope); } catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
            error.evidenceRef = this.relative(file);
            throw error;
        }
        const envelope = { schemaVersion: 1, provider, operation, identifier: String(identifier), retrievedAt: this.clock(), value };
        try { await this.writeExclusive(file, envelope); }
        catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = await this.readJson(file);
            return { value: existing.value, evidenceRef: this.relative(file), cacheHit: true };
        }
        return { value, evidenceRef: this.relative(file), cacheHit: false };
    }

    async seedFixture({ provider, identifier, operation, value, error = null }) {
        if (!this.fixtureMode) throw new Error("Provider cache fixtures may be seeded only in fixture mode.");
        const file = this.cacheFile(provider, identifier, operation);
        const envelope = {
            schemaVersion: 1,
            provider,
            operation,
            identifier: String(identifier),
            retrievedAt: this.clock(),
            value: error ? null : value,
            ...(error ? { error } : {})
        };
        try { await this.writeExclusive(file, envelope); }
        catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
        return this.relative(file);
    }

    async persistIdentityDiscoveryEvidence(candidateId, payload, provenanceRefs = []) {
        if (!CANDIDATE_ID_PATTERN.test(candidateId || "")) throw new Error("Identity-discovery evidence has an invalid candidate ID.");
        const body = {
            schemaVersion: 1,
            candidateId,
            evidenceType: "exact_spotify_bridge_discovery",
            resolverVersion: "identity_discovery_resolver_v1",
            payload,
            provenanceRefs: [...new Set(provenanceRefs)].sort(),
            reviewOnly: true
        };
        const digest = sha256(body);
        const file = path.join(this.evidenceRoot, candidateId, `${digest}.json`);
        const envelope = { evidenceId: `sha256:${digest}`, createdAt: this.clock(), ...body };
        try {
            await this.writeExclusive(file, envelope);
            this.metrics.immutableEvidenceWrites += 1;
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = await this.readJson(file);
            const existingBody = {
                schemaVersion: existing.schemaVersion,
                candidateId: existing.candidateId,
                evidenceType: existing.evidenceType,
                resolverVersion: existing.resolverVersion,
                payload: existing.payload,
                provenanceRefs: existing.provenanceRefs,
                reviewOnly: existing.reviewOnly
            };
            if (sha256(existingBody) !== digest) throw new Error(`Immutable identity-discovery evidence collision: ${file}.`);
            this.metrics.immutableEvidenceReuses += 1;
        }
        return { evidenceId: `sha256:${digest}`, evidenceRef: this.relative(file), digest };
    }
}

module.exports = { IdentityDiscoveryEvidenceStore };
