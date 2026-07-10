# proxy-server

DPS 代理转发服务。对外暴露固定 HTTP 代理地址，内部通过快代理 DPS API 获取轮换 IP。
已接入 Nacos3 配置中心与服务注册发现。

## 架构

```
客户端 (Playwright/HTTP 客户端)
  └── http://proxy-server:3128 (固定地址)
        └── DPS 代理 IP (按需轮换, 有请求时每 10 分钟刷新, 空闲 20 分钟停止)
              └── 目标网站

配置来源: 环境变量 > Nacos 远程配置 > 本地 config.yaml > 硬编码默认值
服务注册: 启动时向 Nacos 注册 proxy-server 实例, 5s 心跳保活, 关闭时注销
```

## 配置

### 配置优先级

1. **环境变量** -- 最高优先级，直接覆盖
2. **Nacos 远程配置** -- 从 Nacos 3.x 配置中心拉取 (dataId: `proxy-server-dev.yaml`)
3. **本地 config.yaml** -- Nacos 不可用时的回退配置
4. **硬编码默认值** -- 兜底

### Nacos 配置

在 Nacos 控制台创建配置：
- **Data ID**: `proxy-server-dev.yaml` (可通过 `NACOS_CONFIG_DATA_ID` 修改)
- **Group**: `DEFAULT_GROUP`
- **格式**: YAML

配置内容示例：

```yaml
log:
  level: info

kuaidaili:
  apiEndpoint: "https://dps.kdlapi.com/api/getdps/"
  secretId: "your_secret_id"
  secretKey: "your_secret_key"
  proxyUsername: "your_username"
  proxyPassword: "your_password"

forwarder:
  port: 3128
  refreshIntervalMs: 600000
  tokenTtlMs: 3000000
  idleTimeoutMs: 1200000
```

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `KUAIDAILI_SECRET_ID` | 是 | - | 快代理 secret_id |
| `KUAIDAILI_SECRET_KEY` | 是 | - | 快代理 secret_key |
| `KUAIDAILI_PROXY_USERNAME` | 是 | - | DPS 代理用户名 |
| `KUAIDAILI_PROXY_PASSWORD` | 是 | - | DPS 代理密码 |
| `KUAIDAILI_API_ENDPOINT` | 否 | `https://dps.kdlapi.com/api/getdps/` | DPS API 地址 |
| `FORWARDER_PORT` | 否 | `3128` | 监听端口 |
| `REFRESH_INTERVAL_MS` | 否 | `600000` (10 分钟) | IP 刷新间隔 |
| `TOKEN_TTL_MS` | 否 | `3000000` (50 分钟) | secret_token 缓存有效期 |
| `IDLE_TIMEOUT_MS` | 否 | `1200000` (20 分钟) | 空闲超时：无请求则停止刷新 |
| `NACOS_SERVER_ADDR` | 否 | `172.16.11.229:38848` | Nacos 服务器地址 |
| `NACOS_NAMESPACE` | 否 | `(空/public)` | Nacos 命名空间 |
| `NACOS_USERNAME` | 否 | `nacos` | Nacos 用户名 |
| `NACOS_PASSWORD` | 否 | `nacos` | Nacos 密码 |
| `NACOS_CONFIG_DATA_ID` | 否 | `proxy-server-dev.yaml` | Nacos 配置文件名 |
| `NACOS_CONFIG_GROUP` | 否 | `DEFAULT_GROUP` | Nacos 配置分组 |
| `NACOS_SERVICE_NAME` | 否 | `proxy-server` | 注册到 Nacos 的服务名 |

## 健康检查

```bash
curl http://proxy-server:3128/healthz
# {"healthy":true,"proxyIp":"1.2.3.4:8080"}
```

- `200` -- 代理 IP 已就绪
- `503` -- 代理 IP 未就绪

## Docker 部署

```bash
# .env 文件
cat > .env << EOF
KUAIDAILI_SECRET_ID=your_secret_id
KUAIDAILI_SECRET_KEY=your_secret_key
KUAIDAILI_PROXY_USERNAME=your_username
KUAIDAILI_PROXY_PASSWORD=your_password

# Nacos (可选，使用默认值则无需设置)
# NACOS_SERVER_ADDR=172.16.11.229:38848
# NACOS_CONFIG_DATA_ID=proxy-server-dev.yaml
EOF

# 启动
docker compose up -d
```

### 作为其他服务的代理

```yaml
# 在其他服务的 docker-compose 中
services:
  web-archiver:
    environment:
      PROXY_SERVER: "http://proxy-server:3128"
    # 确保在同一 Docker 网络
```

### Playwright 使用

```js
const browser = await chromium.launch({
  proxy: { server: 'http://proxy-server:3128' }
});
```

## 工作原理

1. **启动时**: 从 Nacos (或本地 config.yaml) 加载配置，调用 DPS API 两步认证 (get_secret_token + getdps) 获取代理 IP
2. **服务注册**: 向 Nacos 3.x 注册 `proxy-server` 服务实例，5s 心跳保活
3. **按需刷新**: 有代理请求时每 10 分钟刷新 IP；连续 20 分钟无请求则停止刷新，节省 DPS 配额
4. **空闲恢复**: 停止刷新后若有新请求到来，立即刷新 IP 并重启定时器
5. **CONNECT 隧道**: 客户端 HTTPS 请求通过 CONNECT 方法建立隧道
6. **HTTP 转发**: 客户端 HTTP 请求直接转发到 DPS 代理
7. **故障保留**: IP 刷新失败时保留旧 IP，30 秒后重试
8. **优雅关闭**: 收到 SIGTERM 时注销 Nacos 服务实例并关闭服务器

## 文件结构

```
proxy-server/
├── forwarder.js          # 主程序：HTTP 代理服务器 + DPS IP 轮换
├── src/
│   ├── config.js         # 集中配置：env > Nacos > 本地 yaml > 默认值
│   └── nacosClient.js    # Nacos3 客户端：配置拉取 (gRPC) + 服务注册 (v3 admin API)
├── config.yaml           # 本地回退配置
├── package.json
├── Dockerfile
├── docker-compose.yml
└── README.md
```
