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
