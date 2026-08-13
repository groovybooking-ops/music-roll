const { SpotifyApiError } = require("./spotify-client");

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function fetchJsonWithRetry(url, options = {}) {
    const fetchImpl = options.fetchImpl || fetch;
    const maxRetries = options.maxRetries ?? 3;
    const waitImpl = options.waitImpl || wait;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const response = await fetchImpl(url, { headers: options.headers });
        if (response.ok) return response.json();
        if (response.status === 429 && attempt < maxRetries) {
            const seconds = Number(response.headers.get("retry-after")) || 1;
            await waitImpl(seconds * 1000);
            continue;
        }
        throw new SpotifyApiError(
            `Spotify catalog request failed with status ${response.status}.`,
            response.status
        );
    }
}

async function fetchArtistAlbumsPaginated(artistId, accessToken, options = {}) {
    const market = options.market || "US";
    const limit = Math.min(options.limit || 10, 10);
    const baseUrl = options.baseUrl || "https://api.spotify.com/v1";
    let url = `${baseUrl}/artists/${encodeURIComponent(artistId)}/albums?` +
        new URLSearchParams({ include_groups: "album,single", market, limit: String(limit), offset: "0" });
    const items = [];
    let pageCount = 0;
    while (url) {
        const page = await fetchJsonWithRetry(url, {
            fetchImpl: options.fetchImpl,
            waitImpl: options.waitImpl,
            maxRetries: options.maxRetries,
            headers: { Authorization: `Bearer ${accessToken}` }
        });
        items.push(...(page.items || []));
        pageCount += 1;
        url = page.next || null;
    }
    return { items, pageCount, paginationComplete: true, market };
}

module.exports = { fetchArtistAlbumsPaginated, fetchJsonWithRetry };
