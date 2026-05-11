# Tests

The test suite is split into two directories:

- `test/unit/` — pure unit tests over utility helpers (no network, no proxy
  servers). Fast; runs in CI on every supported major Node.js version.
- `test/e2e/` — end-to-end tests that spin up real HTTP/HTTPS/SOCKS proxy
  servers and target servers. Heavier; runs in CI on the latest Node.js
  only.

Shared helpers live in `test/utils/`.

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
    npm run test:docker test/e2e/server.js -- --grep "direct ipv6"
    ```

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
```

In CI, `bun_unit` and `bun_e2e` (in `compatible` mode) run on every PR.
The full Bun e2e suite is opt-in: trigger the **Check** workflow via
**Actions → Check → Run workflow** and pick `full` for the
`bun_e2e_mode` input.

The `compatible` subset is intentionally narrow today — it only runs the
URL-validation tests in `test/e2e/tcp_tunnel.js` (via `--grep 'throws
error'`), which exercise `createTunnel`'s error paths without touching
the network. As individual networked tests are confirmed to pass on
Bun, widen the `test:bun:e2e:compatible` script in `package.json` (drop
the `--grep`, add files, or list specific test names).
