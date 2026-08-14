const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { mappingsChecksum, validateArtistDirectoryV2, validateRegistry } = require("../lib/music-roll-v2");

const root = path.join(__dirname, "..");
const livePath = path.join(root, "data", "artists.json");
const registryPath = path.join(root, "data", "artist-id-registry.json");
const packageRelative = "data/identity-experiments/curated-21-review-migration-package/curated-21-2026-08-14T05-28-44-713Z";
const packageDir = path.join(root, packageRelative);
const evidenceRef = "data/identity-experiments/curated-26-reconsideration/curated-26-2026-08-14T05-23-01-208Z/cohort-summary.review.json";
const excludedNames = new Set(["Elmiene", "Navy Blue", "underscores", "Hotline TNT", "Frankie Knuckles"]);
const preflightOnly = process.argv.includes("--preflight-only");

function assert(condition, message) { if (!condition) throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function bytesHash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function fileHash(file) { return bytesHash(fs.readFileSync(file)); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function atomicWrite(file, bytes) {
    const temporary = `${file}.migration-${process.pid}-${Date.now()}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, file);
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${result.status}).\n${[result.stdout, result.stderr].filter(Boolean).join("\n")}`);
    return [command, ...args].join(" ");
}

function preflight() {
    const liveBytes = fs.readFileSync(livePath); const registryBytes = fs.readFileSync(registryPath);
    const live = JSON.parse(liveBytes); const registry = JSON.parse(registryBytes);
    const manifest = readJson(path.join(packageDir, "manifest.json"));
    const review = readJson(path.join(packageDir, "human-review-summary.json"));
    const preview = readJson(path.join(packageDir, "artists-v2-migration-ready.preview.json"));
    const registryPreview = readJson(path.join(packageDir, "artist-id-registry-extension.preview.json"));
    const preChecksums = { "data/artists.json": bytesHash(liveBytes), "data/artist-id-registry.json": bytesHash(registryBytes) };

    assert(preChecksums["data/artists.json"] === manifest.protectedFiles.before["data/artists.json"], "Live directory checksum differs from the approved package baseline.");
    assert(preChecksums["data/artist-id-registry.json"] === manifest.protectedFiles.before["data/artist-id-registry.json"], "Registry checksum differs from the approved package baseline.");
    assert(manifest.reviewOnly === true && manifest.validation.candidates === 21 && manifest.validation.existingPermanentArtists === 20 && manifest.validation.v2DirectoryRecords === 41, "Approved package manifest is invalid.");
    assert(manifest.validation.schemaValid === true && manifest.validation.compatibilityFieldsValid === true && manifest.validation.uniqueMusicRollIds === true && manifest.validation.uniqueSpotifyIds === true, "Approved package validation flags are incomplete.");
    assert(review.reviewOnly === true && review.candidateCount === 21 && review.proposedDirectorySize === 41 && review.artists.length === 21, "Approved human-review summary is invalid.");
    assert(live.length === 20 && registry.mappings.length === 20, "Guard expected the 20-artist pre-migration baseline.");
    assert(preview.length === 41 && registryPreview.mappings.length === 41, "Approved package must contain exactly 41 directory and registry records.");
    assert(same(preview.slice(0, 20), live), "Approved preview does not preserve all 20 live records exactly.");
    validateArtistDirectoryV2(preview); validateRegistry(registry, live); validateRegistry(registryPreview, preview);
    assert(new Set(preview.map(artist => artist.musicRollId)).size === 41, "Approved preview contains duplicate Music Roll IDs.");
    assert(new Set(preview.map(artist => artist.spotifyId)).size === 41, "Approved preview contains duplicate Spotify IDs.");

    const reviewedBySpotify = new Map(review.artists.map(artist => [artist.spotifyId, artist]));
    assert(reviewedBySpotify.size === 21, "Approved review contains duplicate Spotify IDs.");
    for (const [index, current] of live.entries()) {
        const mapping = registryPreview.mappings[index];
        assert(mapping.musicRollId === current.musicRollId && mapping.spotifyId === current.spotifyId, `Existing registry binding drift at ${current.musicRollId}.`);
    }
    for (const candidate of preview.slice(20)) {
        const approved = reviewedBySpotify.get(candidate.spotifyId);
        assert(approved && !excludedNames.has(candidate.name), `Unapproved or excluded candidate in preview: ${candidate.name}.`);
        assert(approved.approvalState === "not_approved" && approved.migrationEligible === false, `Package candidate was not awaiting explicit approval: ${candidate.name}.`);
        assert(candidate.identity.status === "not_approved" && candidate.identity.confidence === null && candidate.migrationEligible === false, `Candidate state drift for ${candidate.name}.`);
        assert(approved.proposedMusicRollId === candidate.musicRollId && approved.artistName === candidate.name, `Approved mapping drift for ${candidate.name}.`);
        assert(approved.genre === candidate.genre && approved.stage === candidate.tier, `Curated genre or stage drift for ${candidate.name}.`);
        assert(Object.keys(candidate.externalIds).join(",") === "spotify", `Unapproved canonical provider ID found for ${candidate.name}.`);
        assert(candidate.socialUrls.instagram === null && candidate.socialUrls.tiktok === null, `Invented social URL found for ${candidate.name}.`);
        assert(Object.values(candidate.geography.home).every(value => value === null), `Invented geography found for ${candidate.name}.`);
        const proposedMapping = registryPreview.mappings.find(mapping => mapping.musicRollId === candidate.musicRollId);
        assert(proposedMapping?.spotifyId === candidate.spotifyId && proposedMapping.approvalState === "not_approved" && proposedMapping.migrationEligible === false, `Registry-extension mismatch for ${candidate.name}.`);
    }

    const promoted = preview.slice(20).map(candidate => {
        const approved = reviewedBySpotify.get(candidate.spotifyId);
        const { migrationEligible, ...withoutEligibility } = candidate;
        const identity = {
            ...candidate.identity,
            status: "verified_human_approved",
            confidence: null,
            verificationBasis: "explicit_human_approval_of_curated_21_corroboration_package",
            evidenceRefs: [evidenceRef],
            reviewOutcome: approved.identityOutcome,
            humanApprovalSource: `${packageRelative}/human-review-summary.json`
        };
        if (approved.sameNameAmbiguityNote) identity.sameNameAmbiguityNote = structuredClone(approved.sameNameAmbiguityNote);
        if (approved.providerProfileMultiplicityNote) identity.providerProfileMultiplicityNote = structuredClone(approved.providerProfileMultiplicityNote);
        return { ...withoutEligibility, identity, evidence: { ...candidate.evidence, identity: [evidenceRef] }, status: { ...candidate.status, directory: "active" } };
    });
    const nextLive = [...live.map(artist => structuredClone(artist)), ...promoted];
    const proposedRegistryMappings = registryPreview.mappings.slice(20).map(mapping => ({ musicRollId: mapping.musicRollId, spotifyId: mapping.spotifyId, displayNameAtAssignment: review.artists.find(artist => artist.proposedMusicRollId === mapping.musicRollId).artistName }));
    const nextMappings = [...registry.mappings.map(mapping => structuredClone(mapping)), ...proposedRegistryMappings];
    const nextRegistry = { ...registry, reviewOnly: false, bindingRule: "Exact Spotify ID binding from an existing verified identity or an explicitly human-approved corroboration package; never artist name alone.", mappingsSha256: mappingsChecksum(nextMappings), mappings: nextMappings };
    validateArtistDirectoryV2(nextLive); validateRegistry(nextRegistry, nextLive);
    assert(nextLive.length === 41 && nextRegistry.mappings.length === 41, "Constructed permanent state is not exactly 41 records.");
    assert(same(nextLive.slice(0, 20), live), "An existing live record changed during construction.");
    assert(promoted.every(artist => artist.identity.confidence === null && !Object.hasOwn(artist, "migrationEligible") && Object.keys(artist.externalIds).join(",") === "spotify"), "Migration invented a score/provider ID or retained preview eligibility state.");
    assert(promoted.filter(artist => artist.identity.reviewOutcome === "coherent_identity_with_same_name_ambiguity").every(artist => artist.identity.sameNameAmbiguityNote), "Same-name ambiguity provenance was lost.");
    assert(promoted.filter(artist => artist.identity.reviewOutcome === "provider_profile_multiplicity").every(artist => artist.identity.providerProfileMultiplicityNote), "Provider multiplicity provenance was lost.");
    return { liveBytes, registryBytes, live, nextLive, nextRegistry, preChecksums };
}

function main() {
    const prepared = preflight();
    if (preflightOnly) {
        process.stdout.write(`${JSON.stringify({ preflightPassed: true, preChecksums: prepared.preChecksums, currentArtists: 20, approvedCandidates: 21, proposedArtists: 41, proposedMappings: 41 }, null, 2)}\n`);
        return;
    }
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "music-roll-curated-21-"));
    fs.writeFileSync(path.join(backupDir, "artists.json"), prepared.liveBytes, { flag: "wx" });
    fs.writeFileSync(path.join(backupDir, "artist-id-registry.json"), prepared.registryBytes, { flag: "wx" });
    let writeStarted = false;
    try {
        writeStarted = true;
        atomicWrite(livePath, jsonBytes(prepared.nextLive));
        atomicWrite(registryPath, jsonBytes(prepared.nextRegistry));
        const installedLive = readJson(livePath); const installedRegistry = readJson(registryPath);
        validateArtistDirectoryV2(installedLive); validateRegistry(installedRegistry, installedLive);
        assert(installedLive.length === 41 && installedRegistry.mappings.length === 41, "Post-migration count is not exactly 41.");
        assert(same(installedLive.slice(0, 20), prepared.live), "Existing 20 records changed after installation.");
        assert(installedLive.every(artist => typeof artist.image === "string" && artist.image && /^https:\/\//.test(artist.spotify)), "An image or Spotify link is invalid.");
        for (const mapping of prepared.nextRegistry.mappings) assert(installedRegistry.mappings.some(item => item.musicRollId === mapping.musicRollId && item.spotifyId === mapping.spotifyId), `Missing permanent binding: ${mapping.musicRollId}.`);
        const checks = [
            run(process.execPath, ["--test", "test/artist-model-adapter.test.js", "test/my-artists-store.test.js", "test/behavior-event-recorder.test.js"]),
            run("npm", ["test"]),
            run("npm", ["run", "check"]),
            run("git", ["diff", "--check"])
        ];
        process.stdout.write(`${JSON.stringify({ rollbackRequired: false, backupDirectory: backupDir, preChecksums: prepared.preChecksums, postChecksums: { "data/artists.json": fileHash(livePath), "data/artist-id-registry.json": fileHash(registryPath) }, artistCount: installedLive.length, registryCount: installedRegistry.mappings.length, artists: installedLive.map(artist => ({ musicRollId: artist.musicRollId, name: artist.name, spotifyId: artist.spotifyId })), checks }, null, 2)}\n`);
    } catch (error) {
        let rollbackVerified = false;
        if (writeStarted) {
            atomicWrite(livePath, prepared.liveBytes); atomicWrite(registryPath, prepared.registryBytes);
            rollbackVerified = fileHash(livePath) === prepared.preChecksums["data/artists.json"] && fileHash(registryPath) === prepared.preChecksums["data/artist-id-registry.json"];
        }
        process.stderr.write(`Migration failed; rollback ${rollbackVerified ? "verified" : "could not be verified"}. ${error.stack || error.message}\n`);
        process.exitCode = 1;
    }
}

main();
