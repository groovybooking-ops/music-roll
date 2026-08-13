const fs = require("fs/promises");
const path = require("path");

async function readFixtureJson(fixtureRoot, provider, filename) {
    if (!new Set(["spotify", "musicbrainz"]).has(provider)) throw new Error("Unsupported fixture provider.");
    const root = path.resolve(fixtureRoot);
    const target = path.resolve(root, provider, filename);
    if (!target.startsWith(root + path.sep)) throw new Error("Fixture path escapes its root.");
    return JSON.parse(await fs.readFile(target, "utf8"));
}

async function fetchMusicBrainzJsonWithRetry(url, options = {}) {
    const fetchImpl = options.fetchImpl;
    if (typeof fetchImpl !== "function") throw new Error("A fixture fetch implementation is required; live requests are disabled.");
    const waitImpl = options.waitImpl || (() => Promise.resolve());
    const maxRetries = options.maxRetries ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const response = await fetchImpl(url, {
            headers: { "User-Agent": options.userAgent || "MusicRollFixtureTests/1.0" }
        });
        if (response.ok) return response.json();
        if (response.status === 503 && attempt < maxRetries) {
            await waitImpl(1000 * (attempt + 1));
            continue;
        }
        throw new Error(`MusicBrainz fixture request failed with status ${response.status}.`);
    }
}

module.exports = { fetchMusicBrainzJsonWithRetry, readFixtureJson };
