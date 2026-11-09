import { describe, expect, it } from 'vitest';

import { upstreamErrorStatusCodes } from '../../src/index.js';

describe('upstreamErrorStatusCodes', () => {
    it('matches the documented status codes', () => {
        expect(upstreamErrorStatusCodes).toEqual({
            TIMEOUT: 504,
            NON_200: 590,
            STATUS_CODE_OUT_OF_RANGE: 592,
            NOT_FOUND: 593,
            CONNECTION_REFUSED: 594,
            CONNECTION_RESET: 595,
            BROKEN_PIPE: 596,
            AUTH_FAILED: 597,
            GENERIC_ERROR: 599,
        });
    });

    it('is frozen so consumers cannot change the codes the server sends', () => {
        expect(Object.isFrozen(upstreamErrorStatusCodes)).toBe(true);
    });
});
