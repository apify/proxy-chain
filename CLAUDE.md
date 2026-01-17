# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

proxy-chain is a programmable HTTP/HTTPS proxy server for Node.js with support for SSL/TLS, authentication, upstream proxy chaining (HTTP/HTTPS/SOCKS), custom HTTP responses, and traffic statistics. It's used by Apify Proxy and the Crawlee web scraping library.

## Build & Development Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run build:watch    # Watch mode compilation
npm run lint           # ESLint check
npm run lint:fix       # ESLint auto-fix
npm run local-proxy    # Run local proxy server for testing
```

## Testing

Docker-based testing is recommended due to Linux/macOS socket handling differences:

```bash
npm run test:docker                              # Run all tests in Docker
npm run test:docker test/server.js               # Run specific test file
npm run test:docker -- --grep "direct ipv6"      # Run tests matching pattern
```

Local testing requires `/etc/hosts` entry:
```
127.0.0.1 localhost-test
```

```bash
npm run test                        # Run all tests locally
npm run test test/anonymize_proxy.js  # Run specific test file
```

Tests use Mocha with ts-node. Coverage via nyc.

## Architecture

### Request Flow

1. `Server` class (server.ts) receives HTTP requests or CONNECT tunnels
2. User-provided `prepareRequestFunction` determines authentication and routing
3. Request is dispatched to the appropriate handler based on protocol and upstream type

### Handler Modules

- **direct.ts** - Direct CONNECT tunneling to target (no upstream proxy)
- **forward.ts** - HTTP forwarding to target or upstream HTTP/HTTPS proxy
- **chain.ts** - CONNECT tunneling through upstream HTTP/HTTPS proxy
- **chain_socks.ts** - CONNECT tunneling through SOCKS proxy
- **forward_socks.ts** - HTTP forwarding through SOCKS proxy
- **custom_response.ts** - Generate custom HTTP responses without contacting upstream
- **custom_connect.ts** - Route CONNECT requests to custom HTTP server

### Key Source Files

- **server.ts** - Main `Server` class (EventEmitter), handles connection lifecycle
- **statuses.ts** - Custom HTTP status codes 590-599 for proxy-specific errors
- **request_error.ts** - `RequestError` class for custom error responses
- **anonymize_proxy.ts** - Helper to create local anonymous proxy for authenticated upstreams
- **tcp_tunnel_tools.ts** - `createTunnel`/`closeTunnel` for TCP tunneling

### Connection Tracking

Each connection gets a unique ID. Statistics tracked per connection: `srcTxBytes`, `srcRxBytes`, `trgTxBytes`, `trgRxBytes`. Access via `server.getConnectionStats(connectionId)`.

### Server Types

- `serverType: 'http'` (default) - Standard HTTP proxy
- `serverType: 'https'` - HTTPS proxy requiring `httpsOptions: { key, cert }`

## Custom Status Codes

- 590: Upstream non-200 response
- 593: DNS lookup failed
- 594: Connection refused
- 595: Connection reset
- 596: Broken pipe
- 597: Auth failed
- 599: Generic upstream error
