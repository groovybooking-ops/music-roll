const {
    PHASES,
    emptyProviderExecution,
    emptyPhaseStatuses,
    stableConfigurationHash,
    validateEvent,
    validateManifest
} = require("./scheduled-run-schema");
const { emptyBudgetConsumption } = require("./scheduled-budget-policy");

function unique(values) {
    return [...new Set((values || []).filter(Boolean).map(String))].sort();
}

function buildEvent(input, options = {}) {
    const event = {
        schemaVersion: 1,
        eventId: input.eventId || options.eventIdGenerator(),
        runId: input.runId,
        eventType: input.eventType,
        previousRevision: input.previousRevision,
        runRevision: input.previousRevision + 1,
        phase: input.phase || null,
        disposition: input.disposition || null,
        occurredAt: input.occurredAt,
        actor: input.actor,
        payload: structuredClone(input.payload || {})
    };
    validateEvent(event);
    return event;
}

function reduceRun(previous, event) {
    validateEvent(event);
    if (!previous) {
        if (event.eventType !== "run_created") throw new Error("Scheduled-run replay must begin with run_created.");
        const phases = emptyPhaseStatuses();
        phases.created = {
            status: "completed",
            disposition: "completed",
            completedAt: event.occurredAt,
            eventId: event.eventId,
            checkpointRefs: []
        };
        const manifest = {
            schemaVersion: 1,
            runId: event.runId,
            revision: 1,
            createdAt: event.occurredAt,
            startedAt: event.occurredAt,
            completedAt: null,
            networkAllowed: event.payload.networkAllowed,
            stableConfigurationHash: event.payload.stableConfigurationHash,
            configuration: structuredClone(event.payload.configuration),
            budgets: structuredClone(event.payload.budgets),
            budgetConsumption: structuredClone(event.payload.budgetConsumption || emptyBudgetConsumption()),
            lastCompletedPhase: "created",
            phaseStatuses: phases,
            providerPhaseStatuses: { spotify: "pending", ticketmaster: "pending" },
            workerPhaseStatuses: { stage3: "pending", identityDiscovery: "pending" },
            providerExecution: emptyProviderExecution(),
            checkpointRefs: [],
            protectedChecksums: { before: structuredClone(event.payload.protectedChecksums), after: null },
            control: { status: "running", pauseReason: null, stopReason: null },
            lastEventId: event.eventId
        };
        validateManifest(manifest);
        return manifest;
    }
    validateManifest(previous);
    if (event.runId !== previous.runId || event.previousRevision !== previous.revision) throw new Error("Scheduled-run event revision or run ID does not match replay state.");
    const next = structuredClone(previous);
    next.revision = event.runRevision;
    next.lastEventId = event.eventId;
    if (event.eventType === "phase_completed") {
        const expected = PHASES[PHASES.indexOf(previous.lastCompletedPhase) + 1];
        if (event.phase !== expected) throw new Error(`Illegal scheduled-run phase transition: expected ${expected || "none"}, received ${event.phase}.`);
        const refs = unique(event.payload.checkpointRefs);
        next.phaseStatuses[event.phase] = {
            status: event.disposition,
            disposition: event.disposition,
            completedAt: event.occurredAt,
            eventId: event.eventId,
            checkpointRefs: refs
        };
        next.lastCompletedPhase = event.phase;
        if (event.phase === "spotify_discovery_complete_or_skipped") next.providerPhaseStatuses.spotify = event.disposition;
        if (event.phase === "ticketmaster_discovery_complete_or_skipped") next.providerPhaseStatuses.ticketmaster = event.disposition;
        if (event.phase === "stage3_complete") next.workerPhaseStatuses.stage3 = event.disposition;
        if (event.phase === "identity_discovery_complete") next.workerPhaseStatuses.identityDiscovery = event.disposition;
        next.checkpointRefs = unique([...next.checkpointRefs, ...refs]);
        next.budgetConsumption = structuredClone(event.payload.budgetConsumption || next.budgetConsumption);
        if (event.phase === "summary_complete") {
            next.completedAt = event.occurredAt;
            next.protectedChecksums.after = structuredClone(event.payload.protectedChecksums);
            next.control = { status: "completed", pauseReason: null, stopReason: null };
        }
    } else if (event.eventType === "provider_execution_recorded") {
        next.providerExecution[event.payload.provider] = {
            metrics: structuredClone(event.payload.metrics),
            circuitBreaker: structuredClone(event.payload.circuitBreaker),
            stopReason: event.payload.stopReason || null,
            updatedAt: event.occurredAt,
            runId: event.runId
        };
    } else if (event.eventType === "run_paused") {
        if (previous.control.status !== "running") throw new Error("Only a running scheduled run can be paused.");
        next.control = { ...next.control, status: "paused", pauseReason: event.payload.reason };
        next.checkpointRefs = unique([...next.checkpointRefs, ...(event.payload.checkpointRefs || [])]);
        next.budgetConsumption = structuredClone(event.payload.budgetConsumption || next.budgetConsumption);
    } else if (event.eventType === "run_resumed") {
        if (previous.control.status !== "paused") throw new Error("Only a paused scheduled run can be resumed.");
        next.control = { status: "running", pauseReason: null, stopReason: null };
    } else if (event.eventType === "run_stopped") {
        if (!["running", "paused"].includes(previous.control.status)) throw new Error("Only an active scheduled run can be stopped.");
        next.control = { ...next.control, status: "stopped", stopReason: event.payload.reason };
        next.checkpointRefs = unique([...next.checkpointRefs, ...(event.payload.checkpointRefs || [])]);
        next.budgetConsumption = structuredClone(event.payload.budgetConsumption || next.budgetConsumption);
    } else {
        throw new Error("run_created can appear only as the initial scheduled-run event.");
    }
    validateManifest(next);
    return next;
}

function replayRun(events) {
    if (!Array.isArray(events) || !events.length) throw new Error("Scheduled-run replay requires events.");
    return events.reduce(reduceRun, null);
}

function firstIncompletePhase(manifest) {
    validateManifest(manifest);
    return PHASES.find(phase => manifest.phaseStatuses[phase].status === "pending") || null;
}

function assertConfiguration(manifest, configuration) {
    const hash = stableConfigurationHash(configuration);
    if (hash !== manifest.stableConfigurationHash) throw new Error(`Scheduled-run configuration drift: expected ${manifest.stableConfigurationHash}, received ${hash}.`);
    return true;
}

module.exports = { assertConfiguration, buildEvent, firstIncompletePhase, reduceRun, replayRun };
