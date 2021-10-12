export const decodeURIComponentSafe = (encodedURIComponent: string): string => {
    try {
        return decodeURIComponent(encodedURIComponent);
<<<<<<< HEAD
    } catch {
=======
    } catch (e) {
>>>>>>> f1bbe42 (release: 2.0.0 (#162))
        return encodedURIComponent;
    }
};
