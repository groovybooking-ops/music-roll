class DiscogsApiError extends Error {
    constructor(message, statusCode = null, cause = null) {
        super(message, cause ? { cause } : undefined);
        this.name = "DiscogsApiError";
        this.statusCode = statusCode;
    }
}

function validateArtistId(artistId) {
    const value = String(artistId ?? "");
    if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Discogs artist ID must be a positive integer.");
    return value;
}

function normalizeArtist(raw, requestedId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Discogs returned a malformed artist response.");
    if (String(raw.id ?? "") !== requestedId) throw new Error("Discogs returned an unexpected artist ID.");
    if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error("Discogs artist response is missing a name.");
    return {
        discogsArtistId: requestedId,
        name: raw.name,
        realName: typeof raw.realname === "string" && raw.realname.trim() ? raw.realname : null,
        profile: typeof raw.profile === "string" && raw.profile.trim() ? raw.profile : null,
        artistUrls: Array.isArray(raw.urls) ? raw.urls.filter(url => typeof url === "string" && url.trim()) : [],
        aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(item => item && typeof item.name === "string").map(item => ({
            discogsArtistId: item.id == null ? null : String(item.id),
            name: item.name
        })) : [],
        nameVariations: Array.isArray(raw.namevariations) ? raw.namevariations.filter(name => typeof name === "string" && name.trim()) : [],
        discogsResourceUrl: typeof raw.resource_url === "string" ? raw.resource_url : `https://api.discogs.com/artists/${requestedId}`,
        discogsWebUrl: typeof raw.uri === "string" ? raw.uri : `https://www.discogs.com/artist/${requestedId}`,
        dataQuality: typeof raw.data_quality === "string" ? raw.data_quality : null
    };
}

async function getDiscogsArtist(artistId, options = {}) {
    const id = validateArtistId(artistId);
    const fetchImpl = options.fetchImpl || fetch;
    const headers = {
        Accept: "application/vnd.discogs.v2.discogs+json",
        "User-Agent": options.userAgent || "MusicRollIdentityLesson/1.0"
    };
    const token = options.token || process.env.DISCOGS_TOKEN;
    if (token) headers.Authorization = `Discogs token=${token}`;
    let response;
    try {
        response = await fetchImpl(`https://api.discogs.com/artists/${id}`, { headers });
    } catch (error) {
        throw new DiscogsApiError("Discogs artist request failed before receiving a response.", null, error);
    }
    if (response.status === 404) throw new DiscogsApiError(`Discogs artist ${id} was not found.`, 404);
    if (!response.ok) throw new DiscogsApiError(`Discogs artist request failed with status ${response.status}.`, response.status);
    let raw;
    try {
        raw = await response.json();
    } catch (error) {
        throw new DiscogsApiError("Discogs returned invalid JSON.", response.status, error);
    }
    return { artist: normalizeArtist(raw, id), raw, authenticationUsed: Boolean(token) };
}

module.exports = { DiscogsApiError, getDiscogsArtist, normalizeArtist, validateArtistId };
