# Publishing smolup

The public source repository is [Mailo037/smolup](https://github.com/Mailo037/smolup).
The npm package is `smolup`; its primary executable is `smolup`.
The aliases `smush`, `smop` and `smup` invoke the same CLI.

Name lookups and dry runs do not guarantee npm acceptance; only a successful
publication confirms that the release is available.

The first release, `0.4.0`, is published on npm. For another release, update the
version and changelog, then authenticate and publish from the repository checkout:

```powershell
npm login --auth-type=web
npm whoami
npm publish --access public
```

Use `npm whoami` to check the signed-in account. If already signed in to the
intended publishing account, skip `npm login` and run the remaining commands.
Complete browser sign-in and security-key or Windows Hello confirmation yourself.
Publication is a separate manual step; preparing the checkout and running dry runs
does not publish the package.

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
npm install --global smolup
smolup --version
smolup version
smolup doctorfix
```

For later releases, update the package version and changelog, commit the changes,
push the source, and run the same publish command. Both `--version` and the update
checker read the version and package identity from package.json, so no duplicate
version constant needs editing. `smolup update --check` only checks;
`smolup update` installs a verified newer `smolup` release for a
normal global npm installation. Source and npm-link installations receive an
install command instead of modifying the checkout.
