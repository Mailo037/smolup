# Publishing smop

The public source repository is [Mailo037/smop](https://github.com/Mailo037/smop).
The npm package name and primary executable are both `smop`; `smush` and legacy
`smup` are included as aliases.

The first release is prepared as `0.4.0`. Authenticate and publish from the
repository checkout:

```powershell
npm login --auth-type=web
npm whoami
npm publish --access public
```

For this release, confirm `npm whoami` reports `mailo037`. If already signed in to
that account, skip `npm login` and run the remaining commands. Publication is a
separate manual step; preparing the checkout and running dry runs does not publish
the package.

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
npm install --global smop
smop --version
smop version
smop doctorfix
```

An npm name lookup checks whether a package already exists; it does not reserve a
name or prove that npm's name policy accepts it. Packing and publication dry runs
also do not guarantee acceptance. npm rejected the previous unscoped name `smup`
for its similarity to existing packages, so this release uses `smop`.

If npm also rejects `smop`, the fallback is the scoped package `@mailo037/smop`.
Update the name in `package.json`, refresh `package-lock.json`, run the checks and
update package references in the documentation before retrying with
`npm publish --access public`. The CLI command can remain `smop`; installation and
updates then use `@mailo037/smop`. This fallback has not been published, and the
unscoped name's acceptance is only confirmed by a successful real publication.

For later releases, update the package version and changelog, commit the changes,
push the source, and run the same publish command. Both `--version` and the update
checker read the version from package.json, so no duplicate version constant needs
editing. `smop update --check` only checks; `smop update` installs a verified newer
release for a normal global npm installation. Source and npm-link installations
receive an install command instead of modifying the checkout.
