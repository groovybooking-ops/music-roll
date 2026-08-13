const fs = require("fs/promises");
const path = require("path");
const { buildSnapshot, parseAndValidateCsv } = require("../lib/mainstream-reference-import");

function parseArguments(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
        const key = argument.slice(2);
        const value = argv[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
        values[key] = value;
        index += 1;
    }
    const required = ["input", "publisher", "ranking-name", "ranking-type", "territory", "source-url", "license-notes"];
    const missing = required.filter(key => !values[key]);
    if (missing.length) throw new Error(`Missing required options: ${missing.map(key => `--${key}`).join(", ")}`);
    return values;
}

async function writeExclusive(filename, contents) {
    await fs.writeFile(filename, contents, { flag: "wx" });
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const projectRoot = path.join(__dirname, "..");
    const inputPath = path.resolve(args.input);
    const inputBuffer = await fs.readFile(inputPath);
    const parsed = parseAndValidateCsv(inputBuffer.toString("utf8"), {
        rank: args["rank-column"],
        artist: args["artist-column"],
        value: args["value-column"]
    });
    const snapshot = buildSnapshot({
        inputPath,
        inputBuffer,
        parsed,
        metadata: {
            publisher: args.publisher,
            rankingName: args["ranking-name"],
            rankingType: args["ranking-type"],
            territory: args.territory,
            retrievedAt: args["retrieved-at"] || new Date().toISOString(),
            sourceUrl: args["source-url"],
            methodologyUrl: args["methodology-url"],
            licenseNotes: args["license-notes"]
        }
    });
    const rawDirectory = path.join(projectRoot, "data", "mainstream-reference", "raw");
    const snapshotDirectory = path.join(projectRoot, "data", "mainstream-reference", "snapshots");
    await fs.mkdir(rawDirectory, { recursive: true });
    await fs.mkdir(snapshotDirectory, { recursive: true });
    const rawPath = path.join(rawDirectory, snapshot.rawFilename);
    const previewPath = path.join(snapshotDirectory, snapshot.previewFilename);

    await writeExclusive(rawPath, inputBuffer);
    try {
        await writeExclusive(previewPath, JSON.stringify(snapshot.document, null, 2) + "\n");
    } catch (error) {
        await fs.unlink(rawPath);
        throw error;
    }
    console.log(`Imported 200 ranked artists.`);
    console.log(`Raw CSV: ${path.relative(projectRoot, rawPath)}`);
    console.log(`Preview: ${path.relative(projectRoot, previewPath)}`);
    console.log(`SHA-256: ${snapshot.document.source.rawSha256}`);
}

main().catch(error => {
    console.error("Mainstream reference import stopped: " + error.message);
    process.exitCode = 1;
});
