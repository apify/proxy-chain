/**
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {*} handlerOpts
 * @returns Promise.
 */
const handleCustomResponse = async (request, response, handlerOpts) => {
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
        // eslint is broken
        // eslint-disable-next-line no-restricted-syntax
        for (const [key, value] of Object.entries(customResponse.headers)) {
            response.setHeader(key, value);
        }
    }

    response.end(customResponse.body, customResponse.encoding);
};

module.exports.handleCustomResponse = handleCustomResponse;
