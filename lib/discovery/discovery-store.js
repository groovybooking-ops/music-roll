const fs = require("fs/promises");
const path = require("path");
const { createEventId } = require("../ingestion/candidate-schema");
const {
    createDiscoveryAssociation,
    providerEntityKey,
    validateDiscoveryAssociation,
    validateDiscoveryOccurrence
} = require("./discovery-schema");

async function readJson(file) {
    return JSON.parse(await fs.readFile(file, "utf8"));
}

async function listJsonFiles(root) {
    const output = [];
    async function visit(current) {
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
        for (const entry of entries) {
            const target = path.join(current, entry.name);
            if (entry.isDirectory()) await visit(target);
            else if (entry.name.endsWith(".json")) output.push(target);
        }
    }
    await visit(root);
    return output.sort();
}

class DiscoveryStore {
    constructor(storeRoot, options = {}) {
        if (!storeRoot) throw new Error("Discovery store root is required.");
        this.storeRoot = path.resolve(storeRoot);
        this.root = path.join(this.storeRoot, "discovery");
        this.occurrencesRoot = path.join(this.root, "occurrences");
        this.associationsRoot = path.join(this.root, "associations");
        this.indexesRoot = path.join(this.root, "indexes");
        this.clock = options.clock || (() => new Date().toISOString());
    }

    relative(file) {
        return path.relative(this.storeRoot, file).split(path.sep).join("/");
    }

    occurrencePath(occurrence) {
        validateDiscoveryOccurrence(occurrence);
        return path.join(this.occurrencesRoot, occurrence.provider, `${occurrence.occurrenceId.slice(7)}.json`);
    }

    associationPath(association) {
        validateDiscoveryAssociation(association);
        const targetDirectory = association.targetType === "candidate" ? "candidates" : "live";
        return path.join(this.associationsRoot, targetDirectory, association.targetId, `${association.associationId.slice(7)}.json`);
    }

    async writeExclusive(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    }

    async writeAtomic(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${createEventId()}.tmp`);
        await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
        try { await fs.rename(temporary, file); }
        catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    }

    async persistOccurrence(occurrence) {
        validateDiscoveryOccurrence(occurrence);
        const file = this.occurrencePath(occurrence);
        try {
            await this.writeExclusive(file, occurrence);
            return { occurrence, evidenceRef: this.relative(file), created: true, idempotent: false };
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = await readJson(file);
            validateDiscoveryOccurrence(existing);
            if (existing.occurrenceId !== occurrence.occurrenceId) throw new Error(`Immutable discovery occurrence collision: ${file}`);
            return { occurrence: existing, evidenceRef: this.relative(file), created: false, idempotent: true };
        }
    }

    async persistAssociation(input) {
        const association = input.associationId ? input : createDiscoveryAssociation(input, { clock: this.clock });
        validateDiscoveryAssociation(association);
        const file = this.associationPath(association);
        try {
            await this.writeExclusive(file, association);
            return { association, evidenceRef: this.relative(file), created: true, idempotent: false };
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const existing = await readJson(file);
            validateDiscoveryAssociation(existing);
            return { association: existing, evidenceRef: this.relative(file), created: false, idempotent: true };
        }
    }

    async listOccurrences() {
        return Promise.all((await listJsonFiles(this.occurrencesRoot)).map(readJson));
    }

    async findOccurrenceById(occurrenceId) {
        const occurrence = (await this.listOccurrences()).find(item => item.occurrenceId === occurrenceId) || null;
        if (occurrence) validateDiscoveryOccurrence(occurrence);
        return occurrence;
    }

    async listAssociations() {
        return Promise.all((await listJsonFiles(this.associationsRoot)).map(readJson));
    }

    async findAssociationsByOccurrenceId(occurrenceId) {
        return (await this.listAssociations()).filter(item => item.occurrenceId === occurrenceId);
    }

    async findTargetsByProviderEntity(entityKey) {
        const occurrences = await this.listOccurrences();
        const occurrenceIds = new Set(occurrences.filter(item => providerEntityKey(item) === entityKey).map(item => item.occurrenceId));
        return (await this.listAssociations()).filter(item => occurrenceIds.has(item.occurrenceId));
    }

    async rebuildIndexes() {
        const [occurrences, associations] = await Promise.all([this.listOccurrences(), this.listAssociations()]);
        occurrences.forEach(validateDiscoveryOccurrence);
        associations.forEach(validateDiscoveryAssociation);
        const occurrenceById = new Map(occurrences.map(item => [item.occurrenceId, item]));
        const occurrenceTargets = {};
        const providerEntities = {};
        const targets = {};
        for (const occurrence of occurrences) {
            const key = providerEntityKey(occurrence);
            providerEntities[key] ||= { occurrenceIds: [], targets: [] };
            providerEntities[key].occurrenceIds.push(occurrence.occurrenceId);
        }
        for (const association of associations) {
            const targetKey = `${association.targetType}:${association.targetId}`;
            occurrenceTargets[association.occurrenceId] ||= [];
            occurrenceTargets[association.occurrenceId].push({ targetType: association.targetType, targetId: association.targetId, associationId: association.associationId });
            targets[targetKey] ||= [];
            targets[targetKey].push(association.occurrenceId);
            const occurrence = occurrenceById.get(association.occurrenceId);
            if (occurrence) providerEntities[providerEntityKey(occurrence)].targets.push({ targetType: association.targetType, targetId: association.targetId });
        }
        const uniqueSorted = values => [...new Set(values)].sort();
        for (const value of Object.values(providerEntities)) {
            value.occurrenceIds = uniqueSorted(value.occurrenceIds);
            value.targets = [...new Map(value.targets.map(target => [`${target.targetType}:${target.targetId}`, target])).values()].sort((a, b) => `${a.targetType}:${a.targetId}`.localeCompare(`${b.targetType}:${b.targetId}`));
        }
        for (const key of Object.keys(targets)) targets[key] = uniqueSorted(targets[key]);
        const generatedAt = this.clock();
        const indexes = {
            occurrences: { schemaVersion: 1, generatedAt, rebuildable: true, occurrences: Object.fromEntries(occurrences.sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId)).map(item => [item.occurrenceId, { provider: item.provider, providerEntityKey: providerEntityKey(item) }])) },
            providerEntities: { schemaVersion: 1, generatedAt, rebuildable: true, providerEntities },
            targets: { schemaVersion: 1, generatedAt, rebuildable: true, occurrenceTargets, targets }
        };
        await Promise.all([
            this.writeAtomic(path.join(this.indexesRoot, "occurrences.json"), indexes.occurrences),
            this.writeAtomic(path.join(this.indexesRoot, "provider-entities.json"), indexes.providerEntities),
            this.writeAtomic(path.join(this.indexesRoot, "targets.json"), indexes.targets)
        ]);
        return indexes;
    }
}

module.exports = { DiscoveryStore, listJsonFiles };
