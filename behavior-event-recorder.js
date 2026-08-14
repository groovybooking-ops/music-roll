(function(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.MusicRollBehaviorEvents = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";

    const DEFAULT_STORAGE_KEY = "musicRoll.behaviorEvents.v1";
    const allowedEventTypes = new Set([
        "artist_impression",
        "artist_saved",
        "artist_unsaved",
        "spotify_clicked",
        "roll_again",
        "artist_skipped"
    ]);

    function createEventRecorder(storage, options = {}) {
        const storageKey = options.storageKey || DEFAULT_STORAGE_KEY;
        const now = options.now || (() => new Date().toISOString());

        function readEvents() {
            try {
                const parsed = JSON.parse(storage.getItem(storageKey) || "[]");
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                return [];
            }
        }

        function record(type, details = {}) {
            try {
                if (!allowedEventTypes.has(type)) return null;
                if (!/^mr_artist_\d{6}$/.test(details.musicRollId || "")) return null;
                const event = {
                    type,
                    musicRollId: details.musicRollId,
                    timestamp: now(),
                    genreFilter: details.genreFilter || null,
                    tierFilter: details.tierFilter || null
                };
                storage.setItem(storageKey, JSON.stringify([...readEvents(), event]));
                return event;
            } catch (error) {
                return null;
            }
        }

        return { getEvents: readEvents, record };
    }

    return { DEFAULT_STORAGE_KEY, createEventRecorder };
});
