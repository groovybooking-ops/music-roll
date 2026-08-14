const { normalizeReleaseTitle } = require("./catalog-enrichment");

const CONFLICT_TYPES = Object.freeze([
    "semantic_identity_conflict",
    "provider_profile_multiplicity",
    "deprecated_or_obsolete_identifier",
    "merged_or_redirected_profile",
    "unresolved_multiplicity"
]);

function catalogFingerprint(releases = []) {
    const normalized = releases.map(release => ({
        id: release.id || null,
        title: release.name || release.title || "",
        normalizedTitle: normalizeReleaseTitle(release.name || release.title),
        date: release.release_date || release["first-release-date"] || null,
        type: release.album_type || release["primary-type"] || null
    })).filter(release => release.normalizedTitle);
    const years = normalized.map(release => String(release.date || "").match(/^(\d{4})/)?.[1]).filter(Boolean).map(Number);
    return {
        releaseCount: normalized.length,
        distinctiveTitles: [...new Set(normalized.map(release => release.normalizedTitle))],
        earliestYear: years.length ? Math.min(...years) : null,
        latestYear: years.length ? Math.max(...years) : null
    };
}

function compareCatalogFingerprints(left, right) {
    const leftTitles = new Set(left?.distinctiveTitles || []);
    const rightTitles = new Set(right?.distinctiveTitles || []);
    const overlap = [...leftTitles].filter(title => rightTitles.has(title));
    return {
        distinctiveReleaseOverlap: overlap,
        overlapCount: overlap.length,
        chronology: {
            left: { earliestYear: left?.earliestYear ?? null, latestYear: left?.latestYear ?? null },
            right: { earliestYear: right?.earliestYear ?? null, latestYear: right?.latestYear ?? null }
        }
    };
}

function interpretConflict(signals = {}) {
    const semantic = signals.semanticContradictions || [];
    const unresolved = signals.unresolvedIdentifiers || [];
    const redirected = signals.redirectedIdentifiers || [];
    const deprecated = signals.deprecatedIdentifiers || [];
    const multiplicity = signals.providerMultiplicityEvidence || [];
    let conflictType = "unresolved_multiplicity";
    let mechanicallyResolvable = false;
    if (semantic.length) {
        conflictType = "semantic_identity_conflict";
    } else if (!unresolved.length && redirected.length) {
        conflictType = "merged_or_redirected_profile";
        mechanicallyResolvable = true;
    } else if (!unresolved.length && deprecated.length) {
        conflictType = "deprecated_or_obsolete_identifier";
        mechanicallyResolvable = true;
    } else if (!unresolved.length && multiplicity.length) {
        conflictType = "provider_profile_multiplicity";
        mechanicallyResolvable = true;
    }
    return { conflictType, mechanicallyResolvable, signals: { semanticContradictions: semantic, redirectedIdentifiers: redirected, deprecatedIdentifiers: deprecated, providerMultiplicityEvidence: multiplicity, unresolvedIdentifiers: unresolved } };
}

function assessAuthorityMultiplicity(musicBrainzRecords = {}, discogsRecords = {}) {
    const discogsEntries = Object.entries(discogsRecords).filter(([, record]) => record?.artist);
    const discogsIds = discogsEntries.map(([id]) => id);
    const mutuallyLinkedAliases = discogsIds.length > 1 && discogsEntries.every(([id, record]) => {
        const aliases = new Set((record.artist.aliases || []).map(alias => alias.discogsArtistId));
        return discogsIds.filter(other => other !== id).every(other => aliases.has(other));
    });
    const mbEntries = Object.entries(musicBrainzRecords).filter(([, record]) => record?.artist);
    const contradictions = [];
    const multiplicityEvidence = [];
    if (mutuallyLinkedAliases) multiplicityEvidence.push("mutually_linked_discogs_alias_profiles");
    for (let left = 0; left < mbEntries.length; left += 1) for (let right = left + 1; right < mbEntries.length; right += 1) {
        const [leftId, leftRecord] = mbEntries[left]; const [rightId, rightRecord] = mbEntries[right];
        const leftArtist = leftRecord.artist; const rightArtist = rightRecord.artist;
        if (leftArtist.artistType && rightArtist.artistType && leftArtist.artistType !== rightArtist.artistType) contradictions.push(`different_artist_type:${leftId}:${rightId}`);
        if (leftArtist.lifeSpan?.begin && rightArtist.lifeSpan?.begin && leftArtist.lifeSpan.begin !== rightArtist.lifeSpan.begin) contradictions.push(`different_birth_or_begin_date:${leftId}:${rightId}`);
        if (mutuallyLinkedAliases && leftArtist.lifeSpan?.begin && leftArtist.lifeSpan.begin === rightArtist.lifeSpan?.begin) multiplicityEvidence.push(`compatible_alias_chronology:${leftId}:${rightId}`);
    }
    return { contradictions, multiplicityEvidence, mutuallyLinkedAliases };
}

function reviewProviderMultiplicityEvidence(report) {
    const interpretation = report?.finalConflictInterpretation;
    const signals = interpretation?.signals || {};
    const reasons = [];
    if (report?.reviewOnly !== true) reasons.push("not_review_only");
    if (interpretation?.conflictType !== "provider_profile_multiplicity") reasons.push("not_multiplicity_interpretation");
    if ((signals.semanticContradictions || []).length) reasons.push("semantic_contradiction_present");
    if ((signals.unresolvedIdentifiers || []).length) reasons.push("unresolved_identifier_present");
    if (!(signals.providerMultiplicityEvidence || []).length) reasons.push("no_positive_multiplicity_evidence");
    if (!Array.isArray(report?.provenanceClaims) || !report.provenanceClaims.length) reasons.push("missing_provenance");
    const safety = report?.safety || {};
    if (safety.identityVerified !== false || safety.confidenceScoreCalculated !== false || safety.migrationEligibilityChanged !== false || safety.registryModified !== false || safety.liveDirectoryModified !== false) reasons.push("unsafe_side_effect_flag");

    const spotifyFingerprints = Object.values(report?.catalogFingerprints?.spotify || {});
    const mbFingerprints = Object.values(report?.catalogFingerprints?.musicBrainz || {});
    const hasPositiveCatalog = [...spotifyFingerprints, ...mbFingerprints].some(item => item.releaseCount > 0);
    if (!hasPositiveCatalog) reasons.push("no_positive_catalog_anchor");
    const nonEmptySpotify = spotifyFingerprints.filter(item => item.releaseCount > 0);
    if (nonEmptySpotify.length > 1) {
        const comparisons = report?.catalogFingerprintComparisons?.spotify || [];
        if (comparisons.some(item => item.overlapCount === 0 && item.chronology.left.earliestYear != null && item.chronology.right.earliestYear != null)) reasons.push("incompatible_active_catalogs");
    }

    const authorities = Object.values(report?.authorityMetadataComparison || {}).filter(item => item?.name);
    const types = new Set(authorities.map(item => item.artistType).filter(Boolean));
    if (types.size > 1) reasons.push("incompatible_artist_types");
    const begins = new Set(authorities.map(item => item.lifeSpan?.begin).filter(Boolean));
    const hasAliasChronology = (signals.providerMultiplicityEvidence || []).some(item => item.startsWith("compatible_alias_chronology"));
    if (begins.size > 1 && !hasAliasChronology) reasons.push("incompatible_chronology");

    const discogs = Object.values(report?.identifierStates?.discogs || {}).filter(item => item?.name);
    if (discogs.length > 1) {
        const realNames = new Set(discogs.map(item => item.realName).filter(Boolean));
        const mutualAliases = (signals.providerMultiplicityEvidence || []).includes("mutually_linked_discogs_alias_profiles");
        if (!mutualAliases && realNames.size !== 1) reasons.push("uncorroborated_discogs_multiplicity");
    }
    const emptyAlternatesOnly = spotifyFingerprints.length > 1 && nonEmptySpotify.length === 0;
    if (emptyAlternatesOnly) reasons.push("empty_catalogs_cannot_establish_identity");
    return { qualifies: reasons.length === 0, reasons, interpretation: "provider_profile_multiplicity", automaticVerificationAllowed: false, migrationApprovalGranted: false };
}

module.exports = { CONFLICT_TYPES, assessAuthorityMultiplicity, catalogFingerprint, compareCatalogFingerprints, interpretConflict, reviewProviderMultiplicityEvidence };
