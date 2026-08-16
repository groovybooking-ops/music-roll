const path = require("path");
const dotenv = require("dotenv");
const { loadSchedulerConfiguration, NETWORK_JOBS, redact, runUnattendedJob } = require("../lib/scheduling/unattended-scheduler");

function parseArguments(argv) {
    const result = { allowNetwork: false, configuration: null, job: null };
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === "--allow-network") result.allowNetwork = true;
        else if (value === "--configuration") result.configuration = argv[++index];
        else if (value === "--job") result.job = argv[++index];
        else throw new Error(`Unknown unattended scheduler argument: ${value}`);
    }
    return result;
}

async function main() {
    const args = parseArguments(process.argv.slice(2));
    const projectRoot = path.join(__dirname, "..");
    const configurationFile = path.resolve(projectRoot, args.configuration || "config/scheduled-ingestion.macos.json");
    const configuration = await loadSchedulerConfiguration(configurationFile);
    if (NETWORK_JOBS.has(args.job) && !args.allowNetwork) throw new Error(`Unattended ${args.job} requires --allow-network.`);
    dotenv.config({ path: configuration.environmentFile, quiet: true });
    const result = await runUnattendedJob(configuration, args.job, { allowNetwork: args.allowNetwork, environment: process.env });
    console.log(`${new Date().toISOString()} job=${args.job} status=${result.status} runId=${result.runId || "none"}`);
}

if (require.main === module) main().catch(error => {
    const safe = redact({ name: error.name, message: error.message });
    console.error(`${new Date().toISOString()} unattended_ingestion_failed ${safe.name}: ${safe.message}`);
    process.exitCode = 1;
});

module.exports = { main, parseArguments };
