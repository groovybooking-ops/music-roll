const { normalizeArtistName, sha256 } = require("./mainstream-reference-import");

function decodeHtml(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
        if (entity[0] === "#") {
            const hexadecimal = entity[1].toLowerCase() === "x";
            return String.fromCodePoint(Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10));
        }
        return named[entity.toLowerCase()] ?? match;
    });
}

function cellText(cell) {
    return decodeHtml(cell.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function parseInteger(value, label, sourceRow, required = false) {
    const trimmed = value.trim();
    if (!trimmed && !required) return null;
    if (!/^[+-]?[\d,]+$/.test(trimmed)) throw new Error(`Table row ${sourceRow} has invalid ${label}: ${value}`);
    const parsed = Number(trimmed.replace(/,/g, ""));
    if (!Number.isSafeInteger(parsed)) throw new Error(`Table row ${sourceRow} has unsafe ${label}.`);
    return parsed;
}

function parseKworbHtml(html) {
    const tableMatches = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
    let selectedRows = null;
    for (const tableMatch of tableMatches) {
        const rows = [...tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(match =>
            [...match[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(cell => cellText(cell[1]))
        );
        const header = rows[0]?.map(value => value.toLowerCase().replace(/\s+/g, "")) || [];
        if (header.includes("artist") && header.includes("listeners") && header.includes("daily+/-")) {
            selectedRows = rows;
            break;
        }
    }
    if (!selectedRows) throw new Error("Could not find the expected Kworb listener ranking table.");
    const header = selectedRows[0].map(value => value.toLowerCase().replace(/\s+/g, ""));
    const indexes = {
        rank: header.indexOf("#"),
        artist: header.indexOf("artist"),
        listeners: header.indexOf("listeners"),
        dailyChange: header.indexOf("daily+/-"),
        peakRank: header.indexOf("peak"),
        peakListeners: header.indexOf("pklisteners")
    };
    if (Object.values(indexes).some(index => index < 0)) throw new Error("Kworb table columns have changed.");

    const records = selectedRows.slice(1).map((row, index) => {
        const sourceRow = index + 2;
        return {
            rank: parseInteger(row[indexes.rank] || "", "rank", sourceRow, true),
            artistNameRaw: row[indexes.artist] || "",
            monthlyListeners: parseInteger(row[indexes.listeners] || "", "monthly listeners", sourceRow),
            dailyListenerChange: parseInteger(row[indexes.dailyChange] || "", "daily listener change", sourceRow),
            peakRank: parseInteger(row[indexes.peakRank] || "", "peak rank", sourceRow),
            peakMonthlyListeners: parseInteger(row[indexes.peakListeners] || "", "peak monthly listeners", sourceRow),
            sourceRow
        };
    }).filter(record => record.rank >= 1 && record.rank <= 200);

    validateRecords(records);
    return records.map(record => ({
        ...record,
        artistNameNormalized: normalizeArtistName(record.artistNameRaw)
    })).sort((first, second) => first.rank - second.rank);
}

function validateRecords(records) {
    if (records.length !== 200) throw new Error(`Expected exactly 200 ranked records; found ${records.length}.`);
    const rankCounts = new Map();
    for (const record of records) {
        if (!record.artistNameRaw.trim()) throw new Error(`Rank ${record.rank} has a blank artist name.`);
        rankCounts.set(record.rank, (rankCounts.get(record.rank) || 0) + 1);
    }
    const duplicates = [...rankCounts].filter(([, count]) => count > 1).map(([rank]) => rank);
    const missing = Array.from({ length: 200 }, (_, index) => index + 1).filter(rank => !rankCounts.has(rank));
    if (duplicates.length || missing.length) throw new Error(`Invalid ranks. Duplicate: [${duplicates}]; missing: [${missing}].`);
}

function collisionReport(records) {
    const groups = new Map();
    for (const record of records) {
        if (!groups.has(record.artistNameNormalized)) groups.set(record.artistNameNormalized, []);
        groups.get(record.artistNameNormalized).push({ rank: record.rank, artistNameRaw: record.artistNameRaw });
    }
    const duplicateNormalizedNames = [...groups.entries()]
        .filter(([, items]) => items.length > 1)
        .map(([normalizedName, items]) => ({ normalizedName, records: items }));
    const suspiciousNames = records.filter(record => {
        const words = record.artistNameNormalized.split(/\s+/);
        return words.length === 1 || record.artistNameRaw.length <= 4;
    }).map(record => ({
        rank: record.rank,
        artistNameRaw: record.artistNameRaw,
        reason: "Short or single-token display name; manually verify identity before Spotify matching."
    }));
    return { duplicateNormalizedNames, suspiciousNames };
}

function buildKworbSnapshot({ htmlBuffer, records, retrievedAt, musicRollArtists }) {
    const timestamp = new Date(retrievedAt);
    if (Number.isNaN(timestamp.getTime())) throw new Error("Retrieval timestamp is invalid.");
    const date = timestamp.toISOString().slice(0, 10);
    const snapshotId = `kworb-spotify-monthly-listeners-${date}`;
    const musicRollByName = new Map(musicRollArtists.map(artist => [normalizeArtistName(artist.name), artist]));
    const collisions = collisionReport(records);
    const enrichedRecords = records.map(record => {
        const existing = musicRollByName.get(record.artistNameNormalized);
        return {
            ...record,
            musicRoll: existing ? {
                exists: true,
                matchedName: existing.name,
                genre: existing.genre,
                tier: existing.tier,
                matchMethod: "exact_normalized_name_review_only"
            } : { exists: false, matchedName: null, genre: null, tier: null, matchMethod: "none" },
            spotifyIdentityReview: { status: "not_started" },
            mainstreamEvidence: {
                present: true,
                sourceClass: "third_party",
                rankingType: "spotify_monthly_listeners",
                rank: record.rank,
                snapshotId
            }
        };
    });
    return {
        snapshotId,
        rawFilename: `${snapshotId}.html`,
        previewFilename: `${snapshotId}.preview.json`,
        document: {
            schemaVersion: 1,
            snapshotId,
            reviewOnly: true,
            retrievedAt: timestamp.toISOString(),
            source: {
                publisher: "Kworb",
                sourceClass: "third_party",
                rankingName: "Spotify top artists by monthly listeners",
                rankingType: "spotify_monthly_listeners",
                territory: "global",
                sourceUrl: "https://kworb.net/spotify/listeners.html",
                methodologyUrl: "https://kworb.net/faq.html",
                methodologyNotes: [
                    "Kworb is a third-party source and this is not official Spotify chart data.",
                    "Kworb displays Spotify monthly-listener observations and historical peaks; its collection process is not independently verified by Music Roll.",
                    "Monthly listeners are a rolling audience signal and may be influenced by playlists, collaborations, seasonality, and current releases.",
                    "Top 200 presence is strong mainstream evidence; absence is none_observed, not evidence of underground or emerging status."
                ],
                rawSha256: sha256(htmlBuffer)
            },
            import: {
                recordCount: enrichedRecords.length,
                spotifyApiCalled: false,
                identityEnrichmentPerformed: false,
                musicRollComparison: "exact normalized names for reporting only"
            },
            records: enrichedRecords,
            reviewFlags: collisions,
            validation: {
                expectedRecords: 200,
                actualRecords: enrichedRecords.length,
                ranksComplete: true,
                duplicateRanks: [],
                missingRanks: [],
                blankArtistNames: 0,
                duplicateNormalizedNameCount: collisions.duplicateNormalizedNames.length
            }
        }
    };
}

module.exports = { buildKworbSnapshot, collisionReport, parseKworbHtml, validateRecords };
