/**
 * Nacos 客户端封装 -- 配置拉取（gRPC，nacos-config）+ 服务注册（v3 admin HTTP API）。
 *
 * 配置拉取沿用 nacos-config（gRPC，兼容 Nacos 3.x）。
 * 服务注册不再使用 nacos-naming 2.6.3，改为直接调用 Nacos 3.x 的 v3 admin naming HTTP API。
 *
 * 环境变量：
 *   NACOS_SERVER_ADDR  (默认 172.16.11.229:38848)
 *   NACOS_NAMESPACE    (默认 'dev')
 *   NACOS_USERNAME     (默认 nacos)
 *   NACOS_PASSWORD     (默认 nacos)
 */

import { NacosConfigClient } from 'nacos';
import { load as yamlLoad } from 'js-yaml';

const serverAddr = process.env.NACOS_SERVER_ADDR || '172.16.11.229:38848';
const namespace = process.env.NACOS_NAMESPACE || 'dev';
const username = process.env.NACOS_USERNAME || 'nacos';
const password = process.env.NACOS_PASSWORD || 'nacos';

// Nacos 3.x 的 public 命名空间 id 为 'public'
const nsId = namespace || 'public';
const instanceApi = `http://${serverAddr}/nacos/v3/admin/ns/instance`;
const loginApi = `http://${serverAddr}/nacos/v1/auth/login`;

let configClient = null;

function getConfigClient() {
  if (!configClient) {
    configClient = new NacosConfigClient({ serverAddr, namespace, username, password });
  }
  return configClient;
}

// ---- v3 admin API token 管理 ----
let token = null;
let tokenExpireAt = 0;

async function getToken() {
  if (token && Date.now() < tokenExpireAt - 60000) return token;
  const res = await fetch(loginApi, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  if (!res.ok) throw new Error(`nacos login http ${res.status}`);
  const j = await res.json();
  token = j.accessToken;
  tokenExpireAt = Date.now() + (j.tokenTtl || 18000) * 1000;
  return token;
}

async function v3Request(url, init) {
  const tk = await getToken();
  const sep = url.includes('?') ? '&' : '?';
  let res = await fetch(`${url}${sep}accessToken=${encodeURIComponent(tk)}`, init);
  if (res.status === 401) {
    token = null;
    const tk2 = await getToken();
    res = await fetch(`${url}${sep}accessToken=${encodeURIComponent(tk2)}`, init);
  }
  return res;
}

/**
 * 从 Nacos 拉取配置并解析为对象。
 * @param {string} dataId  如 'proxy-server-dev.yaml'
 * @param {string} group   默认 'DEFAULT_GROUP'
 * @returns {Promise<object|null>}
 */
export async function fetchNacosConfig(dataId, group = 'DEFAULT_GROUP') {
  try {
    const client = getConfigClient();
    console.log(`[nacos] ====== 开始拉取 Nacos 配置 ======`);
    console.log(`[nacos] 服务器地址: ${serverAddr}`);
    console.log(`[nacos] 命名空间(namespace): ${namespace || '(空/public)'}`);
    console.log(`[nacos] 配置文件名(dataId): ${dataId}`);
    console.log(`[nacos] 分组(group): ${group}`);

    const content = await client.getConfig(dataId, group);

    if (!content) {
      console.log(`[nacos] 配置内容为空!`);
      return null;
    }

    console.log(`[nacos] 配置内容长度: ${content.length} 字节`);
    console.log(`[nacos] ------ 配置文件内容开始 ------`);
    console.log(content);
    console.log(`[nacos] ------ 配置文件内容结束 ------`);

    const parsed = yamlLoad(content) ?? {};
    console.log(`[nacos] 解析后配置项数量: ${Object.keys(parsed).length}`);
    console.log(`[nacos] ====== Nacos 配置拉取完成 ======`);
    return parsed;
  } catch (err) {
    console.warn(`[nacos] fetchNacosConfig failed: ${err.message}`);
    console.warn(`[nacos] 服务器地址: ${serverAddr}`);
    console.warn(`[nacos] 命名空间(namespace): ${namespace || '(空/public)'}`);
    console.warn(`[nacos] 配置文件名(dataId): ${dataId}`);
    console.warn(`[nacos] 分组(group): ${group}`);
    return null;
  }
}

// ---- 服务注册（v3 admin naming HTTP API）----
const HEARTBEAT_INTERVAL_MS = 5000;
const heartbeats = new Map(); // `${serviceName}|${ip}|${port}` -> interval

function instanceParams(serviceName, ip, port, metadata = {}) {
  return new URLSearchParams({
    serviceName,
    groupName: 'DEFAULT_GROUP',
    namespaceId: nsId,
    ip,
    port: String(port),
    weight: '1',
    healthy: 'true',
    enabled: 'true',
    ephemeral: 'true',
    clusterName: 'DEFAULT',
    metadata: JSON.stringify({ version: '1.0.0', ...metadata }),
  });
}

async function registerOnce(serviceName, ip, port, metadata) {
  const params = instanceParams(serviceName, ip, port, metadata);
  const res = await v3Request(`${instanceApi}?${params}`, { method: 'POST' });
  const j = await res.json().catch(() => ({}));
  if (j.code !== 0) throw new Error(j.message || `nacos register http ${res.status}`);
}

/**
 * 注册服务实例到 Nacos（ephemeral），并启动心跳定时刷新。
 * @param {string} serviceName  如 'proxy-server'
 * @param {string} ip
 * @param {number} port
 * @param {object} metadata
 */
export async function registerService(serviceName, ip, port, metadata = {}) {
  try {
    await registerOnce(serviceName, ip, port, metadata);
    console.log(`[nacos] registered ${serviceName} ${ip}:${port}`);
    const key = `${serviceName}|${ip}|${port}`;
    if (!heartbeats.has(key)) {
      const iv = setInterval(() => {
        registerOnce(serviceName, ip, port, metadata).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS);
      iv.unref?.();
      heartbeats.set(key, iv);
    }
  } catch (err) {
    console.warn(`[nacos] registerService failed: ${err.message || err.code || err}`);
  }
}

/**
 * 注销服务实例并停止心跳。
 */
export async function deregisterService(serviceName, ip, port) {
  const key = `${serviceName}|${ip}|${port}`;
  if (heartbeats.has(key)) {
    clearInterval(heartbeats.get(key));
    heartbeats.delete(key);
  }
  try {
    const params = new URLSearchParams({
      serviceName,
      groupName: 'DEFAULT_GROUP',
      namespaceId: nsId,
      ip,
      port: String(port),
      clusterName: 'DEFAULT',
    });
    const res = await v3Request(`${instanceApi}?${params}`, { method: 'DELETE' });
    const j = await res.json().catch(() => ({}));
    if (j.code !== 0) throw new Error(j.message || `nacos deregister http ${res.status}`);
    console.log(`[nacos] deregistered ${serviceName} ${ip}:${port}`);
  } catch (err) {
    console.warn(`[nacos] deregisterService failed: ${err.message || err.code || err}`);
  }
}
