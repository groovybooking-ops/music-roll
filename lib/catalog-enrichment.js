const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, minimum = 0, maximum = 100) {
    return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function parsePartialDate(value, precision) {
    if (typeof value !== "string" || !value.trim()) return null;
    const parts = value.split("-").map(Number);
    const year = parts[0];
    if (!Number.isInteger(year)) return null;
    const normalizedPrecision = ["year", "month", "day"].includes(precision)
        ? precision
        : parts.length === 1 ? "year" : parts.length === 2 ? "month" : "day";
    const month = normalizedPrecision === "year" ? 1 : parts[1];
    const day = normalizedPrecision === "day" ? parts[2] : 1;
    const start = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(start.getTime())) return null;
    let end;
    if (normalizedPrecision === "year") {
        end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    } else if (normalizedPrecision === "month") {
        end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    } else {
        end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    }
    return { value, precision: normalizedPrecision, start, end };
}

function normalizeReleaseTitle(title) {
    return String(title || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[\[(].*?\b(deluxe|expanded|remaster(?:ed)?|anniversary|edition|bonus|explicit|clean)\b.*?[\])]/g, "")
        .replace(/\b(\d{2,4}(?:st|nd|rd|th)? anniversary|deluxe|expanded|remaster(?:ed)?|edition|bonus tracks?|explicit|clean)\b/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function releaseSummary(release) {
    return {
        spotifyId: release.id,
        name: release.name,
        type: release.album_type,
        releaseDate: release.release_date,
        releaseDatePrecision: release.release_date_precision,
        totalTracks: release.total_tracks,
        spotifyUrl: release.external_urls?.spotify || ""
    };
}

function deduplicateReleases(releases) {
    const byId = new Map();
    for (const release of releases) {
        if (release?.id && !byId.has(release.id)) byId.set(release.id, release);
    }
    const groups = new Map();
    for (const release of byId.values()) {
        const parsed = parsePartialDate(release.release_date, release.release_date_precision);
        const key = [
            release.album_type || "unknown",
            normalizeReleaseTitle(release.name),
            parsed?.start.getUTCFullYear() || "unknown"
        ].join("|");
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(release);
    }
    const included = [];
    const suspectedVariants = [];
    for (const group of groups.values()) {
        group.sort((a, b) => {
            const aDate = parsePartialDate(a.release_date, a.release_date_precision)?.start.getTime() || Infinity;
            const bDate = parsePartialDate(b.release_date, b.release_date_precision)?.start.getTime() || Infinity;
            return aDate - bDate || (a.total_tracks || Infinity) - (b.total_tracks || Infinity);
        });
        included.push(group[0]);
        if (group.length > 1) {
            suspectedVariants.push({
                kept: releaseSummary(group[0]),
                excluded: group.slice(1).map(releaseSummary),
                reason: "Same normalized title, release type, and release year; likely edition/remaster duplicate."
            });
        }
    }
    return { included, suspectedVariants, duplicateIdCount: releases.length - byId.size };
}

function scoreCareerMaturity(careerSpanYears) {
    return careerSpanYears === null ? 0 : clamp(careerSpanYears * 5);
}

function scoreCatalogDepth({ albumCount, singleAndEpCount, approximateTrackCount }) {
    const raw = albumCount * 9 + singleAndEpCount * 2.5 + approximateTrackCount * 0.35;
    return clamp(100 * (1 - Math.exp(-raw / 55)));
}

function scoreReleaseMomentum(activity) {
    const recency = activity.daysSinceLatestRelease === null
        ? 0
        : 45 * Math.exp(-activity.daysSinceLatestRelease / 240);
    return clamp(recency + activity.releasesLast90Days * 18 +
        activity.releasesLast365Days * 8 + activity.releasesLast730Days * 3);
}

function scoreDataConfidence({ releases, suspectedVariants, partialDateCount, paginationComplete }) {
    if (!releases.length) return paginationComplete ? 25 : 0;
    return clamp(100 - suspectedVariants.length * 3 - partialDateCount * 1.5 -
        (paginationComplete ? 0 : 35));
}

function suggestTiers(metrics) {
    const candidates = new Set();
    const reasons = [];
    if (metrics.careerSpanYears !== null && metrics.careerSpanYears >= 20) {
        candidates.add("legacy");
        candidates.add("classic");
        reasons.push(`A ${metrics.careerSpanYears}-year catalog span supports legacy/classic review.`);
    } else if (metrics.careerSpanYears !== null && metrics.careerSpanYears <= 6 && metrics.releaseMomentumScore >= 35) {
        candidates.add("emerging");
        reasons.push("A relatively young catalog with recent output supports emerging review.");
    } else {
        candidates.add("underground");
        candidates.add("emerging");
        reasons.push("Catalog age and activity alone cannot distinguish underground from emerging reach.");
    }
    if (metrics.catalogDepthScore >= 70) {
        candidates.add("mainstream");
        reasons.push("A deep catalog supports established-status review, but does not prove mainstream audience reach.");
    }
    reasons.push("Spotify catalog metadata cannot establish audience size; final tier remains editorial.");
    return { candidates: [...candidates], reasons };
}

function analyzeCatalog(releases, options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    const paginationComplete = options.paginationComplete !== false;
    const deduped = deduplicateReleases(releases);
    const dated = deduped.included.map(release => ({
        release,
        parsed: parsePartialDate(release.release_date, release.release_date_precision)
    })).filter(item => item.parsed);
    dated.sort((a, b) => a.parsed.start - b.parsed.start);
    const earliest = dated[0]?.parsed || null;
    const latest = dated.length ? dated[dated.length - 1].parsed : null;
    const daysSinceLatestRelease = latest
        ? Math.max(0, Math.floor((now - latest.end) / DAY_MS))
        : null;
    const countSince = days => dated.filter(item => now - item.parsed.end <= days * DAY_MS && now >= item.parsed.start).length;
    const albumCount = deduped.included.filter(item => item.album_type === "album").length;
    const singleAndEpCount = deduped.included.filter(item => item.album_type === "single").length;
    const approximateTrackCount = deduped.included.reduce((sum, item) => sum + (Number(item.total_tracks) || 0), 0);
    const careerSpanYears = earliest && latest
        ? Math.round(((latest.end - earliest.start) / (365.2425 * DAY_MS)) * 10) / 10
        : null;
    const activity = {
        daysSinceLatestRelease,
        releasesLast90Days: countSince(90),
        releasesLast365Days: countSince(365),
        releasesLast730Days: countSince(730)
    };
    const scores = {
        careerMaturityScore: scoreCareerMaturity(careerSpanYears),
        catalogDepthScore: scoreCatalogDepth({ albumCount, singleAndEpCount, approximateTrackCount }),
        releaseMomentumScore: scoreReleaseMomentum(activity)
    };
    scores.dataConfidenceScore = scoreDataConfidence({
        releases: deduped.included,
        suspectedVariants: deduped.suspectedVariants,
        partialDateCount: dated.filter(item => item.parsed.precision !== "day").length,
        paginationComplete
    });
    const metrics = {
        earliestRelease: earliest && { date: earliest.value, precision: earliest.precision },
        latestRelease: latest && { date: latest.value, precision: latest.precision },
        careerSpanYears,
        uniqueReleaseCount: deduped.included.length,
        albumCount,
        singleAndEpCount,
        approximateTrackCount,
        ...activity,
        ...scores
    };
    const suggestions = suggestTiers(metrics);
    return {
        metrics,
        suggestedTierCandidates: suggestions.candidates,
        reasons: suggestions.reasons,
        audit: {
            market: options.market || "US",
            fetchedReleaseCount: releases.length,
            duplicateIdCount: deduped.duplicateIdCount,
            suspectedVariants: deduped.suspectedVariants,
            includedReleases: deduped.included.map(releaseSummary),
            paginationComplete
        }
    };
}

module.exports = { analyzeCatalog, deduplicateReleases, normalizeReleaseTitle, parsePartialDate };
