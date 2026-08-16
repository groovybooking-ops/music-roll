const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { spawnSync } = require("child_process");
const { CandidateStore } = require("../ingestion/candidate-store");
const { LiveScheduledCoordinator } = require("./live-scheduled-coordinator");
const { buildWeeklySummary } = require("./scheduled-summary-generator");
const { loadImmutableSummarySources, listJsonFiles } = require("./scheduled-summary-source-loader");
const { ScheduledSummaryStore } = require("./scheduled-summary-store");

const JOBS = Object.freeze(["spotify_discovery", "ticketmaster_discovery", "daily_processing", "weekly_review"]);
const NETWORK_JOBS = new Set(["spotify_discovery", "ticketmaster_discovery", "daily_processing"]);
const SECRET_PATTERN = /(api[_-]?key|client[_-]?secret|access[_-]?token|authorization|bearer)/i;

function assert(condition, message) { if (!condition) throw new Error(message); }
function timestamp(value) { return typeof value === "string" && !Number.isNaN(Date.parse(value)); }
function localDateParts(date) { return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() }; }
function localMidnight(date) { const value = localDateParts(date); return new Date(value.year, value.month, value.day); }
function addDays(date, days) { return new Date(date.getTime() + days * 86400000); }
function isoDate(date) { return date.toISOString().slice(0, 10); }

function validateSchedulerConfiguration(configuration) {
    assert(configuration?.schemaVersion === 1 && configuration.reviewOnly === true, "Unattended scheduler must be schema v1 and review-only.");
    for (const key of ["repositoryRoot", "scheduledRoot", "environmentFile", "generatedPlistDirectory", "launchAgentsDirectory", "logDirectory", "controlDirectory", "invocationDirectory", "lockFile", "pauseFile"]) assert(path.isAbsolute(configuration[key] || ""), `Scheduler path ${key} must be absolute.`);
    assert(configuration.repositoryRoot === "/Users/groovymac/music-roll", "Unattended scheduler must target the canonical Music Roll repository.");
    assert(configuration.environmentFile === path.join(configuration.repositoryRoot, ".env"), "Scheduler environment file must be the canonical protected .env file.");
    assert(Number.isInteger(configuration.logging?.maximumBytes) && configuration.logging.maximumBytes > 0, "Scheduler maximum log size is invalid.");
    assert(Number.isInteger(configuration.logging?.retainedFiles) && configuration.logging.retainedFiles >= 1, "Scheduler retained log count is invalid.");
    for (const job of JOBS) assert(typeof configuration.labels?.[job] === "string" && configuration.labels[job], `Scheduler label ${job} is required.`);
    const scheduleValues = Object.values(configuration.schedules || {});
    assert(scheduleValues.length === 4, "All four unattended schedules are required.");
    for (const schedule of scheduleValues) {
        assert(Number.isInteger(schedule.hour) && schedule.hour >= 0 && schedule.hour <= 23, "Scheduled hour is invalid.");
        assert(Number.isInteger(schedule.minute) && schedule.minute >= 0 && schedule.minute <= 59, "Scheduled minute is invalid.");
    }
    assert(Array.isArray(configuration.spotifyDiscovery?.queries) && configuration.spotifyDiscovery.queries.length > 1 && configuration.spotifyDiscovery.queries.every(value => typeof value === "string" && value.trim()), "Spotify discovery rotation requires multiple queries.");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(configuration.spotifyDiscovery.rotationEpochDate || ""), "Spotify rotation epoch is invalid.");
    assert(Number.isInteger(configuration.spotifyDiscovery.rotationDays) && configuration.spotifyDiscovery.rotationDays > 0, "Spotify rotation interval is invalid.");
    assert(/^[A-Z]{2}$/.test(configuration.ticketmasterDiscovery?.stateCode || ""), "Ticketmaster scheduled state is invalid.");
    assert(configuration.ticketmasterDiscovery.endOffsetDays > configuration.ticketmasterDiscovery.startOffsetDays, "Ticketmaster rolling window is invalid.");
    assert(configuration.ticketmasterDiscovery.endOffsetDays - configuration.ticketmasterDiscovery.startOffsetDays <= 7, "Ticketmaster rolling window exceeds seven days.");
    return true;
}

async function loadSchedulerConfiguration(file) {
    const configuration = JSON.parse(await fs.readFile(file, "utf8"));
    validateSchedulerConfiguration(configuration);
    return configuration;
}

function providerLimits(enabled, requests, candidates) {
    return enabled
        ? { maxRequests: requests, maxPages: 1, maxNormalizedOccurrences: 8, maxNewCandidates: candidates }
        : { maxRequests: 0, maxPages: 0, maxNormalizedOccurrences: 0, maxNewCandidates: 0 };
}

function spotifySelection(configuration, now) {
    const source = configuration.spotifyDiscovery;
    const epoch = Date.parse(`${source.rotationEpochDate}T00:00:00Z`);
    const slot = Math.max(0, Math.floor((now.getTime() - epoch) / (source.rotationDays * 86400000)));
    const index = slot % source.queries.length;
    return { query: source.queries[index], index, slot };
}

function buildCoordinatorConfiguration(configuration, job, now = new Date()) {
    validateSchedulerConfiguration(configuration);
    assert(NETWORK_JOBS.has(job), `Coordinator configuration is unavailable for ${job}.`);
    const spotifyEnabled = job === "spotify_discovery";
    const ticketmasterEnabled = job === "ticketmaster_discovery";
    const workersEnabled = job === "daily_processing";
    const selection = spotifySelection(configuration, now);
    const start = addDays(localMidnight(now), configuration.ticketmasterDiscovery.startOffsetDays);
    const end = addDays(localMidnight(now), configuration.ticketmasterDiscovery.endOffsetDays);
    const limits = configuration.budgets;
    return {
        schemaVersion: 1,
        coordinatorVersion: "scheduled_live_coordinator_v1",
        unattendedJob: job,
        reviewOnly: true,
        spotify: {
            enabled: spotifyEnabled,
            mode: "artist_search_results",
            query: selection.query,
            queryRecordId: `unattended-spotify-rotation-${selection.slot}-${selection.index}`,
            limit: configuration.spotifyDiscovery.limit,
            market: configuration.spotifyDiscovery.market,
            sourceType: "public_music_database",
            sourceName: "Music Roll unattended bounded Spotify discovery"
        },
        ticketmaster: {
            enabled: ticketmasterEnabled,
            mode: "event_attractions",
            stateCode: configuration.ticketmasterDiscovery.stateCode,
            startDateTime: start.toISOString(),
            endDateTime: end.toISOString(),
            size: configuration.ticketmasterDiscovery.size,
            sourceType: "ticketmaster_event",
            sourceName: "Music Roll unattended bounded Ticketmaster discovery"
        },
        budgets: {
            providers: {
                spotify: providerLimits(spotifyEnabled, limits.spotifyMaxRequests, limits.spotifyMaxNewCandidates),
                ticketmaster: providerLimits(ticketmasterEnabled, limits.ticketmasterMaxRequests, limits.ticketmasterMaxNewCandidates)
            },
            workers: {
                stage3Candidates: workersEnabled ? limits.stage3MaxCandidates : 0,
                identityDiscoveryCandidates: workersEnabled ? limits.identityDiscoveryMaxCandidates : 0
            },
            queueHighWaterMarks: structuredClone(limits.queueHighWaterMarks)
        },
        maximumTotalNewCandidates: limits.maximumTotalNewCandidates,
        listingFreshnessHours: {
            spotify: configuration.spotifyDiscovery.listingFreshnessHours,
            ticketmaster: configuration.ticketmasterDiscovery.listingFreshnessHours
        }
    };
}

function xmlEscape(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function dictEntries(entries) { return entries.map(([key, value]) => `<key>${xmlEscape(key)}</key>${value}`).join(""); }
function integer(value) { return `<integer>${value}</integer>`; }
function calendarXml(schedule) {
    const values = schedule.weekdays
        ? schedule.weekdays.map(weekday => ({ Weekday: weekday, Hour: schedule.hour, Minute: schedule.minute }))
        : [{ ...(schedule.weekday != null ? { Weekday: schedule.weekday } : {}), Hour: schedule.hour, Minute: schedule.minute }];
    const dictionaries = values.map(value => `<dict>${dictEntries(Object.entries(value).map(([key, item]) => [key, integer(item)]))}</dict>`).join("");
    return values.length === 1 ? dictionaries : `<array>${dictionaries}</array>`;
}

function plistForJob(configuration, job, nodePath = process.execPath) {
    validateSchedulerConfiguration(configuration);
    assert(JOBS.includes(job), `Unknown launchd job: ${job}.`);
    assert(path.isAbsolute(nodePath), "launchd Node path must be absolute.");
    const program = path.join(configuration.repositoryRoot, "scripts", "run-unattended-ingestion-job.js");
    const stdout = path.join(configuration.logDirectory, "launchd", `${job}.stdout.log`);
    const stderr = path.join(configuration.logDirectory, "launchd", `${job}.stderr.log`);
    const args = [nodePath, program, "--job", job, "--configuration", path.join(configuration.repositoryRoot, "config", "scheduled-ingestion.macos.json")];
    if (NETWORK_JOBS.has(job)) args.push("--allow-network");
    const argumentsXml = `<array>${args.map(value => `<string>${xmlEscape(value)}</string>`).join("")}</array>`;
    const body = dictEntries([
        ["Label", `<string>${xmlEscape(configuration.labels[job])}</string>`],
        ["ProgramArguments", argumentsXml],
        ["WorkingDirectory", `<string>${xmlEscape(configuration.repositoryRoot)}</string>`],
        ["StartCalendarInterval", calendarXml(configuration.schedules[job])],
        ["RunAtLoad", "<false/>"],
        ["ProcessType", "<string>Background</string>"],
        ["LowPriorityIO", "<true/>"],
        ["StandardOutPath", `<string>${xmlEscape(stdout)}</string>`],
        ["StandardErrorPath", `<string>${xmlEscape(stderr)}</string>`]
    ]);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>\n`;
}

async function atomicWrite(file, bytes) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try { await fs.rename(temporary, file); } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}

async function generateLaunchdDefinitions(configuration, options = {}) {
    validateSchedulerConfiguration(configuration);
    const outputDirectory = options.outputDirectory || configuration.generatedPlistDirectory;
    await Promise.all([
        fs.mkdir(path.join(configuration.logDirectory, "launchd"), { recursive: true }),
        fs.mkdir(configuration.controlDirectory, { recursive: true }),
        fs.mkdir(configuration.invocationDirectory, { recursive: true })
    ]);
    const files = [];
    for (const job of JOBS) {
        const file = path.join(outputDirectory, `${configuration.labels[job]}.plist`);
        await atomicWrite(file, plistForJob(configuration, job, options.nodePath || process.execPath));
        files.push(file);
    }
    return files;
}

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_PATTERN.test(key) ? "REDACTED" : redact(item)]));
    if (typeof value === "string") return value.replace(/([?&](?:apikey|api_key|access_token|client_secret)=)[^&\s]+/gi, "$1REDACTED").replace(/Bearer\s+[^\s]+/gi, "Bearer REDACTED");
    return value;
}

async function rotateLog(file, maximumBytes, retainedFiles) {
    const stat = await fs.stat(file).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!stat || stat.size < maximumBytes) return false;
    await fs.unlink(`${file}.${retainedFiles}`).catch(error => { if (error.code !== "ENOENT") throw error; });
    for (let index = retainedFiles - 1; index >= 1; index -= 1) await fs.rename(`${file}.${index}`, `${file}.${index + 1}`).catch(error => { if (error.code !== "ENOENT") throw error; });
    await fs.rename(file, `${file}.1`);
    return true;
}

async function appendSchedulerLog(configuration, job, record) {
    const file = path.join(configuration.logDirectory, `${job}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await rotateLog(file, configuration.logging.maximumBytes, configuration.logging.retainedFiles);
    await fs.appendFile(file, JSON.stringify(redact(record)) + "\n", { mode: 0o600 });
    return file;
}

async function prepareLaunchdLogs(configuration, job) {
    const directory = path.join(configuration.logDirectory, "launchd");
    await fs.mkdir(directory, { recursive: true });
    for (const stream of ["stdout", "stderr"]) await rotateLog(path.join(directory, `${job}.${stream}.log`), configuration.logging.maximumBytes, configuration.logging.retainedFiles);
}

async function recordInvocation(configuration, record) {
    const occurredAt = record.occurredAt || new Date().toISOString();
    const digest = crypto.createHash("sha256").update(`${occurredAt}:${process.pid}:${record.job}:${crypto.randomUUID()}`).digest("hex").slice(0, 24);
    const file = path.join(configuration.invocationDirectory, `${occurredAt.replace(/[:.]/g, "-")}-${record.job}-${digest}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(redact({ schemaVersion: 1, reviewOnly: true, ...record, occurredAt }), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return file;
}

async function schedulerPaused(configuration) { return fs.access(configuration.pauseFile).then(() => true, () => false); }
async function pauseScheduler(configuration, reason = "manual_pause") {
    validateSchedulerConfiguration(configuration);
    if (await schedulerPaused(configuration)) return { changed: false, paused: true, file: configuration.pauseFile };
    await atomicWrite(configuration.pauseFile, JSON.stringify({ schemaVersion: 1, pausedAt: new Date().toISOString(), reason, actor: "human" }, null, 2) + "\n");
    return { changed: true, paused: true, file: configuration.pauseFile };
}
async function resumeScheduler(configuration) {
    validateSchedulerConfiguration(configuration);
    const existed = await schedulerPaused(configuration);
    if (existed) await fs.unlink(configuration.pauseFile);
    return { changed: existed, paused: false, file: configuration.pauseFile };
}

function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function readLock(configuration) {
    try { return JSON.parse(await fs.readFile(configuration.lockFile, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function acquireLockSafe(configuration, job, now) {
    await fs.mkdir(path.dirname(configuration.lockFile), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = await fs.open(configuration.lockFile, "wx", 0o600);
            const payload = { schemaVersion: 1, pid: process.pid, job, acquiredAt: now.toISOString() };
            await handle.writeFile(JSON.stringify(payload) + "\n");
            return { acquired: true, payload, async release() { await handle.close(); await fs.unlink(configuration.lockFile).catch(error => { if (error.code !== "ENOENT") throw error; }); } };
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = await readLock(configuration);
            if (existing && !processAlive(existing.pid)) { await fs.rename(configuration.lockFile, `${configuration.lockFile}.stale-${Date.now()}`).catch(() => {}); continue; }
            return { acquired: false, existing, release: async () => {} };
        }
    }
    return { acquired: false, existing: null, release: async () => {} };
}

function weeklyPeriod(now) {
    const end = localMidnight(now);
    return { start: addDays(end, -7).toISOString(), end: end.toISOString() };
}

async function generateWeeklyReview(configuration, now) {
    const sources = await loadImmutableSummarySources(configuration.scheduledRoot);
    const period = weeklyPeriod(now);
    const summary = buildWeeklySummary({ ...sources, period, generatedAt: now.toISOString() });
    const store = new ScheduledSummaryStore(path.join(configuration.scheduledRoot, "summaries"));
    await store.writeWeekly(summary);
    return summary;
}

async function runUnattendedJob(configuration, job, options = {}) {
    validateSchedulerConfiguration(configuration);
    assert(JOBS.includes(job), `Unknown unattended job: ${job}.`);
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    assert(!Number.isNaN(now.getTime()), "Unattended job timestamp is invalid.");
    const base = { job, occurredAt: now.toISOString(), reviewOnly: true };
    await prepareLaunchdLogs(configuration, job);
    if (await schedulerPaused(configuration) && NETWORK_JOBS.has(job)) {
        const record = { ...base, status: "skipped_paused", networkRequests: 0, candidatesFailed: 0 };
        const invocationFile = await recordInvocation(configuration, record); await appendSchedulerLog(configuration, job, { ...record, invocationFile });
        return { ...record, invocationFile };
    }
    const lock = await (options.acquireLock || acquireLockSafe)(configuration, job, now);
    if (!lock.acquired) {
        const record = { ...base, status: "skipped_locked", networkRequests: 0, candidatesFailed: 0, activeLock: redact(lock.existing) };
        const invocationFile = await recordInvocation(configuration, record); await appendSchedulerLog(configuration, job, { ...record, invocationFile });
        return { ...record, invocationFile };
    }
    try {
        let result;
        if (job === "weekly_review") result = { weeklySummary: await (options.generateWeekly || generateWeeklyReview)(configuration, now) };
        else {
            assert(options.allowNetwork === true, `Unattended ${job} requires --allow-network.`);
            const coordinatorConfiguration = buildCoordinatorConfiguration(configuration, job, now);
            const factory = options.coordinatorFactory || (input => new LiveScheduledCoordinator(input));
            const coordinator = factory({ projectRoot: configuration.repositoryRoot, scheduledRoot: configuration.scheduledRoot, configuration: coordinatorConfiguration, allowNetwork: true, environment: options.environment || process.env, fetchImpl: options.fetchImpl });
            result = await coordinator.run();
        }
        const runId = result.manifest?.runId || null;
        const record = { ...base, status: "succeeded", runId, phasesExecuted: result.phasesExecuted || [], summaryDigest: result.weeklySummary?.artifactDigest || result.report?.dailySummary?.artifactDigest || null, networkRequests: null };
        const invocationFile = await recordInvocation(configuration, record); await appendSchedulerLog(configuration, job, { ...record, invocationFile });
        return { ...record, invocationFile, result };
    } catch (error) {
        const record = { ...base, status: "failed", error: { name: error.name, message: error.message }, candidatesFailed: 0 };
        const invocationFile = await recordInvocation(configuration, record); await appendSchedulerLog(configuration, job, { ...record, invocationFile });
        error.invocationFile = invocationFile;
        throw error;
    } finally { await lock.release(); }
}

async function latestJsonFile(root) {
    const files = await listJsonFiles(root);
    return files.sort().at(-1) || null;
}

function defaultLaunchctlProbe(label) {
    const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
    return result.status === 0;
}

async function schedulerStatus(configuration, options = {}) {
    validateSchedulerConfiguration(configuration);
    const probe = options.launchctlProbe || defaultLaunchctlProbe;
    const runFiles = (await listJsonFiles(path.join(configuration.scheduledRoot, "runs"))).filter(file => file.endsWith(`${path.sep}manifest.json`));
    const runs = await Promise.all(runFiles.map(async file => JSON.parse(await fs.readFile(file, "utf8"))));
    const completed = runs.filter(run => run.control?.status === "completed").sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    const providerLast = provider => completed.filter(run => run.providerExecution?.[provider]?.metrics?.requestsAttempted > 0).sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0] || null;
    const candidateStore = new CandidateStore(path.join(configuration.scheduledRoot, "store"));
    const candidates = await candidateStore.listCandidates();
    const unresolved = candidates.filter(item => !["migrated", "approved"].includes(item.state) && item.state !== "identity_coherent").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, 10);
    const latestBreakers = {};
    for (const run of completed) for (const [provider, execution] of Object.entries(run.providerExecution || {})) if (!latestBreakers[provider] && execution.circuitBreaker) latestBreakers[provider] = execution.circuitBreaker;
    const daily = await latestJsonFile(path.join(configuration.scheduledRoot, "summaries", "daily"));
    const weekly = await latestJsonFile(path.join(configuration.scheduledRoot, "summaries", "weekly"));
    return {
        schemaVersion: 1,
        readOnly: true,
        scheduler: Object.fromEntries(JOBS.map(job => [job, { label: configuration.labels[job], loaded: probe(configuration.labels[job]), generatedPlist: path.join(configuration.generatedPlistDirectory, `${configuration.labels[job]}.plist`) }])),
        paused: await schedulerPaused(configuration),
        activeLock: await readLock(configuration),
        lastSpotifyDiscoveryRun: providerLast("spotify")?.runId || null,
        lastTicketmasterDiscoveryRun: providerLast("ticketmaster")?.runId || null,
        lastCompletedScheduledRun: completed[0]?.runId || null,
        lastDailySummary: daily,
        lastWeeklySummary: weekly,
        queueCounts: Object.fromEntries([...new Set(candidates.map(item => item.state))].sort().map(state => [state, candidates.filter(item => item.state === state).length])),
        openCircuitBreakers: Object.values(latestBreakers).filter(item => item.state === "open"),
        oldestUnresolvedOrReviewCandidates: unresolved.map(item => ({ candidateId: item.candidateId, artistName: item.name.raw, state: item.state, createdAt: item.createdAt }))
    };
}

module.exports = {
    JOBS,
    NETWORK_JOBS,
    appendSchedulerLog,
    buildCoordinatorConfiguration,
    generateLaunchdDefinitions,
    generateWeeklyReview,
    loadSchedulerConfiguration,
    pauseScheduler,
    plistForJob,
    prepareLaunchdLogs,
    redact,
    resumeScheduler,
    rotateLog,
    runUnattendedJob,
    schedulerPaused,
    schedulerStatus,
    validateSchedulerConfiguration,
    weeklyPeriod
};
