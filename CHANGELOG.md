# Changelog

## 0.4.1

- Reject cached media tools that VEO reports as failing SHA-256 verification, including before diagnostic probes.
- Pin VEO 1.12.1, removing the optional FFmpeg npm dependency tree and its installation scripts. Native media downloads use fixed upstream releases, exact byte counts and SHA-256 checks before execution.
- Preserve upstream media-tool licenses and keep existing Windows, Linux and macOS tool resolution.
- Remove current and legacy Smolish cookie environment variables from every subprocess, including FFmpeg and FFprobe.
- Document the Socket findings in the published 0.4.0 dependency tree and the remaining expected uploader capabilities.

## 0.4.0

- Publish the first public `smolup` npm release and `Mailo037/smolup` GitHub repository.
- Use `smolup` as the primary command, retaining `smush`, `smop` and `smup` aliases, legacy environment variables and existing data directories.
- Use six-character VEO-style upload job IDs, with legacy UUID resume support.
- Add version checks, explicit updates and `doctorfix` for media dependencies.
- Color help, commands, flags, values, tables, progress and errors consistently.
- Verify saved credentials using native Windows DPAPI round-trip tests.

## 0.3.0

- Add account storage and daily quota checks before creating upload drafts.
- Add folder watchdogs with durable jobs, counters and title variables.
- Add optional splitting into numbered clips of at most 60 seconds.
- Preserve Private defaults, exact blank titles, resumable uploads and JSON output.
