const crypto = require("crypto");
const { RUN_ID_PATTERN } = require("./scheduled-run-schema");

const CHECKPOINT_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VOLATILE_CONFIGURATION_KEYS = new Set(["runTimestamp", "discoveredAt", "createdAt", "startedAt", "completedAt"]);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function canonicalizeSourceConfiguration(value) {
    if (Array.isArray(value)) return value.map(canonicalizeSourceConfiguration);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).filter(key => !VOLATILE_CONFIGURATION_KEYS.has(key)).sort()
            .map(key => [key, canonicalizeSourceConfiguration(value[key])]));
    }
    return value;
}

function stableSourceConfigurationHash(configuration) {
    assert(configuration && typeof configuration === "object" && !Array.isArray(configuration), "Provider source configuration must be an object.");
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalizeSourceConfiguration(configuration))).digest("hex")}`;
}

function checkpointIdFor({ provider, adapterId, adapterVersion, stableConfigurationHash }) {
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify({ provider, adapterId, adapterVersion, stableConfigurationHash })).digest("hex")}`;
}

function validTimestamp(value) {
    return typeof value === "string" && value.trim() && !Number.isNaN(Date.parse(value));
}

function validateCheckpoint(checkpoint) {
    assert(checkpoint?.schemaVersion === 1, "Provider checkpoint schemaVersion must be 1.");
    assert(CHECKPOINT_ID_PATTERN.test(checkpoint.checkpointId || ""), "Provider checkpoint ID is invalid.");
    assert(/^[a-z][a-z0-9_]*$/.test(checkpoint.provider || ""), "Provider checkpoint provider is invalid.");
    assert(/^[a-z][a-z0-9_]*$/.test(checkpoint.adapterId || ""), "Provider checkpoint adapter ID is invalid.");
    assert(/^v[1-9][0-9]*$/.test(checkpoint.adapterVersion || ""), "Provider checkpoint adapter version is invalid.");
    assert(HASH_PATTERN.test(checkpoint.stableConfigurationHash || ""), "Provider checkpoint configuration hash is invalid.");
    assert(checkpoint.checkpointId === checkpointIdFor(checkpoint), "Provider checkpoint namespace identity drifted.");
    assert(Number.isInteger(checkpoint.revision) && checkpoint.revision >= 1, "Provider checkpoint revision is invalid.");
    assert(Number.isInteger(checkpoint.position?.providerPage) && checkpoint.position.providerPage >= 0, "Provider checkpoint page is invalid.");
    assert(checkpoint.position.cursor == null || typeof checkpoint.position.cursor === "string", "Provider checkpoint cursor is invalid.");
    assert(Number.isInteger(checkpoint.position.itemOffset) && checkpoint.position.itemOffset >= 0, "Provider checkpoint item offset is invalid.");
    assert(checkpoint.rollingWindowIdentity == null || typeof checkpoint.rollingWindowIdentity === "string" || (typeof checkpoint.rollingWindowIdentity === "object" && !Array.isArray(checkpoint.rollingWindowIdentity)), "Provider checkpoint rolling-window identity is invalid.");
    assert(typeof checkpoint.exhausted === "boolean", "Provider checkpoint exhausted state is invalid.");
    assert(checkpoint.lastCompletedRunId == null || RUN_ID_PATTERN.test(checkpoint.lastCompletedRunId), "Provider checkpoint last completed run ID is invalid.");
    assert(checkpoint.latestRawPageEvidenceRef == null || (typeof checkpoint.latestRawPageEvidenceRef === "string" && checkpoint.latestRawPageEvidenceRef.trim()), "Provider checkpoint raw-page evidence ref is invalid.");
    assert(validTimestamp(checkpoint.createdAt) && validTimestamp(checkpoint.updatedAt), "Provider checkpoint timestamps are invalid.");
    assert(Date.parse(checkpoint.updatedAt) >= Date.parse(checkpoint.createdAt), "Provider checkpoint timestamps are reversed.");
    return true;
}

module.exports = {
    CHECKPOINT_ID_PATTERN,
    VOLATILE_CONFIGURATION_KEYS,
    canonicalizeSourceConfiguration,
    checkpointIdFor,
    stableSourceConfigurationHash,
    validateCheckpoint
};
