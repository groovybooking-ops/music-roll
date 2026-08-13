const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { getSpotifyAccessToken, searchArtistCandidatesByName } = require("../lib/spotify-client");
const { fetchArtistAlbumsPaginated } = require("../lib/spotify-catalog-client");
const { assessIdentity } = require("../lib/identity-confidence");
const { assessCorroboration, normalizeTitle } = require("../lib/identity-corroboration");

const root = path.join(__dirname, "..");
const snapshotId = "kworb-spotify-monthly-listeners-2026-08-12";
const names = ["Future", "Queen", "Nirvana", "Dave", "Disney", "P!nk", "A$AP Rocky"];
const sourcePath = path.join(root, "data", "mainstream-reference", "snapshots", `${snapshotId}.identity-enriched.preview.json`);
const runDate = new Date().toISOString().slice(0, 10);
const experimentId = `targeted-identity-corroboration-${runDate}-v2`;
const cacheDir = path.join(root, "data", "mainstream-reference", "experiments", experimentId, "raw");
const outputPath = path.join(root, "data", "mainstream-reference", "experiments", experimentId, "review.preview.json");
const musicBrainzHeaders = { "User-Agent": "MusicRoll/0.1 (identity-review; contact via project repository)", Accept: "application/json" };
dotenv.config({ path: path.join(root, ".env"), quiet: true });

function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function writeJsonExclusive(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function fetchMusicBrainz(url, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const response = await fetch(url, { headers: musicBrainzHeaders });
        if (response.ok) return response.json();
        if ((response.status === 503 || response.status === 429) && attempt < maxRetries) {
            const retrySeconds = Number(response.headers.get("retry-after")) || (attempt + 1);
            await new Promise(resolve => setTimeout(resolve, retrySeconds * 1000));
            continue;
        }
        const error = new Error(`MusicBrainz request failed with status ${response.status}.`);
        error.statusCode = response.status;
        throw error;
    }
}

function exactMusicBrainzCandidates(name, data) {
    const target = normalizeTitle(name);
    return (data.artists || []).filter(artist =>
        normalizeTitle(artist.name) === target ||
        (artist.aliases || []).some(alias => normalizeTitle(alias.name) === target)
    );
}

function spotifyUrlIds(relations = []) {
    return relations
        .filter(relation => relation.type === "streaming" || relation.type === "free streaming")
        .map(relation => relation.url?.resource || "")
        .map(url => url.match(/open\.spotify\.com\/artist\/([A-Za-z0-9]+)/)?.[1])
        .filter(Boolean);
}

function yearFromSpotifyRelease(release) {
    return Number(String(release.release_date || "").slice(0, 4)) || null;
}

function yearFromMusicBrainzArtist(artist) {
    return Number(String(artist["life-span"]?.begin || "").slice(0, 4)) || null;
}

function buildEvidence(name, candidate, spotifyCatalog, mbArtists) {
    const linked = mbArtists.filter(artist => spotifyUrlIds(artist.relations).includes(candidate.id));
    const conflictingLinks = mbArtists.flatMap(artist => spotifyUrlIds(artist.relations)).filter(id => id !== candidate.id);
    const linkedArtist = linked[0] || null;
    const spotifyTitles = spotifyCatalog.items.map(item => item.name);
    const mbTitles = linkedArtist ? (linkedArtist["release-groups"] || []).map(item => item.title) : [];
    const spotifyYears = spotifyCatalog.items.map(yearFromSpotifyRelease).filter(Boolean);
    const mbBeginYear = linkedArtist ? yearFromMusicBrainzArtist(linkedArtist) : null;
    const chronologyConflict = Boolean(mbBeginYear && spotifyYears.length && Math.min(...spotifyYears) < mbBeginYear - 1);
    return {
        crossDatabaseIdentifiers: {
            musicBrainzSpotifyUrl: linked.length === 1 ? "match" : "not_available",
            spotifyUrl: conflictingLinks.length ? "conflict" : "not_available"
        },
        crossDatabaseEntityMetadata: {
            alias: linkedArtist && (linkedArtist.aliases || []).some(alias => normalizeTitle(alias.name) === normalizeTitle(name)) ? "match" : "not_available",
            artistType: "not_available",
            area: linkedArtist?.area ? "compatible" : "not_available",
            activeDates: linkedArtist?.["life-span"]?.begin ? "compatible" : "not_available"
        },
        catalogFingerprint: {
            spotifyReleaseTitles: spotifyTitles,
            musicBrainzReleaseTitles: mbTitles,
            chronology: chronologyConflict ? "conflict" : (mbBeginYear && spotifyYears.length ? "compatible" : "not_available"),
            primaryCoherent: spotifyCatalog.items.length >= 3,
            emptyAlternativeCount: 0,
            multiplePlausibleSameNameCatalogs: mbArtists.length > 1 && conflictingLinks.length > 0,
            complete: spotifyCatalog.paginationComplete,
            partialDatePrecisions: [...new Set(spotifyCatalog.items.map(item => item.release_date_precision).filter(Boolean))]
        },
        weakPresentationEvidence: {
            imageAvailable: Boolean(candidate.imageUrl),
            punctuationOrCaseAgreement: normalizeTitle(name) === normalizeTitle(candidate.name),
            hasRelease: spotifyCatalog.items.length > 0
        },
        audit: {
            linkedMusicBrainzIds: linked.map(artist => artist.id),
            exactMusicBrainzCandidateCount: mbArtists.length,
            otherSpotifyIdsInExactMusicBrainzCandidates: [...new Set(conflictingLinks)],
            spotifyReleaseCount: spotifyCatalog.items.length,
            musicBrainzReleaseGroupCount: mbTitles.length
        }
    };
}

async function main() {
    await fs.access(outputPath).then(() => { throw new Error(`Refusing to overwrite ${path.relative(root, outputPath)}.`); }).catch(error => {
        if (error.code !== "ENOENT") throw error;
    });
    const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    const sourceByName = new Map(source.records.map(record => [record.artistNameRaw, record]));
    const token = await getSpotifyAccessToken();
    const records = [];
    const apiErrors = [];

    for (const name of names) {
        console.log(`Reviewing ${name}...`);
        const sourceRecord = sourceByName.get(name);
        if (!sourceRecord) throw new Error(`Missing source identity record for ${name}.`);
        try {
            const search = await searchArtistCandidatesByName(name);
            await writeJsonExclusive(path.join(cacheDir, `${slug(name)}.spotify-search.json`), search);
            const sourceId = sourceRecord.spotifyIdentityReview.candidateMatch?.spotifyArtistId;
            const allCandidates = [...search.exactMatches, ...search.possibleMatches];
            const candidate = allCandidates.find(item => item.id === sourceId) || search.exactMatches[0] || null;
            if (!candidate) throw new Error("Spotify returned no candidate.");
            const spotifyCatalog = await fetchArtistAlbumsPaginated(candidate.id, token);
            await writeJsonExclusive(path.join(cacheDir, `${slug(name)}.spotify-catalog.json`), spotifyCatalog);

            const query = encodeURIComponent(`artist:\"${name.replace(/\"/g, "\\\"")}\"`);
            const mbSearch = await fetchMusicBrainz(`https://musicbrainz.org/ws/2/artist?query=${query}&fmt=json&limit=10`);
            await writeJsonExclusive(path.join(cacheDir, `${slug(name)}.musicbrainz-search.json`), mbSearch);
            const mbCandidates = exactMusicBrainzCandidates(name, mbSearch).slice(0, 5);
            const mbArtists = [];
            for (const mbCandidate of mbCandidates) {
                await new Promise(resolve => setTimeout(resolve, 1100));
                const detail = await fetchMusicBrainz(`https://musicbrainz.org/ws/2/artist/${mbCandidate.id}?inc=url-rels+aliases+release-groups&fmt=json`);
                mbArtists.push(detail);
            }
            await writeJsonExclusive(path.join(cacheDir, `${slug(name)}.musicbrainz-details.json`), mbArtists);
            const firstStage = assessIdentity(sourceRecord);
            const evidence = buildEvidence(name, candidate, spotifyCatalog, mbArtists);
            const secondStage = assessCorroboration(firstStage, evidence);
            records.push({
                artistNameRaw: name,
                rank: sourceRecord.rank,
                sourceCandidateSpotifyArtistId: sourceId,
                liveCandidate: candidate,
                firstStageAssessment: firstStage,
                secondStageAssessment: secondStage,
                evidence,
                finalIdentityVerified: false
            });
        } catch (error) {
            apiErrors.push({ artistNameRaw: name, statusCode: error.statusCode || null, message: error.message });
            records.push({ artistNameRaw: name, rank: sourceRecord.rank, status: "api_error", finalIdentityVerified: false });
        }
    }
    const ids = records.map(record => record.liveCandidate?.id).filter(Boolean);
    const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicateIds.length) {
        for (const record of records) {
            if (!duplicateIds.includes(record.liveCandidate?.id)) continue;
            record.secondStageAssessment = assessCorroboration(record.firstStageAssessment, record.evidence, { duplicateSpotifyId: record.liveCandidate.id });
        }
    }
    const output = {
        schemaVersion: 1,
        experimentId,
        generatedAt: new Date().toISOString(),
        reviewOnly: true,
        liveApiSources: ["Spotify Web API", "MusicBrainz Web Service"],
        sourceIdentityPreviewId: source.identityPreviewId,
        records,
        summary: {
            total: records.length,
            theoreticalPromotions: records.filter(record => record.firstStageAssessment?.status === "manual_review_required" && record.secondStageAssessment?.status === "high_confidence_candidate").map(record => record.artistNameRaw),
            remainingManualOrConflicting: records.filter(record => record.secondStageAssessment?.requiresHumanReview).map(record => record.artistNameRaw),
            duplicateSpotifyIds: duplicateIds,
            apiErrors
        },
        validation: { expectedNamesPresent: names.every(name => records.some(record => record.artistNameRaw === name)), inferredIdentitiesMarkedVerified: 0, liveMigrationPerformed: false }
    };
    await writeJsonExclusive(outputPath, output);
    console.log(`Targeted review written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("Targeted corroboration stopped: " + error.message);
    process.exitCode = 1;
});
