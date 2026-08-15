const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { cacheRelativePath } = require("../batch-identity-corroboration");
const { CANDIDATE_ID_PATTERN } = require("./candidate-schema");

class OfflineCacheMissError extends Error {
    constructor(provider, operation, identifier) {
        super(`Offline cache miss for ${provider}/${operation}/${identifier}; rerun only with explicit --allow-network approval.`);
        this.name = "OfflineCacheMissError";
        this.provider = provider;
        this.operation = operation;
        this.identifier = identifier;
        this.retryable = true;
    }
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
}

function stableStringify(value) {
    return JSON.stringify(canonicalize(value));
}

function sha256(value) {
    return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
}

class IdentityEvidenceStore {
    constructor(storeRoot, options = {}) {
        this.storeRoot = path.resolve(storeRoot);
        this.cacheRoot = path.join(this.storeRoot, "provider-cache", "v1");
        this.evidenceRoot = path.join(this.storeRoot, "evidence", "identity");
        this.clock = options.clock || (() => new Date().toISOString());
        this.allowNetwork = options.allowNetwork === true;
        this.metrics = options.metrics || {
            cacheHits: 0,
            liveRequests: 0,
            retries: 0,
            immutableEvidenceReuses: 0,
            immutableEvidenceWrites: 0,
            byProvider: {}
        };
    }

    relative(file) {
        return path.relative(this.storeRoot, file).split(path.sep).join("/");
    }

    async readJson(file) {
        return JSON.parse(await fs.readFile(file, "utf8"));
    }

    async writeExclusive(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    }

    async getOrAcquire({ provider, identifier, operation, acquire }) {
        const file = path.join(this.cacheRoot, cacheRelativePath(provider, identifier, operation));
        try {
            const envelope = await this.readJson(file);
            this.metrics.cacheHits += 1;
            this.metrics.byProvider[provider] ||= { cacheHits: 0, liveRequests: 0 };
            this.metrics.byProvider[provider].cacheHits += 1;
            if (envelope.error) {
                const cachedError = new Error(envelope.error.message);
                cachedError.name = envelope.error.name || "CachedProviderError";
                cachedError.statusCode = envelope.error.statusCode || null;
                cachedError.evidenceRef = this.relative(file);
                throw cachedError;
            }
            return { value: envelope.value, evidenceRef: this.relative(file), cacheHit: true };
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (!this.allowNetwork) throw new OfflineCacheMissError(provider, operation, identifier);
        if (typeof acquire !== "function") throw new Error("Provider acquisition callback is required for a cache miss.");
        let value;
        try {
            value = await acquire();
        } catch (error) {
            if (![400, 404, 409, 410, 422].includes(error.statusCode)) throw error;
            const envelope = {
                schemaVersion: 1,
                provider,
                operation,
                identifier: String(identifier),
                retrievedAt: this.clock(),
                value: null,
                error: { name: error.name, message: error.message, statusCode: error.statusCode }
            };
            try { await this.writeExclusive(file, envelope); } catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
            error.evidenceRef = this.relative(file);
            throw error;
        }
        const envelope = {
            schemaVersion: 1,
            provider,
            operation,
            identifier: String(identifier),
            retrievedAt: this.clock(),
            value
        };
        try {
            await this.writeExclusive(file, envelope);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = await this.readJson(file);
            return { value: existing.value, evidenceRef: this.relative(file), cacheHit: true };
        }
        return { value, evidenceRef: this.relative(file), cacheHit: false };
    }

    async persistIdentityEvidence(candidateId, payload, provenanceRefs = []) {
        if (!CANDIDATE_ID_PATTERN.test(candidateId || "")) throw new Error("Identity evidence has an invalid candidate ID.");
        const body = {
            schemaVersion: 1,
            candidateId,
            evidenceType: "identity_resolution",
            resolverVersion: "queue_identity_resolver_v1",
            payload,
            provenanceRefs: [...new Set(provenanceRefs)].sort()
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
            if (sha256({
                schemaVersion: existing.schemaVersion,
                candidateId: existing.candidateId,
                evidenceType: existing.evidenceType,
                resolverVersion: existing.resolverVersion,
                payload: existing.payload,
                provenanceRefs: existing.provenanceRefs
            }) !== digest) throw new Error(`Immutable identity evidence collision: ${file}.`);
            this.metrics.immutableEvidenceReuses += 1;
        }
        return { evidenceId: `sha256:${digest}`, evidenceRef: this.relative(file), digest };
    }
}

module.exports = { IdentityEvidenceStore, OfflineCacheMissError, canonicalize, sha256, stableStringify };
