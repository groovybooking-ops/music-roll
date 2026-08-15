function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function createFixtureCheckpoint(configurationHash) {
    assert(/^sha256:[0-9a-f]{64}$/.test(configurationHash || ""), "Fixture checkpoint configuration hash is invalid.");
    return {
        schemaVersion: 1,
        configurationHash,
        providerPage: 0,
        itemOffset: 0,
        exhausted: false
    };
}

function validateFixtureCheckpoint(checkpoint, configurationHash) {
    assert(checkpoint?.schemaVersion === 1, "Fixture checkpoint schemaVersion must be 1.");
    assert(checkpoint.configurationHash === configurationHash, "Fixture checkpoint configuration hash does not match the adapter configuration.");
    assert(Number.isInteger(checkpoint.providerPage) && checkpoint.providerPage >= 0, "Fixture checkpoint provider page is invalid.");
    assert(Number.isInteger(checkpoint.itemOffset) && checkpoint.itemOffset >= 0, "Fixture checkpoint item offset is invalid.");
    assert(typeof checkpoint.exhausted === "boolean", "Fixture checkpoint exhausted state is invalid.");
    return true;
}

function advanceFixtureCheckpoint({ checkpoint, configurationHash, pageItemCount, consumedItems, hasNextPage }) {
    validateFixtureCheckpoint(checkpoint, configurationHash);
    assert(!checkpoint.exhausted, "Cannot advance an exhausted fixture checkpoint.");
    assert(Number.isInteger(pageItemCount) && pageItemCount >= 0, "Fixture page item count is invalid.");
    assert(checkpoint.itemOffset <= pageItemCount, "Fixture checkpoint item offset exceeds the page size.");
    assert(Number.isInteger(consumedItems) && consumedItems >= 0, "Fixture consumed item count is invalid.");
    assert(checkpoint.itemOffset + consumedItems <= pageItemCount, "Fixture checkpoint consumed beyond the current page.");
    const nextOffset = checkpoint.itemOffset + consumedItems;
    if (nextOffset < pageItemCount) return { ...checkpoint, itemOffset: nextOffset };
    return {
        schemaVersion: 1,
        configurationHash,
        providerPage: checkpoint.providerPage + 1,
        itemOffset: 0,
        exhausted: !hasNextPage
    };
}

module.exports = { advanceFixtureCheckpoint, createFixtureCheckpoint, validateFixtureCheckpoint };
