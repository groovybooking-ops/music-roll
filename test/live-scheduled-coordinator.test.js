const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const path = require("path");
const { LiveScheduledCoordinator } = require("../lib/scheduling/live-scheduled-coordinator");
const { parseArguments } = require("../scripts/run-live-scheduled-ingestion");

const projectRoot = path.join(__dirname, "..");
const configurationFile = path.join(projectRoot, "data/ingestion/scheduled/v1/configurations/first-human-live-v1.json");
const secondConfigurationFile = path.join(projectRoot, "data/ingestion/scheduled/v1/configurations/second-human-live-v1.json");
const thirdConfigurationFile = path.join(projectRoot, "data/ingestion/scheduled/v1/configurations/third-human-live-v1.json");

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

test("second live configuration uses a distinct bounded source namespace and expanded worker backlog cap", async () => {
    const first = JSON.parse(await fs.readFile(configurationFile, "utf8"));
    const second = JSON.parse(await fs.readFile(secondConfigurationFile, "utf8"));
    assert.notEqual(second.spotify.queryRecordId, first.spotify.queryRecordId);
    assert.notEqual(second.ticketmaster.stateCode, first.ticketmaster.stateCode);
    assert.notEqual(second.ticketmaster.startDateTime, first.ticketmaster.startDateTime);
    assert.deepEqual(second.budgets.providers.spotify, { maxRequests: 4, maxPages: 1, maxNormalizedOccurrences: 8, maxNewCandidates: 4 });
    assert.deepEqual(second.budgets.providers.ticketmaster, { maxRequests: 4, maxPages: 1, maxNormalizedOccurrences: 8, maxNewCandidates: 4 });
    assert.deepEqual(second.budgets.workers, { stage3Candidates: 5, identityDiscoveryCandidates: 3 });
    assert.equal(second.maximumTotalNewCandidates, 6);
    assert.equal(second.reviewOnly, true);
});

test("third live configuration preserves caps in another distinct source namespace", async () => {
    const first = JSON.parse(await fs.readFile(configurationFile, "utf8"));
    const second = JSON.parse(await fs.readFile(secondConfigurationFile, "utf8"));
    const third = JSON.parse(await fs.readFile(thirdConfigurationFile, "utf8"));
    assert.equal(new Set([first.spotify.queryRecordId, second.spotify.queryRecordId, third.spotify.queryRecordId]).size, 3);
    assert.equal(new Set([first.ticketmaster.stateCode, second.ticketmaster.stateCode, third.ticketmaster.stateCode]).size, 3);
    assert.equal(new Set([first.ticketmaster.startDateTime, second.ticketmaster.startDateTime, third.ticketmaster.startDateTime]).size, 3);
    assert.deepEqual(third.budgets.providers.spotify, { maxRequests: 4, maxPages: 1, maxNormalizedOccurrences: 8, maxNewCandidates: 4 });
    assert.deepEqual(third.budgets.providers.ticketmaster, { maxRequests: 4, maxPages: 1, maxNormalizedOccurrences: 8, maxNewCandidates: 4 });
    assert.deepEqual(third.budgets.workers, { stage3Candidates: 5, identityDiscoveryCandidates: 3 });
    assert.equal(third.maximumTotalNewCandidates, 6);
    assert.equal(third.reviewOnly, true);
});
