# Architecture

## Core conventions

- The entry point is [`src/index.ts`](../../src/index.ts). It re-exports `server.ts`, `request_error.ts`, `anonymize_proxy.ts`, `tcp_tunnel_tools.ts`, `utils/redact_url.ts` and the `CustomResponse` type. Nothing else is public, so internal modules can be changed freely.
- [`src/server.ts`](../../src/server.ts) is the hot path. `Server extends EventEmitter`, owns the underlying `http` or `https` server, routes both plain requests and CONNECTs, and holds the `connections: Map<number, Socket>` registry.
- `prepareRequestFunction` is the per-request hook users configure. It decides authentication, the upstream proxy, and the optional `customResponseFunction` and `customConnectServer` overrides.
- Every socket is stamped with `proxyChainId` in `Server.registerConnection()`. That id is the correlation key for logs, the `connectionClosed` event, `closeConnection(id)` and `getConnectionStats(id)`.
- Requests are dispatched to one transport module per combination:

  | Request | Upstream | Handler |
  |---|---|---|
  | HTTP | none, or HTTP/HTTPS | [`src/forward.ts`](../../src/forward.ts) |
  | HTTP | SOCKS | [`src/forward_socks.ts`](../../src/forward_socks.ts) |
  | HTTP | `customResponseFunction` | [`src/custom_response.ts`](../../src/custom_response.ts) |
  | CONNECT | none | [`src/direct.ts`](../../src/direct.ts) |
  | CONNECT | HTTP/HTTPS | [`src/chain.ts`](../../src/chain.ts) |
  | CONNECT | SOCKS | [`src/chain_socks.ts`](../../src/chain_socks.ts) |
  | CONNECT | `customConnectServer` | [`src/custom_connect.ts`](../../src/custom_connect.ts) |

- Each transport module exports its own `HandlerOpts` type and a single entry function. `server.ts` imports them aliased and casts its own opts at the call site.
- [`src/statuses.ts`](../../src/statuses.ts) defines the non-standard 590-599 codes and mutates the global `http.STATUS_CODES` table at import time. 591 and 598 are unused.
- [`src/utils/`](../../src/utils) is nine single-purpose modules, one exported function each. Keep new helpers in that shape.
- Module-level registries are process-global: `anonymizedProxyUrlToServer` in [`src/anonymize_proxy.ts`](../../src/anonymize_proxy.ts) and `runningServers` in [`src/tcp_tunnel_tools.ts`](../../src/tcp_tunnel_tools.ts).

## More detail

[README.md](../../README.md) documents every `Server` option, the `prepareRequestFunction` contract and the meaning of
each 590-599 status code.
