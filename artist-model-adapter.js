(function(root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.MusicRollArtistModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function() {
    "use strict";

    const genres = new Set(["rnb", "hiphop", "pop", "rock", "dance"]);
    const v1Tiers = new Set(["local", "underground", "emerging", "mainstream", "legacy", "classic"]);
    const v2Stages = new Set(["underground", "emerging", "mainstream", "legacy", "classic"]);
    const coreFields = ["name", "genre", "tier", "spotifyId", "spotify", "image"];

    function requiredString(value, label) {
        if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
        return value;
    }

    function socialValue(value, label) {
        if (value == null) return null;
        if (typeof value !== "string") throw new Error(`${label} must be a string or null.`);
        return value;
    }

    function assertAllowed(value, allowed, label) {
        if (!allowed.has(value)) throw new Error(`Invalid ${label}: ${value}.`);
    }

    function assertLegacyAgreement(record, field, canonical) {
        if (Object.prototype.hasOwnProperty.call(record, field) && record[field] !== canonical) {
            throw new Error(`Artist v2 compatibility drift: ${field} does not agree with its canonical field.`);
        }
    }

    function adaptV1(record) {
        if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Artist record must be an object.");
        for (const field of coreFields) requiredString(record[field], `Artist v1 ${field}`);
        assertAllowed(record.genre, genres, "artist genre");
        assertAllowed(record.tier, v1Tiers, "artist tier");
        return {
            name: record.name,
            genre: record.genre,
            tier: record.tier,
            spotifyId: record.spotifyId,
            spotify: record.spotify,
            image: record.image,
            instagram: socialValue(record.instagram, "Artist v1 instagram"),
            tiktok: socialValue(record.tiktok, "Artist v1 tiktok")
        };
    }

    function adaptV2(record) {
        requiredString(record.name, "Artist v2 name");
        const genre = requiredString(record.primaryGenre, "Artist v2 primaryGenre");
        const tier = requiredString(record.editorial?.stage, "Artist v2 editorial.stage");
        assertAllowed(genre, genres, "artist primaryGenre");
        assertAllowed(tier, v2Stages, "artist stage");
        if (!Array.isArray(record.genres) || !record.genres.length || record.genres.some(item => typeof item !== "string" || !genres.has(item))) {
            throw new Error("Artist v2 genres must be a non-empty array of allowed genres.");
        }
        if (record.genres[0] !== genre || !record.genres.includes(genre)) throw new Error("Artist v2 primaryGenre must be the first genres entry.");
        const spotifyId = requiredString(record.externalIds?.spotify, "Artist v2 externalIds.spotify");
        const spotify = requiredString(record.externalUrls?.spotify, "Artist v2 externalUrls.spotify");
        const image = requiredString(record.media?.primaryImageUrl, "Artist v2 media.primaryImageUrl");
        const instagram = socialValue(record.socialUrls?.instagram, "Artist v2 socialUrls.instagram");
        const tiktok = socialValue(record.socialUrls?.tiktok, "Artist v2 socialUrls.tiktok");
        for (const [field, canonical] of Object.entries({ genre, tier, spotifyId, spotify, image, instagram, tiktok })) {
            assertLegacyAgreement(record, field, canonical);
        }
        return { name: record.name, genre, tier, spotifyId, spotify, image, instagram, tiktok };
    }

    function adaptArtist(record) {
        return record?.schemaVersion === 2 ? adaptV2(record) : adaptV1(record);
    }

    function adaptArtistDirectory(records) {
        if (!Array.isArray(records) || !records.length) throw new Error("Artist directory must be a non-empty array.");
        return records.map(adaptArtist);
    }

    return { adaptArtist, adaptArtistDirectory };
});
