# 会话总结

## 1. webCllector 项目改动

### Dockerfile
- deps 层加 `npm install cloakbrowser playwright-core`
- runtime 层加 `npx playwright install chromium`（兜底浏览器）
- runtime 层加 `node node_modules/cloakbrowser/dist/cli.js install`（cloakbrowser 预装，必须用 node 直接调用 dist/cli.js，不能用 npx 或 ./node_modules/.bin/cloakbrowser，因为符号链接导致 CLI 的 `import.meta.url === pathToFileURL(process.argv[1]).href` 比对失败，main() 不执行）
- 加了 `ls -la /root/.cloakbrowser/` 验证

### docker-entrypoint.sh
- CloakBrowser 探测扩展为遍历 `/opt/cloakbrowser`（宿主挂载）+ `$HOME/.cloakbrowser`（镜像内置），优先于 playwright 兜底

### config.yaml
- `proxy.directPlatforms: ["deepseek"]`（deepseek 直连不走快代理）

### src/slot/browserSlotBinding.js
- 重写浏览器关闭逻辑：删除 `_forceKill()`，新增 `_killChromeTree()`（SIGTERM 3s 宽限 -> SIGKILL 进程组 -> `process.kill(pid,0)` 验证已死），不依赖不可靠的 `chromeProcess.killed` 标志
- 新增 `_sendSignal()` 和 `_isAlive()` 辅助方法
- 启动失败处 `_forceKill()` 改为 `_killChromeTree()`

---

## 2. RuoYi-Cloud - mindsight-geo-admin 改动

### nacos-config/mindsight-geo-admin-dev.yml
- 删除 `collection.platforms` 整段（label 迁移到 DB platform_config 表）
- 删除 `evaluation.models`（死配置，保留 `evaluation.kafka.commands-topic`）
- 删除 `archive.enabled`（死配置，保留 `archive.minio.bucket`）
- `llm.models.doubao-agent` 补全默认值（从原 collection.platforms.doubao 合并）
- 合并 `collection.platforms.{qwen,doubao}` 连接配置到 `llm.models.{qwen-agent,doubao-agent}`，删除 ProductRawLLMService 中的回退逻辑

### ConfigController.java
- 删除 `AdminCollectionConfig` 类 + `collectionConfig` 字段
- 删除 `EvaluationConfig` 类 + `evaluationConfig` 字段
- 删除 `GET /admin/config/platforms` 端点
- 删除 `GET /admin/config/evaluation-models` 端点
- 删除 `getPlatformLabel()` 方法
- `getPlatformConfigs()` 改为读 `pc.getLabel()`（DB）
- `savePlatformConfigs()` 支持保存 label

### PlatformConfig.java
- 新增 `private String label` 字段

### sql/geo_platform_config_add_label.sql（新建）
- `ALTER TABLE platform_config ADD COLUMN label VARCHAR(64)`
- 回填 doubao=豆包, qwen=通义千问

### ArchiveBranchService.java
- 删除 `@Value archiveEnabled` 字段 + `if (!archiveEnabled)` 检查（死代码）

### ArchiveBizService.java
- 删除 `@Value archiveEnabled` 字段 + `isArchiveEnabled()` getter（从未被调用）

### ProductRawLLMService.java
- `callQwenAgent()`: 去掉 `collection.platforms.qwen` 和 `llm.models.qwen` 回退，只读 `llm.models.qwen-agent`
- `callDoubaoAgent()`: 去掉 `collection.platforms.doubao` 回退，只读 `llm.models.doubao-agent`

### sse/AlertSseBridge.java（新建）
- 订阅 Redis `geo.alerts` channel，SSE 推送给前端

### controller/ArchiveController.java
- 注入 `AlertSseBridge`
- 新增 `GET /admin/archive/alerts/stream` SSE 端点

---

## 3. RuoYi-Cloud - mindsight-geo-taskhandle 改动

### ArchiveResultConsumer.java
- 添加 `StringRedisTemplate` 依赖
- 添加 INFO 日志: `[ArchiveResult] consumed topic=... key=...`
- 重写消费循环: 失败不再 seek back 死循环，改为发告警 + 提交 offset 跳过
- 新增 `notifyArchiveError()`: 发 Redis `geo.alerts` + `ArchiveLarkAlerter.fire()` 飞书告警
- `failureReason` 截断到 50 字符
- 移除 `OffsetAndMetadata` / `TopicPartition` import

### 其他 5 个消费者（WebCollectorResultConsumer / CollectionEventConsumer / EvalEventConsumer / MaintainResultConsumer / SlotEventConsumer）
- 每个消费者在 `handleRecord` 入口添加 INFO 日志打印 topic/offset/key

---

## 4. web-archiver 项目改动

### src/logger.js
- 支持从 config.yaml 读取 `log.level`（同步读文件，Nacos 异步加载前生效）

### src/processor.js
- 新增 `detectErrorPage()`: 检测 HTTP 200 但正文是 503/502/504/403/404 错误页，返回错误码（"503" 等）
- 错误页检测后 requeue 重试（而非直接 fail），达 maxAttempts(5) 后才 fail
- `failure_reason` 用 `http_5xx`/`http_4xx`（DB 已知值），具体错误码放 `last_error`
- 添加 DEBUG 日志: 打印抓取的 body_preview（前 500 字符）

### src/fetcher.js
- kuaidaili 直连路径 `httpGetViaProxy()` 添加浏览器级 headers: User-Agent, Accept, Accept-Language, Accept-Encoding, Connection, Upgrade-Insecure-Requests

### src/kuaidaili.js（完全重写）
- 改为两步认证（和 web-collector kuaidailiClient.js 对齐）:
  1. `fetchSecretToken()`: 调 `get_secret_token` API 用 secret_id + secret_key 换取短期 token（50min 缓存）
  2. `fetchDpsIp()`: 调 `getdps` API 用 secret_id + token 获取代理 IP
- 旧代码用 HMAC-SHA1 签名直接调 getdps，签名格式不对导致 signature error

### config.yaml
- 新增 `log.level: debug`
- `firecrawl.baseUrl` 改为 `http://api:3002`
- `firecrawl.apiVersion` 改为 `v2`（v1 返回截断内容/503 错误页，v2 返回完整正文）
- `kuaidaili.enabled: true`
- 快代理凭证更新为 `secretId: ozy33aeobriuydiwmlql` / `secretKey: 85wdvx6qo2n5pcoqe7lwav9eqpbizb7b`

---

## 5. Nacos 配置变更（服务器 39.105.180.32:38848）

### web-archiver-dev.yaml
- `apiVersion: v1 -> v2`
- `kuaidaili.enabled: false -> true`
- 新增 `log.level: debug`
- 快代理凭证更新
- `baseUrl` 改为 `http://api:3002`

### mindsight-geo-admin-dev.yml
- 同步本地文件的所有删除/合并

### webcollector-dev.yaml
- `proxy.directPlatforms: ["deepseek"]`

---

## 6. Firecrawl playwright-service 反检测（服务器 /root/deploy）

### Dockerfile.playwright-patch
基于 `firecrawl-playwright-service:latest` 镜像，通过 sed 打 4 处补丁:
1. `timeout = 15000` -> `timeout = 30000`（代理链路增加延迟）
2. launch 加 `proxy: { server: PROXY_SERVER }`（Playwright 原生 proxy 选项，per-context proxy 需要 launch 时设）
3. launch args 加 `--disable-blink-features=AutomationControlled`
4. contextOptions 加 `locale: zh-CN`, `timezoneId: Asia/Shanghai`, `extraHTTPHeaders: accept-language`
5. 加 `addInitScript` 覆盖 `navigator.webdriver`/`languages`/`plugins`

build 为 `firecrawl-playwright-service:patched`，docker-compose 中 `image: firecrawl-playwright-service:patched`（无 volume 挂载）

### firecrawl-docker-compose.yaml
- playwright-service: `image: firecrawl-playwright-service:patched`，`PROXY_SERVER: http://dps-forwarder:3128`（去掉 PROXY_USERNAME/PASSWORD，forwarder 自己处理认证）
- 资源限制: `NUM_WORKERS_PER_QUEUE: 3`, `CRAWL_CONCURRENT_REQUESTS: 3`, `BROWSER_POOL_SIZE: 2`, `MAX_CONCURRENT_JOBS: 5`
- 修复了 sed 命令误删 volumes 段导致的 YAML 损坏（api/foundationdb/foundationdb-init 的 volumes 恢复）

---

## 7. dps-forwarder sidecar（已迁移到 /home/nmg/workspace/geo/proxy-server）

### 源码位置
- 原: `/home/nmg/workspace/geo/ruoyi/RuoYi-Cloud/docker/dps-forwarder.js`
- 迁移到: `/home/nmg/workspace/geo/proxy-server/forwarder.js`

### 功能
- 零依赖 Node.js 单文件，用 `node:22-slim` 镜像
- 两步 DPS 认证（get_secret_token + getdps），每 10 分钟刷新 IP
- 支持 HTTP 代理转发 + HTTPS CONNECT 隧道
- CONNECT 隧道用 Buffer 处理 + `removeAllListeners` 避免 pipe 冲突 + `setTimeout(0)` 清除连接后超时

### docker-compose
- 独立服务 `dps-forwarder`，端口 3128
- 环境变量配置 DPS 凭证

---

## 8. 服务器部署状态（39.105.180.32，root/qVkWOZroC5KOhNRr4XV*M&）

### 容器状态
- `firecrawl-playwright-service:patched` - 运行中，反检测 + proxy 生效
- `firecrawl-dps-forwarder-1` - 运行中，DPS IP 轮换正常
- `web-archiver` - 运行中，用 Firecrawl v2 + forwarder 代理
- `web-collector` - 运行中，cloakbrowser + deepseek 直连
- `mindsight-geo-taskhandle` - 运行中（**旧代码，需 rebuild**）
- `mindsight-geo-admin` - 运行中（**旧代码，需 rebuild**）

### 待执行
1. **重新 build web-archiver**（detectErrorPage/requeue/debug日志/浏览器headers/kuaidaili.js 新代码）
2. **重新 build taskhandle**（INFO日志/失败不重试/告警通知/failureReason截断）
3. **重新 build admin**（AlertSseBridge/SSE端点/ConfigController清理/archive.enabled删除）
4. **执行 DB 迁移**:
   ```sql
   ALTER TABLE platform_config ADD COLUMN label VARCHAR(64) DEFAULT NULL COMMENT '平台展示名称' AFTER name;
   UPDATE platform_config SET label='豆包' WHERE name='doubao';
   UPDATE platform_config SET label='通义千问' WHERE name='qwen';
   ALTER TABLE source_archive MODIFY COLUMN failure_reason VARCHAR(50) NULL;
   ```

---

## 9. OpenSpec 提案: unified-proxy-forwarder

位置: `/home/nmg/workspace/geo/webCllector/openspec/changes/unified-proxy-forwarder/`

用 proxy-chain 库重写 dps-forwarder，统一 web-archiver 和 web-collector 的代理管理:
- **shared 模式**: 无 auth，全局共享 IP（web-archiver）
- **session 模式**: Proxy-Authorization username 做 session ID，per-slot sticky IP（web-collector）
- 健康检查、故障转移、流量统计
- 删除 kuaidailiClient.js + Redis 凭证分发

提案包含 proposal.md / design.md / specs / tasks.md，4/4 artifact 完成。

---

## 10. 关键排查经验

### cloakbrowser install 静默失败
- `npx cloakbrowser install` / `./node_modules/.bin/cloakbrowser install` 都不工作（0.2s 退出，无输出）
- 原因: 符号链接导致 `import.meta.url !== pathToFileURL(process.argv[1]).href`，CLI 入口的 `main()` 永远不执行
- 修复: `node node_modules/cloakbrowser/dist/cli.js install`（直接调用真实路径）

### Firecrawl v1 vs v2 API
- v1 (`/v1/scrape`): 返回 129 字节 503 错误页
- v2 (`/v2/scrape`): 返回 125KB 完整正文
- Nacos 配置改 `apiVersion: v2`

### Firecrawl API 缓存
- Firecrawl API 会按 URL 缓存抓取结果
- 反检测补丁应用到 playwright-service 后，需要**重启 firecrawl-api** 清除缓存才能生效

### Playwright per-context proxy
- Chrome `--proxy-server` flag 不够，需要 Playwright `launch({ proxy: { server: PROXY_SERVER } })` 原生选项
- per-context proxy 要求 browser launch 时就设 proxy

### 快代理签名错误
- web-archiver 的 kuaidaili.js 原用 HMAC-SHA1 直接签名，格式不对
- 正确方式: 两步认证（先 get_secret_token 换 token，再用 token 作为 signature 调 getdps）
- web-collector 的 kuaidailiClient.js 一直是两步认证，web-archiver 已对齐

### DPS 账号问题
- 凭证 `uq1vji6ba2v7gytiuc26` / `dfkie0wqr3tqba6wu1rqn0lo579n5jkb` 报 "余额充值订单不能提取私密代理"
- 凭证 `ozy33aeobriuydiwmlql` / `85wdvx6qo2n5pcoqe7lwav9eqpbizb7b` 可正常获取 IP

### taskhandle 死循环
- ArchiveResultConsumer 的 `applyResult` 失败后 seek back 重试 -> 同一条消息永远失败 -> 死循环
- 修复: 失败时发 Redis `geo.alerts` + 飞书告警，然后 commitSync 跳过（不重试）

### failure_reason 列截断
- `error_page_503` (14 字符) 不被 DB 接受（"Data truncated for column 'failure_reason'"）
- 修复: 用已有的 `http_5xx`/`http_4xx` 作为 failure_reason，错误码放 last_error
- Java 端加 `failureReason` 截断到 50 字符保护

### firecrawl-docker-compose.yaml YAML 损坏
- sed 命令 `/volumes:/,/networks:/{/api-patched/d; /volumes:/d}` 误删了整个文件中所有 `volumes:` 行
- 导致 volume 条目串到 `ports:` 和 `networks:` 下面
- 修复: 手动恢复 api/foundationdb/foundationdb-init 的 volumes 段 + 顶级 volumes 声明
