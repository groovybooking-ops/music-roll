const fs = require("fs/promises");
const path = require("path");
const { parseCsv } = require("../mainstream-reference-import");
const { normalizeDiscovery } = require("./candidate-schema");
const { duplicatePreflight } = require("./duplicate-preflight");

function normalizeHeader(value) {
    return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function parseJsonDiscoveries(text) {
    const parsed = JSON.parse(text);
    const records = Array.isArray(parsed) ? parsed : parsed?.discoveries;
    if (!Array.isArray(records) || records.length === 0) throw new Error("JSON intake must contain a non-empty array or a discoveries array.");
    return records;
}

function parseCsvDiscoveries(text) {
    const rows = parseCsv(String(text).replace(/^\uFEFF/, ""));
    if (rows.length < 2) throw new Error("CSV intake requires a header and at least one discovery.");
    const headers = rows[0].map(normalizeHeader);
    if (new Set(headers).size !== headers.length) throw new Error("CSV intake contains duplicate normalized headers.");
    const known = {
        sourceType: ["source_type"],
        sourceName: ["source_name"],
        sourceRecordId: ["source_record_id", "source_record"],
        sourceUrl: ["source_url", "source_record_url"],
        rawArtistName: ["raw_artist_name", "artist_name", "artist", "name"],
        spotifyArtistId: ["spotify_artist_id", "spotify_id"],
        spotifyArtistUrl: ["spotify_artist_url", "spotify_url"],
        discoveredAt: ["discovered_at", "discovered_timestamp"],
        assertedMusicRollId: ["asserted_music_roll_id", "music_roll_id"]
    };
    const indexes = Object.fromEntries(Object.entries(known).map(([field, aliases]) => [field, aliases.map(alias => headers.indexOf(alias)).find(index => index >= 0)]));
    if (indexes.rawArtistName === undefined) throw new Error("CSV intake is missing raw_artist_name (or artist/name).");
    return rows.slice(1).map((row, rowIndex) => {
        const record = { sourceRow: rowIndex + 2 };
        for (const [field, index] of Object.entries(indexes)) {
            if (index !== undefined) record[field] = String(row[index] ?? "");
        }
        return record;
    });
}

function inferFormat(file, explicitFormat) {
    if (explicitFormat) {
        const normalized = explicitFormat.toLowerCase();
        if (!new Set(["json", "csv"]).has(normalized)) throw new Error("Intake format must be json or csv.");
        return normalized;
    }
    const extension = path.extname(file).slice(1).toLowerCase();
    if (!new Set(["json", "csv"]).has(extension)) throw new Error("Could not infer intake format; pass --format json or --format csv.");
    return extension;
}

async function loadDiscoveryFile(file, options = {}) {
    const format = inferFormat(file, options.format);
    const text = await fs.readFile(file, "utf8");
    const records = format === "json" ? parseJsonDiscoveries(text) : parseCsvDiscoveries(text);
    return { format, records };
}

async function intakeDiscoveries({ store, records, permanentRegistry, liveArtists, defaults = {}, actor, evidenceRefs = [] }) {
    if (!store || typeof store.withWriterLock !== "function") throw new Error("Discovery intake requires a candidate store.");
    if (!Array.isArray(records) || records.length === 0) throw new Error("Discovery intake requires records.");
    const discoveredAt = defaults.discoveredAt || new Date().toISOString();
    const normalized = records.map(record => normalizeDiscovery(record, { ...defaults, discoveredAt: record.discoveredAt || discoveredAt }));
    const transitionActor = actor || { type: "command", id: "manual_discovery_intake" };

    return store.withWriterLock(async () => {
        const results = [];
        for (const discovery of normalized) {
            let candidate = await store.findByDiscoveryId(discovery.discoveryId);
            const idempotent = Boolean(candidate);
            if (!candidate) {
                candidate = await store.createCandidateLocked(discovery, {
                    actor: transitionActor,
                    reasonCode: "discovery_intake_created",
                    evidenceRefs
                });
            }
            if (candidate.state === "discovered") {
                const candidates = await store.listCandidates();
                const preflight = duplicatePreflight({ candidate, candidates, permanentRegistry, liveArtists });
                candidate = await store.transitionCandidateLocked(candidate.candidateId, {
                    expectedRevision: candidate.revision,
                    nextState: preflight.nextState,
                    reasonCode: preflight.reasonCode,
                    actor: { type: "system", id: "duplicate_preflight_v1" },
                    evidenceRefs: preflight.evidenceRefs,
                    payload: {
                        ...(preflight.duplicate ? { duplicate: preflight.duplicate } : {}),
                        warnings: preflight.warnings
                    }
                });
            }
            results.push({
                discoveryId: discovery.discoveryId,
                candidateId: candidate.candidateId,
                created: !idempotent,
                idempotent,
                state: candidate.state,
                revision: candidate.revision,
                duplicate: candidate.duplicate,
                warnings: candidate.warnings
            });
        }
        const indexes = await store.rebuildIndexesLocked();
        return { results, indexes };
    });
}

module.exports = {
    inferFormat,
    intakeDiscoveries,
    loadDiscoveryFile,
    parseCsvDiscoveries,
    parseJsonDiscoveries
};
