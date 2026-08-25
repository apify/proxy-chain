# Tests

The test suite is split into two directories:

- `test/unit/` — pure unit tests over utility helpers (no network, no proxy
  servers). Fast; runs in CI on every supported major Node.js version.
- `test/e2e/` — end-to-end tests that spin up real HTTP/HTTPS/SOCKS proxy
  servers and target servers. Heavier; runs in CI on the latest Node.js
  only.

Shared helpers live in `test/utils/`.

Tests run on [Vitest](https://vitest.dev) (`vitest.config.ts`). Each directory is
its own project, selectable with `--project`. The `e2e` files bind real servers,
so each one scans for free ports in its own disjoint window - see
`test/utils/port_ranges.js`.

## Docker (recommended)

Since Linux and macOS handle sockets differently, please run tests in a Docker container
to have a consistent Linux environment for running tests.

1. Run all tests

    ```bash
    npm run test:docker
    ```

2. Run a specific test file

    ```bash
    npm run test:docker test/e2e/server.js
    ```

3. Run all `direct ipv6` test cases across all tests

    ```bash
    npm run test:docker test/e2e/server.js -- -t "direct ipv6"
    ```

4. Run the suite on Bun (the image ships both runtimes)

    ```bash
    npm run test:docker:bun                    # unit + the supported e2e subset
    npm run test:docker:bun:unit               # unit only
    npm run test:docker:bun:e2e:compatible     # the supported e2e subset only
    npm run test:docker:bun:e2e:full           # the whole e2e suite only
    npm run test:docker:bun:full               # unit + the whole e2e suite
    ```

    The e2e tests Bun doesn't support stall until their per-test timeout
    instead of failing fast, so the `:full` variants are slow. Use them only
    when working on those gaps.

    All targets take the same trailing arguments as `test:docker`:

    ```bash
    npm run test:docker:bun:e2e:full test/e2e/tcp_tunnel.js -- -t "throws error"
    ```

    The container entrypoint is `npm run`, so any script from `package.json`
    works — e.g. `npm run docker:run -- test:bun:e2e:full`.

Note: for test in Docker no changes in `/etc/hosts` needed.

## Local Machine

### Prerequisites

1. Node.js 20+ (see `.nvmrc` for exact version)
2. For MacOS with ARM CPUs install Rosetta (workaround for puppeteer)
3. Update `/etc/hosts`

    ```bash
    # Used by proxy-chain NPM package tests
    127.0.0.1 localhost
    127.0.0.1 localhost-test
    ```

    The `localhost` entry is for avoiding dual-stack issues, e.g. when the test server listens at ::1
    (results of getaddrinfo have specified order) and the client attempts to connect to 127.0.0.1 .

    The `localhost-test` entry is a workaround to PhantomJS' behavior where it skips proxy servers for
    localhost addresses.

### Run tests

1. Run all tests (unit + e2e)

    ```bash
    npm test
    ```

2. Run only unit tests

    ```bash
    npm run test:unit
    ```

3. Run only e2e tests

    ```bash
    npm run test:e2e
    ```

4. Run a specific test file

    ```bash
    npm test test/e2e/anonymize_proxy.js
    ```

### Run tests with Bun

[Bun](https://bun.com) is supported as an alternative runtime. Install it from
https://bun.com, then run:

```bash
# Unit tests (always green on Bun, gates every PR)
npm run test:bun

# E2E tests — curated subset known to pass on Bun
npm run test:bun:e2e:compatible

# E2E tests — entire suite (some tests rely on Node-only HTTP semantics
# such as HTTP/1.1 pipelining and stream.pipeline behaviour that current
# Bun releases don't fully emulate; expect failures)
npm run test:bun:e2e:full

# Everything (unit + full e2e); same expected failures as above
npm run test:bun:all

# Everything Bun is known to support (unit + `compatible` e2e)
npm run test:bun:supported
```

Or in Docker, for a consistent Linux environment — see the Docker section
above (`npm run test:docker:bun`).

In CI, `bun_unit` and `bun_e2e` (in `compatible` mode) run on every PR.
The full Bun e2e suite is opt-in: trigger the **Check** workflow via
**Actions → Check → Run workflow** and pick `full` for the
`bun_e2e_mode` input.

The `compatible` subset is intentionally narrow today — it only runs the
URL-validation tests in `test/e2e/tcp_tunnel.js` (via `-t 'throws
error'`), which exercise `createTunnel`'s error paths without touching
the network. As individual networked tests are confirmed to pass on
Bun, widen the `test:bun:e2e:compatible` script in `package.json` (drop
the `-t` filter, add files, or list specific test names).
