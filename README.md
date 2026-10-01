# smup

Download a video link and upload clips of up to 60 seconds to [Smolish](https://smolish.com). Use `smup` or the built-in alias `smush`. Local files, split uploads and folder watchdogs work too. Account storage and daily allowances are checked before creating upload drafts.

```powershell
smup setup
smup "https://example.com/video"
smup list private
```

New uploads are **Private** by default. The title is exactly one ordinary space (`" "`) unless a title is supplied. The draft description is preserved unless `--description` is supplied. The CLI waits for processing and checks the final metadata before reporting success.

## Install

Requires Node.js 22 or newer on Windows, Linux or macOS. After the first npm publication:

```sh
npm install --global smup
smup doctorfix
smup --help
```

From this checkout:

```powershell
npm install
npm link
smup --help
```

smup uses [VEO](https://github.com/Mailo037/veodl) (`veodl` 1.12.0) to download links and resolve FFmpeg and FFprobe. Existing VEO media tools are reused; missing tools are prepared when needed. The VEO version is pinned because smup also uses its tool resolution and terminal formatting.

## Account setup

1. Sign in to **smolish.com** in a browser.
2. Open Developer Tools → **Network** and select a request to `smolish.com/api/...`. Reload the page if necessary.
3. Copy the complete **Cookie** value from **Request Headers**, such as `session_cookie=...; another_cookie=...`. Cookie names are not hard-coded. An optional leading `Cookie:` is accepted.
4. Run `smup setup` in an interactive terminal and paste the value into the hidden prompt.
5. Run `smup whoami` to check the session.

The observed website upload flow uses the session cookie; it does not require a separate API token. Enter the cookie locally. Cookie values are not accepted as command-line arguments, printed in results, sent to VEO or video sources, or included in requests to signed storage URLs.

On Windows, the saved cookie uses Windows DPAPI encryption bound to the current Windows user. On macOS and Linux, it is stored in a file created with private user permissions. Renew an expired session with `smup setup`.

DPAPI provides encryption; Base64 only changes how bytes are represented and does not protect a cookie. Credentials are never copied into the repository or npm package. Keep private-file authentication on macOS and Linux within your own user account.

For non-interactive use, set `SMUP_COOKIE_FILE` to a local UTF-8 file containing the complete Cookie header, or set `SMUP_COOKIE` in the process environment. Authentication precedence is `SMUP_COOKIE`, then `SMUP_COOKIE_FILE`, then the saved cookie. Use `smup whoami --json` to verify non-interactive authentication.

## Upload a clip

```powershell
smup "https://example.com/video"
smush "C:\Videos\clip.mp4"
smup "https://example.com/video" --visibility public -r "My clip"
smup "https://example.com/video" --start 30 --duration 20 -q 720p
smup "https://example.com/video" -d "A description" -o "C:\Videos\prepared"
```

| Option | Behavior |
| --- | --- |
| `--visibility private\|public\|unlisted` | Choose visibility; built-in default is Private. |
| `-r, --rename <title>` | Set the title; `--title` is also accepted. Built-in default is one space. |
| `-d, --description <text>` | Replace the description. Omit to preserve the draft description. |
| `--start <seconds>` | Start at this position; built-in default is `0`. |
| `--duration <seconds>` | Maximum clip length, greater than `0` and at most `60`; built-in default is `60`. |
| `-q, --quality <value>` | VEO download quality: `best`, `1080p`, `720p`, etc. |
| `-p, --preset <name>` | Apply a saved preset. Use `none` to skip the active preset. |
| `-o, --output <directory>` | Save an additional local copy of the prepared clip. Existing files are not overwritten. |
| `--split`, `--no-split` | Enable splitting long videos, or override settings that enable it. Splitting is off by default. |
| `--split-threshold <seconds>` | Split when the remaining source reaches this length; default `90`, minimum `60`. |
| `--part-label prefix\|suffix\|none` | Position or disable the automatic `Part N` title label; default `prefix`. |
| `--dry-run` | Download and prepare a clip without uploading it. |
| `--try-anyway` | Explicitly attempt the normal upload API after a failed or unavailable storage check. |
| `--json` | Write one result object to stdout; `watchdog start` streams events instead. |
| `--no-color` | Disable colors; the `NO_COLOR` environment variable is also respected. |

`smup upload <URL or file>` is the explicit form of the upload command. Quote URLs and paths that contain spaces or shell characters. Use `--` before a filename that begins with a hyphen.

Each invocation handles one source. Without splitting, a longer source produces one clipped video. Shorter sources retain their length. FFprobe checks duration and streams; clips requiring conversion are encoded as H.264/AAC MP4. Compatible short MP4 files can be copied without re-encoding. A required HDR conversion is reported instead of silently changing the colors. Each prepared video must fit Smolish's observed limit of 300 MiB.

Split boundaries follow the configured clip length. Frame counts are bounded and FFprobe verifies the actual output duration before uploading. The original local file is preserved.

## Storage and daily limits

```powershell
smup storage
smup limits --json
smup storage "C:\Videos\clip.mp4"
smup storage --bytes 104857600 --json
```

`storage` reads the signed-in account's tier and byte counters from [Smolish's storage page](https://smolish.com/storage/apply). It shows total quota, used and remaining storage, and the used and remaining daily video allowance. The optional file or `--bytes` checks a proposed size without uploading. A file check uses that file's current size; encoding or cutting may change the prepared size.

The page's reference tiers observed on October 1, 2026 are:

| Tier | Total storage | Daily video uploads |
| --- | --- | --- |
| New account | 1 GiB | 1 GiB |
| Standard | 6 GiB | 2 GiB |
| Trusted | 40 GiB | 10 GiB |

Actual checks use the account's returned counters rather than assuming these reference values. All clips are prepared first, and their combined size is checked before any new draft is created. Resume checks clips that need a new draft; the server handles limits while an existing draft is resumed. The server makes the final decision because account usage can change after a check.

If the prepared upload exceeds an allowance, or the counters cannot be read, an interactive upload asks `This upload may exceed account limits. Try anyway? [y/N]`. The default is No. JSON mode, redirected input and watchdogs do not prompt: they stop or block the file unless `--try-anyway` was explicitly supplied.

```powershell
smup resume <job-id> --try-anyway
```

This flag attempts the normal upload API; Smolish continues enforcing its limits. Free storage or wait for allowance to become available, then resume the saved job. Dry runs only prepare local media and do not reserve remote storage.

## Split a longer video

```powershell
smup "C:\Videos\long.mp4" --split -r "My video"
smup "https://example.com/video" --split -r "{filename} Part {part} of {parts}"
smup "C:\Videos\long.mp4" --split --duration 30 --part-label suffix
smup "C:\Videos\long.mp4" --split --dry-run --json
```

Splitting is opt-in. With `--split`, a source with at least 90 seconds remaining after `--start` produces consecutive clips of up to 60 seconds, including a shorter final part. `--duration` chooses the clip length and `--split-threshold` changes the trigger. Below the threshold, one clip is prepared as usual. Split link uploads download the source before cutting it locally.

For example, a 150-second source produces three planned parts: seconds 0–60, 60–120 and 120–150. Automatic labels put `Part 1`, `Part 2` and `Part 3` before the supplied title. Use `--part-label suffix` to place them after the title, or `none` to disable them. If the title template already contains `{part}`, it supplies its own part label. A blank title becomes just `Part N` for split uploads.

Titles support these variables for both direct uploads and watchdogs:

| Variable | Value |
| --- | --- |
| `{filename}` | Source filename without the extension. For a link, the downloaded filename is used. |
| `{folder}` | Source folder name; the watched root folder name for a watchdog. Empty for a direct link upload. |
| `{part}` | Part number within the source, starting at 1. |
| `{parts}` | Total number of parts for the source. |
| `{global}` | Durable clip sequence shared by direct uploads and watchdogs. |
| `{index}` | Durable clip sequence within a watchdog; starts at 1 within a direct invocation. |

Counters are reserved before preparation and can have gaps after dry runs or failed attempts. Retrying the same saved job retains its numbers. The final rendered title must still fit Smolish's 100-character title limit. Templates apply to titles, not descriptions.

## Preview and resume

```powershell
smup "https://example.com/video" --dry-run --visibility public -r "Preview"
smup jobs
smup resume <job-id>
```

A dry run reports the prepared file and local job ID. A split dry run reports a parent batch ID and its prepared clips. Upload it later with `resume`. Jobs retain their chosen metadata: changing defaults or the active preset does not change an existing job. Explicit metadata flags or an explicitly selected preset can update unfinished clips:

New job IDs contain six lowercase letters or digits, matching VEO's format. Existing UUID jobs remain resumable. SMUP upload jobs are independent of VEO download jobs: downloads run in VEO's incognito mode without adding entries to its history.

```powershell
smup resume <job-id> --visibility private -r "Revised title"
```

If an upload is interrupted, smup preserves the job, checks the file's integrity, asks Smolish which parts already exist, and uploads missing parts. A processing timeout can also be resumed. The temporary prepared file is removed after the server confirms success; an `--output` copy is retained. Dry runs and unfinished jobs keep their prepared file.

Resume a split upload with its parent batch ID. Completed clips are retained and are not uploaded again; pending clips continue with their saved job IDs and titles. A batch whose preparation never finished cannot be resumed as an upload. Use the original source again, or explicitly retry its blocked watchdog record to complete preparation.

Only one smup upload runs at a time on a device. Parts are sent sequentially, with bounded retries for transient transfer failures. If draft creation has an uncertain outcome, the job stops instead of automatically creating another draft. Inspect the Studio before starting a replacement upload.

`smup jobs [job-id]` shows local job history; `history` is a synonym. This differs from `smup list`, which reads the account's videos from Smolish, including videos uploaded through the website.

## Watch a folder

```powershell
smup watchdog add clips "C:\Videos\Inbox" --split -r "{filename} Part {part} of {parts}"
smup watchdog add "C:\Videos\Public" --name public-clips --visibility public --recursive --existing
smup watchdog list
smup watchdog show clips --json
smup watchdog start clips
```

`watchdog add` saves the resolved upload settings, including a selected preset, so later default or preset changes do not change the watcher. Supply the name and folder, or supply a folder and optionally `--name`; otherwise the name is derived from the folder. Names use 1–31 lowercase letters, digits or hyphens, start with a letter, and cannot be command names.

Files already present when the watchdog is added are skipped unless `--existing` is supplied. New regular video files are checked every 5 seconds and must remain unchanged for 10 seconds before preparation. Set `--interval <seconds>` and `--stable <seconds>` when adding the watchdog to change those delays. `--recursive` includes subfolders. Symbolic links are skipped, sources are checked again before uploading, and originals are preserved.

The runner stays in the foreground. Stop it with Ctrl+C, or request an orderly stop from another terminal:

```powershell
smup watchdog status clips
smup watchdog stop clips
smup watchdog start all
```

No background service or scheduled startup is installed. One runner handles the selected watchdogs and uploads files sequentially. If a manual upload is running, the watchdog waits for it. A persistent journal records file content hashes, counters, job IDs and completed videos. Restarting keeps that history and avoids uploading unchanged completed files again. New content at the same path can become a new upload. Removing a watchdog keeps its history and counters.

Quota failures and interrupted uploads become blocked records. The watchdog does not repeatedly retry a blocked file or ask interactive questions. Inspect it, then explicitly request a retry:

```powershell
smup watchdog show clips
smup watchdog retry clips
smup watchdog retry clips "C:\Videos\Inbox\long.mp4"
smup watchdog start clips --try-anyway
smup watchdog remove clips
```

Retries preserve saved upload jobs and completed parts. If preparation did not finish, the retry can prepare the source again before creating drafts. `--try-anyway` is a flag for that runner invocation and is not saved as a watchdog setting. Stop a watchdog before removing it. `watch` is a synonym for `watchdog`.

## Browse and manage videos

```powershell
smup list
smup list private
smup list public --all --sort views --order desc
smup list --status ready --limit 30 --page 2
smup list private --json
smup info <video-id> --json
smup analytics --days 28 --json
smup analytics <video-id> --days 7 --json
smup edit <video-id> --visibility public -r "New title"
smup edit <video-id> -d "Updated description"
```

The list table includes IDs, visibility, processing status and engagement metrics. JSON exposes normalized fields including views, plays, likes and comments. Missing metrics are `null`, rather than an invented zero. Keep video IDs as strings: they can exceed JavaScript's safe integer range.

List filters support `private`, `public` and `unlisted`, either as a positional filter or through `--visibility`. Use `--limit 1..50`, `--page`, `--all`, `--sort date|views|likes|comments`, `--order asc|desc`, and `--status draft|uploading|queued|processing|ready|failed`. `--all` fetches pages sequentially, starting at page 1.

Analytics supports `--days 7`, `28` or `90`. Omit the video ID for account analytics. `edit` changes the explicitly supplied metadata and checks the resulting server values.

## Defaults and presets

Configuration is local and separate from the account cookie:

```powershell
smup config show
smup config set visibility private
smup config set duration 45
smup config set color false
smup config unset duration
smup config path
smup config edit
smup config check
```

Supported settings are `visibility`, `rename`, `description`, `start`, `duration`, `quality`, `output`, `color`, `split`, `splitThreshold` and `partLabel`. Use camel case for config keys and hyphens for CLI flags: `config set splitThreshold 90` corresponds to `--split-threshold 90`. `config edit` opens `VISUAL`, then `EDITOR`, or the platform's default editor. `config reset` clears saved defaults, presets and the active preset; the account cookie, jobs and watchdog registry remain separate.

```powershell
smup preset add shorts --visibility public --duration 30 -q 720p
smup preset add series --split -r "{filename} Part {part} of {parts}"
smup preset list
smup preset show shorts
smup "https://example.com/video" --preset shorts -r "A short clip"
smup preset use shorts
smup "https://example.com/video" --preset none
smup preset reset
smup preset remove shorts
```

Settings are applied in this order: built-in defaults → saved defaults → active or selected preset → explicit flags. Presets store only the options supplied when they are created. Preset names use 1–31 lowercase letters, digits or hyphens and start with a letter; command names are reserved.

## Custom command aliases

```powershell
smup alias list
smup alias add smap
smap "https://example.com/video" --visibility public
smup alias remove smap
```

Aliases forward arguments to `smup` and are created beside the `smup` command found on `PATH`. Use `--bin-dir <directory>` to choose another command directory, which must be on `PATH` to invoke an alias by name. Existing commands are not overwritten, and removal is limited to wrappers created by smup. The built-in commands `smup` and `smush` cannot be removed through alias management.

## Terminal and automation output

Interactive terminals use distinct colors for headings, commands, flags, values, statuses and errors, with progress updating in the same line. Help, tables and human-readable JSON previews are colored too. Redirected output is plain by default; use `--color` to force colors, or `--no-color` / `NO_COLOR` to disable them. Machine `--json` output never contains ANSI escapes. Progress goes to **stderr**; results go to **stdout**.

```powershell
smup list --all --json > videos.json
smup config show --json
smup doctor --json
smup doctor --online --json
```

`doctor` checks the local setup; `--online` also checks the Smolish session. Missing credentials or invalid settings return exit code 1. Media tools marked `pending` are installed automatically on first use. JSON results have `schemaVersion: 1`. Interactive `setup` and `config edit` do not accept `--json`; use environment-based authentication and `config set` for automation. See [the automation guide](docs/AGENT_GUIDE.md) for commands, output fields and resume handling. Exit codes are `0` for success, `1` for errors and `130` for interruption.

## Version checks and repairs

```sh
smup --version
smup version
smup update --check
smup update
smup doctorfix
smup doctor fix --online
```

`--version` shows the installed version without network access. `version` and `update --check` read the latest npm release without changing anything. `update` installs a verified newer release in a normal global npm installation. Source checkouts and `npm link` installations receive an explicit install command instead of overwriting the checkout. Before the first npm publication, checks report `unpublished`.

`doctorfix`, also spelled `doctor fix`, installs missing VEO dependencies and repairs its managed yt-dlp, FFmpeg and FFprobe tools. It verifies the installed tools before reporting success. It does not require an account cookie; `--online` additionally checks sign-in. User-supplied VEO executable overrides are respected and must point to working programs. This is a CLI repair command; no Docker installation is required.

`watchdog start --json` is the streaming exception: stdout contains newline-delimited event objects followed by a final result when the runner stops. Read each line independently and keep stderr separate. Other JSON commands write one result object.

| Data | Windows default | macOS / Linux default |
| --- | --- | --- |
| Config and saved cookie | `%APPDATA%\smup` | `$XDG_CONFIG_HOME/smup` or `~/.config/smup` |
| Jobs and temporary media | `%LOCALAPPDATA%\smup\jobs` | `$XDG_CACHE_HOME/smup/jobs` or `~/.cache/smup/jobs` |

`SMUP_HOME` relocates configuration and places jobs under its `state/jobs` directory. `SMUP_CONFIG` overrides the settings file path independently of authentication.

## Smolish integration

The integration was derived from the signed-in Studio and public website client scripts observed on October 1, 2026. These are internal website endpoints, so changes to Smolish may require updates.

| Operation | Request |
| --- | --- |
| Check session | `GET /api/auth/get-session` |
| List or look up videos | `GET /api/videos` with filters or `ids` |
| Create draft | `POST /api/videos` with `contentType`, `sizeBytes`, `filename` |
| Find missing parts and signed URLs | `GET /api/videos/{id}/parts?sign=1` |
| Refresh a part URL | `POST /api/videos/{id}/parts` with `partNumbers` |
| Transfer a part | `PUT` to the signed storage URL, without the account cookie |
| Complete upload | `POST /api/videos/{id}/complete` without a body |
| Change metadata | `PATCH /api/videos/{id}` |
| Read analytics | `GET /api/studio/analytics` with `days` and optional `videoId` |
| Read account storage | `GET /storage/apply`; parse the account counters from the page payload |

An authenticated end-to-end upload has **not yet been verified** against Smolish, and no live folder watchdog has been left running. Local protocol and media checks do not establish live upload success. An expired session, access protection or a site change can prevent direct requests; the CLI reports these failures.

## Development checks

```powershell
npm test
npm run test:media
npm run test:split
```

Protocol and watchdog checks use local fixtures. The media check creates synthetic media and exercises real FFmpeg preparation and VEO download against a local HTTP server. The split check exercises a longer synthetic source and its prepared clips. These commands do not publish videos to Smolish.

GitHub Actions runs the tests on Windows, Linux and macOS with Node.js 22 and 24. Release instructions are in [Publishing smup](docs/PUBLISHING.md).
