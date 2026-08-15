const { replayCandidate } = require("../ingestion/candidate-state-machine");
const { validateCandidateEvent } = require("../ingestion/candidate-schema");
const { validateDiscoveryAssociation, validateDiscoveryOccurrence } = require("../discovery/discovery-schema");
const { validateManifest } = require("./scheduled-run-schema");
const { validateCheckpoint } = require("./provider-checkpoint-schema");
const { REVIEW_GROUPS, summaryDigest, validateDailySummary, validateWeeklySummary } = require("./scheduled-summary-schema");

const IDENTITY_TERMINAL = new Set(["identity_coherent", "needs_review", "conflicting_identity", "failed_match"]);
const PENDING_STATES = new Set(["identity_discovery_pending", "identity_pending", "retry_wait", "enrichment_pending", "validation_pending"]);
const REVIEW_STATES = new Set(["needs_review", "conflicting_identity", "failed_match", "retry_wait", "identity_coherent", "validation_pending"]);

function assert(condition, message) { if (!condition) throw new Error(message); }
function inPeriod(timestamp, period) { const value = Date.parse(timestamp); return value >= Date.parse(period.start) && value < Date.parse(period.end); }
function round(value, digits = 4) { return value == null ? null : Number(value.toFixed(digits)); }
function rate(numerator, denominator) { return denominator ? round(numerator / denominator) : null; }
function median(values) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function percentile(values, proportion) { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)]; }
function countBy(values, selector) { const result = {}; for (const value of values) { const key = selector(value); if (key != null) result[key] = (result[key] || 0) + 1; } return Object.fromEntries(Object.entries(result).sort()); }
function unique(values) { return [...new Set(values.filter(Boolean))].sort(); }

function normalizeBundle(input) {
    const runs = input.runs || [];
    const events = input.candidateEvents || [];
    const occurrences = input.discoveryOccurrences || [];
    const associations = input.discoveryAssociations || [];
    runs.forEach(validateManifest); events.forEach(validateCandidateEvent); occurrences.forEach(validateDiscoveryOccurrence); associations.forEach(validateDiscoveryAssociation); (input.checkpoints || []).forEach(validateCheckpoint);
    const grouped = new Map();
    for (const event of events) { if (!grouped.has(event.candidateId)) grouped.set(event.candidateId, []); grouped.get(event.candidateId).push(event); }
    for (const candidateEvents of grouped.values()) candidateEvents.sort((a, b) => a.candidateRevision - b.candidateRevision);
    return { runs, events, occurrences, associations, grouped, checkpoints: input.checkpoints || [], operationalArtifacts: structuredClone(input.operationalArtifacts || []), evidenceArtifactRefs: unique(input.evidenceArtifactRefs || []) };
}

function checkpointPositions(checkpoints, end) {
    const latest = new Map();
    for (const checkpoint of checkpoints.filter(item => Date.parse(item.updatedAt) < Date.parse(end))) {
        const current = latest.get(checkpoint.checkpointId);
        if (!current || checkpoint.revision > current.revision) latest.set(checkpoint.checkpointId, checkpoint);
    }
    return [...latest.values()].sort((a, b) => `${a.provider}:${a.checkpointId}`.localeCompare(`${b.provider}:${b.checkpointId}`)).map(item => structuredClone(item));
}

function statesAt(grouped, timestamp, inclusive) {
    const result = [];
    const boundary = Date.parse(timestamp);
    for (const events of grouped.values()) {
        const selected = events.filter(event => inclusive ? Date.parse(event.occurredAt) <= boundary : Date.parse(event.occurredAt) < boundary);
        if (selected.length) result.push(replayCandidate(selected));
    }
    return result;
}

function queueAges(candidates, asOf) {
    const ages = candidates.map(candidate => Math.max(0, (Date.parse(asOf) - Date.parse(candidate.createdAt)) / 3600000));
    return { p50Hours: round(percentile(ages, .5)), p75Hours: round(percentile(ages, .75)), p90Hours: round(percentile(ages, .9)), p95Hours: round(percentile(ages, .95)), maxHours: round(ages.length ? Math.max(...ages) : 0) };
}

function aggregateProviders(runs) {
    const result = {};
    for (const run of runs) for (const [provider, execution] of Object.entries(run.providerExecution)) {
        result[provider] ||= { requests: 0, successfulRequests: 0, cacheHits: 0, retries: 0, errors: 0, retryAfterWaits: 0, permanentAbsences: 0, authenticationFailures: 0, transientFailures: 0, candidatesSkippedLaneOpen: 0, circuitBreaker: null, stopReasons: [] };
        const target = result[provider], metrics = execution.metrics;
        target.requests += metrics.requestsAttempted; target.successfulRequests += metrics.successfulRequests; target.cacheHits += metrics.cacheHits;
        for (const key of ["retries", "errors", "retryAfterWaits", "permanentAbsences", "authenticationFailures", "transientFailures", "candidatesSkippedLaneOpen"]) target[key] += metrics[key];
        if (execution.circuitBreaker && (!target.circuitBreaker || Date.parse(execution.updatedAt) >= Date.parse(target.circuitBreaker.updatedAt || 0))) target.circuitBreaker = { ...structuredClone(execution.circuitBreaker), updatedAt: execution.updatedAt };
        if (execution.stopReason) target.stopReasons.push(execution.stopReason);
    }
    for (const value of Object.values(result)) value.stopReasons = unique(value.stopReasons);
    return result;
}

function aggregateBudgets(runs) {
    const providers = {}, workers = { stage3Candidates: 0, identityDiscoveryCandidates: 0 };
    for (const run of runs) {
        for (const [provider, used] of Object.entries(run.budgetConsumption.providers)) {
            providers[provider] ||= { requests: 0, pages: 0, normalizedOccurrences: 0, newCandidates: 0 };
            for (const key of Object.keys(providers[provider])) providers[provider][key] += used[key];
        }
        workers.stage3Candidates += run.budgetConsumption.workers.stage3Candidates;
        workers.identityDiscoveryCandidates += run.budgetConsumption.workers.identityDiscoveryCandidates;
    }
    return { providers, workers, stopReasons: unique(runs.flatMap(run => [run.control.stopReason, ...Object.values(run.providerExecution).map(value => value.stopReason)])) };
}

function candidateTerminalDurations(grouped, period) {
    const durations = [];
    for (const events of grouped.values()) {
        const discovered = events[0];
        const terminal = events.find(event => event.eventType === "state_transition" && IDENTITY_TERMINAL.has(event.nextState));
        if (terminal && inPeriod(terminal.occurredAt, period)) durations.push((Date.parse(terminal.occurredAt) - Date.parse(discovered.occurredAt)) / 3600000);
    }
    return durations;
}

function workerProjection(events, period) {
    const selected = events.filter(event => inPeriod(event.occurredAt, period));
    const ticketmasterCandidates = new Set(events.filter(event => event.eventType === "candidate_discovered" && event.payload?.discovery?.sourceType === "ticketmaster_event").map(event => event.candidateId));
    const stage3Selections = selected.filter(event => event.eventType === "state_transition" && event.nextState === "identity_resolving");
    const identityDiscoverySelections = selected.filter(event => event.eventType === "state_transition" && event.nextState === "identity_discovering");
    const stage3Outcomes = selected.filter(event => event.eventType === "state_transition" && event.previousState === "identity_resolving");
    const identityDiscoveryOutcomes = selected.filter(event => event.eventType === "state_transition" && event.previousState === "identity_discovering");
    const retryEntries = selected.filter(event => event.eventType === "state_transition" && event.nextState === "retry_wait");
    const retryRecoveries = selected.filter(event => event.eventType === "state_transition" && event.previousState === "retry_wait" && event.nextState !== "needs_review");
    const retryExhaustions = selected.filter(event => event.reasonCode === "retry_budget_exhausted");
    const retryCandidates = unique([...retryEntries, ...retryRecoveries, ...retryExhaustions].map(event => event.candidateId));
    return {
        stage3: { selections: stage3Selections.length, outcomesByState: countBy(stage3Outcomes, event => event.nextState), outcomesByIdentityOutcome: countBy(stage3Outcomes, event => event.payload?.resolvedIdentity?.outcome || null) },
        identityDiscovery: { selections: identityDiscoverySelections.length, outcomesByState: countBy(identityDiscoveryOutcomes, event => event.nextState), outcomesByBridgeOutcome: countBy(identityDiscoveryOutcomes, event => event.payload?.identityDiscovery?.outcome || null) },
        newlyEntered: Object.fromEntries(["needs_review", "conflicting_identity", "failed_match", "retry_wait"].map(state => [state, unique(selected.filter(event => event.nextState === state).map(event => event.candidateId))])),
        retryEntries: retryEntries.length,
        retryRecoveries: retryRecoveries.length,
        retryExhaustions: retryExhaustions.length,
        retryCandidates: retryCandidates.length,
        coherent: stage3Outcomes.filter(event => event.nextState === "identity_coherent").length,
        review: [...stage3Outcomes, ...identityDiscoveryOutcomes].filter(event => ["needs_review", "conflicting_identity"].includes(event.nextState)).length,
        failedMatch: stage3Outcomes.filter(event => event.nextState === "failed_match").length,
        exactBridges: selected.filter(event => event.eventType === "candidate_identifier_attached" && ticketmasterCandidates.has(event.candidateId)).length
    };
}

function buildDailySummary(input) {
    const bundle = normalizeBundle(input);
    const period = input.period;
    assert(period?.start && period?.end && Date.parse(period.start) < Date.parse(period.end), "Daily summary period is invalid.");
    const runs = bundle.runs.filter(run => inPeriod(run.createdAt, period));
    const occurrences = bundle.occurrences.filter(item => inPeriod(item.discoveredAt, period));
    const associations = bundle.associations.filter(item => inPeriod(item.createdAt, period));
    const periodEvents = bundle.events.filter(event => inPeriod(event.occurredAt, period));
    const beforeCandidates = statesAt(bundle.grouped, period.start, false);
    const afterCandidates = statesAt(bundle.grouped, period.end, false);
    const before = countBy(beforeCandidates, candidate => candidate.state), after = countBy(afterCandidates, candidate => candidate.state);
    const workers = workerProjection(bundle.events, period);
    const convergenceArtifacts = bundle.operationalArtifacts.filter(item => item.createdAt && inPeriod(item.createdAt, period) && runs.some(run => run.runId === item.runId));
    const convergenceResults = convergenceArtifacts.flatMap(item => item.results || []);
    const hasConvergenceActions = convergenceArtifacts.length > 0;
    const newCandidates = hasConvergenceActions ? convergenceResults.filter(item => item.createdCandidate === true || ["create_new_candidate", "create_identity_discovery_candidate"].includes(item.action)).length : periodEvents.filter(event => event.eventType === "candidate_discovered").length;
    const candidateAttachments = hasConvergenceActions ? convergenceResults.filter(item => item.action === "attach_existing_candidate").length : periodEvents.filter(event => event.eventType === "discovery_attached").length;
    const rediscoveries = hasConvergenceActions ? convergenceResults.filter(item => item.action === "associate_existing_live_artist").length : associations.filter(item => item.targetType === "live_artist").length;
    const prevented = rediscoveries + candidateAttachments;
    const pending = afterCandidates.filter(candidate => PENDING_STATES.has(candidate.state)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const terminalDurations = candidateTerminalDurations(bundle.grouped, period);
    const providers = aggregateProviders(runs);
    const workerArtifacts = bundle.operationalArtifacts.filter(item => item.completedAt && inPeriod(item.completedAt, period));
    const workerRetries = workerArtifacts.reduce((total, item) => total + (item.metrics?.retries || 0), 0);
    if (workerRetries && providers.musicbrainz) { providers.musicbrainz.retries = Math.max(providers.musicbrainz.retries, workerRetries); providers.musicbrainz.retryAfterWaits = Math.max(providers.musicbrainz.retryAfterWaits, workerRetries); }
    const summary = {
        schemaVersion: 1,
        summaryType: "daily_operational",
        date: input.date || period.start.slice(0, 10),
        period: structuredClone(period),
        generatedAt: input.generatedAt || period.end,
        runIds: runs.map(run => run.runId).sort(),
        providers,
        checkpoints: checkpointPositions(bundle.checkpoints, period.end),
        budgets: aggregateBudgets(runs),
        discovery: { normalizedOccurrences: occurrences.length, byProvider: countBy(occurrences, item => item.provider), existingLiveArtistRediscoveries: rediscoveries, candidateAttachments, newCandidates },
        queue: { before, after, growthByState: Object.fromEntries(unique([...Object.keys(before), ...Object.keys(after)]).map(state => [state, (after[state] || 0) - (before[state] || 0)])), netGrowth: afterCandidates.length - beforeCandidates.length, agePercentiles: queueAges(afterCandidates, period.end), oldestPendingOrRetryCandidates: pending.slice(0, input.oldestLimit || 10).map(candidate => ({ candidateId: candidate.candidateId, artistName: candidate.name.raw, state: candidate.state, firstDiscoveredAt: candidate.createdAt, ageHours: round((Date.parse(period.end) - Date.parse(candidate.createdAt)) / 3600000) })) },
        workers: { stage3: workers.stage3, identityDiscovery: workers.identityDiscovery, newlyEntered: workers.newlyEntered, retryExhaustion: { count: workers.retryExhaustions, candidateIds: workers.newlyEntered.needs_review.filter(candidateId => periodEvents.some(event => event.candidateId === candidateId && event.reasonCode === "retry_budget_exhausted")) } },
        manualPause: runs.some(run => run.control.status === "paused") ? { active: true, runs: runs.filter(run => run.control.status === "paused").map(run => ({ runId: run.runId, reason: run.control.pauseReason })) } : { active: false, runs: [] },
        metrics: {
            discoveryYield: rate(newCandidates, occurrences.length), rediscoveryRate: rate(rediscoveries, occurrences.length), duplicatePreventionRate: rate(prevented, occurrences.length),
            identityCoherentRoutingRate: rate(workers.coherent, workers.stage3.selections), reviewRoutingRate: rate(workers.review, workers.stage3.selections + workers.identityDiscovery.selections), failedMatchRate: rate(workers.failedMatch, workers.stage3.selections),
            ticketmasterExactBridgeRate: rate(workers.exactBridges, workers.identityDiscovery.selections), retryRecoveryRate: rate(workers.retryRecoveries, workers.retryCandidates), retryExhaustionRate: rate(workers.retryExhaustions, workers.retryCandidates),
            medianDiscoveryToIdentityTerminalHours: round(median(terminalDurations))
        },
        sourceArtifactCounts: { runs: runs.length, candidateEvents: periodEvents.length, discoveryOccurrences: occurrences.length, discoveryAssociations: associations.length, evidenceArtifacts: bundle.evidenceArtifactRefs.length },
        reviewOnly: true, mutatesCandidateState: false, artifactDigest: null
    };
    summary.artifactDigest = summaryDigest(summary); validateDailySummary(summary); return summary;
}

function blockerFor(candidate, events) {
    const reasons = events.map(event => event.reasonCode);
    if (reasons.includes("retry_budget_exhausted") || candidate.failureReason === "retry_budget_exhausted") return "retry_budget_exhausted";
    if (candidate.resolvedIdentity.outcome === "semantic_identity_conflict" || candidate.state === "conflicting_identity") return "semantic_identity_conflict";
    if (candidate.resolvedIdentity.sameNameAmbiguity || candidate.resolvedIdentity.outcome === "coherent_identity_with_same_name_ambiguity") return "same_name_ambiguity";
    if (candidate.resolvedIdentity.outcome === "provider_profile_multiplicity") return "provider_profile_multiplicity";
    if (!candidate.candidateIdentifiers.spotifyArtistId || reasons.some(reason => /bridge/.test(reason) && /missing|not_found|no_safe/.test(reason))) return "missing_exact_bridge";
    if (["identity_coherent", "validation_pending"].includes(candidate.state) && candidate.editorial.proposedStage == null) return "editorial_input_missing";
    return "unresolved_identifiers";
}

const RECOMMENDATIONS = {
    same_name_ambiguity: "Compare exact provider identifiers and same-name competitors; select nothing by name alone.",
    provider_profile_multiplicity: "Review every alternate provider profile and confirm that none represents a distinct entity.",
    missing_exact_bridge: "Attach a human-approved exact Spotify/provider identifier or request bounded exact-ID evidence.",
    unresolved_identifiers: "Inspect unresolved exact cross-provider identifiers and preserve the candidate in review.",
    semantic_identity_conflict: "Resolve the incompatible person/group/project or authority evidence before any approval.",
    retry_budget_exhausted: "Decide whether to retry the exact provider operation manually or retain the review hold.",
    editorial_input_missing: "Provide separate human editorial metadata without changing the identity decision."
};

function reviewEntry(candidate, events, asOf) {
    const group = blockerFor(candidate, events);
    const ids = { spotifyArtistIds: unique([candidate.candidateIdentifiers.spotifyArtistId, candidate.resolvedIdentity.selectedSpotifyArtistId]), wikidataQids: unique(candidate.resolvedIdentity.wikidataQids), musicBrainzArtistIds: unique(candidate.resolvedIdentity.musicBrainzArtistIds), discogsArtistIds: unique(candidate.resolvedIdentity.discogsArtistIds), providerEntityKeys: unique((candidate.discoveryAssociations || []).map(item => item.providerEntityKey)), providerSourceRecordIds: unique(candidate.discoveries.map(discovery => discovery.sourceRecordId)) };
    const sources = candidate.discoveries.map(discovery => ({ sourceType: discovery.sourceType, sourceName: discovery.sourceName, sourceRecordId: discovery.sourceRecordId, sourceUrl: discovery.sourceUrl, discoveredAt: discovery.discoveredAt }));
    const conflicts = candidate.resolvedIdentity.conflicts || [];
    const refs = unique([...candidate.resolvedIdentity.evidenceRefs, ...events.flatMap(event => event.evidenceRefs || []), ...(candidate.identifierAttachments || []).flatMap(item => item.evidenceRefs || [])]);
    return { group, candidateId: candidate.candidateId, artistName: candidate.name.raw, lifecycleState: candidate.state, identityOutcome: candidate.resolvedIdentity.outcome, exactIdentifiers: ids, discoverySourceProvenance: sources, conciseEvidenceSummary: conflicts.length ? `${conflicts.length} conflict(s); ${refs.length} evidence reference(s).` : `${refs.length} evidence reference(s); outcome ${candidate.resolvedIdentity.outcome}.`, blockingReason: group, recommendedHumanAction: RECOMMENDATIONS[group], evidenceAndReportRefs: refs, firstDiscoveredAt: candidate.createdAt, ageInQueueHours: round(Math.max(0, (Date.parse(asOf) - Date.parse(candidate.createdAt)) / 3600000)) };
}

function buildWeeklySummary(input) {
    const bundle = normalizeBundle(input), period = input.period;
    assert(period?.start && period?.end && Date.parse(period.start) < Date.parse(period.end), "Weekly summary period is invalid.");
    const candidates = statesAt(bundle.grouped, period.end, false);
    const actionable = candidates.filter(candidate => REVIEW_STATES.has(candidate.state));
    const entries = actionable.map(candidate => reviewEntry(candidate, bundle.grouped.get(candidate.candidateId), period.end));
    const groups = Object.fromEntries(REVIEW_GROUPS.map(group => [group, entries.filter(entry => entry.group === group).sort((a, b) => a.candidateId.localeCompare(b.candidateId))]));
    const before = statesAt(bundle.grouped, period.start, false);
    const summary = { schemaVersion: 1, summaryType: "weekly_human_review", period: structuredClone(period), generatedAt: input.generatedAt || period.end, runIds: bundle.runs.filter(run => inPeriod(run.createdAt, period)).map(run => run.runId).sort(), actionableCandidateCount: actionable.length, groups, metrics: { weeklyNetQueueGrowth: candidates.length - before.length, queueAgePercentiles: queueAges(candidates, period.end) }, reviewOnly: true, mutatesCandidateState: false, recommendationsAreAdvisory: true, artifactDigest: null };
    summary.artifactDigest = summaryDigest(summary); validateWeeklySummary(summary); return summary;
}

module.exports = { buildDailySummary, buildWeeklySummary, blockerFor, median, percentile };
