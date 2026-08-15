const { consumeProvider, emptyBudgetConsumption, providerStopReason } = require("./scheduled-budget-policy");

async function runFixtureProvider(options) {
    if (options.networkAllowed === true) throw new Error("Fixture bounded provider runner does not support network mode.");
    const {
        provider,
        checkpointStore,
        sourceConfiguration,
        pages,
        budgets,
        runId,
        processOccurrence
    } = options;
    let checkpoint = await checkpointStore.resumeCheckpoint(options.checkpoint, {
        provider,
        adapterId: options.adapterId,
        adapterVersion: options.adapterVersion,
        sourceConfiguration
    });
    let checkpointRef = options.checkpointRef || null;
    let consumption = structuredClone(options.consumption || emptyBudgetConsumption());
    const queueCounts = { ...(options.queueCounts || {}) };
    const processed = [];

    async function save(changes) {
        const result = await checkpointStore.updateCheckpoint(checkpoint, {
            provider,
            adapterId: options.adapterId,
            adapterVersion: options.adapterVersion,
            sourceConfiguration,
            expectedRevision: checkpoint.revision,
            ...changes
        });
        checkpoint = result.checkpoint;
        checkpointRef = result.checkpointRef;
    }

    async function stop(reason) {
        let runManifest = null;
        if (options.runStore && options.runManifest) {
            runManifest = await options.runStore.controlRun(runId, {
                expectedRevision: options.runManifest.revision,
                configuration: options.runConfiguration,
                action: "stop",
                reason,
                checkpointRefs: checkpointRef ? [checkpointRef] : [],
                budgetConsumption: consumption,
                actor: { type: "system", id: "fixture_bounded_provider_runner" }
            });
        }
        return { stopped: true, stopReason: reason, checkpoint, checkpointRef, consumption, queueCounts, processed, runManifest };
    }

    while (!checkpoint.exhausted) {
        const page = pages[checkpoint.position.providerPage];
        if (!page) {
            await save({ exhausted: true, lastCompletedRunId: runId });
            break;
        }
        const pageAlreadyAvailable = checkpoint.latestRawPageEvidenceRef === page.rawEvidenceRef;
        let reason = providerStopReason(provider, consumption, budgets, queueCounts, {
            requiresRequest: !pageAlreadyAvailable,
            startsPage: !pageAlreadyAvailable
        });
        if (reason) return stop(reason);
        if (!pageAlreadyAvailable) {
            consumption = consumeProvider(consumption, provider, { requests: 1, pages: 1 });
            await save({ latestRawPageEvidenceRef: page.rawEvidenceRef });
        }
        while (checkpoint.position.itemOffset < page.items.length) {
            const item = page.items[checkpoint.position.itemOffset];
            reason = providerStopReason(provider, consumption, budgets, queueCounts, {
                normalizesOccurrence: true,
                createsCandidate: item.createsCandidate === true,
                targetState: item.targetState || null
            });
            if (reason) return stop(reason);
            const result = await processOccurrence(item);
            consumption = consumeProvider(consumption, provider, {
                normalizedOccurrences: 1,
                newCandidates: item.createsCandidate && result.created ? 1 : 0
            });
            if (item.createsCandidate && result.created && item.targetState) queueCounts[item.targetState] = (queueCounts[item.targetState] || 0) + 1;
            processed.push({ occurrenceId: item.occurrenceId, created: result.created, idempotent: result.idempotent });
            if (options.crashAfterOccurrenceId === item.occurrenceId) throw new Error(`Simulated fixture crash after ${item.occurrenceId}.`);
            await save({
                position: { ...checkpoint.position, itemOffset: checkpoint.position.itemOffset + 1 },
                latestRawPageEvidenceRef: page.rawEvidenceRef
            });
        }
        const nextPage = checkpoint.position.providerPage + 1;
        const exhausted = nextPage >= pages.length;
        await save({
            position: { providerPage: nextPage, cursor: page.nextCursor || null, itemOffset: 0 },
            latestRawPageEvidenceRef: null,
            exhausted,
            lastCompletedRunId: exhausted ? runId : checkpoint.lastCompletedRunId
        });
    }
    return { stopped: false, stopReason: null, checkpoint, checkpointRef, consumption, queueCounts, processed, runManifest: null };
}

module.exports = { runFixtureProvider };
