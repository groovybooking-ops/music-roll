const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function safeHash(value) {
    return String(value).replace(/^sha256:/, "");
}

class ImmutableListingCache {
    constructor(storeRoot, options = {}) {
        this.storeRoot = path.resolve(storeRoot);
        this.root = path.join(this.storeRoot, "discovery", "provider-listing-cache");
        this.clock = options.clock || (() => new Date().toISOString());
        this.freshnessMs = options.freshnessMs ?? 24 * 60 * 60 * 1000;
    }

    file(provider, configurationHash) {
        assert(/^[a-z][a-z0-9_]*$/.test(provider || ""), "Listing cache provider is invalid.");
        assert(/^sha256:[0-9a-f]{64}$/.test(configurationHash || ""), "Listing cache configuration hash is invalid.");
        return path.join(this.root, provider, `${safeHash(configurationHash)}.json`);
    }

    evidenceRef(file) {
        return path.relative(this.storeRoot, file).split(path.sep).join("/");
    }

    async read(provider, configurationHash, options = {}) {
        const file = this.file(provider, configurationHash);
        let artifact;
        try { artifact = JSON.parse(await fs.readFile(file, "utf8")); }
        catch (error) {
            if (error.code === "ENOENT") return null;
            throw error;
        }
        const now = new Date(options.now || this.clock()).getTime();
        const retrievedAt = new Date(artifact.retrievedAt).getTime();
        if (!Number.isFinite(retrievedAt) || now - retrievedAt > this.freshnessMs) return null;
        assert(artifact.provider === provider && artifact.configurationHash === configurationHash, "Listing cache metadata drifted.");
        return { artifact, evidenceRef: this.evidenceRef(file) };
    }

    async write(provider, configurationHash, raw, metadata = {}) {
        const file = this.file(provider, configurationHash);
        const artifact = {
            schemaVersion: 1,
            provider,
            configurationHash,
            retrievedAt: metadata.retrievedAt || this.clock(),
            requestUrl: metadata.requestUrl || null,
            responseDigest: `sha256:${crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex")}`,
            raw
        };
        await fs.mkdir(path.dirname(file), { recursive: true });
        try { await fs.writeFile(file, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" }); }
        catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = JSON.parse(await fs.readFile(file, "utf8"));
            if (existing.responseDigest !== artifact.responseDigest) throw new Error(`Immutable listing cache collision: ${file}`);
            return { artifact: existing, evidenceRef: this.evidenceRef(file), created: false };
        }
        return { artifact, evidenceRef: this.evidenceRef(file), created: true };
    }
}

class BoundedRequestLedger {
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl || fetch;
        this.waitImpl = options.waitImpl || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.caps = { total: options.totalCap ?? 8, spotify: options.spotifyCap ?? 4, ticketmaster: options.ticketmasterCap ?? 4 };
        this.requests = { total: 0, spotify: 0, ticketmaster: 0 };
        this.retries = { total: 0, spotify: 0, ticketmaster: 0 };
        this.errors = [];
    }

    reserve(provider) {
        assert(["spotify", "ticketmaster"].includes(provider), "Unsupported live discovery provider.");
        if (this.requests.total >= this.caps.total || this.requests[provider] >= this.caps[provider]) {
            throw new Error(`Live discovery request cap reached before another ${provider} request.`);
        }
        this.requests.total += 1;
        this.requests[provider] += 1;
    }

    async json(provider, url, init = {}, options = {}) {
        const maxRetries = options.maxRetries ?? 1;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            this.reserve(provider);
            let response;
            try { response = await this.fetchImpl(url, init); }
            catch (error) {
                if (attempt < maxRetries) {
                    this.retries.total += 1;
                    this.retries[provider] += 1;
                    await this.waitImpl(250 * (2 ** attempt));
                    continue;
                }
                this.errors.push({ provider, status: null, message: error.message });
                throw error;
            }
            let body = null;
            try { body = await response.json(); }
            catch (error) {
                this.errors.push({ provider, status: response.status, message: "invalid_json" });
                throw new Error(`${provider} returned invalid JSON.`);
            }
            if (response.ok) return { body, url: String(url), status: response.status };
            const retryable = [429, 500, 502, 503, 504].includes(response.status);
            if (retryable && attempt < maxRetries) {
                this.retries.total += 1;
                this.retries[provider] += 1;
                const retryAfter = Number(response.headers?.get?.("retry-after"));
                await this.waitImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 250 * (2 ** attempt));
                continue;
            }
            const message = body?.error?.message || body?.fault?.faultstring || body?.errors?.[0]?.detail || `${provider} request failed with status ${response.status}.`;
            this.errors.push({ provider, status: response.status, message });
            const error = new Error(message);
            error.statusCode = response.status;
            throw error;
        }
    }
}

module.exports = { BoundedRequestLedger, ImmutableListingCache };
