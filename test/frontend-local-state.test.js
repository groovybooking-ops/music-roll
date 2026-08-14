const test = require("node:test");
const assert = require("node:assert/strict");
const { createMyArtistsStore } = require("../my-artists-store");
const { createEventRecorder } = require("../behavior-event-recorder");

class MemoryStorage {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial));
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.values.set(key, String(value));
    }
}

const firstId = "mr_artist_000001";
const secondId = "mr_artist_000002";

test("saves an artist and prevents duplicate IDs", () => {
    const storage = new MemoryStorage();
    const store = createMyArtistsStore(storage);
    assert.equal(store.add(firstId), true);
    assert.equal(store.add(firstId), true);
    assert.deepEqual(store.getIds(), [firstId]);
});

test("removes a saved artist", () => {
    const storage = new MemoryStorage();
    const store = createMyArtistsStore(storage);
    store.add(firstId);
    store.add(secondId);
    assert.equal(store.remove(firstId), true);
    assert.deepEqual(store.getIds(), [secondId]);
});

test("saved IDs persist when the store is recreated after a reload", () => {
    const storage = new MemoryStorage();
    createMyArtistsStore(storage).add(firstId);
    const reloadedStore = createMyArtistsStore(storage);
    assert.equal(reloadedStore.has(firstId), true);
    assert.equal(reloadedStore.getIds().length, 1);
});

test("empty and corrupt My Artists storage recover as an empty collection", () => {
    const empty = createMyArtistsStore(new MemoryStorage());
    assert.deepEqual(empty.getIds(), []);
    const corrupt = createMyArtistsStore(new MemoryStorage({ "musicRoll.myArtists.v1": "{broken" }));
    assert.deepEqual(corrupt.getIds(), []);
    assert.equal(corrupt.add(firstId), true);
    assert.deepEqual(corrupt.getIds(), [firstId]);
});

test("missing or malformed musicRollId values fail closed", () => {
    const store = createMyArtistsStore(new MemoryStorage());
    assert.equal(store.add(undefined), false);
    assert.equal(store.add("SZA"), false);
    assert.equal(store.add("mr_artist_1"), false);
    assert.deepEqual(store.getIds(), []);
});

test("saved count is derived from the unique persisted ID collection", () => {
    const store = createMyArtistsStore(new MemoryStorage());
    store.add(firstId);
    store.add(firstId);
    store.add(secondId);
    assert.equal(store.getIds().length, 2);
});

test("records only structural behavioral event information", () => {
    const storage = new MemoryStorage();
    const recorder = createEventRecorder(storage, { now: () => "2026-08-14T12:00:00.000Z" });
    const event = recorder.record("artist_saved", {
        musicRollId: firstId,
        genreFilter: "rnb",
        tierFilter: "emerging",
        ignored: "not persisted"
    });
    assert.deepEqual(event, {
        type: "artist_saved",
        musicRollId: firstId,
        timestamp: "2026-08-14T12:00:00.000Z",
        genreFilter: "rnb",
        tierFilter: "emerging"
    });
    assert.deepEqual(recorder.getEvents(), [event]);
});

test("event corruption or storage failures never throw", () => {
    const corrupt = new MemoryStorage({ "musicRoll.behaviorEvents.v1": "not-json" });
    const recorder = createEventRecorder(corrupt, { now: () => "now" });
    assert.doesNotThrow(() => recorder.record("artist_impression", { musicRollId: firstId }));
    assert.equal(recorder.getEvents().length, 1);

    const blockedStorage = {
        getItem() { throw new Error("blocked"); },
        setItem() { throw new Error("blocked"); }
    };
    const blocked = createEventRecorder(blockedStorage);
    assert.doesNotThrow(() => blocked.record("spotify_clicked", { musicRollId: firstId }));
    assert.equal(blocked.record("spotify_clicked", { musicRollId: firstId }), null);
});

test("events with missing IDs or unknown types are ignored", () => {
    const recorder = createEventRecorder(new MemoryStorage());
    assert.equal(recorder.record("artist_saved", {}), null);
    assert.equal(recorder.record("made_up_event", { musicRollId: firstId }), null);
    assert.deepEqual(recorder.getEvents(), []);
});
