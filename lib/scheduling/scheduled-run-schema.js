const crypto = require("crypto");
const { uuidV7 } = require("../ingestion/candidate-schema");
const { emptyBudgetConsumption, validateBudgetConsumption, validateBudgets } = require("./scheduled-budget-policy");
const { BREAKER_STATES, emptyProviderMetrics, validateProviderMetrics } = require("./provider-failure-policy");

const RUN_ID_PATTERN = /^mr_discovery_run_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_EVENT_ID_PATTERN = /^mr_discovery_run_event_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PHASES = Object.freeze([
    "created",
    "spotify_discovery_complete_or_skipped",
    "ticketmaster_discovery_complete_or_skipped",
    "convergence_complete",
    "stage3_complete",
    "identity_discovery_complete",
    "summary_complete"
]);
const EVENT_TYPES = Object.freeze(["run_created", "phase_completed", "provider_execution_recorded", "run_paused", "run_resumed", "run_stopped"]);
const CONTROL_STATUSES = Object.freeze(["running", "paused", "stopped", "completed"]);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function validTimestamp(value) {
    return typeof value === "string" && value.trim() !== "" && !Number.isNaN(Date.parse(value));
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
}

function stableConfigurationHash(configuration) {
    assert(configuration && typeof configuration === "object" && !Array.isArray(configuration), "Scheduled-run configuration must be an object.");
    return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonicalize(configuration))).digest("hex")}`;
}

function createRunId(options = {}) {
    return `mr_discovery_run_${uuidV7(options.now ?? Date.now(), options.randomBytes)}`;
}

function createRunEventId(options = {}) {
    return `mr_discovery_run_event_${uuidV7(options.now ?? Date.now(), options.randomBytes)}`;
}

function validateActor(actor) {
    assert(["system", "command", "worker", "human"].includes(actor?.type), "Scheduled-run actor type is invalid.");
    assert(typeof actor.id === "string" && actor.id.trim(), "Scheduled-run actor ID is required.");
}

function validateChecksums(checksums, label = "protected checksums") {
    assert(checksums && typeof checksums === "object" && !Array.isArray(checksums), `Scheduled-run ${label} are required.`);
    const entries = Object.entries(checksums);
    assert(entries.length > 0, `Scheduled-run ${label} cannot be empty.`);
    assert(entries.every(([file, digest]) => file && /^[0-9a-f]{64}$/.test(digest || "")), `Scheduled-run ${label} are invalid.`);
    return true;
}

function emptyPhaseStatuses() {
    return Object.fromEntries(PHASES.map(phase => [phase, {
        status: "pending",
        disposition: null,
        completedAt: null,
        eventId: null,
        checkpointRefs: []
    }]));
}

function emptyProviderExecution() {
    return Object.fromEntries(["spotify", "ticketmaster", "wikidata", "musicbrainz", "discogs"].map(provider => [provider, {
        metrics: emptyProviderMetrics(),
        circuitBreaker: null,
        stopReason: null,
        updatedAt: null,
        runId: null
    }]));
}

function validateProviderExecution(execution) {
    assert(execution && typeof execution === "object", "Scheduled-run provider execution is required.");
    for (const [provider, value] of Object.entries(execution)) {
        assert(typeof provider === "string" && provider.trim(), "Scheduled-run provider key is invalid.");
        validateProviderMetrics(value.metrics);
        if (value.circuitBreaker != null) {
            assert(BREAKER_STATES.includes(value.circuitBreaker.state), "Scheduled-run provider circuit state is invalid.");
            assert(value.circuitBreaker.provider === provider, "Scheduled-run provider circuit attribution drifted.");
        }
        assert(value.stopReason == null || typeof value.stopReason === "string", "Scheduled-run provider stop reason is invalid.");
        assert(value.updatedAt == null || validTimestamp(value.updatedAt), "Scheduled-run provider execution timestamp is invalid.");
    }
    return true;
}

function validatePhaseStatus(status, phase) {
    assert(["pending", "completed", "skipped"].includes(status?.status), `Scheduled-run phase ${phase} status is invalid.`);
    assert(status.disposition == null || ["completed", "skipped"].includes(status.disposition), `Scheduled-run phase ${phase} disposition is invalid.`);
    assert(status.completedAt == null || validTimestamp(status.completedAt), `Scheduled-run phase ${phase} completion timestamp is invalid.`);
    assert(status.eventId == null || RUN_EVENT_ID_PATTERN.test(status.eventId), `Scheduled-run phase ${phase} event ID is invalid.`);
    assert(Array.isArray(status.checkpointRefs) && status.checkpointRefs.every(value => typeof value === "string" && value.trim()), `Scheduled-run phase ${phase} checkpoint refs are invalid.`);
    if (status.status === "pending") assert(status.disposition == null && status.completedAt == null && status.eventId == null, `Pending phase ${phase} contains completion metadata.`);
    else assert(status.disposition === status.status && status.completedAt && status.eventId, `Completed phase ${phase} is missing completion metadata.`);
}

function validateManifest(manifest) {
    assert(manifest?.schemaVersion === 1, "Scheduled-run manifest schemaVersion must be 1.");
    assert(RUN_ID_PATTERN.test(manifest.runId || ""), "Scheduled-run manifest run ID is invalid.");
    assert(Number.isInteger(manifest.revision) && manifest.revision >= 1, "Scheduled-run manifest revision is invalid.");
    assert(validTimestamp(manifest.createdAt) && validTimestamp(manifest.startedAt), "Scheduled-run creation/start timestamps are invalid.");
    assert(manifest.completedAt == null || validTimestamp(manifest.completedAt), "Scheduled-run completed timestamp is invalid.");
    assert(typeof manifest.networkAllowed === "boolean", "Scheduled-run networkAllowed must be boolean.");
    assert(HASH_PATTERN.test(manifest.stableConfigurationHash || ""), "Scheduled-run configuration hash is invalid.");
    assert(manifest.configuration && stableConfigurationHash(manifest.configuration) === manifest.stableConfigurationHash, "Scheduled-run configuration hash drifted.");
    validateBudgets(manifest.budgets);
    validateBudgetConsumption(manifest.budgetConsumption);
    validateProviderExecution(manifest.providerExecution);
    assert(PHASES.includes(manifest.lastCompletedPhase), "Scheduled-run last completed phase is invalid.");
    assert(CONTROL_STATUSES.includes(manifest.control?.status), "Scheduled-run control status is invalid.");
    assert(manifest.control.pauseReason == null || typeof manifest.control.pauseReason === "string", "Scheduled-run pause reason is invalid.");
    assert(manifest.control.stopReason == null || typeof manifest.control.stopReason === "string", "Scheduled-run stop reason is invalid.");
    assert(manifest.phaseStatuses && Object.keys(manifest.phaseStatuses).length === PHASES.length, "Scheduled-run phase statuses are incomplete.");
    PHASES.forEach(phase => validatePhaseStatus(manifest.phaseStatuses[phase], phase));
    assert(manifest.providerPhaseStatuses?.spotify === manifest.phaseStatuses.spotify_discovery_complete_or_skipped.status, "Spotify provider phase status drifted.");
    assert(manifest.providerPhaseStatuses?.ticketmaster === manifest.phaseStatuses.ticketmaster_discovery_complete_or_skipped.status, "Ticketmaster provider phase status drifted.");
    assert(manifest.workerPhaseStatuses?.stage3 === manifest.phaseStatuses.stage3_complete.status, "Stage 3 worker phase status drifted.");
    assert(manifest.workerPhaseStatuses?.identityDiscovery === manifest.phaseStatuses.identity_discovery_complete.status, "Identity-discovery worker phase status drifted.");
    validateChecksums(manifest.protectedChecksums?.before, "initial protected checksums");
    if (manifest.protectedChecksums.after != null) validateChecksums(manifest.protectedChecksums.after, "final protected checksums");
    assert(Array.isArray(manifest.checkpointRefs) && manifest.checkpointRefs.every(value => typeof value === "string" && value.trim()), "Scheduled-run checkpoint refs are invalid.");
    assert(RUN_EVENT_ID_PATTERN.test(manifest.lastEventId || ""), "Scheduled-run last event ID is invalid.");
    const lastIndex = PHASES.indexOf(manifest.lastCompletedPhase);
    PHASES.forEach((phase, index) => {
        const pending = manifest.phaseStatuses[phase].status === "pending";
        assert(index <= lastIndex ? !pending : pending, `Scheduled-run phase ordering drifted at ${phase}.`);
    });
    if (manifest.control.status === "completed") {
        assert(manifest.lastCompletedPhase === "summary_complete" && manifest.completedAt, "Completed scheduled run is incomplete.");
        validateChecksums(manifest.protectedChecksums.after, "final protected checksums");
    }
    return true;
}

function validateEvent(event) {
    assert(event?.schemaVersion === 1, "Scheduled-run event schemaVersion must be 1.");
    assert(RUN_EVENT_ID_PATTERN.test(event.eventId || ""), "Scheduled-run event ID is invalid.");
    assert(RUN_ID_PATTERN.test(event.runId || ""), "Scheduled-run event run ID is invalid.");
    assert(EVENT_TYPES.includes(event.eventType), "Scheduled-run event type is invalid.");
    assert(Number.isInteger(event.previousRevision) && event.previousRevision >= 0, "Scheduled-run event previous revision is invalid.");
    assert(event.runRevision === event.previousRevision + 1, "Scheduled-run event revision is not sequential.");
    assert(validTimestamp(event.occurredAt), "Scheduled-run event timestamp is invalid.");
    validateActor(event.actor);
    assert(event.payload && typeof event.payload === "object" && !Array.isArray(event.payload), "Scheduled-run event payload must be an object.");
    if (event.eventType === "run_created") {
        assert(event.previousRevision === 0 && event.phase === "created", "Initial scheduled-run event is invalid.");
        assert(event.disposition === "completed", "Created phase must be completed.");
        assert(typeof event.payload.networkAllowed === "boolean", "Initial event networkAllowed is invalid.");
        assert(HASH_PATTERN.test(event.payload.stableConfigurationHash || ""), "Initial event configuration hash is invalid.");
        validateBudgets(event.payload.budgets);
        validateBudgetConsumption(event.payload.budgetConsumption || emptyBudgetConsumption());
        validateChecksums(event.payload.protectedChecksums, "initial protected checksums");
    } else if (event.eventType === "phase_completed") {
        assert(PHASES.slice(1).includes(event.phase), "Scheduled-run completion phase is invalid.");
        assert(["completed", "skipped"].includes(event.disposition), "Scheduled-run phase disposition is invalid.");
        assert(Array.isArray(event.payload.checkpointRefs || []), "Scheduled-run phase checkpoint refs are invalid.");
        validateBudgetConsumption(event.payload.budgetConsumption || emptyBudgetConsumption());
    } else if (event.eventType === "provider_execution_recorded") {
        assert(event.phase == null && event.disposition == null, "Provider execution events cannot complete phases.");
        assert(typeof event.payload.provider === "string" && event.payload.provider.trim(), "Provider execution event provider is required.");
        validateProviderMetrics(event.payload.metrics);
        assert(event.payload.circuitBreaker?.provider === event.payload.provider, "Provider execution circuit attribution is invalid.");
        assert(BREAKER_STATES.includes(event.payload.circuitBreaker.state), "Provider execution circuit state is invalid.");
    } else {
        assert(event.phase == null, "Scheduled-run control events cannot complete a phase.");
        assert(typeof event.payload.reason === "string" && event.payload.reason.trim(), "Scheduled-run control event reason is required.");
        validateBudgetConsumption(event.payload.budgetConsumption || emptyBudgetConsumption());
    }
    return true;
}

module.exports = {
    CONTROL_STATUSES,
    EVENT_TYPES,
    HASH_PATTERN,
    PHASES,
    RUN_EVENT_ID_PATTERN,
    RUN_ID_PATTERN,
    canonicalize,
    createRunEventId,
    createRunId,
    emptyPhaseStatuses,
    emptyProviderExecution,
    stableConfigurationHash,
    validateBudgets,
    validateChecksums,
    validateEvent,
    validateManifest,
    validateProviderExecution
};
