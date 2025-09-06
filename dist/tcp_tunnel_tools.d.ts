export declare function createTunnel(proxyUrl: string, targetHost: string, options?: {
    verbose?: boolean;
    ignoreProxyCertificate?: boolean;
}, callback?: (error: Error | null, result?: string) => void): Promise<string>;
export declare function closeTunnel(serverPath: string, closeConnections: boolean | undefined, callback: (error: Error | null, result?: boolean) => void): Promise<boolean>;
//# sourceMappingURL=tcp_tunnel_tools.d.ts.map