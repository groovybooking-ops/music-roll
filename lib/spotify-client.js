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

async function searchArtistsByName(artistName) {
    const accessToken = await getSpotifyAccessToken();
    const searchParameters = new URLSearchParams({
        q: artistName,
        type: "artist",
        limit: "10",
        market: "US"
    });
    const spotifyResponse = await fetch(
        "https://api.spotify.com/v1/search?" + searchParameters,
        { headers: { Authorization: "Bearer " + accessToken } }
    );
    const spotifyData = await spotifyResponse.json();

    if (!spotifyResponse.ok) {
        const statusCode = spotifyResponse.status === 429 ? 429 : 502;
        throw new SpotifyApiError(
            "Spotify could not complete the artist search.",
            statusCode
        );
    }

    return (spotifyData.artists?.items || []).map(formatArtist);
}

async function searchArtistByExactName(artistName) {
    const artists = await searchArtistsByName(artistName);
    const normalizedRequest = normalizeArtistName(artistName);
    const exactMatch = artists.find(function(artist) {
        return normalizeArtistName(artist.name) === normalizedRequest;
    });

    return {
        exactMatch: exactMatch || null,
        possibleMatches: exactMatch
            ? []
            : rankPossibleMatches(artists, artistName)
    };
}

module.exports = {
    SpotifyApiError,
    normalizeArtistName,
    searchArtistByExactName
};
