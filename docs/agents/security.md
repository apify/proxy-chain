# Security

## Core conventions

- Proxy URLs carry credentials. Run every one through `redactUrl()` from [`src/utils/redact_url.ts`](../../src/utils/redact_url.ts) before it reaches a log message, an error message or an event payload.
- Never log `Proxy-Authorization` or `Authorization` headers, and never echo them back to the client.
- Hop-by-hop headers are stripped through [`src/utils/is_hop_by_hop_header.ts`](../../src/utils/is_hop_by_hop_header.ts) and [`src/utils/valid_headers_only.ts`](../../src/utils/valid_headers_only.ts). Do not bypass them when adding a code path that forwards headers.
- Errors returned to clients must not reveal the upstream proxy URL, its credentials or its hostname.
- User-caused failures are a `RequestError` with a 4xx or a 59x status code. Everything else becomes a 500 and a `requestFailed` event.
