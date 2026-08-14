const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { reviewProviderMultiplicityEvidence } = require("../lib/identity-conflict-resolution");

const root = path.join(__dirname, "..");
const previousPath = path.join(root, "data", "identity-experiments", "curated-40-batch", "curated-40-2026-08-14T03-58-27-597Z", "cohort-summary.review.json");
const resolutionRoot = path.join(root, "data", "identity-experiments", "three-artist-conflict-resolution", "three-artists-2026-08-14T04-14-22-717Z");
const outputRoot = path.join(root, "data", "identity-experiments", "curated-40-provider-multiplicity-reanalysis");
const protectedFiles = ["data/artists.json", "data/artist-id-registry.json"];
const outcomes = ["coherent_identity_evidence", "coherent_identity_with_same_name_ambiguity", "provider_profile_multiplicity", "insufficient_corroboration", "semantic_identity_conflict", "unresolved_identity"];
const resolutionFiles = { "Beyoncé": "beyonce.review.json", "Marvin Gaye": "marvin-gaye.review.json", "Little Simz": "little-simz.review.json" };

const sha256 = async relative => crypto.createHash("sha256").update(await fs.readFile(path.join(root, relative))).digest("hex");
async function writeExclusive(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}

async function main() {
    const protectedBefore = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const previous = JSON.parse(await fs.readFile(previousPath, "utf8"));
    const records = [];
    for (const oldReport of previous.reports) {
        const name = oldReport.candidate.displayName;
        let outcome = oldReport.outcome;
        let reason = "unchanged_under_expanded_taxonomy";
        let conflictResolution = null;
        if (oldReport.outcome === "conflicting_identity") {
            const resolutionFile = resolutionFiles[name];
            if (resolutionFile) {
                const resolution = JSON.parse(await fs.readFile(path.join(resolutionRoot, resolutionFile), "utf8"));
                const evaluation = reviewProviderMultiplicityEvidence(resolution);
                conflictResolution = { sourceReport: path.relative(root, path.join(resolutionRoot, resolutionFile)), evaluation, competingIdentifiers: resolution.competingIdentifiers, provenanceClaims: resolution.provenanceClaims, finalConflictInterpretation: resolution.finalConflictInterpretation };
                if (evaluation.qualifies) {
                    outcome = "provider_profile_multiplicity";
                    reason = "complete_cached_resolution_evidence_demonstrates_coherent_provider_multiplicity_without_semantic_contradiction";
                } else {
                    outcome = "unresolved_identity";
                    reason = "cached_resolution_evidence_does_not_satisfy_strict_multiplicity_rule";
                }
            } else {
                outcome = "unresolved_identity";
                reason = "prior_identifier_conflict_preserved_as_blocked_but_no_complete_cached_evidence_proves_semantic_conflict_or_provider_multiplicity";
            }
        }
        records.push({
            artist: oldReport.candidate,
            previousOutcome: oldReport.outcome,
            outcome,
            reason,
            sourceReport: path.relative(root, path.join(path.dirname(previousPath), "artists", `${String(previous.reports.indexOf(oldReport) + 1).padStart(2, "0")}-${name.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()}-${oldReport.candidate.spotifyArtistId}.review.json`)),
            conflictingIdentifiers: oldReport.conflictingIdentifiers,
            identifierAgreement: oldReport.identifierAgreement,
            sameNameAmbiguity: oldReport.sameNameAmbiguity,
            conflictResolution,
            safety: { identityVerified: false, identityApproved: false, confidenceScoreCalculated: false, migrationEligibilityChanged: false }
        });
    }
    const countsByOutcome = Object.fromEntries(outcomes.map(outcome => [outcome, records.filter(record => record.outcome === outcome).length]));
    const artistsByOutcome = Object.fromEntries(outcomes.map(outcome => [outcome, records.filter(record => record.outcome === outcome).map(record => record.artist.displayName)]));
    const changed = records.filter(record => record.previousOutcome !== record.outcome).map(record => ({ artist: record.artist.displayName, previousOutcome: record.previousOutcome, outcome: record.outcome, reason: record.reason }));
    const protectedAfter = Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, await sha256(file)])));
    const report = {
        schemaVersion: 1,
        reportId: `curated-40-provider-multiplicity-reanalysis-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        generatedAt: new Date().toISOString(),
        reviewOnly: true,
        networkRequestsMade: 0,
        previousCohortReport: path.relative(root, previousPath),
        records,
        summary: { total: records.length, countsByOutcome, artistsByOutcome, changedClassifications: changed },
        humanMigrationReviewCandidates: {
            coherentEvidence: artistsByOutcome.coherent_identity_evidence,
            coherentWithAmbiguityRequiringNameReview: artistsByOutcome.coherent_identity_with_same_name_ambiguity,
            providerMultiplicityRequiringCanonicalProfileReview: artistsByOutcome.provider_profile_multiplicity
        },
        protectedFiles: { before: protectedBefore, after: protectedAfter, unchanged: protectedFiles.every(file => protectedBefore[file] === protectedAfter[file]) },
        safety: { identitiesVerified: 0, identitiesApproved: 0, confidenceScoresCalculated: 0, migrationEligibilityChanges: 0, migrationsPerformed: 0 }
    };
    const outputPath = path.join(outputRoot, `${report.reportId}.review.json`);
    await writeExclusive(outputPath, report);
    console.log(`REPORT=${path.relative(root, outputPath)}`);
    console.log(JSON.stringify({ countsByOutcome, changedClassifications: changed, networkRequestsMade: 0, protectedFilesUnchanged: report.protectedFiles.unchanged }));
}

main().catch(error => { console.error("Provider multiplicity reanalysis stopped: " + (error.stack || error.message)); process.exitCode = 1; });
