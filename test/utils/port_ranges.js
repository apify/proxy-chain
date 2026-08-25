/**
 * One disjoint window per e2e scan site, so test files can bind servers in parallel.
 * Kept below 32768 to stay out of the ephemeral range, which the kernel hands out
 * to outbound sockets and `port: 0` servers.
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
