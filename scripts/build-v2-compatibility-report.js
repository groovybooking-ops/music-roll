const fs = require("fs/promises");
const path = require("path");
const { compare } = require("../experiments/v2-compatibility/parity-harness.js");

const root = path.join(__dirname, "..");
const outputPath = path.join(root, "data", "artists-v2.compatibility-report.json");

async function main() {
    const live = JSON.parse(await fs.readFile(path.join(root, "data", "artists.json"), "utf8"));
    const preview = JSON.parse(await fs.readFile(path.join(root, "data", "artists-v2.preview.json"), "utf8"));
    const parity = compare(live, preview);
    if (!parity.directoriesIdentical || parity.mismatches.length) throw new Error("V1/v2 effective behavior differs.");
    const report = {
        experiment: "artist-v2-browser-compatibility",
        generatedAt: new Date().toISOString(),
        reviewOnly: true,
        liveDirectoryChanged: false,
        recommendationBehaviorChanged: false,
        parity
    };
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(`Compatibility report written: ${path.relative(root, outputPath)}`);
}

main().catch(error => {
    console.error("V2 compatibility report stopped: " + error.message);
    process.exitCode = 1;
});
