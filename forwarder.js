/**
 * DPS 代理转发层 (sidecar) — DEPRECATED
 *
 * @deprecated 已被 forwarder v2 替代（webCllector/forwarder/）。
 *             forwarder v2 基于 proxy-chain v3.0.0，支持双 DPS 订单、双模式（shared/session）、
 *             账期失败计数、ProxyCat 策略故障转移、空闲监测等。
 *             保留此文件用于向后兼容，待 forwarder v2 全量部署后可安全删除。
 *
 * 对外暴露固定 HTTP 代理地址 (localhost:3128)，
 * 内部定时调快代理 DPS API 获取 IP，自动轮换。
 *
 * Playwright/任何 HTTP 客户端只需设 PROXY_SERVER=http://dps-forwarder:3128
 * 无需关心 DPS API 认证和 IP 过期。
 *
 * 配置来源优先级：环境变量 > Nacos 远程配置 > 本地 config.yaml > 硬编码默认值
 * 启动时向 Nacos 注册服务实例，关闭时注销。
 *
 * 用法: node forwarder.js
 */

import http from 'node:http';
import os from 'node:os';
import { URL } from 'node:url';
import { connect as netConnect } from 'node:net';
import { config } from './src/config.js';
import { registerService, deregisterService } from './src/nacosClient.js';

const SECRET_ID = config.kuaidaili.secretId;
const SECRET_KEY = config.kuaidaili.secretKey;
const PROXY_USERNAME = config.kuaidaili.proxyUsername;
const PROXY_PASSWORD = config.kuaidaili.proxyPassword;
const API_ENDPOINT = config.kuaidaili.apiEndpoint;
const PORT = config.forwarder.port;
const REFRESH_MS = config.forwarder.refreshIntervalMs;
const TOKEN_TTL_MS = config.forwarder.tokenTtlMs;
const IDLE_TIMEOUT_MS = config.forwarder.idleTimeoutMs;

const SERVICE_NAME = process.env.NACOS_SERVICE_NAME || 'proxy-server';

// ── 状态 ──
let currentProxyIp = null;   // "ip:port"
let cachedToken = null;      // { secretToken, fetchedAt }
let refreshing = false;
let healthy = false;
let stopping = false;
let lastRequestAt = Date.now();
let refreshTimer = null;

function log(msg, extra) {
  const entry = { time: new Date().toISOString(), level: 'info', msg };
  if (extra) Object.assign(entry, extra);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function logWarn(msg, extra) {
  const entry = { time: new Date().toISOString(), level: 'warn', msg };
  if (extra) Object.assign(entry, extra);
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── Step 1: 获取 secret_token ──
async function fetchSecretToken() {
  if (cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_TTL_MS) {
    return cachedToken.secretToken;
  }
  const tokenUrl = API_ENDPOINT.replace('/getdps', '/get_secret_token');
  const body = new URLSearchParams({ secret_id: SECRET_ID, secret_key: SECRET_KEY });

  log('get_secret_token request');
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`get_secret_token HTTP ${res.status}: ${text}`);

  let token = '';
  if (text.startsWith('{')) {
    const j = JSON.parse(text);
    if (j.code === 0 && j.data?.secret_token) {
      token = j.data.secret_token;
    } else {
      throw new Error(`get_secret_token error: ${text}`);
    }
  } else if (!text.startsWith('ERROR')) {
    token = text;
  } else {
    throw new Error(`get_secret_token error: ${text}`);
  }

  cachedToken = { secretToken: token, fetchedAt: Date.now() };
  log('secret_token acquired', { tokenLen: token.length });
  return token;
}

// ── Step 2: 获取 DPS 代理 IP ──
async function fetchDpsIp() {
  const token = await fetchSecretToken();
  const base = API_ENDPOINT.replace(/\/+$/, '');
  const params = new URLSearchParams({
    secret_id: SECRET_ID,
    signature: token,
    num: '1',
    format: 'text',
    sep: '1',
  });

  log('getdps request');
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = (await res.text()).trim();
  if (!res.ok) {
    if (/signature|token/i.test(text)) cachedToken = null;
    throw new Error(`getdps HTTP ${res.status}: ${text}`);
  }

  let ip = '';
  if (text.startsWith('{')) {
    const j = JSON.parse(text);
    if (j.code === 0 && j.data?.proxy_list?.length > 0) {
      ip = j.data.proxy_list[0];
    } else {
      if (/signature|token/i.test(j.msg || '')) cachedToken = null;
      throw new Error(`getdps error: ${j.msg || `code=${j.code}`}`);
    }
  } else if (!text.startsWith('ERROR')) {
    ip = text;
  } else {
    throw new Error(`getdps error: ${text}`);
  }

  if (!ip) throw new Error('getdps returned empty');
  return ip;
}

// ── 刷新代理 IP ──
async function refreshProxy() {
  if (refreshing) return;
  refreshing = true;
  try {
    const ip = await fetchDpsIp();
    currentProxyIp = ip;
    healthy = true;
    log('proxy IP refreshed', { ip });
  } catch (e) {
    logWarn('proxy refresh failed', { error: e.message });
    healthy = !!currentProxyIp;
    // 保留旧 IP 继续用，下次定时器再试
  } finally {
    refreshing = false;
  }
}

// ── 活动感知的定时刷新 ──
function touchActivity() {
  lastRequestAt = Date.now();
  if (!refreshTimer) {
    log('activity resumed, restarting refresh timer');
    startRefreshTimer();
    refreshProxy();
  }
}

function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    if (Date.now() - lastRequestAt > IDLE_TIMEOUT_MS) {
      log('idle timeout, stopping refresh timer', { idleMs: Date.now() - lastRequestAt });
      stopRefreshTimer();
      return;
    }
    await refreshProxy();
  }, REFRESH_MS);
  refreshTimer.unref?.();
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ── HTTP 代理服务器 ──
// 支持 CONNECT (HTTPS) 和普通 HTTP 转发
const server = http.createServer((req, res) => {
  // 健康检查
  if (req.url === '/healthz') {
    const ok = healthy && !!currentProxyIp;
    res.statusCode = ok ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ healthy: ok, proxyIp: currentProxyIp }));
    return;
  }

  // HTTP 代理: GET http://example.com/path
  if (req.url.startsWith('http://')) {
    handleHttpProxy(req, res);
    return;
  }
  // 其他请求返回 403
  res.writeHead(403);
  res.end('This is a proxy server. Use HTTP proxy or CONNECT method.');
});

// CONNECT 方法 (HTTPS 隧道)
server.on('connect', (req, clientSocket, head) => {
  touchActivity();
  const target = req.url; // "host:port"
  const started = Date.now();

  if (!currentProxyIp) {
    logWarn('CONNECT rejected: proxy IP not ready', { target, durationMs: 0 });
    clientSocket.write('HTTP/1.1 503 Proxy IP not ready\r\n\r\n');
    clientSocket.end();
    return;
  }

  const proxyIp = currentProxyIp;
  const [proxyHost, proxyPort] = proxyIp.split(':');
  const auth = Buffer.from(`${PROXY_USERNAME}:${PROXY_PASSWORD}`).toString('base64');

  log('CONNECT start', { target, proxyIp });

  const proxySocket = netConnect({
    host: proxyHost,
    port: parseInt(proxyPort, 10),
    timeout: 10_000,
  });

  let connected = false;
  let finished = false;
  let headerBuf = Buffer.alloc(0);

  function finish(result, extra) {
    if (finished) return;
    finished = true;
    const durationMs = Date.now() - started;
    const level = result === 'established' ? 'info' : 'warn';
    const entry = { time: new Date().toISOString(), level, msg: `CONNECT ${result}`, target, proxyIp, durationMs };
    if (extra) Object.assign(entry, extra);
    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  proxySocket.on('connect', () => {
    proxySocket.write(
      `CONNECT ${target} HTTP/1.1\r\n` +
      `Host: ${target}\r\n` +
      `Proxy-Authorization: Basic ${auth}\r\n` +
      `\r\n`
    );
  });

  proxySocket.on('data', (chunk) => {
    if (connected) return; // pipe 接管后忽略

    headerBuf = Buffer.concat([headerBuf, chunk]);
    const headerEnd = headerBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headerStr = headerBuf.slice(0, headerEnd).toString();
    const statusLine = headerStr.split('\r\n')[0];

    if (!statusLine.includes('200')) {
      finish('rejected', { dpsStatus: statusLine });
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
      proxySocket.destroy();
      return;
    }

    // 连接成功，清除超时
    proxySocket.setTimeout(0);
    connected = true;
    finish('established');
    clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n');

    // 发送残余数据
    const remainder = headerBuf.slice(headerEnd + 4);
    if (remainder.length > 0) {
      clientSocket.write(remainder);
    }

    // 双向管道
    proxySocket.removeAllListeners('data');
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
  });

  proxySocket.on('timeout', () => {
    if (!connected) {
      finish('timeout');
      clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      clientSocket.end();
      proxySocket.destroy();
    }
  });

  proxySocket.on('error', (e) => {
    if (!connected) {
      finish('error', { error: e.message, code: e.code });
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    }
    proxySocket.destroy();
  });

  clientSocket.on('error', (e) => {
    finish('client_error', { error: e.message, code: e.code });
    proxySocket.destroy();
  });
});

// HTTP 代理 (非 HTTPS)
function handleHttpProxy(req, res) {
  touchActivity();
  const started = Date.now();

  if (!currentProxyIp) {
    logWarn('HTTP proxy rejected: proxy IP not ready', { url: req.url, method: req.method, durationMs: 0 });
    res.writeHead(503);
    res.end('Proxy IP not ready');
    return;
  }

  const proxyIp = currentProxyIp;
  const targetUrl = new URL(req.url);
  const [proxyHost, proxyPort] = proxyIp.split(':');
  const auth = Buffer.from(`${PROXY_USERNAME}:${PROXY_PASSWORD}`).toString('base64');

  log('HTTP proxy start', { method: req.method, url: req.url, proxyIp });

  const proxyReq = http.request({
    host: proxyHost,
    port: parseInt(proxyPort, 10),
    method: req.method,
    path: req.url,
    headers: {
      ...req.headers,
      host: targetUrl.host,
      'proxy-authorization': `Basic ${auth}`,
    },
  }, (proxyRes) => {
    const durationMs = Date.now() - started;
    const statusCode = proxyRes.statusCode;
    const level = statusCode >= 400 ? 'warn' : 'info';
    const entry = { time: new Date().toISOString(), level, msg: 'HTTP proxy done', method: req.method, url: req.url, proxyIp, statusCode, durationMs };
    process.stdout.write(JSON.stringify(entry) + '\n');
    res.writeHead(statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    const durationMs = Date.now() - started;
    logWarn('HTTP proxy error', { method: req.method, url: req.url, proxyIp, error: e.message, code: e.code, durationMs });
    res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
}

// ── 优雅关闭 ──
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down gracefully');
  stopRefreshTimer();
  await deregisterService(SERVICE_NAME, getLocalIp(), PORT).catch(() => {});
  server.close();
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdown();
  });
}

process.on('unhandledRejection', (reason) => {
  logWarn('unhandledRejection', { reason: String(reason) });
});

// ── 启动 ──
async function start() {
  log('dps-forwarder starting', { port: PORT, refreshMs: REFRESH_MS });

  // 先获取一个 IP 再启动
  await refreshProxy();
  if (!currentProxyIp) {
    logWarn('no proxy IP at startup, will retry in 30s');
    setTimeout(refreshProxy, 30_000);
  }

  // 定时刷新（有请求时保持刷新，空闲 20 分钟后停止）
  startRefreshTimer();

  server.listen(PORT, '0.0.0.0', () => {
    log('dps-forwarder listening', { port: PORT, proxyIp: currentProxyIp });
    registerService(SERVICE_NAME, getLocalIp(), PORT).catch(() => {});
  });
}

start().catch((e) => {
  logWarn('startup failed', { error: e.message });
  process.exit(1);
});
