# Tests

## Docker (recommended)

Since Linux and macOS handle sockets differently, please run tests in a Docker container
to have a consistent Linux environment for running tests.

1. Build image

    ```bash
    docker build --tag proxy-chain-tests --file test/Dockerfile .
    ```

2. Run all tests

    ```bash
    docker run proxy-chain-tests
    ```

3. Run specific tests

    ```bash
    docker run proxy-chain-tests npm test test/socks.js
    ```

4. Interactive debugging

    ```bash
    docker run -it proxy-chain-tests bash
    ```


Note: for Docker no changes in `/etc/hosts` needed.

## Local Machine

### Prerequisites

1. Node.js 18+ (see `.nvmrc` for exact version)
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

1. Run all tests

    ```bash
    npm run test
    ```

2. Run specific tests

    ```bash
    npm run test test/anonymize_proxy.js
    ```
