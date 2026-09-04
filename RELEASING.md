# Releasing

Versions and changelog entries are derived from the conventional commit messages on `master` by
[git-cliff](https://git-cliff.org), through the shared
[`apify/actions/git-cliff-release`](https://github.com/apify/actions/tree/master/git-cliff-release)
action. Everything runs in CI - there is nothing to install or configure locally.

## Stable release

Actions -> **Release** -> **Run workflow**, and pick a `release_type`:

| `release_type` | Version |
| --- | --- |
| `auto` | Derived from the commits since the last stable tag. Fails when none of them warrant a release. |
| `patch` / `minor` / `major` | Forced bump, ignoring what the commits suggest. |
| `custom` | Exactly what you put in `custom_version`, e.g. `3.2.0`. |

The run then:

1. Runs the full `check.yaml` suite. Nothing is written if it fails.
2. Computes the version, the changelog and the release notes.
3. Commits `package.json` and `CHANGELOG.md` as `chore(release): vX.Y.Z [skip ci]`, signed, straight
   to `master`.
4. Publishes that commit to npm under the `latest` tag through OIDC.
5. Creates the `vX.Y.Z` tag and the GitHub release on that commit.

Step 5 comes last on purpose: a failed publish leaves the release commit untagged, so re-dispatching
computes the same version and retries cleanly.

## How `auto` picks the version

From the conventional commits since the last stable tag, highest match wins:

| Commit | Bump |
| --- | --- |
| A breaking change - `feat!:`, `fix(scope)!:`, or a `BREAKING CHANGE:` footer | major |
| `feat:` | minor |
| `fix:`, `perf:`, `revert:` | patch |

`chore`, `ci`, `docs`, `test`, `refactor`, `style`, `build` and `chore(deps...)` are skipped - they
neither bump the version nor show up in the changelog. When everything since the last tag is one of
those, `auto` fails with "Nothing to release" instead of cutting an empty patch; dispatch `patch`
explicitly if you want the release anyway. Breaking commits are exempt from the skip, so a `chore!:`
still forces a major.

Pull requests are squash merged, so the squashed commit title is the pull request title - **the pull
request title is what decides the bump**.

## Beta release

Every push to `master` publishes a `X.Y.Z-beta.N` prerelease under the `beta` tag, where `X.Y.Z` is
the next patch version and `N` is one more than the highest beta already on npm. The version is set
in the checkout only - nothing is committed, and no git tag is pushed.

Commits whose message contains `[skip ci]` are not published, which is how the release commit avoids
publishing itself twice.

## Previewing a release

The **Release dry run** workflow computes the same version, changelog and release notes and writes
them into the run summary without touching the repository, npm or the release list. It runs
automatically on pull requests that touch `.github/workflows/**` or `CHANGELOG.md`, and can be
dispatched by hand at any time. The complete generated `CHANGELOG.md` is attached to the run as an
artifact, so it can be diffed against the current one.

## Changelog

Entries come from commit titles, and cover the same types that bump the version. Use `fix(deps):`
rather than `chore(deps):` for dependency bumps that users should see, such as security fixes -
`chore(deps...)` is skipped.

The `vX.Y.Z-beta.N` tags left over from the previous release setup do not affect any of this - the
action deletes prerelease tags in its own clone before computing a version.

## Repository configuration

- **npm trusted publisher** must point at `release.yaml`. Both the `latest` and the `beta` publish
  run from that file for this reason; moving a `pnpm publish` step into another workflow breaks the
  OIDC handshake until the npm configuration is updated to match.
- **`APIFY_SERVICE_ACCOUNT_GITHUB_TOKEN`** is used for the release commit and the GitHub release when
  it is available, and the workflow falls back to the built-in `GITHUB_TOKEN` when it is not. The
  fallback cannot push to `master` if the branch is protected.
