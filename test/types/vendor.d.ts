/**
 * Minimal declarations for test-only dependencies that ship no types and have no
 * `@types` package. Each block covers only the surface the tests actually use.
 */

declare module 'portastic' {
    export function find(options: { min: number; max: number }): Promise<number[]>;
}

declare module 'basic-auth-parser' {
    function parse(header: string): {
        scheme: string;
        username: string;
        password: string;
    };

    // eslint-disable-next-line import-x/no-default-export -- mirrors the package's `module.exports = parse`.
    export default parse;
}

declare module 'socksv5' {
    import type net from 'node:net';

    export type SocksAuth = {
        METHOD: number;
        server(stream: net.Socket, callback: (success: boolean) => void): void;
    };

    export type SocksConnectionInfo = {
        srcAddr: string;
        srcPort: number;
        dstAddr: string;
        dstPort: number;
    };

    /**
     * socksv5's server is a bare `EventEmitter` wrapping a private `net.Server`, so it
     * forwards only the methods below - `net.Server` members such as `listening` are absent.
     */
    export type SocksServer = {
        listen(port?: number, hostname?: string, callback?: () => void): SocksServer;
        address(): net.AddressInfo | string | null;
        close(callback?: (error?: Error) => void): SocksServer;
        useAuth(auth: SocksAuth): SocksServer;
    };

    /**
     * `index.js` re-exports through a runtime loop, so Node's CJS named-export detection
     * finds nothing - only the default import works outside bundlers.
     */
    const socksv5: {
        createServer(
            handler: (
                info: SocksConnectionInfo,
                accept: (intercept?: boolean) => net.Socket | undefined,
                deny: () => void,
            ) => void,
        ): SocksServer;

        auth: {
            None(): SocksAuth;
            UserPassword(
                check: (username: string, password: string, callback: (success: boolean) => void) => void,
            ): SocksAuth;
        };
    };

    // eslint-disable-next-line import-x/no-default-export -- see the note above.
    export default socksv5;
}

declare module 'faye-websocket' {
    import type { Buffer } from 'node:buffer';

    export type FayeMessageEvent = { data: string };

    export type FayeClientOptions = {
        // faye-specific: routes the handshake through an upstream proxy.
        proxy?: {
            origin: string | undefined;
            tls?: { cert: Buffer } | null;
        };
    };

    export class Client {
        constructor(url: string, protocols?: string[], options?: FayeClientOptions);
        on(event: 'open' | 'close', listener: () => void): void;
        on(event: 'message', listener: (event: FayeMessageEvent) => void): void;
        on(event: 'error', listener: (error: Error) => void): void;
        send(message: string): void;
        close(): void;
    }
}
