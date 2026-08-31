# TypeScript conventions

## Repo specifics

- `"type": "module"` with `module` and `moduleResolution` set to `NodeNext`, plus `verbatimModuleSyntax`. Relative imports end in `.js`, type-only imports use `import type`, and Node builtins use the `node:` prefix.
- Files are `snake_case.ts`. Identifiers are `camelCase`, types and classes `PascalCase`, module-level constants `SCREAMING_SNAKE`.
- Named exports only. `import/no-default-export` is enforced, config files opt out inline.
- Throw `RequestError(message, statusCode, headers?)` from [`src/request_error.ts`](../../src/request_error.ts) for anything the client should see. Anything else becomes a 500 and a `requestFailed` event.
- There is no logger dependency. `Server.log(connectionId, message)` prints only when `verbose` is set. Other modules receive `server` in their opts and call `server.log(...)`. That is the only logging seam, do not add `console` calls elsewhere.
- `dist/` is built by `tsc`. `declarationMap` and `sourceMap` are off on purpose, and the empty `.npmignore` is intentional. Both carry a comment explaining why.

## Core conventions

- Prefer early returns. Keep the main logic at the lowest practical indentation level.
- Prefer object parameters for more than 3 parameters, or when parameters are easy to mix up.
- Use `?` only when omitting the parameter is a meaningful call shape. Use `| undefined` when the parameter still conceptually belongs in every call.
- Prefer fixing types over casting. If a cast is temporarily necessary, keep the logic correct and leave a TODO.
- Do not use `any` if it can be avoided. Prefer `unknown` when the type is genuinely not known.
- Avoid enums. Use `as const` objects plus `ValueOf<typeof ...>`, and name them in singular.
- Do not mutate parameters. Keep other mutation local and deliberate.
- Use full descriptive names. Avoid `T`, `i` or `acc` when a clearer name exists.
- Use boolean names such as `isX`, `hasX` and `shouldX`.
- Use unit suffixes for measured values (`timeoutMillis`, `bytesWritten`) and the `At` suffix for timestamps (`connectedAt`).
- Keep functions short and keep related logic close together. If you can clearly name a chunk of logic, extract it, but do not chain helpers so deeply that the flow becomes hard to follow.

## Comments

- Do not add comments that restate the code. Most of the codebase is self-documenting.
- Keep comments short and factual, in proper English, ending with a full stop.
