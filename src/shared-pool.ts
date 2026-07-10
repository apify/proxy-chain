import net from 'node:net';
import type { DpsApi } from './dps-api.js';

const TAG = '[SharedPool]';

interface CachedIp {
    ip: string;
    port: number;
    acquiredAt: number;
}

export class SharedPool {
    private dpsApi: DpsApi;
    private ttlMs: number;
    private currentIP: CachedIp | null = null;
    private lastRequestTime = 0;

    // ProxyCat 策略: lock + cooldown
    private switching = false;
    private lastFailureTime = 0;
    private readonly COOLDOWN_MS = 3_000;

    // 空闲监测
    private isIdle = false;

    // 并发安全: 防止重复调用 DPS API
    private fetchPromise: Promise<CachedIp | null> | null = null;

    constructor({ dpsApi, ttlMs }: { dpsApi: DpsApi; ttlMs: number }) {
        this.dpsApi = dpsApi;
        this.ttlMs = ttlMs;
    }

    async acquire(): Promise<CachedIp | null> {
        if (this.isIdle) this.wake();

        if (this.currentIP && Date.now() - this.currentIP.acquiredAt < this.ttlMs) {
            return this.currentIP;
        }

        // 并发安全: 已有 fetch 在进行中, 复用结果
        if (this.fetchPromise) return this.fetchPromise;

        this.fetchPromise = this.fetchNew();
        try {
            return await this.fetchPromise;
        } finally {
            this.fetchPromise = null;
        }
    }

    touchLastRequest(): void {
        this.lastRequestTime = Date.now();
    }

    /**
     * ProxyCat 策略: lock + cooldown + verify-before-switch
     * CONNECT 失败时调用
     */
    async invalidateWithCooldown(): Promise<void> {
        if (this.switching) return;
        if (Date.now() - this.lastFailureTime < this.COOLDOWN_MS) return;

        this.switching = true;
        this.lastFailureTime = Date.now();
        try {
            if (this.currentIP && await this.isCurrentIpStillValid()) {
                console.log(`${TAG} IP still valid after failure, keeping ${this.currentIP.ip}:${this.currentIP.port}`);
                return;
            }
            console.log(`${TAG} discarding dead IP ${this.currentIP?.ip}:${this.currentIP?.port}`);
            this.currentIP = null;
        } finally {
            this.switching = false;
        }
    }

    startIdleMonitor(): void {
        setInterval(() => {
            if (!this.isIdle && this.lastRequestTime > 0 && Date.now() - this.lastRequestTime > this.ttlMs * 2) {
                console.log(`${TAG} idle for >${this.ttlMs * 2}ms, pausing refresh`);
                this.isIdle = true;
                this.currentIP = null;
            }
        }, 60_000);
    }

    // ---- internals ----

    private async fetchNew(retries = 1): Promise<CachedIp | null> {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const ip = await this.dpsApi.getDpsIp();
                this.currentIP = { ...ip, acquiredAt: Date.now() };
                console.log(`${TAG} acquired new IP ${ip.ip}:${ip.port}`);
                return this.currentIP;
            } catch (err: any) {
                console.warn(`${TAG} fetch attempt ${attempt + 1}/${retries + 1} failed: ${err.message}`);
                if (attempt < retries) await sleep(300);
            }
        }
        console.error(`${TAG} all fetch attempts failed`);
        return null;
    }

    private async isCurrentIpStillValid(): Promise<boolean> {
        if (!this.currentIP) return false;
        return new Promise<boolean>((resolve) => {
            const socket = net.connect({ host: this.currentIP!.ip, port: this.currentIP!.port });
            const cleanup = (ok: boolean) => { try { socket.destroy(); } catch {} resolve(ok); };
            const timer = setTimeout(() => cleanup(false), 3_000);
            socket.on('error', () => { clearTimeout(timer); cleanup(false); });
            socket.once('connect', () => { clearTimeout(timer); cleanup(true); });
        });
    }

    private wake(): void {
        this.isIdle = false;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
