const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assessAuthorityMultiplicity, catalogFingerprint, compareCatalogFingerprints, interpretConflict, reviewProviderMultiplicityEvidence } = require("../lib/identity-conflict-resolution");

test("catalog fingerprints preserve chronology and distinctive overlap", () => {
    const left = catalogFingerprint([{ id: "a", name: "Lemonade", release_date: "2016-04-23" }, { id: "b", name: "Renaissance", release_date: "2022" }]);
    const right = catalogFingerprint([{ id: "c", name: "Lemonade (Deluxe Edition)", release_date: "2016" }]);
    const comparison = compareCatalogFingerprints(left, right);
    assert.deepEqual(comparison.distinctiveReleaseOverlap, ["lemonade"]);
    assert.deepEqual(comparison.chronology.left, { earliestYear: 2016, latestYear: 2022 });
});

test("semantic contradictions outrank provider artifacts", () => {
    const result = interpretConflict({ semanticContradictions: ["different_isni"], redirectedIdentifiers: ["old-id"] });
    assert.equal(result.conflictType, "semantic_identity_conflict");
    assert.equal(result.mechanicallyResolvable, false);
});

test("redirected and deprecated identifiers are mechanically resolvable only when complete", () => {
    assert.equal(interpretConflict({ redirectedIdentifiers: ["old-id"] }).conflictType, "merged_or_redirected_profile");
    assert.equal(interpretConflict({ deprecatedIdentifiers: ["old-id"] }).conflictType, "deprecated_or_obsolete_identifier");
    assert.equal(interpretConflict({ redirectedIdentifiers: ["old-id"], unresolvedIdentifiers: ["other-id"] }).conflictType, "unresolved_multiplicity");
});

test("shared provider evidence can classify profile multiplicity without verifying identity", () => {
    const result = interpretConflict({ providerMultiplicityEvidence: ["same_mbid_and_distinctive_catalog"] });
    assert.equal(result.conflictType, "provider_profile_multiplicity");
    assert.equal(result.mechanicallyResolvable, true);
});

test("mutual Discogs aliases and compatible chronology override an ISNI-only difference", () => {
    const musicBrainz = {
        stage: { artist: { artistType: "Person", lifeSpan: { begin: "1994-02-23" }, isni: ["ISNI-A"] } },
        legal: { artist: { artistType: "Person", lifeSpan: { begin: "1994-02-23" }, isni: ["ISNI-B"] } }
    };
    const discogs = {
        "1": { artist: { aliases: [{ discogsArtistId: "2" }] } },
        "2": { artist: { aliases: [{ discogsArtistId: "1" }] } }
    };
    const result = assessAuthorityMultiplicity(musicBrainz, discogs);
    assert.deepEqual(result.contradictions, []);
    assert.equal(result.mutuallyLinkedAliases, true);
    assert.ok(result.multiplicityEvidence.some(item => item.startsWith("compatible_alias_chronology")));
});

test("Beyoncé, Marvin Gaye, and Little Simz regression fixtures qualify without verification", () => {
    const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/identity-conflict-resolution/provider-multiplicity-regressions.json"), "utf8"));
    for (const fixture of Object.values(fixtures)) {
        const result = reviewProviderMultiplicityEvidence(fixture);
        assert.equal(result.qualifies, true);
        assert.equal(result.automaticVerificationAllowed, false);
        assert.equal(result.migrationApprovalGranted, false);
    }
});

test("empty catalogs, aliases, or multiplicity cannot override semantic or unresolved evidence", () => {
    const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/identity-conflict-resolution/provider-multiplicity-regressions.json"), "utf8"));
    const semantic = structuredClone(fixtures.beyonce);
    semantic.finalConflictInterpretation.signals.semanticContradictions.push("person_vs_group");
    assert.equal(reviewProviderMultiplicityEvidence(semantic).qualifies, false);
    const empty = structuredClone(fixtures.marvinGaye);
    for (const fingerprint of Object.values(empty.catalogFingerprints.spotify)) fingerprint.releaseCount = 0;
    empty.catalogFingerprints.musicBrainz["mb-a"].releaseCount = 0;
    assert.equal(reviewProviderMultiplicityEvidence(empty).qualifies, false);
    const unresolved = structuredClone(fixtures.littleSimz);
    unresolved.finalConflictInterpretation.signals.unresolvedIdentifiers.push("discogs:missing");
    assert.equal(reviewProviderMultiplicityEvidence(unresolved).qualifies, false);
});
