"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleCustomResponse = void 0;
const handleCustomResponse = async (_request, response, handlerOpts) => {
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
            response.setHeader(key, value);
        }
    }
    response.end(customResponse.body, customResponse.encoding);
};
exports.handleCustomResponse = handleCustomResponse;
//# sourceMappingURL=custom_response.js.map