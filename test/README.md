
To run the tests, you need to add the following line to your `/etc/hosts`:

```
# Used by proxy-chain NPM package tests
127.0.0.1 localhost
127.0.0.1 localhost-test
```

The `localhost` entry is for avoiding dual-stack issues, e.g. when the test server listens at ::1
(results of getaddrinfo have specifed order) and the client attempts to connect to 127.0.0.1 .

The `localhost-test` entry is a workaround to PhantomJS' behavior where it skips proxy servers for
localhost addresses.
