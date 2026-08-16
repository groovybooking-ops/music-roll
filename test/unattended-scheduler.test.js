const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
    JOBS,
    buildCoordinatorConfiguration,
    generateLaunchdDefinitions,
    loadSchedulerConfiguration,
    pauseScheduler,
    prepareLaunchdLogs,
    resumeScheduler,
    runUnattendedJob,
    schedulerPaused,
    schedulerStatus
} = require("../lib/scheduling/unattended-scheduler");

const projectRoot = path.join(__dirname, "..");
const configurationFile = path.join(projectRoot, "config", "scheduled-ingestion.macos.json");

async function temporaryConfiguration(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-unattended-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = await loadSchedulerConfiguration(configurationFile);
    return {
        ...source,
        repositoryRoot: projectRoot,
        scheduledRoot: path.join(root, "scheduled"),
        environmentFile: path.join(projectRoot, ".env"),
        generatedPlistDirectory: path.join(root, "generated"),
        launchAgentsDirectory: path.join(root, "LaunchAgents"),
        logDirectory: path.join(root, "logs"),
        controlDirectory: path.join(root, "control"),
        invocationDirectory: path.join(root, "invocations"),
        lockFile: path.join(root, "control", "unattended.lock"),
        pauseFile: path.join(root, "control", "PAUSED.json")
    };
}

test("generated plists are valid, absolute, schedule-specific, and contain no credentials", async t => {
    const configuration = await temporaryConfiguration(t);
    const files = await generateLaunchdDefinitions(configuration, { nodePath: process.execPath });
    assert.equal(files.length, 4);
    for (const file of files) {
        const bytes = await fs.readFile(file, "utf8");
        assert.match(bytes, new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(bytes, /SPOTIFY_CLIENT|TICKETMASTER_API|client_secret|access_token|Authorization|EnvironmentVariables/i);
        assert.equal(spawnSync("plutil", ["-lint", file]).status, 0);
    }
    const spotify = await fs.readFile(files.find(file => file.includes("spotify-discovery")), "utf8");
    assert.match(spotify, /<integer>2<\/integer>/); assert.match(spotify, /<integer>5<\/integer>/); assert.match(spotify, /<integer>3<\/integer>/); assert.match(spotify, /<integer>5<\/integer>/);
});

test("provider and worker jobs use isolated lanes with unchanged safety caps", async t => {
    const configuration = await temporaryConfiguration(t); const now = new Date("2026-08-18T10:00:00Z");
    const spotify = buildCoordinatorConfiguration(configuration, "spotify_discovery", now);
    const ticketmaster = buildCoordinatorConfiguration(configuration, "ticketmaster_discovery", now);
    const workers = buildCoordinatorConfiguration(configuration, "daily_processing", now);
    assert.equal(spotify.spotify.enabled, true); assert.equal(spotify.ticketmaster.enabled, false); assert.deepEqual(spotify.budgets.workers, { stage3Candidates: 0, identityDiscoveryCandidates: 0 });
    assert.equal(ticketmaster.spotify.enabled, false); assert.equal(ticketmaster.ticketmaster.enabled, true); assert.equal(ticketmaster.budgets.providers.ticketmaster.maxRequests, 4);
    assert.equal(workers.spotify.enabled, false); assert.equal(workers.ticketmaster.enabled, false); assert.deepEqual(workers.budgets.workers, { stage3Candidates: 5, identityDiscoveryCandidates: 3 });
    assert.equal(workers.maximumTotalNewCandidates, 6); assert.equal(workers.reviewOnly, true);
});

test("pause and resume are idempotent and paused acquisition skips without invoking a coordinator", async t => {
    const configuration = await temporaryConfiguration(t);
    assert.equal(await schedulerPaused(configuration), false);
    assert.equal((await pauseScheduler(configuration, "fixture_pause")).changed, true);
    assert.equal((await pauseScheduler(configuration, "fixture_pause")).changed, false);
    let invoked = false;
    const result = await runUnattendedJob(configuration, "spotify_discovery", { allowNetwork: true, now: "2026-08-18T10:00:00Z", coordinatorFactory() { invoked = true; } });
    assert.equal(result.status, "skipped_paused"); assert.equal(result.networkRequests, 0); assert.equal(result.candidatesFailed, 0); assert.equal(invoked, false);
    assert.equal((await resumeScheduler(configuration)).changed, true); assert.equal((await resumeScheduler(configuration)).changed, false); assert.equal(await schedulerPaused(configuration), false);
});

test("an overlapping scheduler lock records a safe skip and does not manufacture candidate failure", async t => {
    const configuration = await temporaryConfiguration(t);
    await fs.mkdir(path.dirname(configuration.lockFile), { recursive: true });
    await fs.writeFile(configuration.lockFile, JSON.stringify({ schemaVersion: 1, pid: process.pid, job: "fixture_active", acquiredAt: "2026-08-18T09:59:00Z" }));
    const result = await runUnattendedJob(configuration, "daily_processing", { allowNetwork: true, now: "2026-08-18T10:00:00Z" });
    assert.equal(result.status, "skipped_locked"); assert.equal(result.networkRequests, 0); assert.equal(result.candidatesFailed, 0);
    assert.equal((await fs.readdir(configuration.invocationDirectory)).length, 1);
});

test("successful scheduled simulation records run ID and leaves protected live files unchanged", async t => {
    const configuration = await temporaryConfiguration(t);
    const protectedFiles = [path.join(projectRoot, "data/artists.json"), path.join(projectRoot, "data/artist-id-registry.json")];
    const before = await Promise.all(protectedFiles.map(file => fs.readFile(file, "utf8")));
    const result = await runUnattendedJob(configuration, "daily_processing", {
        allowNetwork: true,
        now: "2026-08-18T10:00:00Z",
        coordinatorFactory(input) {
            assert.equal(input.configuration.spotify.enabled, false); assert.equal(input.configuration.ticketmaster.enabled, false);
            return { async run() { return { manifest: { runId: "mr_discovery_run_fixture" }, phasesExecuted: ["stage3_complete", "identity_discovery_complete", "summary_complete"], report: { dailySummary: { artifactDigest: `sha256:${"a".repeat(64)}` } } }; } };
        }
    });
    assert.equal(result.status, "succeeded"); assert.equal(result.runId, "mr_discovery_run_fixture");
    assert.deepEqual(await Promise.all(protectedFiles.map(file => fs.readFile(file, "utf8"))), before);
});

test("daily processing uses the real coordinator with both discovery lanes cleanly skipped", async t => {
    const configuration = await temporaryConfiguration(t);
    const result = await runUnattendedJob(configuration, "daily_processing", {
        allowNetwork: true,
        now: "2026-08-18T10:00:00Z",
        fetchImpl() { throw new Error("disabled provider unexpectedly attempted network"); }
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.result.phasesExecuted, ["spotify_discovery_complete_or_skipped", "ticketmaster_discovery_complete_or_skipped", "convergence_complete", "stage3_complete", "identity_discovery_complete", "summary_complete"]);
    assert.equal(result.result.manifest.phaseStatuses.spotify_discovery_complete_or_skipped.status, "skipped");
    assert.equal(result.result.manifest.phaseStatuses.ticketmaster_discovery_complete_or_skipped.status, "skipped");
    assert.equal(result.result.report.safety.approvals, 0); assert.equal(result.result.report.safety.reservations, 0);
});

test("failed invocation is logged with credential-shaped values redacted", async t => {
    const configuration = await temporaryConfiguration(t);
    await assert.rejects(() => runUnattendedJob(configuration, "ticketmaster_discovery", {
        allowNetwork: true,
        now: "2026-08-18T10:00:00Z",
        coordinatorFactory() { return { async run() { throw new Error("provider failed?apikey=super-secret-value"); } }; }
    }), /provider failed/);
    const log = await fs.readFile(path.join(configuration.logDirectory, "ticketmaster_discovery.jsonl"), "utf8");
    assert.match(log, /"status":"failed"/); assert.match(log, /apikey=REDACTED/); assert.doesNotMatch(log, /super-secret-value/);
    assert.equal(await fs.access(configuration.lockFile).then(() => true, () => false), false);
});

test("weekly review remains available while acquisition is paused", async t => {
    const configuration = await temporaryConfiguration(t); await pauseScheduler(configuration);
    let generated = false;
    const result = await runUnattendedJob(configuration, "weekly_review", { now: "2026-08-24T08:30:00Z", async generateWeekly() { generated = true; return { artifactDigest: `sha256:${"b".repeat(64)}` }; } });
    assert.equal(result.status, "succeeded"); assert.equal(generated, true);
});

test("launchd stdout and stderr files rotate under the configured bound", async t => {
    const configuration = await temporaryConfiguration(t); configuration.logging.maximumBytes = 16; configuration.logging.retainedFiles = 2;
    const directory = path.join(configuration.logDirectory, "launchd"); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "daily_processing.stdout.log"), "x".repeat(32));
    await fs.writeFile(path.join(directory, "daily_processing.stderr.log"), "y".repeat(32));
    await prepareLaunchdLogs(configuration, "daily_processing");
    await fs.access(path.join(directory, "daily_processing.stdout.log.1")); await fs.access(path.join(directory, "daily_processing.stderr.log.1"));
});

test("status is read-only and reports scheduler, pause, queue, summaries, and breakers", async t => {
    const configuration = await temporaryConfiguration(t);
    const before = JSON.stringify(configuration);
    const status = await schedulerStatus(configuration, { launchctlProbe: () => false });
    assert.equal(status.readOnly, true); assert.equal(status.paused, false); assert.deepEqual(status.queueCounts, {}); assert.deepEqual(status.openCircuitBreakers, []);
    assert.equal(Object.keys(status.scheduler).length, JOBS.length); assert.ok(Object.values(status.scheduler).every(item => item.loaded === false));
    assert.equal(JSON.stringify(configuration), before);
    assert.equal(await fs.access(configuration.scheduledRoot).then(() => true, () => false), false);
});
