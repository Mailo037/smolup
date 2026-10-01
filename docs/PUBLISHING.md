# Publishing smup

The public source repository is https://github.com/Mailo037/smup. The npm package
name and executable are both `smup`; `smush` is included as an alias.

The first release is prepared as `0.4.0`. Authenticate and publish from the
repository checkout:

```powershell
npm login --auth-type=web
npm whoami
npm publish --access public
```

Complete browser sign-in and security-key or Windows Hello confirmation yourself.
No npm token belongs in this repository. `npm publish` runs the test suite through
`prepublishOnly`; a failed test stops publication. The package's explicit file list
includes the CLI, runtime modules, setup script, license and documentation. It
excludes credentials, jobs, videos, reference checkouts, local test output and
development tests.

For a preview without publishing:

```powershell
npm test
npm pack --dry-run --ignore-scripts
npm publish --dry-run --ignore-scripts
```

After publication:

```powershell
npm install --global smup
smup --version
smup version
smup doctorfix
```

The registry availability check does not reserve a name. If npm reports that the
name is unavailable, inspect the package owner before changing the release name.

For later releases, update the package version and changelog, commit the changes,
push the source, and run the same publish command. Both `--version` and the update
checker read the version from package.json, so no duplicate version constant needs
editing. `smup update --check` only checks; `smup update` installs a verified newer
release for a normal global npm installation. Source and npm-link installations
receive an install command instead of modifying the checkout.
