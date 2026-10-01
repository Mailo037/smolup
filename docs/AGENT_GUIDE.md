# smolup automation guide

Use the CLI's `--json` mode for automation. Invoke the command with an argument array; avoid building a shell command from video URLs, titles or paths. Progress is written to stderr and results are written to stdout. Most commands return one JSON object. `watchdog start --json` writes newline-delimited events followed by a final result.

Install the npm package `smolup` and invoke `smolup`. The built-in aliases `smush`, `smop` and `smup` forward to the same CLI.

## Authentication and preflight

Configure credentials locally with interactive `smolup setup`, or provide a Cookie header through `SMOLUP_COOKIE_FILE` or `SMOLUP_COOKIE`. Cookie values are never CLI arguments. Do not include credentials in source URLs, logs, reports or job descriptions.

For each authentication variable, resolve the `SMOLUP_` name first, then legacy `SMOP_`, then `SMUP_`. An environment cookie takes precedence over an environment cookie file; saved credentials are used last.

```text
smolup doctor --json
smolup whoami --json
smolup doctor --online --json
smolup doctorfix --json
smolup version --json
smolup update --check --json
smolup storage --json
smolup storage --bytes 104857600 --json
```

`doctor` is a local diagnostic command unless `--online` is supplied. It reports missing credentials and invalid config with exit code 1. Media tools awaiting automatic installation have status `pending` and do not by themselves make the setup fail. `whoami` checks the current session. An authenticated live upload has not yet been verified; Smolish's internal website endpoints may change.

`setup --json` and `config edit --json` are rejected because they require interactive input or an editor. Use environment-based authentication and `config set` for automation.

`storage`, also available as `limits`, reads account counters from the authenticated `GET /storage/apply` page payload. Its tier and byte values are authoritative for preflight; reference tier constants are labels and documentation, not replacements for account data. A file argument checks that file's current size. Encoding and splitting can change the bytes required for the upload.

Before creating new remote drafts, uploads check the sum of all prepared clips against both remaining storage and the daily video allowance. Completed clips and clips with an existing draft are excluded from proposed new storage; the server handles limits while an existing draft is resumed. The server still enforces its current limits after preflight.

Quota excess or unavailable counters stop JSON and non-interactive uploads with an error. There is no prompt in JSON mode or in a watchdog. Only use `--try-anyway` if the caller explicitly requests an attempt despite that result. It uses the normal upload API and does not change the account's allowance. This flag applies to a direct upload, resume or watchdog start invocation; it is not a config or preset setting.

## Prepare, upload and resume

```text
smolup https://example.com/video --dry-run --json
smolup https://example.com/video --visibility private --rename "A clip" --duration 30 --json
smolup https://example.com/video --split --rename "{filename} Part {part} of {parts}" --json
smolup resume JOB_ID --json
smolup jobs --json
```

An invocation handles one source. Duration must be greater than zero and at most 60 seconds. `--start` chooses the beginning of the clip. `--quality` selects the VEO download quality. `--output` preserves an additional local copy of each prepared clip.

New local job IDs have six lowercase letters or digits. Persist the ID exactly; UUID-format legacy jobs remain resumable. Upload IDs are independent of VEO's download history because source downloads use incognito mode.

Built-in upload defaults are Private visibility, a title containing exactly one ordinary space, a start position of zero, a maximum duration of 60 seconds and the best download quality. Splitting is disabled by default, the split threshold is 90 seconds, and the part label is a prefix. The draft description is unchanged unless explicitly supplied. Saved settings and presets may alter those defaults.

Configuration precedence is built-in defaults → saved defaults → active or selected preset → explicit flags. Use `--preset none` to skip the active preset. For a predictable upload, supply the required metadata and media options explicitly.

A job records the resolved upload metadata. `resume` preserves that metadata regardless of subsequent config changes. Explicit metadata flags or an explicitly selected preset can update an unfinished job. Use `edit` for a completed video's metadata.

After an interrupted transfer, resume the same job. Uploaded parts are checked remotely and missing parts are sent after verifying the local file's integrity. If draft creation has an uncertain result, inspect the Studio before starting another upload. Do not blindly retry by creating a new job.

## Split jobs and title templates

```text
smolup SOURCE --split --split-threshold 90 --duration 60 --rename "{filename} Part {part} of {parts}" --json
smolup SOURCE --split --part-label suffix --dry-run --json
smolup resume BATCH_JOB_ID --json
```

`--split` produces consecutive planned clips when the source remaining after `--start` is at least `--split-threshold` seconds. The threshold must be at least 60 seconds. Below it, one clip is prepared as usual. Each clip uses `--duration`, and the final clip may be shorter. Split link uploads download the source before local cutting. All clips are prepared before the aggregate quota check and before creating new drafts.

For a title without `{part}`, multiple clips receive an automatic `Part N` prefix. `--part-label suffix` places it after the title, and `none` disables it. An explicit `{part}` in the title template supplies its own label. A blank title becomes `Part N` when an automatic label is used.

| Title variable | Meaning |
| --- | --- |
| `{filename}` | Source filename stem, without the extension. |
| `{folder}` | Source folder basename; watched root basename for a watchdog; empty for a direct URL. |
| `{part}`, `{parts}` | One-based source part number and total source part count. |
| `{global}` | Durable clip ordinal across direct uploads and all watchdogs. |
| `{index}` | Durable per-watchdog clip ordinal; one-based within a direct invocation. |

Ordinals are reserved before preparation and can contain gaps after dry runs or errors. A saved job keeps its assigned values when resumed. A split source reserves one ordinal per clip. Unknown variables and rendered titles longer than 100 characters are errors. Templates apply only to titles.

A multi-clip source produces a parent batch job and child upload jobs. Persist the parent `jobId` to resume the batch. Resume keeps completed clips and their server IDs; it uploads only pending clips. A parent whose preparation never completed cannot be uploaded through resume. A blocked watchdog retry can restart preparation from the source while retaining completed child uploads; otherwise run the source again after inspecting the saved job.

## Folder watchdogs

```text
smolup watchdog add clips C:\Videos\Inbox --split --rename "{filename} Part {part} of {parts}" --json
smolup watchdog add C:\Videos\Archive --name archive --recursive --existing --json
smolup watchdog list --json
smolup watchdog show clips --json
smolup watchdog start clips --json
smolup watchdog status clips --json
smolup watchdog stop clips --json
smolup watchdog retry clips --json
smolup watchdog retry clips C:\Videos\Inbox\blocked.mp4 --json
smolup watchdog remove clips --json
```

`watch` is a command synonym. Adding a watchdog snapshots resolved defaults, presets and flags. Its saved upload settings are unchanged by later config edits. By default, files present at add time are skipped. Use `--existing` to include them or `--recursive` to include subfolders. `--interval` is the polling delay in seconds (default 5), and `--stable` is the required unchanged interval (default 10). Upload settings and these flags are accepted by `watchdog add`.

The runner stays in the foreground and can select one name or `all`. One runner handles files sequentially. Use `stop` from another terminal for an orderly stop, or Ctrl+C to interrupt the runner. It does not install a background service. Only regular video files inside the saved folder are eligible; symbolic links are skipped, and sources are rechecked before upload.

A persistent journal stores hashes, counters, job IDs and server video IDs. Restarting preserves completed-file deduplication. Changed contents at the same path can become a new upload. A blocked file is not retried on each scan; request `watchdog retry NAME [FILE]`. If a runner ended mid-upload, retry explicitly to resume its saved jobs. Quota failures block records without prompting. A caller-authorized `watchdog start --try-anyway` explicitly attempts the normal API despite a failed quota check.

`retry` queues blocked records; an active or subsequently started runner performs the work. A watcher waits while a manual upload holds the upload lock. Stopping before any job is created defers that source with status `retry` and event `upload_deferred`, so it can continue on the next start. Quota-blocked records and events include a structured `quota` snapshot and reasons. `remove` requires the watchdog to be stopped and retains its journal and counters. Retained ordinals can have gaps and are not a count of successfully published videos.

## Read account videos

```text
smolup list private --all --json
smolup list public --sort views --order desc --limit 30 --page 1 --json
smolup list --status ready --json
smolup info VIDEO_ID --json
smolup analytics VIDEO_ID --days 28 --json
smolup analytics --days 7 --json
```

`list` reads the Smolish account, including uploads made outside smolup. `jobs` reads local upload history. Filters support visibility `private`, `public` or `unlisted`; status `draft`, `uploading`, `queued`, `processing`, `ready` or `failed`; sort `date`, `views`, `likes` or `comments`; and order `asc` or `desc`.

`--limit` ranges from 1 to 50 for account lists. `--all` starts at page 1 and fetches pages sequentially. Analytics accepts 7, 28 or 90 days and returns the site's analytics payload; consumers should tolerate additional site fields.

## Change metadata

```text
smolup edit VIDEO_ID --visibility public --json
smolup edit VIDEO_ID --rename "Revised title" --description "Revised description" --json
```

Only requested metadata is changed. An edit is confirmed against the server before success is reported. A title is limited to 100 characters on one line; a description is limited to 2,000 characters.

## JSON contract

Successful result objects include `schemaVersion: 1`, `command` and `status`. The command determines additional fields. Keep stderr separate when capturing stdout; do not merge progress into the JSON stream. Check the process exit code before using a result. A watchdog stream also contains event objects with `type`; those events need not have a `status` field.

| Command | Status | Additional result fields |
| --- | --- | --- |
| Upload / resume | `uploaded` | `jobId`, `output`, `videoId`, `visibility`, `title`, `url`, `video` |
| Upload with `--dry-run` | `prepared` | `jobId`, `file`, `output`, `durationSeconds`, `sizeBytes`, `metadata` |
| Split upload / resume | `uploaded` | Parent `jobId`, `partCount`, `items`, aggregate `sizeBytes` and `durationSeconds` |
| Split upload with `--dry-run` | `prepared` | Parent `jobId`, `partCount`, `items`, aggregate `sizeBytes` and `durationSeconds` |
| Whoami | `authenticated` | `user` with string `id` and `name` |
| Info | `ok` | `video` |
| Edit | `updated` | `video` |
| Analytics | `ok` | `videoId` (or `null` for the account), `days`, `analytics` |
| Jobs | `ok` | `jobs`, `total`, `skipped`; with an ID, `job` |
| Doctor | `ok` or `attention` | `ready`, `online`, `checks` with `name`, `status`, `detail` |
| Storage / limits | `ok` or `attention` | `storage`, `quota`, reference `tiers`, `tiersObservedAt` |
| Watchdog start (final result) | `stopped` | Selected `names` |

`output` is the saved local copy's path or `null`. `video` uses the normalized video object described below. Dry-run `metadata` contains `title`, `visibility` and an optional `description`. A missing description means it will be preserved from the draft, rather than replaced with an empty string.

Split `items` contain the child results. Persist the parent job ID and inspect each item for its own prepared file or confirmed server video. Uploaded items also include their one-based `part`. A multi-clip result does not use a single top-level video ID to represent all clips. Aggregate duration describes the prepared clips and may differ slightly from planned ranges due to frame timing.

The `storage` object uses byte counters and has these fields: `tier`, `label`, `quotaBytes`, `usedBytes`, `remainingBytes`, `dailyVideoLimit`, `dailyVideoBytes`, `dailyRemainingBytes`, `overQuota`, `source` and `fetchedAt`. Unavailable storage data produces an error rather than fabricated counters. Reference `tiers` are New account 1 GiB total / 1 GiB daily, Standard 6 GiB / 2 GiB and Trusted 40 GiB / 10 GiB, with `tiersObservedAt: "2026-10-01"`; consumers must use returned account values for decisions.

Without a proposed size, `quota` is `null`. With a file or `--bytes`, it contains `allowed`, `proposedBytes`, `reasons` and the account `storage` snapshot. A rejected proposal returns `status: "attention"` and exit code 1; a permitted proposal returns `ok` and exit code 0. Upload quota errors add a `quota` field to the failed envelope; an unavailable check has `storage: null` and `unavailable: true` in that quota result.

Account lists include:

| Field | Meaning |
| --- | --- |
| `items` | Array of normalized video objects. |
| `count` | Number of returned items. |
| `total` | Server-provided matching count, or `null` when unavailable. |
| `page`, `limit` | Requested starting page and page size. |
| `pagesFetched` | Number of pages requested. |
| `all` | Whether all-page retrieval was requested. |
| `filters` | Visibility, status, sort and order used for the list. |

A normalized video object has these fields:

```json
{
  "id": "12345678901234567",
  "title": " ",
  "description": "clip.mp4",
  "visibility": "private",
  "status": "ready",
  "durationSeconds": 30,
  "sizeBytes": 1000000,
  "views": 12,
  "plays": 14,
  "likes": 2,
  "comments": 1,
  "createdAt": "2026-10-01T12:00:00.000Z",
  "url": "https://smolish.com/v/12345678901234567",
  "studioUrl": "https://smolish.com/studio/video/12345678901234567"
}
```

The example is illustrative. IDs are **strings** and must remain strings. Missing numeric metrics, timestamps, visibility and status are `null`; missing title and description text become empty strings. Do not interpret a missing metric as zero. The `ready` state identifies completed processing; other states can still be returned by list and info commands.

Upload results include the local job ID and confirmed video information. Dry-run results include the job ID and prepared file. Persist the job ID to resume the same upload. Ignore unknown fields within schema version 1 so compatible additions do not break a consumer.

JSON errors contain `status: "failed"`, `error`, `jobId` and `videoId`. IDs are `null` when no job or video was created; `command` is `null` if argument parsing failed. `doctor` uses its diagnostic `attention` result when checks fail. Exit codes are `0` for success, `1` for errors and `130` for interruption. A failed upload can leave a resumable job; use the returned job information or `smolup jobs --json` to inspect it.

## Watchdog event stream

Read `watchdog start --json` stdout one line at a time. Each event is a complete JSON object with `schemaVersion: 1`, `command: "watchdog"`, `type` and event-specific fields:

| Type | Useful fields / meaning |
| --- | --- |
| `watchdog_started` | `name`, `folder`, `pid`; runner started for this watchdog. |
| `watchdog_stopped` | `name`; runner stopped watching it. |
| `upload_started` | `name`, `file`, `global`, `index`, `jobIds`; saved retries can already have job IDs. |
| `upload_completed` | `name`, `file`, `jobIds`, `videoIds`, counters and completion details. |
| `upload_blocked` | `name`, `file`, `error`, `uncertain`, saved job/video IDs; explicit retry is required. |
| `watchdog_error` | `name`, `error`; a folder could not be scanned. |
| `file_waiting` | `name`, `file`, `error`; the file could not yet be processed safely. |

The stream ends with a normal result object when the runner stops, or a failed result for a fatal command error. A graceful stop reports `status: "stopped"`. Blocked uploads are recorded events while the runner continues; a zero runner exit code does not mean every observed file uploaded successfully. Inspect events or `watchdog show NAME --json` for blocked records before treating the folder as complete. Keep unknown event fields and types forward-compatible.

Watchdog list/status results include `globalReservedClips` and a `watchdogs` array. Each record exposes saved settings, folder and polling options, `running`, `reservedClips`, `uploadedClips`, `blockedFiles`, `pendingFiles` and `ignoredFiles`. `show` also includes individual file `records`. Reserved counters can include dry runs or failures and are not successful-upload totals.

## Local settings and aliases

```text
smolup config show --json
smolup config set visibility private --json
smolup config set duration 30 --json
smolup config set split true --json
smolup config set splitThreshold 90 --json
smolup config set partLabel prefix --json
smolup preset add shorts --visibility public --duration 30 --json
smolup preset show shorts --json
smolup preset use shorts --json
smolup preset reset --json
smolup alias add smap --json
smolup alias list --json
smolup alias remove smap --json
```

Configuration commands do not need authentication. Presets store partial settings. Command aliases forward arguments to smolup; they are not presets. Alias management does not overwrite existing commands or remove unrelated files. Use `--bin-dir` to choose a different command directory.

`SMOLUP_HOME` relocates config and authentication and puts jobs under `state/jobs`. `SMOLUP_CONFIG` overrides only the settings file path. Config and job files contain user settings and media paths; authentication is stored separately. Use `smolup config path --json` to discover the effective config location.

For each path override, resolve the `SMOLUP_` name first, then legacy `SMOP_`, then `SMUP_`. Default paths use `smolup` directories. If a corresponding new directory does not exist, an existing `smop` directory is reused first, followed by an existing `smup` directory, without moving files. Use the returned effective paths rather than assuming a directory name.

Watchdog definitions are stored in the config directory's `watchdogs.json`; the persistent upload journal is in the state directory under `watchdogs`. `SMOLUP_CONFIG` changes the general settings file only, while `SMOLUP_HOME` also relocates watchdog definitions and state. Keep those files when restarting or migrating a runner to preserve deduplication and ordinal assignments.
