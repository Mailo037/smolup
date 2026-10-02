# Dependency security

The [Socket report for smolup 0.4.0](https://socket.dev/npm/package/smolup/alerts/0.4.0?tab=dependencies) includes risks from optional media packages beneath `veodl@1.12.0`.

The important findings are:

- `ffmpeg-static@5.3.0` runs an installation script that downloads an executable without a shipped checksum. Socket's AI warning concerns download integrity and configurable origins; it does not identify confirmed malicious code.
- Its dependency `caseless@0.12.0` has an AI warning about inherited properties in its header setter. Several supporting packages have not received updates for more than five years.
- The optional binary packages have separate upstream licenses. smolup's MIT license does not replace those licenses.

An npm audit with no known vulnerabilities does not resolve these findings. Omitting optional dependencies skips their npm installation, but VEO 1.12.0 can still run the same FFmpeg installer during media setup. `--ignore-scripts` alone is therefore not a complete fix.

smolup 0.4.1 pins [VEO 1.12.1](https://github.com/Mailo037/veodl/pull/2), which removes that optional npm tree. Its downloader uses fixed upstream binary releases and shipped SHA-256 hashes and byte counts. It verifies both FFmpeg and FFprobe before execution and rejects unverified managed caches. Upstream license and build information are preserved beside the tools. There are no transitive runtime npm dependencies or npm installation scripts in this tree. The published 0.4.0 dependency and its historical Socket report cannot be changed retroactively.

Managed downloads verify the pinned release bytes; explicitly supplied executables and system tools remain trusted user choices. Socket can still report native executable downloads and other capabilities. A new Socket scan, rather than changes to the historical report, is needed to assess 0.4.1.

Network access, filesystem access, environment settings and starting media programs are expected capabilities for this uploader. Those capability alerts should be evaluated against the actual code rather than hidden. In particular, the Smolish cookie belongs only in account requests and local credential storage, never in media-tool subprocesses or storage transfers.

To inspect the installed tree:

```sh
npm ls --all
npm audit
smolup doctor --json
```

For an installation of smolup in a global npm prefix, inspect its dependency tree with `npm ls --global --all smolup`.
