export const HELP = `smop — download, trim and manage Smolish videos

Usage:
  smop <URL or file> [options]          Download with VEO, trim and upload
  smop upload <URL or file> [options]   Explicit form of the same command
  smush <URL or file> [options]         Built-in command alias

Account and videos:
  smop setup                           Save a website cookie locally
  smop whoami                          Check the signed-in account
  smop list [private|public|unlisted]   List your videos, views, likes and comments
  smop info <video-id>                  Show video details
  smop analytics [video-id] --days 28   Account or video analytics
  smop edit <video-id> [options]        Change title, description or visibility
  smop resume <job-id> [options]        Continue an existing upload
  smop jobs [job-id]                    Local upload history (alias: history)
  smop storage [file]                  Account storage and daily upload allowance
  smop storage --bytes <number>        Check a proposed size without uploading
  smop doctor [--online]               Check local setup and optionally sign-in
  smop doctor fix                     Repair VEO and media backend installation
  smop version                        Check installed and latest npm versions
  smop update [--check]                Install an update or check without changes

Configuration:
  smop config show|path|edit|check|reset
  smop config set <setting> <value>     Save a default setting
  smop config unset <setting>          Restore its built-in default
  smop preset list|show <name>          Inspect presets
  smop preset add <name> [options]      Create a preset
  smop preset use <name>|reset          Select or clear the default preset
  smop preset remove <name>            Remove a preset
  smop alias list|add <name>|remove <name>

Folder watchdogs:
  smop watchdog add <name> <folder> [upload options]
  smop watchdog list|show <name>|status [name|all]
  smop watchdog start [name|all]        Watch in the foreground; Ctrl+C stops
  smop watchdog stop [name|all]         Request a stop from another terminal
  smop watchdog retry <name> [file]     Retry blocked files using saved jobs
  smop watchdog remove <name>          Remove a stopped watchdog

Upload options:
  --visibility <value>                 private (default), public or unlisted
  -r, --rename <title>                 Video title (default: one space)
  -d, --description <text>             Override the draft description
  -p, --preset <name>                  Apply a preset; "none" skips the active one
  --start <seconds>                    Start position (default: 0)
  --duration <seconds>                 Maximum clip length, up to 60 (default: 60)
  -q, --quality <resolution>           VEO quality: best, 1080p, 720p, ...
  -o, --output <directory>             Keep a local copy of the prepared video
  --split                             Split long sources into multiple clips
  --no-split                          Override a preset or default that splits
  --split-threshold <seconds>          Split remaining source at this length (90)
  --part-label prefix|suffix|none      Automatic "Part N" title label (prefix)
  --dry-run                           Download and prepare without uploading
  --try-anyway                        Explicitly attempt after a failed quota check

Title variables:
  {filename} {folder} {part} {parts} {global} {index}
  Example: -r "{filename} Part {part} of {parts}" --split

Watchdog add options:
  --recursive --existing --interval <seconds> --stable <seconds>
  Existing files are skipped by default; polling is 5s, stability delay is 10s.

List options:
  --limit <1-50> --page <number> --all
  --sort date|views|likes|comments --order asc|desc --status <state>

Output:
  --json                              JSON results; watchdog start streams NDJSON
  --color                             Force colors, including redirected output
  --no-color                          Disable colors; NO_COLOR is also respected
  -h, --help                          Show command help
  -v, --version                       Show version

Defaults < active/selected preset < explicit flags. New uploads are Private.
Storage checks use account values. Smolish enforces limits even with --try-anyway.
The original file is preserved. Progress goes to stderr; results go to stdout.
`;

export const COMMAND_HELP = {
  setup: `smop setup [--no-color]

Enter your Smolish website Cookie header in the hidden local prompt.
The cookie is never accepted as a command-line argument or printed in output.
Windows stores it with DPAPI encryption for the current user. On other systems,
the local credential file is restricted to the current user.
Setup verifies your session before saving credentials. --json cannot show a prompt.
`,
  whoami: `smop whoami [--json]

Verify the current Smolish session and show your account identity.
Credentials come from the saved cookie, SMOP_COOKIE, or SMOP_COOKIE_FILE.
`,
  info: `smop info <video-id> [--json]

Show the selected video's title, visibility, status, views, likes and comments.
Video IDs are strings and must be passed exactly as returned by Smolish.
`,
  analytics: `smop analytics [video-id] [--days 7|28|90] [--json]

Show account analytics, or analytics for one video when its ID is supplied.
The default reporting period is 28 days. --json returns machine-readable data.
`,
  jobs: `smop jobs [job-id] [--limit NUMBER] [--json]

List local upload jobs, or inspect one job and its saved settings.
New job IDs use six characters. Existing jobs keep their saved IDs.
Use smop resume <job-id> to continue a prepared or interrupted upload.
"history" is a command synonym.
`,
  doctor: `smop doctor [--online] [--json]
smop doctor fix [--online] [--json]
smop doctorfix [--online] [--json]

Check Node.js, VEO, yt-dlp, FFmpeg and account credential setup.
--online also verifies the Smolish session. Repair downloads missing VEO media
backends and rechecks them; no account credentials are changed.
`,
  version: `smop version [--json]
smop --version

The version command checks the installed version against the official npm registry.
--version prints only the locally installed version and makes no network request.
Before the first npm publication, the online result reports the package unpublished.
`,
  update: `smop update [--check] [--json]

--check compares installed and latest npm versions without making changes.
Update installs the exact latest published version for a global npm installation.
Source checkouts and npm links receive the installation command to run instead.
Account settings, cookies, watchdogs and upload jobs are kept outside the package.
`,
  config: `smop config show [--preset NAME] [--json]
smop config set <setting> <value> [--json]
smop config unset <setting> [--json]
smop config path|edit|check|reset [--json]

Settings: visibility, rename, description, start, duration, quality, output, color,
split, splitThreshold, partLabel.
Example: smop config set visibility private
Example: smop config set color false
Example: smop config set split true
Example: smop config set splitThreshold 90
Config is local and separate from the encrypted account cookie.
`,
  preset: `smop preset list [--json]
smop preset show <name> [--json]
smop preset add <name> [--visibility VALUE] [-r TITLE] [-q QUALITY] [--duration SECONDS]
smop preset use <name> | smop preset reset
smop preset remove <name>

Example: smop preset add shorts --visibility public --duration 30 -q 720p
Example: smop preset add series --split -r "{filename} Part {part} of {parts}"
Example: smop "https://example.com/video" --preset shorts -r "A short clip"
`,
  alias: `smop alias list [--json]
smop alias add <name> [--bin-dir PATH] [--json]
smop alias remove <name> [--bin-dir PATH] [--json]

Custom commands forward all arguments to smop. Existing commands are never
overwritten. Only wrappers created by smop can be removed.
Example: smop alias add smap
`,
  list: `smop list [private|public|unlisted] [--json]
smop list --all --sort views --order desc
smop list private --page 2 --limit 30

Lists videos from your Smolish account, including uploads made outside smop.
JSON includes full IDs, titles, visibility, status, views, likes and comments.
Missing metrics are null; --all fetches pages sequentially.
`,
  resume: `smop resume <job-id> [--visibility VALUE] [-r TITLE] [-d DESCRIPTION] [--json]

Uses the saved video's metadata. Current defaults do not overwrite an existing
job. Explicit metadata flags or a selected preset can change unfinished jobs.
Split batch jobs resume pending clips and keep completed clips without reuploading.
Storage is checked for pending clips that do not already have a remote draft.
Use --try-anyway to explicitly attempt when the account check cannot approve it.
`,
  edit: `smop edit <video-id> [--visibility VALUE] [-r TITLE] [-d DESCRIPTION] [--json]

Changes only the explicitly supplied metadata and confirms the server result.
Example: smop edit 12345678901234567 --visibility public -r "My video"
`,
  storage: `smop storage [--json]
smop storage <file> [--json]
smop storage --bytes <number> [--json]

Reads the signed-in account's tier, storage used/available and daily allowance
from https://smolish.com/storage/apply. "limits" is a command synonym.
The file form checks its current file size; prepared clips may have another size.
Uploads check the combined prepared size before creating new remote drafts.
When quota is exceeded or cannot be verified, an interactive upload asks [y/N].
JSON, redirected input and watchdogs never prompt; use --try-anyway explicitly.
An attempt uses the normal upload API, which still enforces the site's limits.
`,
  watchdog: `smop watchdog add <name> <folder> [upload options] [--recursive] [--existing]
smop watchdog add <folder> [--name NAME] [upload options]
smop watchdog list [--json]
smop watchdog show <name> [--json]
smop watchdog status [name|all] [--json]
smop watchdog start [name|all] [--try-anyway] [--json]
smop watchdog stop [name|all] [--json]
smop watchdog retry <name> [file] [--json]
smop watchdog remove <name> [--json]

Add saves the resolved upload settings and preset. Existing files are skipped
unless --existing is supplied. --recursive includes subfolders. --interval sets
polling seconds (default: 5); --stable waits for unchanged files (default: 10).
Start runs in the foreground. Ctrl+C interrupts it; stop requests an orderly stop
from another terminal. No background service or login task is installed.
Uploads are sequential. The persistent journal keeps counters, job IDs and file
hashes across restarts. Blocked files need explicit retry and retain saved jobs.
Watchdogs never show quota prompts. --try-anyway is an explicit attempt only.

Title variables: {filename}, {folder}, {part}, {parts}, {global}, {index}.
Counters are durable reserved clip numbers and may have gaps after failures.
Example: smop watchdog add clips "C:\\Videos\\Inbox" --split -r "{filename} Part {part}"
Example: smop watchdog start clips --json
With --json, start writes one event per stdout line and a final result (NDJSON).
Other commands write one JSON result. "watch" is a command synonym.
`,
  upload: `smop <URL or file> [options]
smop upload <URL or file> [options]

Private by default; title defaults to one ordinary space; clips are at most 60s.
--split is off by default. With --split, remaining sources at least 90s long
become consecutive clips; --duration sets each clip length (up to 60s).
--start chooses the first source position. --split-threshold changes the trigger.
Below that trigger, one clip is prepared as usual. The final part may be shorter.
--part-label prefix|suffix|none controls the automatic "Part N" label (prefix).
An explicit {part} in -r/--rename supplies its own label.

Example: smop "C:\\Videos\\long.mp4" --split -r "My video"
Example: smop "https://example.com/video" --split -r "{filename} Part {part} of {parts}"
Example: smop "C:\\Videos\\long.mp4" --split --dry-run --json

Prepared clips are checked together against live storage and daily limits before
new drafts are created. --try-anyway explicitly attempts the normal upload API.
Use smop --help for the full upload options.
`,
};

COMMAND_HELP.doctorfix = COMMAND_HELP.doctor;
