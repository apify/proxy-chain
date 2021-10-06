export const decodeURIComponentSafe = (encodedURIComponent: string): string => {
    try {
        return decodeURIComponent(encodedURIComponent);
    } catch (e) {
        return encodedURIComponent;
    }
};
