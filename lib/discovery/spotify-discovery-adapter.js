const { SOURCE_TYPES, SPOTIFY_ID_PATTERN } = require("../ingestion/candidate-schema");
const { normalizeDiscoveryOccurrence } = require("./discovery-schema");
const { advanceFixtureCheckpoint, createFixtureCheckpoint, validateFixtureCheckpoint } = require("./fixture-checkpoint");
const { defineDiscoverySourceAdapter } = require("./source-adapter");

const SPOTIFY_FIXTURE_MODES = Object.freeze([
    "exact_artist_seeds",
    "artist_search_results",
    "album_artist_relationships"
]);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function artistUrl(id) {
    return `https://open.spotify.com/artist/${id}`;
}

function artistFromEntry(entry) {
    return entry?.artist || entry;
}

function pageEntries(mode, raw) {
    if (mode === "exact_artist_seeds") return raw?.items || raw?.artists || [];
    if (mode === "artist_search_results") return raw?.artists?.items || [];
    if (mode === "album_artist_relationships") {
        return (raw?.items || []).flatMap((album, albumIndex) => (album?.artists || []).map((artist, artistPosition) => ({ album, albumIndex, artist, artistPosition })));
    }
    return [];
}

function validateArtist(artist) {
    assert(artist && SPOTIFY_ID_PATTERN.test(artist.id || ""), "Spotify discovery fixture artist ID is invalid.");
    assert(typeof artist.name === "string" && artist.name.trim(), "Spotify discovery fixture artist name is required.");
}

function createSpotifyFixtureDiscoveryAdapter(options = {}) {
    const fixtures = options.fixtures || {};
    const clock = options.clock || (() => new Date().toISOString());
    let adapter;

    function fixtureFor(configuration) {
        const fixture = fixtures[configuration.fixtureKey];
        assert(fixture && Array.isArray(fixture.pages), `Spotify discovery fixture is missing: ${configuration.fixtureKey}.`);
        return fixture;
    }

    function validateConfiguration(configuration) {
        assert(configuration && typeof configuration === "object", "Spotify discovery configuration is required.");
        assert(SPOTIFY_FIXTURE_MODES.includes(configuration.mode), "Spotify discovery fixture mode is invalid.");
        assert(typeof configuration.fixtureKey === "string" && configuration.fixtureKey.trim(), "Spotify discovery fixture key is required.");
        assert(SOURCE_TYPES.includes(configuration.sourceType), "Spotify discovery source type is invalid.");
        assert(typeof configuration.sourceName === "string" && configuration.sourceName.trim(), "Spotify discovery source name is required.");
        assert(configuration.allowNetwork !== true && configuration.networkAllowed !== true, "Spotify Stage 2 discovery is fixture-only; network mode is unavailable.");
        const fixture = fixtureFor(configuration);
        assert(!fixture.mode || fixture.mode === configuration.mode, "Spotify discovery fixture mode does not match the configuration.");
        return true;
    }

    async function acquirePage({ configuration, checkpoint, networkAllowed = false }) {
        validateConfiguration(configuration);
        if (networkAllowed) throw new Error("Spotify Stage 2 discovery is fixture-only; network mode is unavailable.");
        const configurationHash = adapter.canonicalConfigurationHash(configuration);
        checkpoint ||= createFixtureCheckpoint(configurationHash);
        validateFixtureCheckpoint(checkpoint, configurationHash);
        const fixture = fixtureFor(configuration);
        if (checkpoint.exhausted) return { configurationHash, checkpoint, providerPage: checkpoint.providerPage, raw: null, rawEvidenceRef: null, itemCount: 0, hasNextPage: false, exhausted: true };
        const page = fixture.pages[checkpoint.providerPage];
        assert(page, `Spotify fixture page ${checkpoint.providerPage} is missing before exhaustion.`);
        const entries = pageEntries(configuration.mode, page.raw);
        return {
            configurationHash,
            checkpoint,
            providerPage: checkpoint.providerPage,
            raw: structuredClone(page.raw),
            rawEvidenceRef: page.rawEvidenceRef,
            itemCount: entries.length,
            hasNextPage: checkpoint.providerPage + 1 < fixture.pages.length,
            exhausted: false
        };
    }

    function normalizePage(page, { configuration }) {
        validateConfiguration(configuration);
        if (page.exhausted) return [];
        const discoveredAt = configuration.discoveredAt || clock();
        const common = entry => ({
            provider: "spotify",
            sourceType: configuration.sourceType,
            sourceName: configuration.sourceName,
            rawEvidenceRef: page.rawEvidenceRef,
            discoveredAt: entry.discoveredAt || discoveredAt
        });
        if (configuration.mode === "exact_artist_seeds") {
            return pageEntries(configuration.mode, page.raw).map((entry, position) => {
                const artist = artistFromEntry(entry);
                validateArtist(artist);
                return normalizeDiscoveryOccurrence({
                    ...common(entry),
                    sourceRecordId: entry.sourceRecordId || `seed:${artist.id}`,
                    sourceUrl: artistUrl(artist.id),
                    rawArtistName: artist.name,
                    providerEntity: { type: "artist", id: artist.id, url: artistUrl(artist.id) },
                    trustedIdentifiers: { spotifyArtistId: artist.id, spotifyArtistUrl: artistUrl(artist.id) },
                    sourceContext: { mode: configuration.mode, seedPosition: position },
                    exactIdentityBridges: entry.exactIdentityBridges || []
                });
            });
        }
        if (configuration.mode === "artist_search_results") {
            const query = String(page.raw?.query || configuration.query || "");
            return pageEntries(configuration.mode, page.raw).map((artist, index) => {
                validateArtist(artist);
                const resultPosition = Number(page.raw?.artists?.offset || 0) + index;
                return normalizeDiscoveryOccurrence({
                    ...common(artist),
                    sourceRecordId: `${page.raw?.queryRecordId || query}:result:${resultPosition}:${artist.id}`,
                    sourceUrl: artistUrl(artist.id),
                    rawArtistName: artist.name,
                    providerEntity: { type: "artist", id: artist.id, url: artistUrl(artist.id) },
                    trustedIdentifiers: { spotifyArtistId: artist.id, spotifyArtistUrl: artistUrl(artist.id) },
                    sourceContext: {
                        mode: configuration.mode,
                        query,
                        resultPosition,
                        note: "Spotify exposed this provider entity for the configured query; this is not proof of the query author's intended identity."
                    }
                });
            });
        }
        return pageEntries(configuration.mode, page.raw).map(entry => {
            const artist = entry.artist;
            const album = entry.album;
            validateArtist(artist);
            assert(album && typeof album.id === "string" && album.id.trim(), "Spotify album relationship fixture requires an album ID.");
            return normalizeDiscoveryOccurrence({
                ...common(entry),
                sourceRecordId: `album:${album.id}:artist:${entry.artistPosition}:${artist.id}`,
                sourceUrl: artistUrl(artist.id),
                rawArtistName: artist.name,
                providerEntity: { type: "artist", id: artist.id, url: artistUrl(artist.id) },
                trustedIdentifiers: { spotifyArtistId: artist.id, spotifyArtistUrl: artistUrl(artist.id) },
                sourceContext: {
                    mode: configuration.mode,
                    albumId: album.id,
                    albumName: album.name || null,
                    albumPosition: entry.albumIndex,
                    artistPosition: entry.artistPosition,
                    relationshipType: "album_artist"
                }
            });
        });
    }

    function nextCheckpoint({ configuration, checkpoint, page, consumedItems }) {
        validateConfiguration(configuration);
        return advanceFixtureCheckpoint({
            checkpoint,
            configurationHash: adapter.canonicalConfigurationHash(configuration),
            pageItemCount: page.itemCount,
            consumedItems,
            hasNextPage: page.hasNextPage
        });
    }

    adapter = defineDiscoverySourceAdapter({
        adapterId: "spotify_fixture_discovery_v1",
        provider: "spotify",
        adapterVersion: "v1",
        validateConfiguration,
        acquirePage,
        normalizePage,
        nextCheckpoint
    });
    return adapter;
}

module.exports = { SPOTIFY_FIXTURE_MODES, createSpotifyFixtureDiscoveryAdapter, pageEntries };
