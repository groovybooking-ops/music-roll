# Music Roll unattended ingestion on macOS

This layer schedules review-only discovery and identity analysis. It never approves candidates, reserves Music Roll IDs, migrates artists, or writes `data/artists.json` or `data/artist-id-registry.json`.

## Proposed local schedule

- Ticketmaster discovery: daily at 02:10.
- Spotify discovery: Tuesday and Friday at 03:05.
- Queue identity workers and daily summary: daily at 04:15.
- Weekly human-review summary: Monday at 08:30.

Times are local macOS calendar times and are configured in `config/scheduled-ingestion.macos.json`. launchd may defer a job while the Mac is asleep or powered off; this layer does not force wake or change system security.

## Controls

Generate and validate definitions without installing them:

```sh
npm run ingestion:scheduler:generate
npm run ingestion:status
```

Pause or resume unattended network acquisition:

```sh
npm run ingestion:pause
npm run ingestion:resume
```

Weekly and status summaries remain available while paused. A shared exclusive lock prevents overlapping discovery or worker invocations. Locked and paused invocations are recorded as skips and do not change candidate states.

## Installation commands requiring separate approval

The generated files are copied into the per-user LaunchAgents directory, then bootstrapped into the current graphical user session:

```sh
mkdir -p /Users/groovymac/music-roll/data/ingestion/scheduled/v1/scheduler/logs/launchd
cp /Users/groovymac/music-roll/config/launchd/generated/com.musicroll.ingestion.*.plist /Users/groovymac/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.spotify-discovery.plist
launchctl bootstrap gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.ticketmaster-discovery.plist
launchctl bootstrap gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.daily-processing.plist
launchctl bootstrap gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.weekly-review.plist
```

No installation command above is executed during implementation.

To completely unload and disable the jobs:

```sh
launchctl bootout gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.spotify-discovery.plist
launchctl bootout gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.ticketmaster-discovery.plist
launchctl bootout gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.daily-processing.plist
launchctl bootout gui/$(id -u) /Users/groovymac/Library/LaunchAgents/com.musicroll.ingestion.weekly-review.plist
```

The plist files contain absolute executable and repository paths, but no credentials. Runtime scripts load the protected `/Users/groovymac/music-roll/.env` file directly. Structured scheduler logs are stored under `data/ingestion/scheduled/v1/scheduler/logs`, rotate at 1 MiB, retain five prior files, and redact credential-shaped fields and URL parameters.
