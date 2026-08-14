const path = require("node:path");
const { compareIdentityEvidence, auditSameNameMusicBrainzEntities } = require("./identity-evidence-comparison");

const OUTCOMES = Object.freeze([
    "coherent_identity_evidence",
    "coherent_identity_with_same_name_ambiguity",
    "insufficient_corroboration",
    "conflicting_identity",
    "unresolved_identity"
]);

function cacheRelativePath(provider, identifier, operation = "record") {
    if (!new Set(["spotify", "wikidata", "musicbrainz", "discogs"]).has(String(provider || ""))) throw new Error("Unsupported identity provider.");
    if (!/^[A-Za-z0-9.-]+$/.test(String(identifier || "")) || !/^[a-z-]+$/.test(String(operation || ""))) throw new Error("Unsafe cache key.");
    return path.join(provider, operation, `${identifier}.json`);
}

function blockedCohortFromAccounting(accounting) {
    if (accounting?.reviewOnly !== true || !Array.isArray(accounting.records)) throw new Error("A review-only accounting preview is required.");
    return accounting.records.filter(record => record.migrationDecision?.eligible === false).map(record => ({
        displayName: record.name,
        proposedMusicRollId: record.proposedMusicRollId,
        spotifyArtistId: record.spotify?.id
    }));
}

function classifyEvidence({ wikidata, musicBrainz, discogs, identifierComparison, sameNameAudit }) {
    if (!wikidata) return "unresolved_identity";
    if (identifierComparison.conflicts.length) return "conflicting_identity";
    if (!wikidata.musicBrainzArtistId || !wikidata.discogsArtistId || !musicBrainz || !discogs) return "insufficient_corroboration";
    if (!sameNameAudit) return "insufficient_corroboration";
    const required = ["spotifyArtistId", "wikidataQid", "musicBrainzArtistId", "discogsArtistId"];
    if (!required.every(type => identifierComparison.identifierComparison[type]?.status === "agreement")) return "insufficient_corroboration";
    return sameNameAudit?.sameNameAmbiguity === "multiple_exact_display_name_entities"
        ? "coherent_identity_with_same_name_ambiguity"
        : "coherent_identity_evidence";
}

function buildArtistEvidenceReport(candidate, evidence = {}) {
    if (!candidate?.displayName || !/^[A-Za-z0-9]{22}$/.test(candidate.spotifyArtistId || "")) throw new Error("A named stored Spotify candidate is required.");
    const providerErrors = Array.isArray(evidence.providerErrors) ? evidence.providerErrors : [];
    let comparison = null;
    let sameNameAudit = null;
    if (evidence.wikidata) {
        comparison = compareIdentityEvidence({
            spotifyArtistId: candidate.spotifyArtistId,
            wikidata: evidence.wikidata,
            musicBrainz: evidence.musicBrainz || { externalUrls: [] },
            discogs: evidence.discogs || { artistUrls: [] }
        });
    }
    if (evidence.wikidata?.musicBrainzArtistId && Array.isArray(evidence.nameCandidates) && Array.isArray(evidence.nameCandidateDetails)) {
        sameNameAudit = auditSameNameMusicBrainzEntities(evidence.wikidata.musicBrainzArtistId, evidence.nameCandidates, evidence.nameCandidateDetails);
    }
    const comparisonForClassification = comparison || { identifierComparison: {}, conflicts: [] };
    const outcome = providerErrors.length ? "unresolved_identity" : classifyEvidence({ ...evidence, identifierComparison: comparisonForClassification, sameNameAudit });
    return {
        schemaVersion: 1,
        reviewOnly: true,
        candidate,
        outcome,
        sourceResults: { wikidata: evidence.wikidata || null, musicBrainz: evidence.musicBrainz || null, discogs: evidence.discogs || null },
        identifierAgreement: comparison?.identifierComparison || {},
        conflictingIdentifiers: comparison?.conflicts || [],
        sameNameAmbiguity: sameNameAudit || { sameNameAmbiguity: "not_evaluated", competingEntities: [] },
        missingEvidence: [
            !evidence.wikidata && "wikidata_bridge",
            evidence.wikidata && !evidence.wikidata.musicBrainzArtistId && "wikidata_musicbrainz_id",
            evidence.wikidata && !evidence.wikidata.discogsArtistId && "wikidata_discogs_id",
            evidence.wikidata?.musicBrainzArtistId && !evidence.musicBrainz && "musicbrainz_record",
            evidence.wikidata?.discogsArtistId && !evidence.discogs && "discogs_record",
            evidence.musicBrainz && !sameNameAudit && "musicbrainz_same_name_audit"
        ].filter(Boolean),
        providerErrors,
        confidenceScoreCalculated: false,
        automaticVerificationPerformed: false,
        migrationPerformed: false
    };
}

function buildBatchReview(candidates, evidenceBySpotifyId = {}) {
    const reports = candidates.map(candidate => buildArtistEvidenceReport(candidate, evidenceBySpotifyId[candidate.spotifyArtistId] || {}));
    return {
        schemaVersion: 1,
        reviewOnly: true,
        reports,
        summary: {
            total: reports.length,
            countsByOutcome: Object.fromEntries(OUTCOMES.map(outcome => [outcome, reports.filter(report => report.outcome === outcome).length])),
            needsInvestigation: reports.filter(report => !report.outcome.startsWith("coherent_identity")).map(report => ({ displayName: report.candidate.displayName, spotifyArtistId: report.candidate.spotifyArtistId, outcome: report.outcome }))
        },
        safety: { automaticVerificationPerformed: false, confidenceScoreCalculated: false, migrationPerformed: false }
    };
}

module.exports = { OUTCOMES, blockedCohortFromAccounting, buildArtistEvidenceReport, buildBatchReview, cacheRelativePath, classifyEvidence };
