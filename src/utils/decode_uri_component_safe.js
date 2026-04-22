"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeURIComponentSafe = void 0;
const decodeURIComponentSafe = (encodedURIComponent) => {
    try {
        return decodeURIComponent(encodedURIComponent);
    }
    catch {
        return encodedURIComponent;
    }
};
exports.decodeURIComponentSafe = decodeURIComponentSafe;
