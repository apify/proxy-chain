import type net from 'node:net';
import type tls from 'node:tls';

type AdditionalProps = {
    proxyChainId?: number;
    proxyChainErrorHandled?: boolean;
    tlsOverheadAvailable?: boolean;
    /**
     * Contains net.Socket (parent) socket for tls.TLSSocket and should be `undefined` for net.Socket.
     * It's not officially documented in Node.js docs.
     * See https://github.com/nodejs/node/blob/v25.0.0/lib/internal/tls/wrap.js#L939
     */
    _parent?: Socket | undefined;
};

export type Socket = net.Socket & AdditionalProps;
export type TLSSocket = tls.TLSSocket & AdditionalProps;
