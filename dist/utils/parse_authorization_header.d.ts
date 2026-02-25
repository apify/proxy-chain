interface Authorization {
    type: string;
    data: string;
    username?: string;
    password?: string;
}
export declare const parseAuthorizationHeader: (header: string) => Authorization | null;
export {};
//# sourceMappingURL=parse_authorization_header.d.ts.map