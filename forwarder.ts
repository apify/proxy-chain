/**
 * Unified DPS proxy forwarder v2
 *
 * 基于 proxy-chain v3.0.0 源码二次开发。
 * proxy-chain Server 负责 CONNECT 隧道建立和数据转发，
 * 本入口通过 prepareRequestFunction 回调选择 DPS IP。
 *
 * 支持双模式:
 *   - shared (无 auth): 全局共享短命 IP, 供 web-archiver
 *   - session (有 auth): per-session sticky 长命 IP, 供 web-collector
 */

import { Server } from './src/server.js';
import { DpsApi } from './src/dps-api.js';
import { SharedPool } from './src/shared-pool.js';
import { SessionPool } from './src/session-pool.js';

const TAG = '[Forwarder]';

// ── 配置 ──

function env(key: string, fallback = ''): string {
    return process.env[key] || fallback;
}

function envNum(key: string, fallback: number): number {
    const v = process.env[key];
    return v ? parseInt(v, 10) : fallback;
}

const PORT = envNum('FORWARDER_PORT', 3128);
const SHARED_TTL_MS = envNum('SHARED_TTL_MS', 90_000);     // 1.5min
const SESSION_TTL_MS = envNum('SESSION_TTL_MS', 900_000);   // 15min

// ── 初始化双订单 DPS API ──

// 短命池订单: IP 寿命 1-2min, 供 web-archiver (shared 模式)
const dpsApiShort = new DpsApi({
    secretId: env('DPS_SHORT_SECRET_ID'),
    secretKey: env('DPS_SHORT_SECRET_KEY'),
    proxyUsername: env('DPS_SHORT_PROXY_USERNAME'),
    proxyPassword: env('DPS_SHORT_PROXY_PASSWORD'),
    orderKey: 'short',
});

// 长命池订单: IP 寿命 15-20min, 供 web-collector (session 模式)
const dpsApiLong = new DpsApi({
    secretId: env('DPS_LONG_SECRET_ID'),
    secretKey: env('DPS_LONG_SECRET_KEY'),
    proxyUsername: env('DPS_LONG_PROXY_USERNAME'),
    proxyPassword: env('DPS_LONG_PROXY_PASSWORD'),
    orderKey: 'long',
});

// ── 初始化双池 ──

const sharedPool = new SharedPool({ dpsApi: dpsApiShort, ttlMs: SHARED_TTL_MS });
const sessionPool = new SessionPool({ dpsApi: dpsApiLong, ttlMs: SESSION_TTL_MS });

// ── 创建 proxy-chain Server ──

const server = new Server({
    port: PORT,
    verbose: env('FORWARDER_VERBOSE') === 'true',
    prepareRequestFunction: async ({ username, hostname }) => {
        try {
            if (!username) {
                // Shared 模式: 从 SharedPool 获取 DPS IP
                const ip = await sharedPool.acquire();
                if (!ip) throw new Error('SharedPool: failed to acquire DPS IP');
                sharedPool.touchLastRequest();
                return {
                    upstreamProxyUrl: `http://${ip.ip}:${ip.port}`,
                    customTag: { mode: 'shared' as const },
                };
            } else {
                // Session 模式: 从 SessionPool 获取 sticky IP
                const entry = await sessionPool.getOrCreate(username, hostname);
                sessionPool.touchLastRequest(username);
                return {
                    upstreamProxyUrl: `http://${entry.ip}:${entry.port}`,
                    customTag: { mode: 'session' as const, id: username },
                };
            }
        } catch (err: any) {
            console.error(`${TAG} prepareRequestFunction error: ${err.message}`);
            throw err; // proxy-chain 会转为 502 响应
        }
    },
});

// ── 事件处理: 故障转移 ──

server.on('tunnelConnectFailed', async ({ customTag }: { customTag?: { mode: string; id?: string } }) => {
    try {
        if (customTag?.mode === 'shared') {
            await sharedPool.invalidateWithCooldown();
        } else if (customTag?.mode === 'session' && customTag.id) {
            await sessionPool.recordFailure(customTag.id);
        }
    } catch (err: any) {
        console.error(`${TAG} tunnelConnectFailed handler error: ${err.message}`);
    }
});

// ── 事件处理: 流量统计 ──

server.on('connectionClosed', ({ connectionId, stats }: { connectionId: number; stats: any }) => {
    console.log(`${TAG} [${connectionId}] srcTx=${stats.srcTxBytes} srcRx=${stats.srcRxBytes} trgTx=${stats.trgTxBytes} trgRx=${stats.trgRxBytes}`);
});

// ── 启动 ──

await server.listen();
console.log(`${TAG} listening on :${server.port}`);
console.log(`${TAG} shared TTL=${SHARED_TTL_MS}ms, session TTL=${SESSION_TTL_MS}ms`);

// 启动空闲监测 + 定期健康检查
sharedPool.startIdleMonitor();
sessionPool.startIdleMonitor();
sessionPool.startHealthChecker();

// 优雅关闭
const shutdown = async () => {
    console.log(`${TAG} shutting down...`);
    await server.close(true);
    process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
