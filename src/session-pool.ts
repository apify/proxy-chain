import net from 'node:net';
import type { DpsApi } from './dps-api.js';

const TAG = '[SessionPool]';

class SessionEntry {
    ip: string;
    port: number;
    targetHost: string;
    acquiredAt: number;
    lastRequestTime: number;
    healthStatus: 'ok' | 'checking' | 'fail' | 'dormant';
    billingPeriod: { failureCount: number; failureThreshold: number };

    constructor(ip: string, port: number, targetHost: string) {
        this.ip = ip;
        this.port = port;
        this.targetHost = targetHost;
        this.acquiredAt = Date.now();
        this.lastRequestTime = Date.now();
        this.healthStatus = 'ok';
        this.billingPeriod = { failureCount: 0, failureThreshold: 2 };
    }
}

export class SessionPool {
    private dpsApi: DpsApi;
    private ttlMs: number;
    private sessions = new Map<string, SessionEntry>();
    private acquiring = new Map<string, Promise<SessionEntry>>(); // per-session 锁

    constructor({ dpsApi, ttlMs }: { dpsApi: DpsApi; ttlMs: number }) {
        this.dpsApi = dpsApi;
        this.ttlMs = ttlMs;
    }

    async getOrCreate(sessionId: string, targetHost: string): Promise<SessionEntry> {
        const entry = this.sessions.get(sessionId);
        if (entry && !this.isExpired(entry)) {
            entry.lastRequestTime = Date.now();
            return entry;
        }

        // 并发安全: 已有获取在进行中, 复用结果
        if (this.acquiring.has(sessionId)) {
            return this.acquiring.get(sessionId)!;
        }

        const promise = this.acquireWithHealthCheck(sessionId, targetHost);
        this.acquiring.set(sessionId, promise);
        try {
            return await promise;
        } finally {
            this.acquiring.delete(sessionId);
        }
    }

    touchLastRequest(sessionId: string): void {
        const entry = this.sessions.get(sessionId);
        if (entry) entry.lastRequestTime = Date.now();
    }

    /**
     * 记录请求失败 (账期计数)
     * 达到阈值后触发健康检查, 不通过则丢弃 IP
     */
    async recordFailure(sessionId: string): Promise<void> {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;

        entry.billingPeriod.failureCount++;
        console.log(`${TAG} ${sessionId} failure ${entry.billingPeriod.failureCount}/${entry.billingPeriod.failureThreshold}`);

        if (entry.billingPeriod.failureCount >= entry.billingPeriod.failureThreshold) {
            const alive = await this.checkEntryHealth(entry);
            if (!alive) {
                console.log(`${TAG} ${sessionId} health check failed, discarding IP ${entry.ip}:${entry.port}`);
                this.sessions.delete(sessionId);
            } else {
                console.log(`${TAG} ${sessionId} health check passed, resetting failure count`);
                entry.billingPeriod.failureCount = 0;
            }
        }
    }

    /** 活跃期定期健康检查 (每 5min) */
    startHealthChecker(): void {
        setInterval(async () => {
            for (const [id, entry] of this.sessions) {
                if (entry.healthStatus === 'dormant') continue;
                const alive = await this.checkEntryHealth(entry);
                if (!alive) {
                    console.log(`${TAG} ${id} periodic check failed, discarding IP`);
                    this.sessions.delete(id);
                } else {
                    entry.billingPeriod.failureCount = 0;
                }
            }
        }, 5 * 60_000);
    }

    /** 空闲监测: 2×TTL 标记 dormant, 4×TTL 清理 */
    startIdleMonitor(): void {
        setInterval(() => {
            const now = Date.now();
            for (const [id, entry] of this.sessions) {
                const idle = now - entry.lastRequestTime;
                if (idle > this.ttlMs * 4) {
                    console.log(`${TAG} ${id} dormant > 4×TTL, cleaning up`);
                    this.sessions.delete(id);
                } else if (idle > this.ttlMs * 2) {
                    entry.healthStatus = 'dormant';
                }
            }
        }, 60_000);
    }

    // ---- internals ----

    private async acquireWithHealthCheck(sessionId: string, targetHost: string): Promise<SessionEntry> {
        for (let i = 0; i < 5; i++) {
            try {
                const ip = await this.dpsApi.getDpsIp();
                const healthy = await this.checkHealth(ip, targetHost);
                if (healthy) {
                    const entry = new SessionEntry(ip.ip, ip.port, targetHost);
                    this.sessions.set(sessionId, entry);
                    console.log(`${TAG} ${sessionId} acquired IP ${ip.ip}:${ip.port} (attempt ${i + 1})`);
                    return entry;
                }
                console.warn(`${TAG} ${sessionId} health check failed for ${ip.ip}:${ip.port} (attempt ${i + 1})`);
            } catch (err: any) {
                console.warn(`${TAG} ${sessionId} acquire attempt ${i + 1} failed: ${err.message}`);
            }
        }
        throw new Error(`${TAG} ${sessionId} failed to get healthy IP after 5 attempts`);
    }

    /** 统一健康检查: CONNECT 到 target:443 */
    private checkHealth(ipObj: { ip: string; port: number }, targetHost: string): Promise<boolean> {
        const target = targetHost || 'www.baidu.com';
        return new Promise<boolean>((resolve) => {
            const socket = net.connect({ host: ipObj.ip, port: ipObj.port });
            const cleanup = (ok: boolean) => { try { socket.destroy(); } catch {} resolve(ok); };
            const timer = setTimeout(() => cleanup(false), 4_000);
            socket.on('error', () => { clearTimeout(timer); cleanup(false); });
            socket.on('close', () => clearTimeout(timer));
            socket.once('connect', () => {
                const auth = Buffer.from(
                    `${this.dpsApi.proxyUsername}:${this.dpsApi.proxyPassword || ''}`
                ).toString('base64');
                socket.write(
                    `CONNECT ${target}:443 HTTP/1.1\r\n` +
                    `Host: ${target}:443\r\n` +
                    `Proxy-Authorization: Basic ${auth}\r\n\r\n`
                );
            });
            let buf = '';
            socket.on('data', (chunk: Buffer) => {
                buf += chunk.toString();
                const firstLine = buf.split('\r\n')[0];
                if (/^HTTP\/1\.[01] 2\d\d /.test(firstLine)) {
                    clearTimeout(timer); cleanup(true);
                } else if (/^HTTP\/1\.[01] [3-5]\d\d /.test(firstLine)) {
                    clearTimeout(timer); cleanup(false);
                }
            });
        });
    }

    private checkEntryHealth(entry: SessionEntry): Promise<boolean> {
        return this.checkHealth({ ip: entry.ip, port: entry.port }, entry.targetHost);
    }

    private isExpired(entry: SessionEntry): boolean {
        return Date.now() - entry.acquiredAt >= this.ttlMs;
    }
}
