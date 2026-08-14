class TicketmasterApiError extends Error {
    constructor(message, statusCode = null, cause = null) {
        super(message, cause ? { cause } : undefined);
        this.name = "TicketmasterApiError";
        this.statusCode = statusCode;
    }
}

function validateAttractionId(value) {
    const id = String(value ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Ticketmaster attraction ID is invalid.");
    return id;
}

function imageUrl(images) {
    const valid = (images || []).filter(image => typeof image?.url === "string" && image.url.trim());
    valid.sort((left, right) => Number(right.ratio === "16_9") - Number(left.ratio === "16_9") || (Number(right.width) || 0) - (Number(left.width) || 0));
    return valid[0]?.url || null;
}

function classificationPart(value) {
    return value && (value.id || value.name) ? { id: value.id || null, name: value.name || null } : null;
}

function normalizeClassifications(classifications) {
    return (classifications || []).filter(item => item && typeof item === "object").map(item => ({
        primary: item.primary === true,
        segment: classificationPart(item.segment),
        genre: classificationPart(item.genre),
        subGenre: classificationPart(item.subGenre),
        type: classificationPart(item.type),
        subType: classificationPart(item.subType)
    }));
}

function upcomingEventCount(raw) {
    if (Number.isFinite(raw?.upcomingEvents?._total)) return raw.upcomingEvents._total;
    if (Number.isFinite(raw?.upcomingEvents?.ticketmaster)) return raw.upcomingEvents.ticketmaster;
    return null;
}

function normalizeAttraction(raw, requestedId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Ticketmaster returned a malformed attraction response.");
    if (String(raw.id || "") !== requestedId) throw new Error("Ticketmaster returned an unexpected attraction ID.");
    if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("Ticketmaster attraction response is missing a name.");
    return {
        attractionId: requestedId,
        name: raw.name,
        attractionUrl: typeof raw.url === "string" && raw.url.trim() ? raw.url : null,
        imageUrl: imageUrl(raw.images),
        classifications: normalizeClassifications(raw.classifications),
        upcomingEventCount: upcomingEventCount(raw)
    };
}

function finiteCoordinate(value) {
    if (value == null || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeEvent(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.name !== "string") throw new Error("Ticketmaster returned a malformed event response.");
    const venue = raw._embedded?.venues?.[0] || null;
    return {
        eventId: raw.id,
        name: raw.name,
        dateTime: {
            localDate: raw.dates?.start?.localDate || null,
            localTime: raw.dates?.start?.localTime || null,
            utcDateTime: raw.dates?.start?.dateTime || null
        },
        venue: venue?.name || null,
        city: venue?.city?.name || null,
        region: venue?.state?.stateCode || venue?.state?.name || null,
        country: venue?.country?.countryCode || venue?.country?.name || null,
        latitude: finiteCoordinate(venue?.location?.latitude),
        longitude: finiteCoordinate(venue?.location?.longitude),
        ticketUrl: typeof raw.url === "string" && raw.url.trim() ? raw.url : null
    };
}

function errorMessage(body, fallback) {
    return body?.fault?.faultstring || body?.errors?.[0]?.detail || body?.errors?.[0]?.title || fallback;
}

function wait(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

async function requestJson(pathname, parameters, options = {}) {
    const apiKey = options.apiKey !== undefined ? options.apiKey : process.env.TICKETMASTER_API_KEY;
    if (!apiKey) throw new TicketmasterApiError("Missing Ticketmaster API key. Add TICKETMASTER_API_KEY to .env.");
    const fetchImpl = options.fetchImpl || fetch;
    const waitImpl = options.waitImpl || wait;
    const maxRetries = options.maxRetries ?? 2;
    const query = new URLSearchParams({ ...parameters, apikey: apiKey });
    const url = `https://app.ticketmaster.com/discovery/v2/${pathname}?${query}`;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response;
        try { response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": options.userAgent || "MusicRollTicketmasterReview/1.0" } }); }
        catch (error) {
            if (attempt < maxRetries) { await waitImpl(500 * (2 ** attempt)); continue; }
            throw new TicketmasterApiError("Ticketmaster request failed before receiving a response.", null, error);
        }
        let body = null;
        try { body = await response.json(); } catch (error) {
            if (response.ok) throw new TicketmasterApiError("Ticketmaster returned invalid JSON.", response.status, error);
        }
        if (response.ok) return body;
        if ([429, 500, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
            const retryAfter = Number(response.headers?.get?.("retry-after"));
            await waitImpl(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * (2 ** attempt));
            continue;
        }
        throw new TicketmasterApiError(errorMessage(body, `Ticketmaster request failed with status ${response.status}.`), response.status);
    }
}

async function getTicketmasterAttraction(attractionId, options = {}) {
    const id = validateAttractionId(attractionId);
    const parameters = options.locale ? { locale: options.locale } : {};
    try {
        const raw = await requestJson(`attractions/${encodeURIComponent(id)}.json`, parameters, options);
        return { attraction: normalizeAttraction(raw, id), raw, lookupMethod: "exact_attraction_path", requestedAttractionId: id, discoveryAttractionId: id, legacyAttractionId: null };
    } catch (error) {
        if (!(error instanceof TicketmasterApiError) || error.statusCode !== 404) throw error;
        const raw = await requestJson("attractions.json", { id, ...parameters, size: "2" }, options);
        const attractions = raw?._embedded?.attractions || [];
        const exact = attractions.filter(attraction => String(attraction?.id || "") === id);
        if (exact.length === 1) return { attraction: normalizeAttraction(exact[0], id), raw, lookupMethod: "exact_id_filter", requestedAttractionId: id, discoveryAttractionId: id, legacyAttractionId: null };
        if (!/^\d+$/.test(id)) throw new TicketmasterApiError(`Ticketmaster has no unique attraction for exact ID ${id}.`, exact.length ? 409 : 404);
        const pageFetchImpl = options.pageFetchImpl || fetch;
        let pageResponse;
        try { pageResponse = await pageFetchImpl(`https://www.ticketmaster.com/artist/${encodeURIComponent(id)}`, { headers: { Accept: "text/html", "User-Agent": options.userAgent || "MusicRollTicketmasterReview/1.0" } }); }
        catch (pageError) { throw new TicketmasterApiError("Ticketmaster legacy attraction page lookup failed before receiving a response.", null, pageError); }
        if (!pageResponse.ok) throw new TicketmasterApiError(`Ticketmaster legacy attraction page failed with status ${pageResponse.status}.`, pageResponse.status);
        const html = await pageResponse.text();
        const universalIds = [...new Set(html.match(/K8vZ[A-Za-z0-9]+/g) || [])];
        if (universalIds.length !== 1) throw new TicketmasterApiError(`Ticketmaster legacy ID ${id} did not expose one unique Discovery attraction ID.`, universalIds.length ? 409 : 404);
        const discoveryId = validateAttractionId(universalIds[0]);
        const discoveryRaw = await requestJson(`attractions/${encodeURIComponent(discoveryId)}.json`, parameters, options);
        const legacyFromUrl = String(discoveryRaw?.url || "").match(/\/artist\/(\d+)(?:[/?#]|$)/)?.[1] || null;
        if (legacyFromUrl !== id) throw new TicketmasterApiError(`Ticketmaster Discovery attraction ${discoveryId} did not link back to legacy ID ${id}.`, 409);
        return { attraction: normalizeAttraction(discoveryRaw, discoveryId), raw: discoveryRaw, bridgeRaw: { legacyPageUrl: pageResponse.url || `https://www.ticketmaster.com/artist/${id}`, exactDiscoveryIds: universalIds }, lookupMethod: "exact_legacy_page_bridge", requestedAttractionId: id, discoveryAttractionId: discoveryId, legacyAttractionId: id };
    }
}

async function getUpcomingEventsForAttraction(attractionId, options = {}) {
    const id = validateAttractionId(attractionId);
    const size = options.size ?? 3;
    if (!Number.isInteger(size) || size < 1 || size > 10) throw new Error("Ticketmaster event sample size must be an integer from 1 to 10.");
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    if (Number.isNaN(now.getTime())) throw new Error("Ticketmaster event lookup requires a valid current date.");
    const startDateTime = now.toISOString().replace(/\.\d{3}Z$/, "Z");
    const parameters = { attractionId: id, size: String(size), sort: "date,asc", startDateTime };
    if (options.locale) parameters.locale = options.locale;
    const raw = await requestJson("events.json", parameters, options);
    const events = (raw?._embedded?.events || []).map(normalizeEvent);
    return { attractionId: id, totalUpcomingEvents: Number.isFinite(raw?.page?.totalElements) ? raw.page.totalElements : null, sampleSize: events.length, events, raw };
}

module.exports = { TicketmasterApiError, getTicketmasterAttraction, getUpcomingEventsForAttraction, normalizeAttraction, normalizeClassifications, normalizeEvent, validateAttractionId };
