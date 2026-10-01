# Changelog

## 0.4.0

- Prepare the first public `smolup` npm release and `Mailo037/smolup` GitHub repository.
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
