# Testing

## Core conventions

- Vitest with two projects defined in [`vitest.config.ts`](../../vitest.config.ts): `unit` (`test/unit/**/*.ts`) and `e2e` (`test/e2e/**/*.ts`). `pnpm test` runs both with coverage, `pnpm run test:unit` and `pnpm run test:e2e` run one. For a single file use `pnpm vitest run test/e2e/<file>.ts`.
- Globals are off. Import `describe`, `it`, `expect` and the rest from `vitest`.
- Test files have no `.test.` or `.spec.` suffix, membership is by directory. Any `.ts` file added under `test/unit/` or `test/e2e/` becomes a test file, so shared code belongs in `test/utils/`, which is not a project.
- Never pick a port ad hoc. Take a disjoint window from [`test/utils/port_ranges.ts`](../../test/utils/port_ranges.ts), which stays below the ephemeral range, then use `portastic.find()` and `takePort()`. A new e2e file that binds servers needs a new range key.
- The e2e timeout is 2000 ms so hangs fail fast. Slow suites opt out explicitly, for example `describe(name, { timeout: 50_000 }, ...)`.
- Use `listenOnPort`, `closeServer`, `getServerPort`, `takePort` and `wait` from [`test/utils/test_helpers.ts`](../../test/utils/test_helpers.ts), and `TargetServer` from [`test/utils/target_server.ts`](../../test/utils/target_server.ts), instead of raw callbacks.
- Local e2e needs `127.0.0.1 localhost-test` in `/etc/hosts`. macOS and Linux handle sockets differently, so `pnpm run test:docker` is the reference environment.
- Declare untyped test dependencies in [`test/types/vendor.d.ts`](../../test/types/vendor.d.ts) rather than casting to `any`.
- Cover the unit's own branches, one behaviour per test. Do not re-test dependencies that have their own suites, and do not test what TypeScript already guarantees.
- Fix the tests your change breaks.

## More detail

[test/README.md](../../test/README.md) covers the Docker setup, the required `/etc/hosts` entries and the Bun
compatibility matrix.
