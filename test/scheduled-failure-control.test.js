const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { normalizeDiscovery, uuidV7 } = require("../lib/ingestion/candidate-schema");
const { CandidateStore } = require("../lib/ingestion/candidate-store");
const { FixtureProviderExecutor } = require("../lib/scheduling/fixture-provider-executor");
const { MAX_ELAPSED_MS, RETRY_DELAYS_MS, evaluateRetryRecord, recordRetryFailure, routeRetryExhaustion } = require("../lib/scheduling/candidate-retry-policy");
const { createCircuitBreaker, emptyProviderMetrics, enterHalfOpen, recordBreakerFailure, recordBreakerSuccess } = require("../lib/scheduling/provider-failure-policy");
const { ScheduledRunStore } = require("../lib/scheduling/scheduled-run-store");
const { ScheduledFailureStore } = require("../lib/scheduling/scheduled-failure-store");
const fixture = require("./fixtures/scheduled-discovery/run-configuration.json");
const failureScenarios = require("./fixtures/scheduled-discovery/provider-failure-scenarios.json");

const T0 = "2026-08-15T12:00:00.000Z";
const candidateId = "mr_candidate_0198b7e0-0000-7000-8000-000000000001";
const runId = "mr_discovery_run_0198b7e0-0000-7000-8000-000000000001";
const protectedChecksums = { "data/artists.json": "a".repeat(64), "data/artist-id-registry.json": "b".repeat(64) };
const at = ms => new Date(Date.parse(T0) + ms).toISOString();

test("fixture matrix is explicitly offline and enumerates every approved failure scenario", () => {
    assert.equal(failureScenarios.networkAllowed, false);
    assert.equal(failureScenarios.reviewOnly, true);
    assert.equal(failureScenarios.scenarios.length, 17);
});

function job(provider, overrides = {}) {
    return { runId, candidateId, provider, operation: "fixture_operation", started: true, evidenceRefs: ["fixture:evidence"], ...overrides };
}

test("Spotify authentication failure opens only Spotify while Ticketmaster continues", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0 });
    const spotify = await executor.execute(job("spotify"), async () => ({ statusCode: 401 }));
    const ticketmaster = await executor.execute(job("ticketmaster"), async () => ({ statusCode: 200, value: "ok" }));
    assert.equal(spotify.breaker.state, "open");
    assert.equal(executor.providerMetrics("spotify").authenticationFailures, 1);
    assert.equal(ticketmaster.status, "success");
    assert.equal(executor.breaker("ticketmaster").state, "closed");
    const sameRunSpotify = await executor.execute(job("spotify", { candidateId: candidateId.replace(/1$/, "2") }), async () => ({ statusCode: 200 }));
    assert.equal(sameRunSpotify.status, "skipped_lane_open");
    assert.equal(sameRunSpotify.candidateUntouched, true);
});

test("Ticketmaster 503 does not stop a separately queued Stage 3 provider lane", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0, transientThreshold: 1 });
    await executor.execute(job("ticketmaster"), async () => ({ statusCode: 503 }));
    const stage3 = await executor.execute(job("wikidata", { operation: "spotify_bridge" }), async () => ({ statusCode: 200 }));
    assert.equal(executor.breaker("ticketmaster").state, "open");
    assert.equal(stage3.status, "success");
});

test("MusicBrainz 429 respects a longer Retry-After", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0 });
    const result = await executor.execute(job("musicbrainz", { operation: "artist" }), async () => ({ statusCode: 429, retryAfter: 7200 }));
    assert.equal(result.retryRecord.nextRetryAt, at(2 * 60 * 60 * 1000));
    assert.equal(executor.providerMetrics("musicbrainz").retryAfterWaits, 1);
});

test("Discogs transient network failure is attributable and retryable", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0 });
    const result = await executor.execute(job("discogs", { operation: "artist" }), async () => { const error = new Error("fixture network failure"); error.category = "network"; throw error; });
    assert.equal(result.status, "transient_infrastructure");
    assert.equal(result.retryRecord.provider, "discogs");
    assert.equal(executor.providerMetrics("discogs").transientFailures, 1);
});

test("semantic 404 is a permanent absence and is never retried", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0 });
    const result = await executor.execute(job("wikidata"), async () => ({ statusCode: 404 }));
    assert.equal(result.status, "permanent_absence");
    assert.equal(result.retryable, false);
    assert.equal(executor.retryRecords.size, 0);
    assert.equal(executor.providerMetrics("wikidata").permanentAbsences, 1);
});

test("retry attempts use +15 minutes, +2 hours, and +24 hours", () => {
    let record = recordRetryFailure(null, { candidateId, provider: "musicbrainz", operation: "artist", occurredAt: T0, failureCategory: "transient_infrastructure" });
    assert.equal(record.nextRetryAt, at(RETRY_DELAYS_MS[0]));
    record = recordRetryFailure(record, { candidateId, provider: "musicbrainz", operation: "artist", occurredAt: at(RETRY_DELAYS_MS[0]), failureCategory: "transient_infrastructure" });
    assert.equal(record.nextRetryAt, at(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1]));
    record = recordRetryFailure(record, { candidateId, provider: "musicbrainz", operation: "artist", occurredAt: at(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1]), failureCategory: "transient_infrastructure" });
    assert.equal(record.nextRetryAt, at(RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1] + RETRY_DELAYS_MS[2]));
    assert.equal(record.exhausted, false);
});

test("a fourth failure exhausts the three-retry budget", () => {
    let record = null;
    for (let attempt = 0; attempt < 4; attempt += 1) record = recordRetryFailure(record, { candidateId, provider: "discogs", operation: "artist", occurredAt: at(attempt * 1000), failureCategory: "transient_infrastructure" });
    assert.equal(record.exhausted, true);
    assert.equal(record.exhaustionReason, "retry_attempts_exhausted");
    assert.equal(record.nextRetryAt, null);
});

test("72 elapsed hours exhausts retry budget without manufacturing another provider attempt", () => {
    const first = recordRetryFailure(null, { candidateId, provider: "spotify", operation: "profile", occurredAt: T0, failureCategory: "transient_infrastructure" });
    const exhausted = evaluateRetryRecord(first, at(MAX_ELAPSED_MS));
    assert.equal(exhausted.exhausted, true);
    assert.equal(exhausted.attemptCount, 1);
    assert.equal(exhausted.exhaustionReason, "retry_elapsed_time_exhausted");
});

test("provider breaker opens at threshold and skips candidates while open", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0, transientThreshold: 1 });
    await executor.execute(job("ticketmaster"), async () => ({ statusCode: 503 }));
    const skipped = await executor.execute(job("ticketmaster", { candidateId: candidateId.replace(/1$/, "2") }), async () => ({ statusCode: 200 }));
    assert.equal(skipped.status, "skipped_lane_open");
    assert.equal(skipped.candidateUntouched, true);
    assert.equal(executor.providerMetrics("ticketmaster").candidatesSkippedLaneOpen, 1);
});

test("half-open probe success closes breaker", () => {
    const initial = createCircuitBreaker("musicbrainz", { occurredAt: T0, runId });
    const open = recordBreakerFailure(initial, { occurredAt: T0, failureType: "transient_infrastructure", reason: "503", runId, probeDelayMs: 1000 }, { transientThreshold: 1 });
    const halfOpen = enterHalfOpen(open, at(1000));
    const closed = recordBreakerSuccess(halfOpen, at(1001));
    assert.equal(closed.state, "closed");
    assert.equal(closed.failureCount, 0);
});

test("half-open probe failure reopens breaker", () => {
    const initial = createCircuitBreaker("discogs", { occurredAt: T0, runId });
    const open = recordBreakerFailure(initial, { occurredAt: T0, failureType: "transient_infrastructure", reason: "network", runId, probeDelayMs: 1000 }, { transientThreshold: 1 });
    const halfOpen = enterHalfOpen(open, at(1000));
    const reopened = recordBreakerFailure(halfOpen, { occurredAt: at(1000), failureType: "transient_infrastructure", reason: "network", runId, probeDelayMs: 1000 });
    assert.equal(reopened.state, "open");
    assert.equal(reopened.nextProbeAt, at(2000));
});

test("one candidate failure does not stop the next below breaker threshold", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0, transientThreshold: 2 });
    const first = await executor.execute(job("discogs"), async () => ({ statusCode: 503 }));
    const second = await executor.execute(job("discogs", { candidateId: candidateId.replace(/1$/, "2") }), async () => ({ statusCode: 200 }));
    assert.equal(first.status, "transient_infrastructure");
    assert.equal(second.status, "success");
    assert.equal(executor.breaker("discogs").failureCount, 0);
});

test("provider outage before candidate operation leaves candidate untouched", async () => {
    const executor = new FixtureProviderExecutor({ clock: () => T0, transientThreshold: 1 });
    const result = await executor.execute(job("ticketmaster", { started: false }), async () => ({ statusCode: 503 }));
    assert.equal(result.candidateUntouched, true);
    assert.equal(result.retryRecord, null);
});

test("retry exhaustion appends retry_wait to needs_review and replay matches", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-retry-exhaustion-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let idTick = 1;
    const store = new CandidateStore(root, {
        candidateIdGenerator: () => candidateId,
        eventIdGenerator: () => `mr_candidate_event_${uuidV7(Date.parse(T0) + idTick++, Buffer.alloc(10, idTick))}`,
        clock: () => T0
    });
    const discovery = normalizeDiscovery({ sourceType: "manual_curated_list", sourceName: "retry fixture", rawArtistName: "Retry Artist", spotifyArtistId: "0000000000000000000001", discoveredAt: T0 });
    let candidate = await store.createCandidate(discovery, { candidateId });
    candidate = await store.transitionCandidate(candidateId, { expectedRevision: candidate.revision, nextState: "identity_pending", reasonCode: "fixture_identity_pending", actor: { type: "system", id: "fixture" } });
    candidate = await store.transitionCandidate(candidateId, { expectedRevision: candidate.revision, nextState: "identity_resolving", reasonCode: "fixture_identity_resolving", actor: { type: "worker", id: "fixture" } });
    candidate = await store.transitionCandidate(candidateId, { expectedRevision: candidate.revision, nextState: "retry_wait", reasonCode: "fixture_retry", actor: { type: "worker", id: "fixture" }, payload: { processing: { retryAt: at(1000), resumeState: "identity_pending" } } });
    let record = null;
    for (let attempt = 0; attempt < 4; attempt += 1) record = recordRetryFailure(record, { candidateId, provider: "musicbrainz", operation: "artist", occurredAt: at(attempt * 1000), failureCategory: "transient_infrastructure", evidenceRefs: [`fixture:failure:${attempt}`] });
    const held = await routeRetryExhaustion(store, candidate, record, { occurredAt: at(5000) });
    assert.equal(held.state, "needs_review");
    assert.equal(held.failureReason, "retry_budget_exhausted");
    assert.equal(held.processing.retryRecord.attemptCount, 4);
    assert.deepEqual(await store.replay(candidateId), held);
});

test("scheduled manifest records provider-isolated failure metrics without failing run", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-provider-manifest-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let tick = 1;
    const store = new ScheduledRunStore(root, {
        runIdGenerator: () => runId,
        eventIdGenerator: () => `mr_discovery_run_event_${uuidV7(Date.parse(T0) + tick++, Buffer.alloc(10, tick))}`,
        clock: () => T0
    });
    const created = await store.createRun({ configuration: fixture.configuration, budgets: fixture.budgets, networkAllowed: false, protectedChecksums });
    const breaker = recordBreakerFailure(createCircuitBreaker("spotify", { occurredAt: T0, runId }), { occurredAt: T0, failureType: "authentication_or_configuration", reason: "fixture auth", runId });
    const metrics = { ...emptyProviderMetrics(), requestsAttempted: 1, authenticationFailures: 1 };
    const manifest = await store.recordProviderExecution(runId, { expectedRevision: created.revision, configuration: fixture.configuration, provider: "spotify", metrics, circuitBreaker: breaker, stopReason: "provider_authentication_failure" });
    assert.equal(manifest.providerExecution.spotify.circuitBreaker.state, "open");
    assert.equal(manifest.providerExecution.spotify.metrics.authenticationFailures, 1);
    assert.equal(manifest.control.status, "running");
    assert.equal(manifest.providerPhaseStatuses.ticketmaster, "pending");
    assert.equal(await store.verifyManifest(runId), true);
});

test("circuit and retry snapshots retain immutable history and reject stale persistence", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "music-roll-failure-store-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new ScheduledFailureStore(root);
    const closed = createCircuitBreaker("wikidata", { occurredAt: T0, runId });
    await store.persistBreaker(closed, -1);
    const opened = recordBreakerFailure(closed, { occurredAt: T0, failureType: "authentication_or_configuration", reason: "config", runId });
    await store.persistBreaker(opened, closed.revision);
    await assert.rejects(() => store.persistBreaker(opened, closed.revision), /Stale circuit-breaker revision/);
    const retry1 = recordRetryFailure(null, { candidateId, provider: "musicbrainz", operation: "artist", occurredAt: T0, failureCategory: "transient_infrastructure" });
    await store.persistRetry(retry1, 0);
    const retry2 = recordRetryFailure(retry1, { candidateId, provider: "musicbrainz", operation: "artist", occurredAt: at(1000), failureCategory: "transient_infrastructure" });
    await store.persistRetry(retry2, 1);
    await assert.rejects(() => store.persistRetry(retry2, 1), /Stale retry attempt count/);
    assert.equal((await store.readBreaker("wikidata")).state, "open");
    assert.equal((await store.readRetry(retry2)).attemptCount, 2);
});
