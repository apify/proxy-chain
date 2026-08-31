# Proxy Chain

Proxy Chain is a Node.js proxy server library published to npm as [`proxy-chain`](https://www.npmjs.com/package/proxy-chain).
It is a single-package TypeScript ESM library providing an HTTP and HTTPS proxy with authentication, upstream proxy
chaining over HTTP and SOCKS, and CONNECT tunneling. This is a public Apache-2.0 repository, used by Apify Proxy,
Crawlee and by anyone routing Puppeteer or Playwright through an authenticated proxy.

## Always relevant

- Only pnpm. [`pnpm-lock.yaml`](pnpm-lock.yaml) is the lockfile, npm or yarn will diverge from it.
- Node.js `>=20.11`, see `engines` in [`package.json`](package.json). CI runs 20, 22, 24 and 26.
- ESM only, with `module: NodeNext`. Every relative import ends in `.js`.
- [`src/index.ts`](src/index.ts) is the entire public surface. Anything not re-exported there is internal.
- [`README.md`](README.md) is the user-facing API contract. A public behaviour change needs a README update.
- Common commands:
  - `pnpm run build`
  - `pnpm run type-check`
  - `pnpm run lint`
  - `pnpm test`
  - `pnpm run test:unit`
  - `pnpm run test:e2e`
  - `pnpm run test:docker`
  - `pnpm run local-proxy`

## Code style

- Lint rules live in [eslint.config.mjs](eslint.config.mjs), which extends [`@apify/eslint-config`](https://www.npmjs.com/package/@apify/eslint-config). Run `pnpm run lint:fix` to apply what is auto-fixable.
- There is no formatter. Indentation is 4 spaces from [.editorconfig](.editorconfig).
- `pnpm run type-check` type-checks `src` and `test` separately, using different tsconfigs. Run it before finishing.

## Agent references

- [Architecture](docs/agents/architecture.md)
- [TypeScript conventions](docs/agents/typescript.md)
- [Testing](docs/agents/testing.md)
- [Git and PRs](docs/agents/git-and-prs.md)
- [Security](docs/agents/security.md)

## More detail

[README.md](README.md) is the source of truth for the public API, the `Server` options, the `prepareRequestFunction`
contract and the custom 590-599 status codes. [test/README.md](test/README.md) covers Docker-based testing and the Bun
compatibility matrix.
