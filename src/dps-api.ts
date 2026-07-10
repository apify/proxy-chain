import net from 'node:net';

const TAG = '[DpsApi]';

export class DpsApi {
    secretId: string;
    secretKey: string;
    proxyUsername: string;
    proxyPassword: string;
    orderKey: string;
    private apiEndpoint: string;
    private secretToken: string | null = null;
    private tokenFetchedAt = 0;
    private readonly TOKEN_TTL_MS = 50 * 60 * 1000; // 50min

    constructor({ secretId, secretKey, proxyUsername, proxyPassword, orderKey, apiEndpoint }: {
        secretId: string;
        secretKey: string;
        proxyUsername: string;
        proxyPassword: string;
        orderKey: string;
        apiEndpoint?: string;
    }) {
        if (!secretId || !secretKey) throw new Error(`[${orderKey}] secretId and secretKey are required`);
        this.secretId = secretId;
        this.secretKey = secretKey;
        this.proxyUsername = proxyUsername;
        this.proxyPassword = proxyPassword;
        this.orderKey = orderKey;
        this.apiEndpoint = apiEndpoint || 'https://dps.kdlapi.com/api';
    }

    async getDpsIp(): Promise<{ ip: string; port: number }> {
        const token = await this.ensureToken();
        const url = `${this.apiEndpoint}/getdps`;
        const params = new URLSearchParams({
            secret_id: this.secretId,
            signature: token,
            num: '1',
            format: 'text',
            sep: '1',
        });

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: params.toString(),
                signal: ctrl.signal,
            });
            const text = (await res.text()).trim();

            if (!res.ok) {
                if (/signature|token/i.test(text)) this.secretToken = null;
                throw new Error(`getdps HTTP ${res.status} body=${truncate(text)}`);
            }

            if (text.startsWith('{')) {
                try {
                    const j = JSON.parse(text);
                    if (typeof j === 'object' && j.code != null && j.code !== 0) {
                        if (/signature|token/i.test(j.msg || '')) this.secretToken = null;
                        throw new Error(`getdps error: ${j.msg || `code=${j.code}`}`);
                    }
                } catch (e: any) {
                    if (e.code != null) throw e;
                }
            }

            const m = /^([0-9.]+):(\d+)$/.exec(text.split(/\s+/)[0]);
            if (!m) throw new Error(`getdps unexpected body: ${truncate(text)}`);
            return { ip: m[1], port: parseInt(m[2], 10) };
        } finally {
            clearTimeout(timer);
        }
    }

    private async ensureToken(): Promise<string> {
        const now = Date.now();
        if (this.secretToken && now - this.tokenFetchedAt < this.TOKEN_TTL_MS) {
            return this.secretToken;
        }

        const url = `${this.apiEndpoint}/get_secret_token`;
        const params = new URLSearchParams({
            secret_id: this.secretId,
            secret_key: this.secretKey,
        });

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
        });
        const text = (await res.text()).trim();

        if (res.ok && text) {
            if (text.startsWith('{')) {
                const j = JSON.parse(text);
                if (j.code === 0 && j.data?.secret_token) {
                    this.secretToken = j.data.secret_token;
                    this.tokenFetchedAt = now;
                    console.log(`${TAG}[${this.orderKey}] token refreshed`);
                    return this.secretToken!;
                }
                throw new Error(`get_secret_token error: ${text}`);
            } else if (!text.startsWith('ERROR')) {
                this.secretToken = text;
                this.tokenFetchedAt = now;
                return this.secretToken!;
            }
        }

        throw new Error(`[${this.orderKey}] get_secret_token failed: HTTP ${res.status}`);
    }
}

function truncate(s: string | null): string {
    if (s == null) return '';
    return s.length <= 200 ? s : s.slice(0, 200) + '...';
}
