const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { mappingsChecksum, validateArtistDirectoryV2, validateRegistry } = require("../lib/music-roll-v2");

const root = path.join(__dirname, "..");
const livePath = path.join(root, "data", "artists.json");
const registryPath = path.join(root, "data", "artist-id-registry.json");
const packageDir = path.join(root, "data", "identity-experiments", "curated-14-review-migration-package", "curated-14-2026-08-14T04-22-36-754Z");
const migrationEvidenceRef = "data/identity-experiments/curated-40-provider-multiplicity-reanalysis/curated-40-provider-multiplicity-reanalysis-2026-08-14T04-18-32-340Z.review.json";

function assert(condition, message) { if (!condition) throw new Error(message); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function bytesHash(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function fileHash(file) { return bytesHash(fs.readFileSync(file)); }
function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function atomicWrite(file, bytes) {
    const temporary = `${file}.migration-${process.pid}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, file);
}

function run(command, args) {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    if (result.status !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        throw new Error(`${command} ${args.join(" ")} failed (${result.status}).\n${output}`);
    }
    return { command: [command, ...args].join(" "), output: result.stdout.trim() };
}

function preflight() {
    const liveBytes = fs.readFileSync(livePath);
    const registryBytes = fs.readFileSync(registryPath);
    const live = JSON.parse(liveBytes);
    const registry = JSON.parse(registryBytes);
    const manifest = readJson(path.join(packageDir, "manifest.json"));
    const review = readJson(path.join(packageDir, "human-review-summary.json"));
    const preview = readJson(path.join(packageDir, "artists-v2-migration-ready.preview.json"));
    const registryPreview = readJson(path.join(packageDir, "artist-id-registry-extension.preview.json"));

    assert(fileHash(livePath) === manifest.protectedFiles.before["data/artists.json"], "Live directory checksum no longer matches the approved package baseline.");
    assert(fileHash(registryPath) === manifest.protectedFiles.before["data/artist-id-registry.json"], "Permanent registry checksum no longer matches the approved package baseline.");
    assert(manifest.reviewOnly === true && manifest.validation.supportedArtists === 14 && manifest.validation.v2DirectoryRecords === 20, "Approved package manifest is invalid.");
    assert(review.reviewOnly === true && review.artistCount === 14 && review.artists.length === 14, "Approved human-review summary is invalid.");
    assert(live.length === 6 && registry.mappings.length === 6, "Guard expected the six-artist pre-migration baseline.");
    assert(preview.length === 20 && registryPreview.mappings.length === 20, "Approved package must contain exactly 20 directory and registry records.");
    assert(same(preview.slice(0, 6), live), "Approved package does not preserve the six live artist records exactly.");
    validateArtistDirectoryV2(preview);
    validateRegistry(registry, live);

    const reviewedBySpotify = new Map(review.artists.map(item => [item.spotifyId, item]));
    const previewIds = new Set(preview.map(item => item.musicRollId));
    const previewSpotify = new Set(preview.map(item => item.spotifyId));
    assert(previewIds.size === 20 && previewSpotify.size === 20, "Approved directory contains duplicate identifiers.");
    assert(reviewedBySpotify.size === 14, "Approved review contains duplicate Spotify identifiers.");
    for (const artist of preview.slice(6)) {
        const approved = reviewedBySpotify.get(artist.spotifyId);
        assert(approved, `Unapproved artist in migration preview: ${artist.name}.`);
        assert(approved.proposedMusicRollId === artist.musicRollId && approved.curatedName === artist.name, `Approved mapping drift for ${artist.name}.`);
        assert(approved.genre === artist.genre && approved.stage === artist.tier, `Curated classification drift for ${artist.name}.`);
    }
    for (const mapping of registryPreview.mappings) {
        const artist = preview.find(item => item.musicRollId === mapping.musicRollId);
        assert(artist?.spotifyId === mapping.spotifyId, `Registry preview binding mismatch: ${mapping.musicRollId}.`);
    }

    const promoted = preview.slice(6).map(artist => {
        const approved = reviewedBySpotify.get(artist.spotifyId);
        const identity = {
            ...artist.identity,
            status: "verified_human_approved",
            confidence: null,
            verificationBasis: "explicit_human_approval_of_multi_source_identity_corroboration",
            evidenceRefs: [migrationEvidenceRef],
            reviewOutcome: approved.identityOutcome
        };
        if (approved.identityOutcome === "provider_profile_multiplicity") {
            assert(approved.providerProfileMultiplicityNotes.length > 0, `Multiplicity evidence notes missing for ${artist.name}.`);
            identity.providerProfileMultiplicityNotes = [...approved.providerProfileMultiplicityNotes];
        }
        return {
            ...artist,
            identity,
            evidence: { ...artist.evidence, identity: [migrationEvidenceRef] },
            status: { ...artist.status, directory: "active" }
        };
    });
    const nextLive = [...live.map(item => structuredClone(item)), ...promoted];
    const mappings = nextLive.map(artist => ({
        musicRollId: artist.musicRollId,
        spotifyId: artist.spotifyId,
        displayNameAtAssignment: artist.name
    }));
    const nextRegistry = {
        ...registry,
        reviewOnly: false,
        bindingRule: "Exact Spotify ID binding from an existing verified identity or an explicitly human-approved corroboration package; never artist name alone.",
        mappingsSha256: mappingsChecksum(mappings),
        mappings
    };
    validateArtistDirectoryV2(nextLive);
    validateRegistry(nextRegistry, nextLive);
    assert(same(nextLive.slice(0, 6), live), "Existing live artists changed during construction.");
    assert(new Set(nextLive.map(item => item.spotifyId)).size === 20, "Constructed directory has duplicate Spotify IDs.");
    assert(nextLive.slice(6).every(item => item.identity.confidence === null && Object.keys(item.externalIds).join(",") === "spotify"), "Migration invented a score or canonical provider ID.");
    return { liveBytes, registryBytes, nextLive, nextRegistry, preChecksums: { "data/artists.json": bytesHash(liveBytes), "data/artist-id-registry.json": bytesHash(registryBytes) } };
}

function main() {
    const prepared = preflight();
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "music-roll-curated-14-"));
    fs.writeFileSync(path.join(backupDir, "artists.json"), prepared.liveBytes, { flag: "wx" });
    fs.writeFileSync(path.join(backupDir, "artist-id-registry.json"), prepared.registryBytes, { flag: "wx" });
    let wroteLive = false;
    try {
        atomicWrite(livePath, jsonBytes(prepared.nextLive));
        atomicWrite(registryPath, jsonBytes(prepared.nextRegistry));
        wroteLive = true;
        const installedLive = readJson(livePath);
        const installedRegistry = readJson(registryPath);
        validateArtistDirectoryV2(installedLive);
        validateRegistry(installedRegistry, installedLive);
        assert(installedLive.length === 20 && installedRegistry.mappings.length === 20, "Post-migration count is not exactly 20.");
        assert(same(installedLive.slice(0, 6), JSON.parse(prepared.liveBytes)), "Existing six records changed after installation.");
        for (const mapping of prepared.nextRegistry.mappings) {
            assert(installedRegistry.mappings.some(item => item.musicRollId === mapping.musicRollId && item.spotifyId === mapping.spotifyId), `Missing permanent binding: ${mapping.musicRollId}.`);
        }
        const checks = [
            run(process.execPath, ["--test", "test/artist-model-adapter.test.js"]),
            run("npm", ["run", "check"]),
            run("npm", ["test"]),
            run("git", ["diff", "--check"])
        ];
        const result = {
            rollbackRequired: false,
            backupDirectory: backupDir,
            preChecksums: prepared.preChecksums,
            postChecksums: { "data/artists.json": fileHash(livePath), "data/artist-id-registry.json": fileHash(registryPath) },
            artistCount: installedLive.length,
            registryCount: installedRegistry.mappings.length,
            artists: installedLive.map(item => ({ musicRollId: item.musicRollId, name: item.name, spotifyId: item.spotifyId })),
            checks: checks.map(item => item.command)
        };
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        if (wroteLive) {
            atomicWrite(livePath, prepared.liveBytes);
            atomicWrite(registryPath, prepared.registryBytes);
        }
        process.stderr.write(`Migration failed; live files restored. ${error.stack || error.message}\n`);
        process.exitCode = 1;
    }
}

main();
