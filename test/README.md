# Tests

## Prerequisites

1. For MacOS with ARM CPUs install Rosetta (workaround for puppeteer)

    ```bash
    softwareupdate --install-rosetta
    ```

3. Install nvm and use specific node version

    ```bash
    nvm use
    ```

4. Update `/etc/hosts`

    ```bash
    # Used by proxy-chain NPM package tests
    127.0.0.1 localhost
    127.0.0.1 localhost-test
    ```

    The `localhost` entry is for avoiding dual-stack issues, e.g. when the test server listens at ::1
    (results of getaddrinfo have specifed order) and the client attempts to connect to 127.0.0.1 .

    The `localhost-test` entry is a workaround to PhantomJS' behavior where it skips proxy servers for
    localhost addresses.

## Run tests

1. Run all tests

    ```bash
    npm run test
    ```

2. Run specifc tests

    ```bash
    npm run test test/anonymize_proxy.js
    ```
