const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { buildCandidateEvent, reduceCandidate } = require("../lib/ingestion/candidate-state-machine");
const { normalizeDiscovery, uuidV7 } = require("../lib/ingestion/candidate-schema");
const { createDiscoveryAssociation, normalizeDiscoveryOccurrence } = require("../lib/discovery/discovery-schema");
const { emptyBudgetConsumption } = require("../lib/scheduling/scheduled-budget-policy");
const { createCircuitBreaker, emptyProviderMetrics, recordBreakerFailure } = require("../lib/scheduling/provider-failure-policy");
const { buildEvent, replayRun } = require("../lib/scheduling/scheduled-run-journal");
const { stableConfigurationHash } = require("../lib/scheduling/scheduled-run-schema");
const { checkpointIdFor, stableSourceConfigurationHash } = require("../lib/scheduling/provider-checkpoint-schema");
const { buildDailySummary, buildWeeklySummary } = require("../lib/scheduling/scheduled-summary-generator");
const { ScheduledSummaryStore } = require("../lib/scheduling/scheduled-summary-store");
const { loadImmutableSummarySources } = require("../lib/scheduling/scheduled-summary-source-loader");
const { validateDailySummary, validateWeeklySummary } = require("../lib/scheduling/scheduled-summary-schema");
const fixture = require("./fixtures/scheduled-discovery/run-configuration.json");
const scenarios = require("./fixtures/scheduled-discovery/summary-scenarios.json");

const DAY = 24 * 60 * 60 * 1000;
const T0_MS = Date.parse("2026-08-10T00:00:00.000Z");
const at = hours => new Date(T0_MS + hours * 3600000).toISOString();
const period = { start: at(0), end: at(24) };
let idCounter = 0;
const nextUuid = timestamp => uuidV7(Date.parse(timestamp) + (++idCounter), Buffer.alloc(10, idCounter));

function makeCandidate(name, createdAt, initialState = "identity_pending", sourceType = "manual_curated_list") {
    const candidateId = `mr_candidate_${nextUuid(createdAt)}`;
    const discovery = normalizeDiscovery({ sourceType, sourceName: "scheduled summary fixture", sourceRecordId: `source-${candidateId}`, sourceUrl: `https://fixture.invalid/${candidateId}`, rawArtistName: name, spotifyArtistId: initialState === "identity_discovery_pending" ? null : String(idCounter).padStart(22, "0"), discoveredAt: createdAt });
    const events = [];
    const eventIdGenerator = () => `mr_candidate_event_${nextUuid(createdAt)}`;
    let candidate = null;
    function append(input) { const event = buildCandidateEvent({ candidateId, occurredAt: input.occurredAt, eventType: input.eventType || "state_transition", previousState: candidate?.state ?? null, nextState: input.nextState, previousRevision: candidate?.revision ?? 0, reasonCode: input.reasonCode, actor: input.actor || { type: "worker", id: "summary_fixture" }, evidenceRefs: input.evidenceRefs || [], payload: input.payload || {} }, { eventIdGenerator }); candidate = reduceCandidate(candidate, event); events.push(event); return candidate; }
    append({ eventType: "candidate_discovered", nextState: "discovered", reasonCode: "fixture_discovered", occurredAt: createdAt, actor: { type: "command", id: "summary_fixture" }, payload: { discovery } });
    append({ nextState: initialState, reasonCode: initialState === "identity_pending" ? "fixture_identity_pending" : "fixture_identity_discovery_pending", occurredAt: new Date(Date.parse(createdAt) + 1000).toISOString() });
    return { candidateId, discovery, events, get candidate() { return candidate; }, transition(nextState, occurredAt, reasonCode, payload = {}, evidenceRefs = []) { return append({ nextState, occurredAt, reasonCode, payload, evidenceRefs }); }, attachSpotify(occurredAt) { const value = String(idCounter + 100).padStart(22, "0"); return append({ eventType: "candidate_identifier_attached", nextState: candidate.state, occurredAt, reasonCode: "exact_spotify_bridge_discovered", evidenceRefs: ["fixture:bridge"], payload: { identifier: { provider: "spotify", entityType: "artist", value, url: `https://open.spotify.com/artist/${value}`, bridgeEvidenceId: `sha256:${"b".repeat(64)}`, evidenceRefs: ["fixture:bridge"] } } }); }, attachDiscovery(occurredAt, occurrenceId) { const attached = normalizeDiscovery({ sourceType: "playlist", sourceName: "fixture second source", sourceRecordId: `attachment-${candidateId}`, rawArtistName: name, spotifyArtistId: candidate.candidateIdentifiers.spotifyArtistId, discoveredAt: occurredAt }); return append({ eventType: "discovery_attached", nextState: candidate.state, occurredAt, reasonCode: "discovery_occurrence_attached", evidenceRefs: ["fixture:occurrence"], payload: { discovery: attached, discoveryAssociation: { occurrenceId, evidenceRef: "fixture:occurrence", provider: "spotify", providerEntityKey: `spotify:artist:${candidate.candidateIdentifiers.spotifyArtistId}` } } }); } };
}

function identityPayload(candidate, outcome, extras = {}) { const value = structuredClone(candidate.resolvedIdentity); return { ...value, outcome, selectedSpotifyArtistId: candidate.candidateIdentifiers.spotifyArtistId, evidenceRefs: [`fixture:evidence:${candidate.candidateId}`], resolvedAt: extras.resolvedAt, resolverVersion: "fixture_v1", ...extras } }

function makeRun({ createdAt = at(1), provider = "spotify", requests = 2, cacheHits = 1, errors = 0, transientFailures = 0, open = false, pause = false, stopReason = null, normalizedOccurrences = 4, newCandidates = 2, suffix = 1 } = {}) {
    const runId = `mr_discovery_run_${uuidV7(Date.parse(createdAt) + suffix, Buffer.alloc(10, suffix))}`;
    let eventCounter = suffix;
    const eventIdGenerator = () => `mr_discovery_run_event_${uuidV7(Date.parse(createdAt) + (++eventCounter), Buffer.alloc(10, eventCounter))}`;
    const consumption = emptyBudgetConsumption(); consumption.providers[provider === "ticketmaster" ? "ticketmaster" : "spotify"] = { requests, pages: requests ? 1 : 0, normalizedOccurrences, newCandidates };
    const created = buildEvent({ runId, eventType: "run_created", previousRevision: 0, phase: "created", disposition: "completed", occurredAt: createdAt, actor: { type: "system", id: "fixture" }, payload: { networkAllowed: false, stableConfigurationHash: stableConfigurationHash(fixture.configuration), configuration: fixture.configuration, budgets: fixture.budgets, budgetConsumption: consumption, protectedChecksums: { "data/artists.json": "a".repeat(64), "data/artist-id-registry.json": "b".repeat(64) } } }, { eventIdGenerator });
    const events = [created];
    let breaker = createCircuitBreaker(provider, { occurredAt: createdAt, runId });
    if (open) breaker = recordBreakerFailure(breaker, { occurredAt: createdAt, failureType: transientFailures ? "transient_infrastructure" : "authentication_or_configuration", reason: "fixture outage", runId }, { transientThreshold: 1 });
    const metrics = { ...emptyProviderMetrics(), requestsAttempted: requests, successfulRequests: Math.max(0, requests - errors), cacheHits, errors, retries: transientFailures, transientFailures };
    events.push(buildEvent({ runId, eventType: "provider_execution_recorded", previousRevision: 1, occurredAt: new Date(Date.parse(createdAt) + 1000).toISOString(), actor: { type: "system", id: "fixture" }, payload: { provider, metrics, circuitBreaker: breaker, stopReason } }, { eventIdGenerator }));
    if (pause) events.push(buildEvent({ runId, eventType: "run_paused", previousRevision: 2, occurredAt: new Date(Date.parse(createdAt) + 2000).toISOString(), actor: { type: "human", id: "fixture" }, payload: { reason: "manual_fixture_pause", budgetConsumption: consumption, checkpointRefs: [] } }, { eventIdGenerator }));
    if (stopReason) events.push(buildEvent({ runId, eventType: "run_stopped", previousRevision: 2, occurredAt: new Date(Date.parse(createdAt) + 2000).toISOString(), actor: { type: "system", id: "fixture" }, payload: { reason: stopReason, budgetConsumption: consumption, checkpointRefs: [] } }, { eventIdGenerator }));
    return replayRun(events);
}

function occurrence(provider, id, name, discoveredAt) { return normalizeDiscoveryOccurrence({ provider, sourceType: provider === "ticketmaster" ? "ticketmaster_event" : "playlist", sourceName: "summary fixture", sourceRecordId: `record-${id}`, rawArtistName: name, providerEntity: { type: provider === "ticketmaster" ? "attraction" : "artist", id }, discoveredAt, reviewOnly: true }); }
function checkpoint(provider, createdAt, position) { const sourceConfiguration = { mode: "fixture", provider }; const stableConfigurationHash = stableSourceConfigurationHash(sourceConfiguration); const value = { schemaVersion: 1, checkpointId: checkpointIdFor({ provider, adapterId: `${provider}_discovery`, adapterVersion: "v1", stableConfigurationHash }), provider, adapterId: `${provider}_discovery`, adapterVersion: "v1", stableConfigurationHash, revision: 2, position, rollingWindowIdentity: null, exhausted: false, lastCompletedRunId: null, latestRawPageEvidenceRef: `fixture:${provider}:page`, createdAt, updatedAt: new Date(Date.parse(createdAt) + 1000).toISOString() }; return value; }

function fixtureBundle() {
    const coherent = makeCandidate("Coherent Artist", at(1)); coherent.transition("identity_resolving", at(2), "identity_resolution_started"); coherent.transition("identity_coherent", at(3), "identity_coherent", { resolvedIdentity: identityPayload(coherent.candidate, "coherent_identity_evidence", { resolvedAt: at(3) }) }, ["fixture:coherent"]);
    const bridge = makeCandidate("Bridge Artist", at(4), "identity_discovery_pending", "ticketmaster_event"); bridge.transition("identity_discovering", at(5), "identity_discovery_started"); bridge.attachSpotify(at(6)); bridge.transition("identity_pending", at(7), "exact_spotify_bridge_found");
    const exhausted = makeCandidate("Exhausted Artist", at(-48)); exhausted.transition("identity_resolving", at(-47), "identity_resolution_started"); exhausted.transition("retry_wait", at(-46), "identity_provider_retry_scheduled", { processing: { retryAt: at(-1), resumeState: "identity_pending" } }); exhausted.transition("needs_review", at(8), "retry_budget_exhausted", { failureReason: "retry_budget_exhausted", processing: { retryAt: null, resumeState: null } }, ["fixture:retry"]);
    const recovered = makeCandidate("Recovered Artist", at(9)); recovered.transition("identity_resolving", at(10), "identity_resolution_started"); recovered.transition("retry_wait", at(11), "identity_provider_retry_scheduled", { processing: { retryAt: at(12), resumeState: "identity_pending" } }); recovered.transition("identity_pending", at(12), "identity_retry_became_eligible");
    const oldest = makeCandidate("Old Pending", at(-72));
    const attachmentOccurrence = occurrence("spotify", "attachment-artist", "Old Pending", at(13)); oldest.attachDiscovery(at(13), attachmentOccurrence.occurrenceId);
    const occurrences = [occurrence("spotify", "coherent", "Coherent Artist", at(1)), occurrence("ticketmaster", "bridge", "Bridge Artist", at(4)), occurrence("ticketmaster", "live", "Live Artist", at(14)), attachmentOccurrence];
    const associations = [createDiscoveryAssociation({ occurrenceId: occurrences[2].occurrenceId, targetType: "live_artist", targetId: "mr_artist_000001", matchedBy: ["exact_spotify_binding"], evidenceRefs: ["fixture:live"], createdAt: at(14) })];
    const candidates = [coherent, bridge, exhausted, recovered, oldest];
    return { runs: [makeRun({ pause: true })], candidateEvents: candidates.flatMap(item => item.events), discoveryOccurrences: occurrences, discoveryAssociations: associations, checkpoints: [checkpoint("spotify", at(1), { providerPage: 1, cursor: null, itemOffset: 2 }), checkpoint("ticketmaster", at(1), { providerPage: 1, cursor: "fixture-next", itemOffset: 0 })] };
}

test("summary fixture matrix enumerates every approved offline scenario", () => { assert.equal(scenarios.reviewOnly, true); assert.equal(scenarios.scenarios.length, 12); });

test("normal daily summary reports provider, discovery, queue, worker, and pause operations", () => {
    const summary = buildDailySummary({ ...fixtureBundle(), period });
    assert.equal(validateDailySummary(summary), true); assert.equal(summary.discovery.normalizedOccurrences, 4); assert.equal(summary.discovery.newCandidates, 3); assert.equal(summary.discovery.existingLiveArtistRediscoveries, 1); assert.equal(summary.discovery.candidateAttachments, 1);
    assert.equal(summary.workers.stage3.selections, 2); assert.equal(summary.workers.stage3.outcomesByState.identity_coherent, 1); assert.equal(summary.workers.identityDiscovery.selections, 1); assert.equal(summary.manualPause.active, true);
    assert.equal(summary.providers.spotify.requests, 2); assert.equal(summary.providers.spotify.cacheHits, 1); assert.equal(summary.checkpoints.length, 2);
});

test("provider outage and open circuit breaker remain isolated and visible", () => {
    const bundle = fixtureBundle(); bundle.runs = [makeRun({ provider: "ticketmaster", requests: 1, errors: 1, transientFailures: 1, open: true })];
    const summary = buildDailySummary({ ...bundle, period });
    assert.equal(summary.providers.ticketmaster.errors, 1); assert.equal(summary.providers.ticketmaster.circuitBreaker.state, "open"); assert.equal(summary.providers.spotify.requests, 0);
});

test("queue high-water stop reason is reported without changing queue state", () => {
    const bundle = fixtureBundle(); bundle.runs = [makeRun({ stopReason: "queue_high_water_reached:needs_review" })];
    const before = JSON.stringify(bundle.candidateEvents); const summary = buildDailySummary({ ...bundle, period });
    assert.ok(summary.budgets.stopReasons.includes("queue_high_water_reached:needs_review")); assert.equal(JSON.stringify(bundle.candidateEvents), before);
});

test("retry exhaustion is reported separately from failed match", () => {
    const summary = buildDailySummary({ ...fixtureBundle(), period });
    assert.equal(summary.workers.retryExhaustion.count, 1); assert.equal(summary.workers.retryExhaustion.candidateIds.length, 1); assert.equal(summary.workers.newlyEntered.needs_review.length, 1); assert.equal(summary.workers.newlyEntered.failed_match.length, 0); assert.equal(summary.metrics.retryExhaustionRate, 0.5); assert.equal(summary.metrics.retryRecoveryRate, 0.5);
});

test("no-activity day produces zero deltas and null undefined-denominator rates", () => {
    const bundle = fixtureBundle(); const quiet = { start: at(48), end: at(72) }; const summary = buildDailySummary({ ...bundle, runs: [], period: quiet });
    assert.equal(summary.discovery.normalizedOccurrences, 0); assert.equal(summary.queue.netGrowth, 0); assert.equal(summary.metrics.discoveryYield, null); assert.deepEqual(summary.runIds, []);
});

test("multiple scheduled runs aggregate provider accounting", () => {
    const bundle = fixtureBundle(); bundle.runs = [makeRun({ requests: 2, cacheHits: 1, suffix: 10 }), makeRun({ createdAt: at(15), requests: 3, cacheHits: 2, suffix: 20 })]; const summary = buildDailySummary({ ...bundle, period });
    assert.equal(summary.runIds.length, 2); assert.equal(summary.providers.spotify.requests, 5); assert.equal(summary.providers.spotify.cacheHits, 3);
});

function weeklyBundle() {
    const definitions = [
        ["Same Name", "same", "needs_review", "coherent_identity_with_same_name_ambiguity", { sameNameAmbiguity: { completed: true, competitors: [{}] } }],
        ["Multiplicity", "multi", "needs_review", "provider_profile_multiplicity", {}],
        ["No Bridge", "bridge", "needs_review", "unresolved_identity", {}, "identity_discovery_pending"],
        ["Unresolved", "unresolved", "needs_review", "insufficient_corroboration", {}],
        ["Semantic", "semantic", "conflicting_identity", "semantic_identity_conflict", {}],
        ["Retry Hold", "retry", "needs_review", "unresolved_identity", {}, "identity_pending", "retry_budget_exhausted"],
        ["Editorial", "editorial", "identity_coherent", "coherent_identity_evidence", {}]
    ];
    const candidates = definitions.map(([name, key, state, outcome, extras, initial = "identity_pending", finalReason]) => {
        const item = makeCandidate(name, at(-24 + candidatesPlaceholder++), initial, initial === "identity_discovery_pending" ? "ticketmaster_event" : "manual_curated_list");
        if (initial === "identity_discovery_pending") item.transition("identity_discovering", at(-10 + candidatesPlaceholder), "identity_discovery_started"); else item.transition("identity_resolving", at(-10 + candidatesPlaceholder), "identity_resolution_started");
        const payload = { resolvedIdentity: identityPayload(item.candidate, outcome, { ...extras, resolvedAt: at(-5 + candidatesPlaceholder) }) };
        if (finalReason === "retry_budget_exhausted") { item.transition("retry_wait", at(-8 + candidatesPlaceholder), "identity_provider_retry_scheduled", { processing: { retryAt: at(-2), resumeState: "identity_pending" } }); payload.failureReason = "retry_budget_exhausted"; }
        item.transition(state, at(-1 + candidatesPlaceholder), finalReason || `fixture_${key}`, payload, [`fixture:${key}`]); return item;
    });
    return { runs: [], candidateEvents: candidates.flatMap(item => item.events), discoveryOccurrences: [], discoveryAssociations: [], checkpoints: [] };
}
let candidatesPlaceholder = 0;

test("weekly summary groups candidates by every requested blocker with advisory actions", () => {
    candidatesPlaceholder = 0; const summary = buildWeeklySummary({ ...weeklyBundle(), period: { start: at(-48), end: at(24) } }); assert.equal(validateWeeklySummary(summary), true);
    for (const group of ["same_name_ambiguity", "provider_profile_multiplicity", "missing_exact_bridge", "unresolved_identifiers", "semantic_identity_conflict", "retry_budget_exhausted", "editorial_input_missing"]) { assert.ok(summary.groups[group].length >= 1, group); assert.ok(summary.groups[group][0].recommendedHumanAction); }
    assert.equal(summary.actionableCandidateCount, 7); assert.equal(summary.recommendationsAreAdvisory, true);
});

test("queue age percentiles and oldest pending candidates are deterministic", () => {
    const summary = buildDailySummary({ ...fixtureBundle(), period }); assert.equal(summary.queue.agePercentiles.maxHours, 96); assert.equal(summary.queue.oldestPendingOrRetryCandidates[0].artistName, "Old Pending"); assert.equal(summary.queue.oldestPendingOrRetryCandidates[0].ageHours, 96);
});

test("median discovery-to-identity-terminal time uses immutable transition timestamps", () => {
    const summary = buildDailySummary({ ...fixtureBundle(), period }); assert.equal(summary.metrics.medianDiscoveryToIdentityTerminalHours, 29);
});

test("deleted summary rebuilds byte-identically from immutable artifacts", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-summary-")); t.after(() => fs.rm(root, { recursive: true, force: true })); const scheduledRoot = path.join(root, "scheduled"); const store = new ScheduledSummaryStore(path.join(root, "summaries")); const bundle = fixtureBundle();
    async function write(relative, value) { const file = path.join(scheduledRoot, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
    for (const event of bundle.candidateEvents) await write(`store/events/${event.candidateId}/${String(event.candidateRevision).padStart(6, "0")}.json`, event);
    for (const item of bundle.discoveryOccurrences) await write(`store/discovery/occurrences/${item.provider}/${item.occurrenceId.slice(7)}.json`, item);
    for (const item of bundle.discoveryAssociations) await write(`store/discovery/associations/${item.targetType}/${item.associationId.slice(7)}.json`, item);
    for (const item of bundle.checkpoints) await write(`checkpoints/${item.provider}/history/${String(item.revision).padStart(6, "0")}.json`, item);
    await write("store/evidence/identity/fixture.json", { schemaVersion: 1, reviewOnly: true });
    const loaded = await loadImmutableSummarySources(scheduledRoot); const first = buildDailySummary({ ...loaded, period }); await store.writeDaily(first); const bytes = await fs.readFile(store.dailyPath(first.date), "utf8"); await fs.unlink(store.dailyPath(first.date)); const reloaded = await loadImmutableSummarySources(scheduledRoot); const rebuilt = buildDailySummary({ ...reloaded, period }); await store.writeDaily(rebuilt); assert.equal(await fs.readFile(store.dailyPath(first.date), "utf8"), bytes); assert.deepEqual(rebuilt, first); assert.equal(first.sourceArtifactCounts.evidenceArtifacts, 1);
});

test("daily and weekly summary generation never mutates candidate events or snapshots", () => {
    candidatesPlaceholder = 0; const dailyBundle = fixtureBundle(), weekly = weeklyBundle(); const dailyBefore = JSON.stringify(dailyBundle), weeklyBefore = JSON.stringify(weekly); buildDailySummary({ ...dailyBundle, period }); buildWeeklySummary({ ...weekly, period: { start: at(-48), end: at(24) } }); assert.equal(JSON.stringify(dailyBundle), dailyBefore); assert.equal(JSON.stringify(weekly), weeklyBefore);
});
