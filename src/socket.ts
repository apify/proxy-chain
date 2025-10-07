import type net from 'node:net';
import type tls from 'node:tls';

type AdditionalProps = {
    proxyChainId?: number;
    proxyChainErrorHandled?: boolean;
};

export type Socket = net.Socket & AdditionalProps;
export type TLSSocket = tls.TLSSocket & AdditionalProps;
