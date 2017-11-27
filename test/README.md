
To run the tests, you need to add the following line to your `/etc/hosts`:

```
# Used by proxy-chain NPM package tests
127.0.0.1 localhost-test
```

This is a workaround to PhantomJS' behavior where it skips proxy servers for localhost addresses.