const { SOURCE_TYPES } = require("../ingestion/candidate-schema");
const { normalizeClassifications } = require("../ticketmaster-client");
const { normalizeDiscoveryOccurrence } = require("./discovery-schema");
const { advanceFixtureCheckpoint, createFixtureCheckpoint, validateFixtureCheckpoint } = require("./fixture-checkpoint");
const { defineDiscoverySourceAdapter } = require("./source-adapter");

const TICKETMASTER_FIXTURE_MODES = Object.freeze(["exact_attraction_seeds", "event_attractions"]);

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function optionalCoordinate(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function eventAttractionEntries(raw) {
    return (raw?._embedded?.events || []).flatMap((event, eventPosition) => {
        const attractions = event?._embedded?.attractions || [];
        return attractions.map((attraction, attractionPosition) => ({ event, eventPosition, attraction, attractionPosition }));
    });
}

function pageEntries(mode, raw) {
    return mode === "exact_attraction_seeds" ? (raw?.items || []) : eventAttractionEntries(raw);
}

function legacyAttractionIds(attraction, wrapper = {}) {
    const fromUrl = String(attraction?.url || "").match(/\/artist\/(\d+)(?:[/?#]|$)/)?.[1] || null;
    return [...new Set([wrapper.legacyAttractionId, attraction?.legacyAttractionId, fromUrl, ...(wrapper.legacyAttractionIds || [])].filter(Boolean).map(String))];
}

function createTicketmasterFixtureDiscoveryAdapter(options = {}) {
    const fixtures = options.fixtures || {};
    const clock = options.clock || (() => new Date().toISOString());
    let adapter;

    function fixtureFor(configuration) {
        const fixture = fixtures[configuration.fixtureKey];
        assert(fixture && Array.isArray(fixture.pages), `Ticketmaster discovery fixture is missing: ${configuration.fixtureKey}.`);
        return fixture;
    }

    function validateConfiguration(configuration) {
        assert(configuration && typeof configuration === "object", "Ticketmaster discovery configuration is required.");
        assert(TICKETMASTER_FIXTURE_MODES.includes(configuration.mode), "Ticketmaster discovery fixture mode is invalid.");
        assert(typeof configuration.fixtureKey === "string" && configuration.fixtureKey.trim(), "Ticketmaster discovery fixture key is required.");
        assert(SOURCE_TYPES.includes(configuration.sourceType), "Ticketmaster discovery source type is invalid.");
        assert(typeof configuration.sourceName === "string" && configuration.sourceName.trim(), "Ticketmaster discovery source name is required.");
        assert(configuration.allowNetwork !== true && configuration.networkAllowed !== true, "Ticketmaster Stage 2 discovery is fixture-only; network mode is unavailable.");
        const fixture = fixtureFor(configuration);
        assert(!fixture.mode || fixture.mode === configuration.mode, "Ticketmaster discovery fixture mode does not match the configuration.");
        return true;
    }

    async function acquirePage({ configuration, checkpoint, networkAllowed = false }) {
        validateConfiguration(configuration);
        if (networkAllowed) throw new Error("Ticketmaster Stage 2 discovery is fixture-only; network mode is unavailable.");
        const configurationHash = adapter.canonicalConfigurationHash(configuration);
        checkpoint ||= createFixtureCheckpoint(configurationHash);
        validateFixtureCheckpoint(checkpoint, configurationHash);
        const fixture = fixtureFor(configuration);
        if (checkpoint.exhausted) return { configurationHash, checkpoint, providerPage: checkpoint.providerPage, raw: null, rawEvidenceRef: null, itemCount: 0, hasNextPage: false, exhausted: true };
        const fixturePage = fixture.pages[checkpoint.providerPage];
        assert(fixturePage, `Ticketmaster fixture page ${checkpoint.providerPage} is missing before exhaustion.`);
        return {
            configurationHash,
            checkpoint,
            providerPage: checkpoint.providerPage,
            raw: structuredClone(fixturePage.raw),
            rawEvidenceRef: fixturePage.rawEvidenceRef,
            attractionEvidenceRefs: structuredClone(fixturePage.attractionEvidenceRefs || {}),
            exactIdentityBridgesByAttractionId: structuredClone(fixturePage.exactIdentityBridgesByAttractionId || {}),
            itemCount: pageEntries(configuration.mode, fixturePage.raw).length,
            hasNextPage: checkpoint.providerPage + 1 < fixture.pages.length,
            exhausted: false
        };
    }

    function occurrenceForAttraction({ attraction, wrapper = {}, configuration, page, sourceRecordId, sourceUrl, sourceContext }) {
        assert(attraction && typeof attraction.id === "string" && attraction.id.trim(), "Ticketmaster discovery fixture attraction ID is required.");
        assert(typeof attraction.name === "string" && attraction.name.trim(), "Ticketmaster discovery fixture attraction name is required.");
        const attractionEvidenceRef = wrapper.attractionEvidenceRef || page.attractionEvidenceRefs?.[attraction.id] || null;
        const bridges = wrapper.exactIdentityBridges || page.exactIdentityBridgesByAttractionId?.[attraction.id] || [];
        return normalizeDiscoveryOccurrence({
            provider: "ticketmaster",
            sourceType: configuration.sourceType,
            sourceName: configuration.sourceName,
            sourceRecordId,
            sourceUrl,
            rawArtistName: attraction.name,
            providerEntity: {
                type: "attraction",
                id: attraction.id,
                url: attraction.url || null,
                legacyIds: legacyAttractionIds(attraction, wrapper)
            },
            trustedIdentifiers: {},
            exactIdentityBridges: bridges,
            sourceContext: {
                ...sourceContext,
                discoveryAttractionId: attraction.id,
                legacyAttractionIds: legacyAttractionIds(attraction, wrapper),
                attractionUrl: attraction.url || null,
                classifications: normalizeClassifications(attraction.classifications),
                evidenceRefs: {
                    rawPage: page.rawEvidenceRef,
                    attraction: attractionEvidenceRef,
                    event: sourceContext.eventEvidenceRef || null
                },
                note: "Ticketmaster classifications are source evidence only and do not set Music Roll genre or stage."
            },
            rawEvidenceRef: sourceContext.eventEvidenceRef || attractionEvidenceRef || page.rawEvidenceRef,
            discoveredAt: wrapper.discoveredAt || configuration.discoveredAt || clock()
        });
    }

    function normalizePage(page, { configuration }) {
        validateConfiguration(configuration);
        if (page.exhausted) return [];
        if (configuration.mode === "exact_attraction_seeds") {
            return pageEntries(configuration.mode, page.raw).map((wrapper, seedPosition) => {
                const attraction = wrapper.attraction || wrapper;
                return occurrenceForAttraction({
                    attraction,
                    wrapper,
                    configuration,
                    page,
                    sourceRecordId: wrapper.sourceRecordId || `seed:${attraction.id}`,
                    sourceUrl: attraction.url || null,
                    sourceContext: {
                        mode: configuration.mode,
                        seedPosition,
                        lookupMethod: wrapper.lookupMethod || "exact_fixture_seed",
                        eventEvidenceRef: null
                    }
                });
            });
        }
        return pageEntries(configuration.mode, page.raw).map(entry => {
            const event = entry.event;
            const attraction = entry.attraction;
            const venue = event?._embedded?.venues?.[0] || null;
            return occurrenceForAttraction({
                attraction,
                wrapper: {},
                configuration,
                page,
                sourceRecordId: `${event.id}/attraction/${attraction.id}`,
                sourceUrl: event.url || attraction.url || null,
                sourceContext: {
                    mode: configuration.mode,
                    eventId: event.id,
                    eventName: event.name || null,
                    eventDateTime: {
                        localDate: event.dates?.start?.localDate || null,
                        localTime: event.dates?.start?.localTime || null,
                        utcDateTime: event.dates?.start?.dateTime || null
                    },
                    eventClassifications: normalizeClassifications(event.classifications),
                    eventPosition: entry.eventPosition,
                    attractionPosition: entry.attractionPosition,
                    venue: {
                        id: venue?.id || null,
                        name: venue?.name || null,
                        city: venue?.city?.name || null,
                        region: venue?.state?.stateCode || venue?.state?.name || null,
                        country: venue?.country?.countryCode || venue?.country?.name || null,
                        latitude: optionalCoordinate(venue?.location?.latitude),
                        longitude: optionalCoordinate(venue?.location?.longitude)
                    },
                    eventEvidenceRef: page.rawEvidenceRef
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
        adapterId: "ticketmaster_fixture_discovery_v1",
        provider: "ticketmaster",
        adapterVersion: "v1",
        validateConfiguration,
        acquirePage,
        normalizePage,
        nextCheckpoint
    });
    return adapter;
}

module.exports = { TICKETMASTER_FIXTURE_MODES, createTicketmasterFixtureDiscoveryAdapter, eventAttractionEntries, pageEntries };
