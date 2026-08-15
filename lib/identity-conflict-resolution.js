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

function activeArtist(record) {
    return record?.artist || (record?.musicBrainzArtistId || record?.discogsArtistId ? record : null);
}

function generalizedProviderMultiplicity({ claims = [], musicBrainzRecords = {}, discogsRecords = {}, musicBrainzFingerprints = {}, deprecatedIdentifiers = [], redirectedIdentifiers = [] } = {}) {
    const normalizedMusicBrainz = Object.fromEntries(Object.entries(musicBrainzRecords).map(([id, record]) => [id, record?.artist ? record : { artist: activeArtist(record), state: activeArtist(record) ? "active" : record?.state || "unresolved" }]));
    const normalizedDiscogs = Object.fromEntries(Object.entries(discogsRecords).map(([id, record]) => [id, record?.artist ? record : { artist: activeArtist(record), state: activeArtist(record) ? "active" : record?.state || "unresolved" }]));
    const values = type => [...new Set(claims.filter(claim => claim.identifierType === type && claim.value != null).map(claim => String(claim.value)))];
    const mbids = values("musicBrainzArtistId");
    const discogsIds = values("discogsArtistId");
    const qids = values("wikidataQid");
    const unresolvedIdentifiers = [];
    for (const id of mbids) if (!activeArtist(normalizedMusicBrainz[id]) && !deprecatedIdentifiers.includes(`musicbrainz:${id}`) && !redirectedIdentifiers.some(value => value.startsWith(`musicbrainz:${id}->`))) unresolvedIdentifiers.push(`musicbrainz:${id}`);
    for (const id of discogsIds) if (!activeArtist(normalizedDiscogs[id]) && !deprecatedIdentifiers.includes(`discogs:${id}`) && !redirectedIdentifiers.some(value => value.startsWith(`discogs:${id}->`))) unresolvedIdentifiers.push(`discogs:${id}`);

    const authority = assessAuthorityMultiplicity(normalizedMusicBrainz, normalizedDiscogs);
    const semanticContradictions = [...authority.contradictions];
    const providerMultiplicityEvidence = [...authority.multiplicityEvidence];
    const fingerprintComparisons = [];
    const fingerprintEntries = Object.entries(musicBrainzFingerprints);
    for (let left = 0; left < fingerprintEntries.length; left += 1) for (let right = left + 1; right < fingerprintEntries.length; right += 1) {
        const comparison = { left: fingerprintEntries[left][0], right: fingerprintEntries[right][0], ...compareCatalogFingerprints(fingerprintEntries[left][1], fingerprintEntries[right][1]) };
        fingerprintComparisons.push(comparison);
        if (comparison.overlapCount >= 2) providerMultiplicityEvidence.push(`musicbrainz_catalog_overlap:${comparison.left}:${comparison.right}:${comparison.overlapCount}`);
    }

    if (discogsIds.length > 1) {
        const assertingMbids = new Map();
        for (const claim of claims.filter(claim => claim.identifierType === "discogsArtistId" && claim.source === "musicbrainz" && claim.assertedByIdentifier)) {
            const set = assertingMbids.get(claim.assertedByIdentifier) || new Set();
            set.add(String(claim.value));
            assertingMbids.set(claim.assertedByIdentifier, set);
        }
        if ([...assertingMbids.values()].some(set => discogsIds.every(id => set.has(id)))) providerMultiplicityEvidence.push("multiple_discogs_profiles_asserted_by_one_musicbrainz_entity");
        const activeDiscogs = discogsIds.map(id => activeArtist(normalizedDiscogs[id])).filter(Boolean);
        const realNames = new Set(activeDiscogs.map(artist => artist.realName).filter(Boolean));
        if (activeDiscogs.length === discogsIds.length && realNames.size === 1 && [...realNames][0]) providerMultiplicityEvidence.push("shared_discogs_real_name");
        if (!providerMultiplicityEvidence.length) unresolvedIdentifiers.push("unexplained_multiple_discogs_ids");
    }

    if (mbids.length > 1) {
        const spotifyByMbid = new Map();
        for (const claim of claims.filter(claim => claim.identifierType === "spotifyArtistId" && claim.source === "musicbrainz" && claim.assertedByIdentifier)) {
            const set = spotifyByMbid.get(claim.assertedByIdentifier) || new Set();
            set.add(String(claim.value));
            spotifyByMbid.set(claim.assertedByIdentifier, set);
        }
        const commonSpotify = [...new Set(claims.filter(claim => claim.identifierType === "spotifyArtistId" && claim.source === "music_roll_input").map(claim => String(claim.value)))];
        if (commonSpotify.length === 1 && mbids.every(id => spotifyByMbid.get(id)?.has(commonSpotify[0]))) providerMultiplicityEvidence.push("multiple_musicbrainz_profiles_assert_same_spotify_entity");
        const officialSets = mbids.map(id => new Set((activeArtist(normalizedMusicBrainz[id])?.externalUrls || []).filter(item => item.relationshipType === "official homepage").map(item => item.url)));
        if (officialSets.filter(set => set.size).length > 1 && !officialSets.slice(1).some(set => [...set].some(url => officialSets[0].has(url))) && !fingerprintComparisons.some(item => item.overlapCount >= 2)) unresolvedIdentifiers.push("incompatible_or_unlinked_official_urls");
        if (!providerMultiplicityEvidence.length) unresolvedIdentifiers.push("unexplained_multiple_musicbrainz_ids");
    }
    if (qids.length > 1 && !qids.slice(1).every(id => deprecatedIdentifiers.includes(`wikidata:${id}`) || redirectedIdentifiers.some(value => value.startsWith(`wikidata:${id}->`)))) unresolvedIdentifiers.push("multiple_active_wikidata_qids");

    const interpretation = interpretConflict({ semanticContradictions, redirectedIdentifiers, deprecatedIdentifiers, providerMultiplicityEvidence: [...new Set(providerMultiplicityEvidence)], unresolvedIdentifiers: [...new Set(unresolvedIdentifiers)] });
    const hasPositiveCatalogAnchor = Object.values(musicBrainzFingerprints).some(fingerprint => fingerprint?.releaseCount > 0);
    const mechanicallyCoherentMultiplicity = ["provider_profile_multiplicity", "merged_or_redirected_profile", "deprecated_or_obsolete_identifier"].includes(interpretation.conflictType);
    return { interpretation, fingerprintComparisons, hasPositiveCatalogAnchor, qualifiesAsProviderMultiplicity: mechanicallyCoherentMultiplicity && hasPositiveCatalogAnchor, automaticVerificationAllowed: false, migrationApprovalGranted: false };
}

function assessMechanicallyClosedProviderMultiplicity({
    claims = [],
    musicBrainzRecords = {},
    discogsRecords = {},
    resolution,
    sameNameAudit,
    providerErrors = [],
    storedSpotifyArtistId,
    spotifyConfirmedByMusicBrainz = false,
    legalNameRelationshipEvidence = []
} = {}) {
    const values = type => [...new Set(claims.filter(claim => claim.identifierType === type && claim.value != null).map(claim => String(claim.value)))];
    const spotifyIds = values("spotifyArtistId");
    const mbids = values("musicBrainzArtistId");
    const qids = values("wikidataQid");
    const discogsIds = values("discogsArtistId");
    const reasons = [];
    const explainedAlternates = [];
    const signals = resolution?.interpretation?.signals || {};
    const normalizeLegalName = value => typeof value === "string" && value.trim()
        ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")
        : null;
    const hasCorroboratedLegalNameRelationship = discogsIds.length > 1 && legalNameRelationshipEvidence.some(evidence => {
        const relationshipTypes = new Set(["legal_name_stage_name", "legal_name_alias"]);
        const coveredIds = new Set((evidence?.discogsArtistIds || []).map(String));
        const providerSource = evidence?.providerAssertion?.source;
        const providerEvidenceRef = evidence?.providerAssertion?.evidenceRef;
        const independentCorroboration = (evidence?.independentCorroboration || []).filter(item =>
            item?.source && item.source !== providerSource && item?.evidenceRef
        );
        return relationshipTypes.has(evidence?.relationshipType)
            && coveredIds.size === discogsIds.length
            && discogsIds.every(id => coveredIds.has(id))
            && Boolean(providerSource && providerEvidenceRef)
            && independentCorroboration.length > 0;
    });

    if (resolution?.interpretation?.conflictType !== "provider_profile_multiplicity") reasons.push("not_provider_profile_multiplicity");
    if ((signals.semanticContradictions || []).length) reasons.push("semantic_contradiction_present");
    if ((signals.unresolvedIdentifiers || []).length) reasons.push("unresolved_identifier_present");
    if (providerErrors.length) reasons.push("provider_error_present");
    if (!spotifyConfirmedByMusicBrainz) reasons.push("stored_spotify_not_confirmed_by_musicbrainz");
    if (!resolution?.hasPositiveCatalogAnchor) reasons.push("no_positive_catalog_anchor");
    if (sameNameAudit?.sameNameAmbiguity !== "none_observed") reasons.push("same_name_ambiguity_present_or_not_evaluated");
    if (qids.length !== 1) reasons.push("wikidata_identifier_not_unique");
    if (mbids.length !== 1) reasons.push("musicbrainz_identifier_not_unique");
    if (spotifyIds.length !== 1 || spotifyIds[0] !== storedSpotifyArtistId) reasons.push("unresolved_alternate_spotify_identifier");

    for (const mbid of mbids) if (!(musicBrainzRecords[mbid]?.artist || musicBrainzRecords[mbid]?.musicBrainzArtistId)) reasons.push(`missing_musicbrainz_record:${mbid}`);
    for (const discogsId of discogsIds) if (!(discogsRecords[discogsId]?.artist || discogsRecords[discogsId]?.discogsArtistId)) reasons.push(`missing_discogs_record:${discogsId}`);

    if (discogsIds.length > 1) {
        const artists = discogsIds.map(id => discogsRecords[id]?.artist || discogsRecords[id]);
        const mutuallyLinked = artists.every((artist, index) => {
            const aliases = new Set((artist?.aliases || []).map(alias => String(alias.discogsArtistId)));
            return discogsIds.every((id, otherIndex) => index === otherIndex || aliases.has(id));
        });
        const normalizedRealNames = artists.map(artist => normalizeLegalName(artist?.realName));
        const everyProfileHasLegalName = normalizedRealNames.every(Boolean);
        const realNames = new Set(normalizedRealNames.filter(Boolean));
        const allProfilesShareLegalName = everyProfileHasLegalName && realNames.size === 1;
        const legalNameExplanationComplete = allProfilesShareLegalName || hasCorroboratedLegalNameRelationship;
        if (!mutuallyLinked) reasons.push("discogs_alternates_not_mutually_linked");
        if (!everyProfileHasLegalName && !hasCorroboratedLegalNameRelationship) reasons.push("discogs_alternates_have_missing_legal_name");
        if (everyProfileHasLegalName && realNames.size !== 1 && !hasCorroboratedLegalNameRelationship) reasons.push("discogs_alternates_lack_shared_legal_name");
        if (!legalNameExplanationComplete) reasons.push("discogs_alternates_lack_corroborated_legal_name_relationship");
        if (mutuallyLinked && legalNameExplanationComplete) {
            const explanation = allProfilesShareLegalName
                ? "mutual_alias_and_shared_nonempty_legal_name"
                : "mutual_alias_and_independently_corroborated_legal_name_relationship";
            for (const discogsId of discogsIds) explainedAlternates.push({ identifierType: "discogsArtistId", value: discogsId, explanation });
        }
    }

    return {
        mechanicallyClosed: reasons.length === 0,
        reasons: [...new Set(reasons)],
        explainedAlternates,
        automaticApprovalAllowed: false,
        migrationApprovalGranted: false
    };
}

module.exports = { CONFLICT_TYPES, assessAuthorityMultiplicity, assessMechanicallyClosedProviderMultiplicity, catalogFingerprint, compareCatalogFingerprints, generalizedProviderMultiplicity, interpretConflict, reviewProviderMultiplicityEvidence };
