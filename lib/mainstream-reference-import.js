const crypto = require("crypto");
const path = require("path");

function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (quoted) {
            if (character === '"' && text[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (character === '"') {
                quoted = false;
            } else {
                field += character;
            }
        } else if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            row.push(field);
            field = "";
        } else if (character === "\n") {
            row.push(field.replace(/\r$/, ""));
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += character;
        }
    }
    if (quoted) throw new Error("CSV contains an unterminated quoted field.");
    if (field || row.length) {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
    }
    return rows.filter(candidate => candidate.some(value => value.trim() !== ""));
}

function normalizeHeader(value) {
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeArtistName(value) {
    return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function findColumn(headers, requested, fallbacks, label, required = true) {
    const candidates = requested ? [normalizeHeader(requested)] : fallbacks;
    const index = candidates.map(candidate => headers.indexOf(candidate)).find(value => value >= 0);
    if (index === undefined && required) {
        throw new Error(`CSV is missing the ${label} column. Available headers: ${headers.join(", ")}`);
    }
    return index;
}

function parseAndValidateCsv(text, columns = {}) {
    const rows = parseCsv(text.replace(/^\uFEFF/, ""));
    if (rows.length < 2) throw new Error("CSV must contain a header and 200 artist rows.");
    const headers = rows[0].map(normalizeHeader);
    if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate normalized headers.");
    const rankIndex = findColumn(headers, columns.rank, ["rank", "ranking"], "rank");
    const artistIndex = findColumn(headers, columns.artist, ["artist_name", "artist", "name"], "artist name");
    const valueIndex = findColumn(
        headers,
        columns.value,
        ["ranking_value", "monthly_listeners", "listeners", "value"],
        "ranking value",
        false
    );
    const dataRows = rows.slice(1);
    if (dataRows.length !== 200) {
        throw new Error(`CSV must contain exactly 200 artist records; found ${dataRows.length}.`);
    }

    const records = dataRows.map((row, index) => {
        const sourceRow = index + 2;
        const rankText = String(row[rankIndex] ?? "").trim();
        if (!/^\d+$/.test(rankText)) throw new Error(`Source row ${sourceRow} has an invalid integer rank.`);
        const rank = Number(rankText);
        const artistNameRaw = String(row[artistIndex] ?? "");
        if (!artistNameRaw.trim()) throw new Error(`Source row ${sourceRow} has a blank artist name.`);
        return {
            rank,
            artistNameRaw,
            artistNameNormalized: normalizeArtistName(artistNameRaw),
            rankingValueRaw: valueIndex === undefined ? null : String(row[valueIndex] ?? ""),
            sourceRow
        };
    });

    const rankCounts = new Map();
    for (const record of records) rankCounts.set(record.rank, (rankCounts.get(record.rank) || 0) + 1);
    const duplicateRanks = [...rankCounts].filter(([, count]) => count > 1).map(([rank]) => rank).sort((a, b) => a - b);
    const missingRanks = Array.from({ length: 200 }, (_, index) => index + 1).filter(rank => !rankCounts.has(rank));
    const outOfRangeRanks = [...rankCounts.keys()].filter(rank => rank < 1 || rank > 200).sort((a, b) => a - b);
    if (duplicateRanks.length || missingRanks.length || outOfRangeRanks.length) {
        throw new Error(`Ranks must be exactly 1-200. Duplicate: [${duplicateRanks}]; missing: [${missingRanks}]; out of range: [${outOfRangeRanks}].`);
    }
    records.sort((first, second) => first.rank - second.rank);
    return { records, columns: { rank: headers[rankIndex], artist: headers[artistIndex], value: valueIndex === undefined ? null : headers[valueIndex] } };
}

function sha256(buffer) {
    return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeSlug(value) {
    const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!slug) throw new Error("Publisher and ranking type must contain filename-safe characters.");
    return slug;
}

function buildSnapshot({ inputPath, inputBuffer, parsed, metadata }) {
    const retrievedAt = new Date(metadata.retrievedAt);
    if (Number.isNaN(retrievedAt.getTime())) throw new Error("retrieved-at must be a valid ISO-8601 timestamp.");
    const date = retrievedAt.toISOString().slice(0, 10);
    const snapshotId = `${date}-${safeSlug(metadata.publisher)}-${safeSlug(metadata.rankingType)}`;
    const checksum = sha256(inputBuffer);
    return {
        snapshotId,
        rawFilename: `${snapshotId}--${path.basename(inputPath)}`,
        previewFilename: `${snapshotId}.preview.json`,
        document: {
            schemaVersion: 1,
            snapshotId,
            reviewOnly: true,
            retrievedAt: retrievedAt.toISOString(),
            source: {
                publisher: metadata.publisher,
                rankingName: metadata.rankingName,
                rankingType: metadata.rankingType,
                territory: metadata.territory,
                sourceUrl: metadata.sourceUrl,
                methodologyUrl: metadata.methodologyUrl || null,
                licenseNotes: metadata.licenseNotes,
                originalFilename: path.basename(inputPath),
                rawSha256: checksum
            },
            import: {
                detectedColumns: parsed.columns,
                recordCount: parsed.records.length,
                identityEnrichmentPerformed: false,
                musicRollComparisonPerformed: false
            },
            records: parsed.records,
            validation: {
                expectedRecords: 200,
                actualRecords: parsed.records.length,
                ranksComplete: true,
                duplicateRanks: [],
                missingRanks: [],
                blankArtistNames: 0
            }
        }
    };
}

module.exports = { buildSnapshot, normalizeArtistName, parseAndValidateCsv, parseCsv, sha256 };
