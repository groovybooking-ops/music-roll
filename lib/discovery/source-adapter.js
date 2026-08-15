const crypto = require("crypto");
const { validateDiscoveryOccurrence } = require("./discovery-schema");

const REQUIRED_METHODS = Object.freeze([
    "validateConfiguration",
    "acquirePage",
    "normalizePage",
    "nextCheckpoint"
]);

function configurationHash(configuration) {
    const canonical = value => Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
            : value;
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical(configuration))).digest("hex")}`;
}

function defineDiscoverySourceAdapter(adapter) {
    if (!adapter || typeof adapter !== "object") throw new Error("Discovery source adapter is required.");
    if (!/^[a-z][a-z0-9_]*$/.test(adapter.adapterId || "")) throw new Error("Discovery source adapter ID is invalid.");
    if (!/^[a-z][a-z0-9_]*$/.test(adapter.provider || "")) throw new Error("Discovery source provider is invalid.");
    if (!/^v[1-9][0-9]*$/.test(adapter.adapterVersion || "")) throw new Error("Discovery source adapter version is invalid.");
    for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") throw new Error(`Discovery source adapter is missing ${method}().`);
    const canonicalConfigurationHash = adapter.canonicalConfigurationHash || adapter.configurationHash || configurationHash;
    return Object.freeze({
        adapterId: adapter.adapterId,
        provider: adapter.provider,
        adapterVersion: adapter.adapterVersion,
        validateConfiguration: adapter.validateConfiguration,
        canonicalConfigurationHash,
        configurationHash: canonicalConfigurationHash,
        acquirePage: adapter.acquirePage,
        normalizePage(page, context) {
            const occurrences = adapter.normalizePage(page, context);
            if (!Array.isArray(occurrences)) throw new Error("Discovery adapter normalizePage() must return an array.");
            for (const occurrence of occurrences) {
                validateDiscoveryOccurrence(occurrence);
                if (occurrence.provider !== adapter.provider) throw new Error("Discovery adapter emitted an occurrence for another provider.");
            }
            return occurrences;
        },
        nextCheckpoint: adapter.nextCheckpoint
    });
}

module.exports = { REQUIRED_METHODS, configurationHash, defineDiscoverySourceAdapter };
