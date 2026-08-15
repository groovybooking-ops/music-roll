const fs = require("fs/promises");
const path = require("path");
const dotenv = require("dotenv");
const { LiveScheduledCoordinator } = require("../lib/scheduling/live-scheduled-coordinator");

function parseArguments(argv) { const result = { allowNetwork: false }; for (let i = 0; i < argv.length; i += 1) { const value = argv[i]; if (value === "--allow-network") result.allowNetwork = true; else if (value === "--run-id") result.runId = argv[++i]; else if (value === "--scheduled-root") result.scheduledRoot = argv[++i]; else if (value === "--configuration") result.configuration = argv[++i]; else throw new Error(`Unknown argument: ${value}`); } return result; }

async function main() {
    const args = parseArguments(process.argv.slice(2));
    if (!args.allowNetwork) throw new Error("Refusing live scheduled ingestion without --allow-network.");
    const projectRoot = path.join(__dirname, ".."); dotenv.config({ path: path.join(projectRoot, ".env"), quiet: true });
    const scheduledRoot = path.resolve(projectRoot, args.scheduledRoot || "data/ingestion/scheduled/v1");
    const configurationFile = path.resolve(projectRoot, args.configuration || "data/ingestion/scheduled/v1/configurations/first-human-live-v1.json");
    const configuration = JSON.parse(await fs.readFile(configurationFile, "utf8"));
    const coordinator = new LiveScheduledCoordinator({ projectRoot, scheduledRoot, configuration, allowNetwork: true, environment: process.env });
    const result = await coordinator.run({ runId: args.runId || null });
    console.log(JSON.stringify({ runId: result.manifest.runId, resumed: result.resumed, phasesExecuted: result.phasesExecuted, report: result.report }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { parseArguments };
