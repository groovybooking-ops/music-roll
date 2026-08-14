const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { adaptArtist, adaptArtistDirectory } = require("../artist-model-adapter.js");
const { compare, roll } = require("../experiments/v2-compatibility/parity-harness.js");

const root = path.join(__dirname, "..");
const v1Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "artist-model", "artists-v1.json"), "utf8"));
const v2Fixture = JSON.parse(fs.readFileSync(path.join(root, "data", "artists-v2.preview.json"), "utf8"));

test("dedicated v1 fixture remains immutable", () => {
    const bytes = fs.readFileSync(path.join(__dirname, "fixtures", "artist-model", "artists-v1.json"));
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "6a8d17a9aea78fa918afd61cad7f561f1d741856ef7a0c4e2bed10339c1235d7");
});

test("adapts a valid v1 artist without changing compatibility values", () => {
    assert.deepEqual(adaptArtist(v1Fixture[0]), v1Fixture[0]);
});

test("derives v2 compatibility values from canonical fields", () => {
    assert.deepEqual(adaptArtist(v2Fixture[0]), adaptArtist(v1Fixture[0]));
});

test("all six dedicated v1 and v2 artists normalize identically", () => {
    assert.deepEqual(adaptArtistDirectory(v2Fixture), adaptArtistDirectory(v1Fixture));
});

test("rejects missing required fields and invalid stage or genre", () => {
    const missingV1SpotifyUrl = structuredClone(v1Fixture[0]);
    delete missingV1SpotifyUrl.spotify;
    assert.throws(() => adaptArtist(missingV1SpotifyUrl), /Artist v1 spotify must be/);
    const missingV2SpotifyUrl = structuredClone(v2Fixture[0]);
    delete missingV2SpotifyUrl.externalUrls.spotify;
    delete missingV2SpotifyUrl.spotify;
    assert.throws(() => adaptArtist(missingV2SpotifyUrl), /externalUrls.spotify/);
    const invalidStage = structuredClone(v2Fixture[0]);
    invalidStage.editorial.stage = "local";
    delete invalidStage.tier;
    assert.throws(() => adaptArtist(invalidStage), /Invalid artist stage/);
    const invalidGenre = structuredClone(v2Fixture[0]);
    invalidGenre.primaryGenre = "jazz";
    delete invalidGenre.genre;
    assert.throws(() => adaptArtist(invalidGenre), /Invalid artist primaryGenre/);
});

test("fails loudly when any v2 legacy field drifts", () => {
    for (const [field, value] of [["genre", "pop"], ["tier", "classic"], ["spotifyId", "wrong"], ["spotify", "wrong"], ["image", "wrong"], ["instagram", "wrong"], ["tiktok", "wrong"]]) {
        const drift = structuredClone(v2Fixture[0]);
        drift[field] = value;
        assert.throws(() => adaptArtist(drift), /compatibility drift/);
    }
});

test("rejects a v2 artist without a Spotify mapping", () => {
    const missing = structuredClone(v2Fixture[0]);
    delete missing.externalIds.spotify;
    assert.throws(() => adaptArtist(missing), /externalIds.spotify/);
});

test("preserves null social URLs", () => {
    const record = structuredClone(v2Fixture[0]);
    record.socialUrls = { instagram: null, tiktok: null };
    delete record.instagram;
    delete record.tiktok;
    assert.equal(adaptArtist(record).instagram, null);
    assert.equal(adaptArtist(record).tiktok, null);
});

test("future multi-genre records retain primaryGenre filtering behavior", () => {
    const record = structuredClone(v2Fixture[0]);
    record.genres = ["rnb", "dance"];
    assert.equal(adaptArtist(record).genre, "rnb");
    assert.equal(roll([adaptArtist(record)], "rnb", "emerging", 0).selected.name, "GROOVY");
    assert.equal(roll([adaptArtist(record)], "dance", "emerging", 0).empty, true);
});

test("browser parity model matches filtering, rolls, cards, links, images, and Roll Again", () => {
    const report = compare(v1Fixture, v2Fixture);
    assert.equal(report.directoriesIdentical, true);
    assert.equal(report.filteringParity, true);
    assert.equal(report.randomSelectionParity, true);
    assert.equal(report.resultCardParity, true);
    assert.equal(report.spotifyLinkParity, true);
    assert.equal(report.imageParity, true);
    assert.equal(report.rollAgainParity, true);
    assert.equal(report.mismatches.length, 0);
});

test("adapter and parity checks remain valid when the simulated live directory is schema v2", () => {
    const simulatedV2Live = structuredClone(v2Fixture);
    assert.deepEqual(adaptArtistDirectory(simulatedV2Live), adaptArtistDirectory(v1Fixture));
    const report = compare(v1Fixture, simulatedV2Live);
    assert.equal(report.directoriesIdentical, true);
    assert.equal(report.filteringParity, true);
    assert.equal(report.randomSelectionParity, true);
    assert.equal(report.resultCardParity, true);
    assert.equal(report.spotifyLinkParity, true);
    assert.equal(report.imageParity, true);
    assert.equal(report.rollAgainParity, true);
    assert.deepEqual(report.mismatches, []);
});

test("the permanent directory preserves adapter, filtering, and random roll behavior", () => {
    const live = JSON.parse(fs.readFileSync(path.join(root, "data", "artists.json"), "utf8"));
    const adapted = adaptArtistDirectory(live);
    assert.equal(adapted.length, 41);
    for (const artist of adapted) {
        const matches = adapted.filter(item => item.genre === artist.genre && item.tier === artist.tier);
        for (const randomValue of [0, 0.5, 0.999999]) {
            const result = roll(adapted, artist.genre, artist.tier, randomValue);
            assert.equal(result.empty, false);
            assert.ok(matches.some(item => item.spotifyId === result.selected.spotifyId));
            assert.equal(result.card.spotifyHref, result.selected.spotify);
            assert.equal(result.card.imageSrc, result.selected.image);
        }
    }
});

function livePageHarness(payload, options = {}) {
    const listeners = {};
    const errors = [];
    const alerts = [];
    const storage = new Map();
    function element(id) {
        const ownListeners = {};
        listeners[id] = ownListeners;
        return {
            id, disabled: false, hidden: false, textContent: "", dataset: {}, style: {},
            classList: { add() {}, remove() {} },
            addEventListener(type, listener) { ownListeners[type] = listener; },
            append() {}, replaceChildren() {}, focus() {}, scrollIntoView() {},
            setAttribute(name, value) { this[name] = String(value); },
            removeAttribute(name) { delete this[name]; },
            dispatch(type, event = {}) { ownListeners[type]?.({ target: this, preventDefault() {}, ...event }); }
        };
    }
    const ids = ["rollForm", "genre", "tier", "rollButton", "rollAgainButton", "result", "loadingStatus", "artistName", "artistInfo", "artistImage", "spotifyLink", "saveArtistButton", "myArtistsButton", "savedArtistCount", "myArtistsDialog", "closeMyArtistsButton", "myArtistsList", "collectionAnnouncement"];
    const elements = Object.fromEntries(ids.map(id => [id, element(id)]));
    elements.rollButton.disabled = true;
    elements.rollAgainButton.disabled = true;
    elements.saveArtistButton.disabled = true;
    elements.result.hidden = true;
    elements.loadingStatus.textContent = "Loading artist directory...";
    elements.genre.value = options.genre || "rnb";
    elements.tier.value = options.tier || "emerging";
    elements.spotifyLink.href = "#";
    elements.myArtistsDialog.showModal = function() { this.open = true; };
    elements.myArtistsDialog.close = function() { this.open = false; };
    elements.rollButton.click = function() { if (!this.disabled) elements.rollForm.dispatch("submit"); };
    elements.rollAgainButton.click = function() { if (!this.disabled) this.dispatch("click"); };
    const localStorage = {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); }
    };
    const context = vm.createContext({
        document: { getElementById(id) { return elements[id]; }, createElement(tag) { return element(tag); } },
        fetch: async () => ({ ok: options.fetchOk !== false, json: async () => payload }),
        alert(message) { alerts.push(message); },
        console: { error(...values) { errors.push(values); } },
        requestAnimationFrame(callback) { callback(); },
        window: { localStorage }, Math: Object.assign(Object.create(Math), { random: () => options.randomValue ?? 0 })
    });
    vm.runInContext(fs.readFileSync(path.join(root, "artist-model-adapter.js"), "utf8"), context, { filename: "artist-model-adapter.js" });
    vm.runInContext(fs.readFileSync(path.join(root, "my-artists-store.js"), "utf8"), context, { filename: "my-artists-store.js" });
    vm.runInContext(fs.readFileSync(path.join(root, "behavior-event-recorder.js"), "utf8"), context, { filename: "behavior-event-recorder.js" });
    vm.runInContext(fs.readFileSync(path.join(root, "script.js"), "utf8"), context, { filename: "script.js" });
    return { alerts, context, elements, errors, listeners };
}

test("live page normalizes all 41 artists and enables unchanged roll behavior", async () => {
    const live = JSON.parse(fs.readFileSync(path.join(root, "data", "artists.json"), "utf8"));
    const harness = livePageHarness(live, { genre: "dance", tier: "mainstream" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext("artists.length", harness.context), 41);
    assert.equal(harness.elements.rollButton.disabled, false);
    assert.equal(harness.elements.rollAgainButton.disabled, false);
    assert.equal(harness.elements.loadingStatus.hidden, false);
    assert.equal(harness.elements.loadingStatus.textContent, "The artist directory is ready. Make your picks and roll.");
    assert.equal(typeof harness.listeners.rollForm.submit, "function");
    harness.elements.rollButton.click();
    assert.equal(harness.elements.result.hidden, false);
    assert.equal(harness.elements.artistName.textContent, "Peggy Gou");
    assert.match(harness.elements.spotifyLink.href, /^https:\/\/open\.spotify\.com\/artist\//);
    assert.equal(vm.runInContext("currentArtist.musicRollId", harness.context), "mr_artist_000042");
    harness.elements.rollAgainButton.click();
    assert.equal(harness.elements.artistName.textContent, "Peggy Gou");
    assert.equal(harness.errors.length, 0);
    assert.ok(vm.runInContext("artists", harness.context).some(artist => artist.instagram === null && artist.tiktok === null));
});

test("live page logs directory failures while retaining the user-facing error", async () => {
    const harness = livePageHarness([], { fetchOk: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vm.runInContext("artists.length", harness.context), 0);
    assert.equal(harness.elements.rollButton.disabled, true);
    assert.equal(harness.elements.loadingStatus.textContent, "Music Roll could not load the artist directory. Please try again later.");
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0][0], /could not load/i);
});
