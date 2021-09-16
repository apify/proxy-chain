const decodeURIComponentSafe = (encodedURIComponent) => {
    try {
        return decodeURIComponent(encodedURIComponent);
    } catch (e) {
        return encodedURIComponent;
    }
};

module.exports.decodeURIComponentSafe = decodeURIComponentSafe;
