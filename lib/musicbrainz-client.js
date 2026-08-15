class MusicBrainzApiError extends Error {
    constructor(message, statusCode = null, cause = null) {
        super(message, cause ? { cause } : undefined);
        this.name = "MusicBrainzApiError";
        this.statusCode = statusCode;
    }
}

const MBID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateMbid(mbid) {
    const value = String(mbid ?? "").trim().toLowerCase();
    if (!MBID_PATTERN.test(value)) throw new Error("MusicBrainz artist ID must be a valid MBID UUID.");
    return value;
}

function normalizeArea(area) {
    if (!area || typeof area !== "object") return null;
    return {
        id: typeof area.id === "string" ? area.id : null,
        name: typeof area.name === "string" ? area.name : null,
        sortName: typeof area["sort-name"] === "string" ? area["sort-name"] : null,
        type: typeof area.type === "string" ? area.type : null
    };
}

function normalizeArtist(raw, requestedMbid) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("MusicBrainz returned a malformed artist response.");
    if (String(raw.id || "").toLowerCase() !== requestedMbid) throw new Error("MusicBrainz returned an unexpected artist MBID.");
    if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("MusicBrainz artist response is missing a name.");
    return {
        musicBrainzArtistId: requestedMbid,
        name: raw.name,
        sortName: typeof raw["sort-name"] === "string" ? raw["sort-name"] : null,
        artistType: typeof raw.type === "string" ? raw.type : null,
        disambiguation: typeof raw.disambiguation === "string" && raw.disambiguation.trim() ? raw.disambiguation : null,
        country: typeof raw.country === "string" ? raw.country : null,
        area: normalizeArea(raw.area),
        beginArea: normalizeArea(raw["begin-area"]),
        lifeSpan: {
            begin: typeof raw["life-span"]?.begin === "string" ? raw["life-span"].begin : null,
            end: typeof raw["life-span"]?.end === "string" ? raw["life-span"].end : null,
            ended: typeof raw["life-span"]?.ended === "boolean" ? raw["life-span"].ended : null
        },
        aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(alias => alias && typeof alias.name === "string").map(alias => ({
            name: alias.name,
            sortName: typeof alias["sort-name"] === "string" ? alias["sort-name"] : null,
            type: typeof alias.type === "string" ? alias.type : null,
            locale: typeof alias.locale === "string" ? alias.locale : null,
            primary: alias.primary === true
        })) : [],
        isni: Array.isArray(raw.isnis) ? raw.isnis.filter(value => typeof value === "string" && value.trim()) : [],
        externalUrls: Array.isArray(raw.relations) ? raw.relations.filter(relation => relation?.url?.resource).map(relation => ({
            relationshipType: typeof relation.type === "string" ? relation.type : null,
            url: relation.url.resource
        })) : []
    };
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getMusicBrainzArtist(mbid, options = {}) {
    const id = validateMbid(mbid);
    const fetchImpl = options.fetchImpl || fetch;
    const waitImpl = options.waitImpl || wait;
    const maxRetries = options.maxRetries ?? 2;
    const url = `https://musicbrainz.org/ws/2/artist/${id}?inc=aliases+url-rels&fmt=json`;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response;
        try {
            response = await fetchImpl(url, {
                headers: {
                    Accept: "application/json",
                    "User-Agent": options.userAgent || "MusicRollIdentityLesson/1.0 (https://github.com/music-roll)"
                }
            });
        } catch (error) {
            throw new MusicBrainzApiError("MusicBrainz artist request failed before receiving a response.", null, error);
        }
        if (response.status === 503 && attempt < maxRetries) {
            const retrySeconds = Number(response.headers?.get?.("retry-after")) || (attempt + 1);
            await waitImpl(Math.max(1000, retrySeconds * 1000));
            continue;
        }
        if (response.status === 404) throw new MusicBrainzApiError(`MusicBrainz artist ${id} was not found.`, 404);
        if (!response.ok) throw new MusicBrainzApiError(`MusicBrainz artist request failed with status ${response.status}.`, response.status);
        let raw;
        try {
            raw = await response.json();
        } catch (error) {
            throw new MusicBrainzApiError("MusicBrainz returned invalid JSON.", response.status, error);
        }
        return { artist: normalizeArtist(raw, id), raw };
    }
}

async function getMusicBrainzArtistResolution(mbid, options = {}) {
    const requestedMbid = validateMbid(mbid);
    const fetchImpl = options.fetchImpl || fetch;
    let response;
    try {
        response = await fetchImpl(`https://musicbrainz.org/ws/2/artist/${requestedMbid}?inc=aliases+url-rels&fmt=json`, { headers: { Accept: "application/json", "User-Agent": options.userAgent || "MusicRollIdentityLesson/1.0 (https://github.com/music-roll)" } });
    } catch (error) { throw new MusicBrainzApiError("MusicBrainz artist-resolution request failed before receiving a response.", null, error); }
    if (!response.ok) throw new MusicBrainzApiError(`MusicBrainz artist-resolution request failed with status ${response.status}.`, response.status);
    const raw = await response.json();
    const resolvedMbid = validateMbid(raw?.id);
    return { state: resolvedMbid === requestedMbid ? "active" : "redirected", requestedMbid, resolvedMbid, artist: normalizeArtist(raw, resolvedMbid), raw, redirectLocation: response.headers?.get?.("location") || response.url || null };
}

function normalizeName(value) {
    return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function validateSpotifyArtistUrl(value) {
    const url = String(value || "").trim();
    if (!/^https:\/\/open\.spotify\.com\/artist\/[A-Za-z0-9]{22}$/.test(url)) throw new Error("An exact Spotify artist URL is required.");
    return url;
}

function validateExactProviderUrl(value) {
    const resource = String(value || "").trim();
    let parsed;
    try { parsed = new URL(resource); } catch (error) { throw new Error("An exact HTTPS provider URL is required."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("An exact HTTPS provider URL is required.");
    return resource;
}

function normalizeExactUrlArtists(raw) {
    const relations = Array.isArray(raw?.relations) ? raw.relations : [];
    const candidates = relations.filter(relation => relation?.["target-type"] === "artist" && relation.artist?.id).map(relation => ({
        musicBrainzArtistId: validateMbid(relation.artist.id),
        name: typeof relation.artist.name === "string" ? relation.artist.name : null,
        sortName: typeof relation.artist["sort-name"] === "string" ? relation.artist["sort-name"] : null,
        artistType: typeof relation.artist.type === "string" ? relation.artist.type : null,
        disambiguation: typeof relation.artist.disambiguation === "string" && relation.artist.disambiguation.trim() ? relation.artist.disambiguation : null,
        relationshipType: typeof relation.type === "string" ? relation.type : null,
        relationshipDirection: typeof relation.direction === "string" ? relation.direction : null
    }));
    return [...new Map(candidates.map(candidate => [candidate.musicBrainzArtistId, candidate])).values()];
}

async function lookupMusicBrainzArtistsByExactUrl(providerUrl, options = {}) {
    const resource = validateExactProviderUrl(providerUrl);
    const fetchImpl = options.fetchImpl || fetch;
    const waitImpl = options.waitImpl || wait;
    const maxRetries = options.maxRetries ?? 2;
    const url = "https://musicbrainz.org/ws/2/url?" + new URLSearchParams({ resource, inc: "artist-rels", fmt: "json" });
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        let response;
        try {
            response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": options.userAgent || "MusicRollIdentityLesson/1.0 (https://github.com/music-roll)" } });
        } catch (error) {
            throw new MusicBrainzApiError("MusicBrainz exact URL request failed before receiving a response.", null, error);
        }
        if (response.status === 503 && attempt < maxRetries) {
            const retrySeconds = Number(response.headers?.get?.("retry-after")) || (attempt + 1);
            await waitImpl(Math.max(1000, retrySeconds * 1000));
            continue;
        }
        if (response.status === 404) return { resource, exactUrlFound: false, candidates: [], raw: null };
        if (!response.ok) throw new MusicBrainzApiError(`MusicBrainz exact URL request failed with status ${response.status}.`, response.status);
        let raw;
        try { raw = await response.json(); } catch (error) {
            throw new MusicBrainzApiError("MusicBrainz exact URL lookup returned invalid JSON.", response.status, error);
        }
        const candidates = normalizeExactUrlArtists(raw);
        return { resource, exactUrlFound: true, candidates, raw };
    }
}

async function lookupMusicBrainzArtistsByExactSpotifyUrl(spotifyArtistUrl, options = {}) {
    const resource = validateSpotifyArtistUrl(spotifyArtistUrl);
    const result = await lookupMusicBrainzArtistsByExactUrl(resource, options);
    return { spotifyArtistUrl: resource, exactUrlFound: result.exactUrlFound, candidates: result.candidates, raw: result.raw };
}

async function searchMusicBrainzArtistsByExactName(name, options = {}) {
    const requestedName = String(name || "").trim();
    if (!requestedName) throw new Error("MusicBrainz artist name is required.");
    const fetchImpl = options.fetchImpl || fetch;
    const query = `artist:\"${requestedName.replace(/["\\]/g, "\\$&")}\"`;
    const url = "https://musicbrainz.org/ws/2/artist?" + new URLSearchParams({ query, fmt: "json", limit: String(options.limit || 25) });
    let response;
    try {
        response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": options.userAgent || "MusicRollIdentityLesson/1.0 (https://github.com/music-roll)" } });
    } catch (error) {
        throw new MusicBrainzApiError("MusicBrainz artist-name audit request failed before receiving a response.", null, error);
    }
    if (!response.ok) throw new MusicBrainzApiError(`MusicBrainz artist-name audit failed with status ${response.status}.`, response.status);
    const raw = await response.json();
    if (!Array.isArray(raw.artists)) throw new Error("MusicBrainz returned a malformed artist search response.");
    const exactMatches = raw.artists.filter(artist => normalizeName(artist.name) === normalizeName(requestedName)).map(artist => ({
        musicBrainzArtistId: artist.id,
        name: artist.name,
        sortName: artist["sort-name"] || null,
        artistType: artist.type || null,
        country: artist.country || null,
        disambiguation: artist.disambiguation || null,
        score: Number.isFinite(artist.score) ? artist.score : null
    }));
    return { requestedName, exactMatches, raw };
}

module.exports = { MusicBrainzApiError, getMusicBrainzArtist, getMusicBrainzArtistResolution, lookupMusicBrainzArtistsByExactSpotifyUrl, lookupMusicBrainzArtistsByExactUrl, normalizeArtist, normalizeExactUrlArtists, searchMusicBrainzArtistsByExactName, validateExactProviderUrl, validateMbid, validateSpotifyArtistUrl };
