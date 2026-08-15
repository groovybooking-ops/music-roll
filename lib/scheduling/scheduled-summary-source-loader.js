const fs = require("fs/promises");
const path = require("path");
const { replayRun } = require("./scheduled-run-journal");

async function listJsonFiles(root) {
    const files = [];
    async function visit(current) {
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
        for (const entry of entries) { const target = path.join(current, entry.name); if (entry.isDirectory()) await visit(target); else if (entry.name.endsWith(".json")) files.push(target); }
    }
    await visit(root); return files.sort();
}
async function readAll(root) { return Promise.all((await listJsonFiles(root)).map(async file => ({ file, value: JSON.parse(await fs.readFile(file, "utf8")) }))); }

async function loadImmutableSummarySources(scheduledRoot) {
    const root = path.resolve(scheduledRoot);
    const [runItems, candidateItems, occurrenceItems, associationItems, checkpointItems, evidenceItems] = await Promise.all([
        readAll(path.join(root, "runs")), readAll(path.join(root, "store", "events")), readAll(path.join(root, "store", "discovery", "occurrences")), readAll(path.join(root, "store", "discovery", "associations")), readAll(path.join(root, "checkpoints")), readAll(path.join(root, "store", "evidence"))
    ]);
    const runEvents = runItems.filter(item => item.file.includes(`${path.sep}events${path.sep}`)).map(item => item.value);
    const byRun = new Map(); for (const event of runEvents) { if (!byRun.has(event.runId)) byRun.set(event.runId, []); byRun.get(event.runId).push(event); }
    const runs = [...byRun.values()].map(events => replayRun(events.sort((a, b) => a.runRevision - b.runRevision)));
    const checkpoints = checkpointItems.filter(item => item.file.includes(`${path.sep}history${path.sep}`)).map(item => item.value);
    const operationalArtifacts = runItems.filter(item => item.file.includes(`${path.sep}artifacts${path.sep}`) && ["convergence.json", "stage3.json", "identity-discovery.json"].includes(path.basename(item.file))).map(item => item.value);
    return { runs, candidateEvents: candidateItems.map(item => item.value), discoveryOccurrences: occurrenceItems.map(item => item.value), discoveryAssociations: associationItems.map(item => item.value), checkpoints, operationalArtifacts, evidenceArtifactRefs: evidenceItems.map(item => path.relative(root, item.file).split(path.sep).join("/")) };
}

module.exports = { listJsonFiles, loadImmutableSummarySources };
