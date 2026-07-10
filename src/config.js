// Centralized configuration for proxy-server.
// 优先级：环境变量 > Nacos 远程配置 > 本地 config.yaml > 硬编码默认值。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { fetchNacosConfig } from './nacosClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const num = (envVal, fileVal, defaultVal) => {
  if (envVal != null && envVal !== '') return Number(envVal);
  if (fileVal != null) return fileVal;
  return defaultVal;
};

const str = (envVal, fileVal, defaultVal) => {
  if (envVal != null && envVal !== '') return envVal;
  if (fileVal != null) return fileVal;
  return defaultVal;
};

/** 从 YAML 配置文件加载 */
function loadFileConfig() {
  const candidates = [
    '/app/config.yaml',
    '/app/config.yml',
    resolve(__dirname, '..', 'config.yaml'),
    resolve(__dirname, '..', 'config.yml'),
  ];
  for (const p of candidates) {
    try {
      const raw = readFileSync(p, 'utf-8');
      console.log(`[config] loaded from ${p}`);
      return yamlLoad(raw) ?? {};
    } catch { /* skip */ }
  }
  console.log('[config] no config.yaml found, using defaults');
  return {};
}

/** 加载配置：Nacos 优先，回退到本地文件 */
async function loadRemoteOrLocal() {
  const nacosDataId = process.env.NACOS_CONFIG_DATA_ID || 'proxy-server-dev.yaml';
  const nacosGroup = process.env.NACOS_CONFIG_GROUP || 'DEFAULT_GROUP';
  const nacosNamespace = process.env.NACOS_NAMESPACE || 'dev';
  const nacosServerAddr = process.env.NACOS_SERVER_ADDR || '172.16.11.229:38848';

  console.log(`[config] ====== 配置加载开始 ======`);
  console.log(`[config] Nacos 服务器: ${nacosServerAddr}`);
  console.log(`[config] Nacos 命名空间: ${nacosNamespace || '(空/public)'}`);
  console.log(`[config] Nacos 配置文件名: ${nacosDataId}`);
  console.log(`[config] Nacos 分组: ${nacosGroup}`);

  try {
    const remote = await fetchNacosConfig(nacosDataId, nacosGroup);
    if (remote && Object.keys(remote).length > 0) {
      console.log(`[config] 从 Nacos 加载配置成功，配置项: ${Object.keys(remote).join(', ')}`);
      console.log(`[config] ====== 配置加载完成 (来源: Nacos) ======`);
      return remote;
    }
    console.log('[config] Nacos 返回空配置，回退到本地文件');
  } catch (err) {
    console.warn(`[config] Nacos 加载失败: ${err.message}，回退到本地文件`);
  }

  const localConfig = loadFileConfig();
  console.log(`[config] ====== 配置加载完成 (来源: 本地文件) ======`);
  return localConfig;
}

const file = await loadRemoteOrLocal();

// 共享凭证配置（application-dev.yml）：快代理 DPS 凭证的唯一来源。
// 键名从 Spring 风格映射到本服务的扁平风格；凭证字段优先 shared，其次 file，最后默认值。
async function loadSharedConfig() {
  const sharedDataId = process.env.NACOS_SHARED_CONFIG_DATA_ID || 'application-dev.yml';
  const nacosGroup = process.env.NACOS_CONFIG_GROUP || 'DEFAULT_GROUP';
  try {
    const remote = await fetchNacosConfig(sharedDataId, nacosGroup);
    if (remote && Object.keys(remote).length > 0) {
      console.log(`[config] 共享配置 ${sharedDataId} 加载成功`);
      return remote;
    }
    console.log(`[config] 共享配置 ${sharedDataId} 返回空`);
  } catch (err) {
    console.warn(`[config] 共享配置 ${sharedDataId} 加载失败: ${err.message}`);
  }
  return {};
}

function mapShared(raw) {
  const root = raw || {};
  const k = root.kuaidaili || {};
  return {
    kuaidaili: {
      apiEndpoint: k['api-endpoint'],
      secretId: k['secret-id'],
      secretKey: k['secret-key'],
      proxyUsername: k['proxy-username'],
      proxyPassword: k['proxy-password'],
    },
  };
}

const shared = mapShared(await loadSharedConfig());

export const config = {
  log: {
    level: str(process.env.LOG_LEVEL, file.log?.level, 'info'),
  },
  kuaidaili: {
    apiEndpoint: str(process.env.KUAIDAILI_API_ENDPOINT, shared.kuaidaili?.apiEndpoint ?? file.kuaidaili?.apiEndpoint, 'https://dps.kdlapi.com/api/getdps/'),
    secretId: str(process.env.KUAIDAILI_SECRET_ID, shared.kuaidaili?.secretId ?? file.kuaidaili?.secretId, ''),
    secretKey: str(process.env.KUAIDAILI_SECRET_KEY, shared.kuaidaili?.secretKey ?? file.kuaidaili?.secretKey, ''),
    proxyUsername: str(process.env.KUAIDAILI_PROXY_USERNAME, shared.kuaidaili?.proxyUsername ?? file.kuaidaili?.proxyUsername, ''),
    proxyPassword: str(process.env.KUAIDAILI_PROXY_PASSWORD, shared.kuaidaili?.proxyPassword ?? file.kuaidaili?.proxyPassword, ''),
  },
  forwarder: {
    port: num(process.env.FORWARDER_PORT, file.forwarder?.port, 3128),
    refreshIntervalMs: num(process.env.REFRESH_INTERVAL_MS, file.forwarder?.refreshIntervalMs, 10 * 60 * 1000),
    tokenTtlMs: num(process.env.TOKEN_TTL_MS, file.forwarder?.tokenTtlMs, 50 * 60 * 1000),
    idleTimeoutMs: num(process.env.IDLE_TIMEOUT_MS, file.forwarder?.idleTimeoutMs, 20 * 60 * 1000),
  },
};

export default config;
