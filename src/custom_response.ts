import http from 'http';

export interface CustomResponse {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
    encoding?: BufferEncoding;
}

export interface HandlerOpts {
    customResponseFunction: () => CustomResponse | Promise<CustomResponse>,
}

export const handleCustomResponse = async (
    _request: http.IncomingMessage,
    response: http.ServerResponse,
    handlerOpts: HandlerOpts,
): Promise<void> => {
    const { customResponseFunction } = handlerOpts;
    if (!customResponseFunction) {
        throw new Error('The "customResponseFunction" option is required');
    }

    const customResponse = await customResponseFunction();

    if (typeof customResponse !== 'object' || customResponse === null) {
        throw new Error('The user-provided "customResponseFunction" must return an object.');
    }

    response.statusCode = customResponse.statusCode || 200;

    if (customResponse.headers) {
        for (const [key, value] of Object.entries(customResponse.headers)) {
            response.setHeader(key, value as string);
        }
    }

    response.end(customResponse.body, customResponse.encoding!);
};
