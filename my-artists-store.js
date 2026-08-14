(function(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.MusicRollMyArtists = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";

    const DEFAULT_STORAGE_KEY = "musicRoll.myArtists.v1";
    const MUSIC_ROLL_ID_PATTERN = /^mr_artist_\d{6}$/;

    function isValidMusicRollId(value) {
        return typeof value === "string" && MUSIC_ROLL_ID_PATTERN.test(value);
    }

    function createMyArtistsStore(storage, storageKey = DEFAULT_STORAGE_KEY) {
        function readIds() {
            try {
                const parsed = JSON.parse(storage.getItem(storageKey) || "[]");
                if (!Array.isArray(parsed)) return [];
                return [...new Set(parsed.filter(isValidMusicRollId))];
            } catch (error) {
                return [];
            }
        }

        function writeIds(ids) {
            try {
                storage.setItem(storageKey, JSON.stringify(ids));
                return true;
            } catch (error) {
                return false;
            }
        }

        function add(musicRollId) {
            if (!isValidMusicRollId(musicRollId)) return false;
            const ids = readIds();
            if (ids.includes(musicRollId)) return true;
            return writeIds([...ids, musicRollId]);
        }

        function remove(musicRollId) {
            if (!isValidMusicRollId(musicRollId)) return false;
            const ids = readIds();
            if (!ids.includes(musicRollId)) return true;
            return writeIds(ids.filter(id => id !== musicRollId));
        }

        return {
            add,
            getIds: readIds,
            has: musicRollId => isValidMusicRollId(musicRollId) && readIds().includes(musicRollId),
            remove
        };
    }

    return { DEFAULT_STORAGE_KEY, createMyArtistsStore, isValidMusicRollId };
});
