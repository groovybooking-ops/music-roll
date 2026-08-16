const path = require("path");
const {
    generateLaunchdDefinitions,
    loadSchedulerConfiguration,
    pauseScheduler,
    resumeScheduler,
    schedulerStatus
} = require("../lib/scheduling/unattended-scheduler");

function parseArguments(argv) {
    const result = { command: argv[0] || null, configuration: null, reason: "manual_pause" };
    for (let index = 1; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === "--configuration") result.configuration = argv[++index];
        else if (value === "--reason") result.reason = argv[++index];
        else throw new Error(`Unknown scheduler-management argument: ${value}`);
    }
    return result;
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const projectRoot = path.join(__dirname, "..");
    const configurationFile = path.resolve(projectRoot, args.configuration || "config/scheduled-ingestion.macos.json");
    const configuration = await loadSchedulerConfiguration(configurationFile);
    let result;
    if (args.command === "generate") result = { generated: await generateLaunchdDefinitions(configuration), installed: false, loaded: false };
    else if (args.command === "pause") result = await pauseScheduler(configuration, args.reason);
    else if (args.command === "resume") result = await resumeScheduler(configuration);
    else if (args.command === "status") result = await schedulerStatus(configuration);
    else throw new Error("Scheduler command must be generate, pause, resume, or status.");
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
module.exports = { main, parseArguments };
