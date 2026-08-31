# Git and PRs

## Branch naming

- Lowercase and DNS-friendly, a `prefix/` is allowed.
- Prefer `feat/`, `fix/` or `chore/`.

## Commits and PR titles

- Use Conventional Commits with an optional scope `fix(forward): destroy outbound socket when client disconnects early`.
- The PR title becomes the final commit.
- The target branch is `master`.

## Pull requests

- Explain what, why and how. Keep it concise. Mention risks when relevant.
- Keep PRs small. Split large work into stacked PRs when there is a clear logical separation.
- Link the related issue or resource.
- This is a public repository. Keep internal Apify references, infrastructure details and customer names out of code, comments, commit messages and PR descriptions.

## Releases

- [`.github/workflows/release.yaml`](../../.github/workflows/release.yaml) publishes a beta on every push to `master`, and `latest` when a GitHub Release is published.
- `.github/scripts/before-beta-release.cjs` fails the build if the `version` in `package.json` already exists on npm, so bump it in the PR.
- The package is published and widely depended on. Adding to `src/index.ts` is cheap, changing or removing from it is a major version.

## CI

- [`.github/workflows/check.yaml`](../../.github/workflows/check.yaml) runs lint and type-check on Node 24, unit tests on Node 20, 22, 24 and 26, e2e on Node 24, and the Bun jobs.
- `[skip ci]` in the head commit message skips every job.

## Reviews

- Review in two passes, high level first, then details.
- Prefix comments with `important`, `suggestion` or `nit`.
