const fs = require("fs/promises");
const https = require("https");
const path = require("path");
const { buildKworbSnapshot, parseKworbHtml } = require("../lib/kworb-mainstream-reference");

const SOURCE_URL = "https://kworb.net/spotify/listeners.html";

function retrieve(url, redirects = 0) {
    if (redirects > 3) return Promise.reject(new Error("Too many redirects from Kworb."));
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: { "User-Agent": "MusicRollReferenceImporter/1.0 (single snapshot request)" },
            timeout: 15000
        }, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                response.resume();
                resolve(retrieve(new URL(response.headers.location, url), redirects + 1));
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Kworb returned HTTP ${response.statusCode}.`));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on("data", chunk => {
                size += chunk.length;
                if (size > 5 * 1024 * 1024) request.destroy(new Error("Kworb response exceeded the 5 MB safety limit."));
                else chunks.push(chunk);
            });
            response.on("end", () => resolve(Buffer.concat(chunks)));
        });
        request.on("timeout", () => request.destroy(new Error("Kworb request timed out.")));
        request.on("error", reject);
    });
}

async function writeExclusive(filename, contents) {
    await fs.writeFile(filename, contents, { flag: "wx" });
}

async function main() {
    const root = path.join(__dirname, "..");
    const rawDirectory = path.join(root, "data", "mainstream-reference", "raw");
    const snapshotDirectory = path.join(root, "data", "mainstream-reference", "snapshots");
    const htmlBuffer = await retrieve(SOURCE_URL);
    const retrievedAt = new Date().toISOString();
    const records = parseKworbHtml(htmlBuffer.toString("utf8"));
    const musicRollArtists = JSON.parse(await fs.readFile(path.join(root, "data", "artists.json"), "utf8"));
    const snapshot = buildKworbSnapshot({ htmlBuffer, records, retrievedAt, musicRollArtists });
    await fs.mkdir(rawDirectory, { recursive: true });
    await fs.mkdir(snapshotDirectory, { recursive: true });
    const rawPath = path.join(rawDirectory, snapshot.rawFilename);
    const previewPath = path.join(snapshotDirectory, snapshot.previewFilename);
    await writeExclusive(rawPath, htmlBuffer);
    try {
        await writeExclusive(previewPath, JSON.stringify(snapshot.document, null, 2) + "\n");
    } catch (error) {
        await fs.unlink(rawPath);
        throw error;
    }
    console.log(`Imported ${records.length} Kworb records.`);
    console.log(`Raw snapshot: ${path.relative(root, rawPath)}`);
    console.log(`Review preview: ${path.relative(root, previewPath)}`);
}

main().catch(error => {
    console.error("Kworb import stopped: " + error.message);
    process.exitCode = 1;
});
