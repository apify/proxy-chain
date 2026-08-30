import { expect } from 'vitest';

import { httpRequest, type HttpRequestOpts } from './http_client.js';

/** Asserts a CONNECT through the proxy failed with the given status code. */
export const expectProxyTunnelError = async (promise: Promise<unknown>, statusCode: number): Promise<void> => {
    await expect(promise).rejects.toThrow(new RegExp(`Proxy response \\(${statusCode}\\)`));
};

export const expectSuccessfulRequest = async (
    opts: HttpRequestOpts & { expectBodyContainsText: string },
): Promise<void> => {
    const { expectBodyContainsText, ...requestOpts } = opts;
    const response = await httpRequest(requestOpts);

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(expectBodyContainsText);
};
