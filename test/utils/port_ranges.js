/**
 * Each e2e scan site gets its own window, so that test files binding real servers
 * can run in parallel without handing out the same port to two of them.
 *
 * The windows stay below 32768 to sit outside the ephemeral port range (Linux
 * defaults to 32768-60999, macOS to 49152-65535). `portastic` only proves a port
 * is free at scan time, so a window inside that range can be taken by an outbound
 * socket - or by a `port: 0` server - in the gap before we bind.
 *
 * Keep the windows disjoint.
 */
export const PORT_RANGES = {
    server: { min: 20000, max: 20099 },
    httpAgentHttp: { min: 20100, max: 20199 },
    httpAgentHttps: { min: 20200, max: 20299 },
    anonymizeProxy: { min: 20300, max: 20399 },
    anonymizeProxyNoPassword: { min: 20400, max: 20499 },
    socksNoAuth: { min: 20500, max: 20599 },
    socksAuth: { min: 20600, max: 20699 },
    socksAnonymize: { min: 20700, max: 20799 },
};
