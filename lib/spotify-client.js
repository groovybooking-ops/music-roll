let cachedAccessToken = "";
let tokenExpiresAt = 0;

class SpotifyApiError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.name = "SpotifyApiError";
        this.statusCode = statusCode;
    }
}

function normalizeArtistName(name) {
    return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function formatArtist(artist) {
    return {
        name: artist.name,
        id: artist.id,
        spotifyUrl: artist.external_urls.spotify,
        imageUrl: artist.images?.[0]?.url || ""
    };
}

function rankPossibleMatches(artists, requestedName) {
    const normalizedRequest = normalizeArtistName(requestedName);

    return artists
        .map(function(artist, spotifyPosition) {
            const normalizedName = normalizeArtistName(artist.name);
            let nameScore = 3;

            if (normalizedName.startsWith(normalizedRequest)) {
                nameScore = 1;
            } else if (normalizedName.includes(normalizedRequest)) {
                nameScore = 2;
            }

            return { artist, nameScore, spotifyPosition };
        })
        .sort(function(first, second) {
            return first.nameScore - second.nameScore ||
                first.spotifyPosition - second.spotifyPosition;
        })
        .map(function(match) {
            return match.artist;
        });
}

async function getSpotifyAccessToken() {
    if (cachedAccessToken && Date.now() < tokenExpiresAt) {
        return cachedAccessToken;
    }

    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new SpotifyApiError(
            "Missing Spotify credentials. Add them to your local .env file."
        );
    }

    const basicCredentials = Buffer.from(
        clientId + ":" + clientSecret
    ).toString("base64");
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: "Basic " + basicCredentials,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ grant_type: "client_credentials" })
    });
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
        throw new SpotifyApiError(
            "Spotify rejected the Client ID or Client Secret.",
            401
        );
    }

    cachedAccessToken = tokenData.access_token;
    tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

    return cachedAccessToken;
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function searchArtistsByName(artistName, options = {}) {
    const accessToken = await getSpotifyAccessToken();
    const searchParameters = new URLSearchParams({
        q: artistName,
        type: "artist",
        limit: "10",
        market: "US"
    });
    const fetchImpl = options.fetchImpl || fetch;
    const waitImpl = options.waitImpl || wait;
    const maxRetries = options.maxRetries ?? 3;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const spotifyResponse = await fetchImpl(
            "https://api.spotify.com/v1/search?" + searchParameters,
            { headers: { Authorization: "Bearer " + accessToken } }
        );
        const spotifyData = await spotifyResponse.json();
        if (spotifyResponse.ok) {
            return (spotifyData.artists?.items || []).map(formatArtist);
        }
        if (spotifyResponse.status === 429 && attempt < maxRetries) {
            const retrySeconds = Number(spotifyResponse.headers.get("retry-after")) || 1;
            await waitImpl(retrySeconds * 1000);
            continue;
        }
        const error = new SpotifyApiError(
            spotifyData.error?.message || "Spotify could not complete the artist search.",
            spotifyResponse.status
        );
        error.reason = spotifyData.error?.reason || null;
        throw error;
    }
}

async function searchArtistCandidatesByName(artistName, options = {}) {
    const artists = await searchArtistsByName(artistName, options);
    const normalizedRequest = normalizeArtistName(artistName);
    return {
        exactMatches: artists.filter(artist => normalizeArtistName(artist.name) === normalizedRequest),
        possibleMatches: rankPossibleMatches(artists, artistName)
    };
}

async function searchArtistByExactName(artistName) {
    const result = await searchArtistCandidatesByName(artistName);
    const exactMatch = result.exactMatches[0] || null;

    return {
        exactMatch,
        possibleMatches: exactMatch
            ? []
            : result.possibleMatches
    };
}

module.exports = {
    SpotifyApiError,
    getSpotifyAccessToken,
    normalizeArtistName,
    searchArtistCandidatesByName,
    searchArtistByExactName
};
