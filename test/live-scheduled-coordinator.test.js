const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { LiveScheduledCoordinator } = require("../lib/scheduling/live-scheduled-coordinator");
const { parseArguments } = require("../scripts/run-live-scheduled-ingestion");

const projectRoot = path.join(__dirname, "..");
const configurationFile = path.join(projectRoot, "data/ingestion/scheduled/v1/configurations/first-human-live-v1.json");

test("live scheduled coordinator requires the explicit network gate", async () => {
    const configuration = JSON.parse(await fs.readFile(configurationFile, "utf8"));
    assert.throws(() => new LiveScheduledCoordinator({ projectRoot, scheduledRoot: path.join(projectRoot, "data/ingestion/scheduled/v1"), configuration, allowNetwork: false }), /--allow-network/);
    assert.deepEqual(parseArguments(["--allow-network", "--run-id", "mr_discovery_run_fixture"]), { allowNetwork: true, runId: "mr_discovery_run_fixture" });
});

test("first live scheduled configuration preserves all approved hard caps", async () => {
    const configuration = JSON.parse(await fs.readFile(configurationFile, "utf8"));
    assert.deepEqual(configuration.budgets.providers.spotify, { maxRequests: 4, maxPages: 1, maxNormalizedOccurrences: 8, maxNewCandidates: 4 });
    assert.deepEqual(configuration.budgets.providers.ticketmaster, { maxRequests: 4, maxPages: 1, maxNormalizedOccurrences: 8, maxNewCandidates: 4 });
    assert.deepEqual(configuration.budgets.workers, { stage3Candidates: 3, identityDiscoveryCandidates: 2 });
    assert.equal(configuration.maximumTotalNewCandidates, 6);
    assert.equal(configuration.reviewOnly, true);
});
