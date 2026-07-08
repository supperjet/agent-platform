# Agent Platform

面向 AI 应用的 TypeScript monorepo，按职责拆成三个可独立演进的 workspace package。

## Packages

- `agent-client`：React 应用、前端状态、HTTP client 和 SSE 消费逻辑，不依赖 Agent 实现。
- `agent-server`：HTTP/SSE、Session/Command、MySQL、Redis/BullMQ 和公开事件投影。
- `agent-core`：模型执行、Tool、Agent 内部事件和可恢复 Conversation State。

依赖方向：

```text
agent-client  --HTTP/SSE-->  agent-server  -->  agent-core
```

`agent-client` 不通过 workspace import 依赖 server；未来可直接拆成独立仓库，并从 server OpenAPI 生成 client。`agent-core` 可以使用 Faux Provider 独立验证，不需要启动 Fastify 或基础设施。

## 开始使用

推荐通过 Docker Compose 一次启动 MySQL、Redis、数据库迁移、Server、Worker 和 Client：

```bash
# 如果尚未创建 .env，修改.env.example输入DEEPSEEK_API_KEY（后期支持多个源）.
npm run dev:up
```

访问前端 `http://127.0.0.1:5173`，Server 地址为 `http://127.0.0.1:3000`。Compose 会等待 MySQL、Redis 和迁移就绪后按依赖顺序启动应用；`packages/` 下的源码以 volume 挂载，Server、Worker 和 Client 均支持热更新。

停止全部服务：

```bash
npm run dev:down
```

可在 `.env` 中覆盖 `MYSQL_PORT`、`REDIS_PORT`、`SERVER_PORT`、`CLIENT_PORT`、`DEEPSEEK_MODEL_ID`、`WORKER_CONCURRENCY` 和 `LOG_LEVEL`。`docker compose down -v` 会同时删除本地数据库和 Redis 数据，请谨慎使用。

### 不使用 Docker 启动应用

先安装依赖并检查项目：

```bash
npm install
npm run check
```

默认服务地址为 `http://127.0.0.1:3000`。

默认 `STORAGE_MODE=inMemory`，Server 会在本进程执行 Command，不需要单独启动 Worker。数据库模式需要 MySQL、Redis，并在另一个终端启动 Worker：

```bash
npm run dev:server
npm run dev:worker
```

数据库模式下只启动 Server 时，Command 会可靠保留在队列中，不会自动降级为进程内执行。

### 前端调试

`agent-client` 使用 React、TypeScript 和 Vite。分别在两个终端启动 server 和 client：

```bash
npm run dev:server
npm run dev:client
```

访问 `http://127.0.0.1:5173`。Vite 默认把 `/api` 代理到 `http://127.0.0.1:3000`；如需连接其他 server，可在启动前设置 `AGENT_SERVER_URL`。浏览器端也可通过 `VITE_AGENT_SERVER_URL` 指定公开 server 地址。

## 设计约束

1. `agent-core` 不依赖 Fastify、数据库或浏览器类型。
2. `agent-server` 负责把 core 事件投影成稳定的公开协议。
3. `agent-client` 只认识公开协议，不读取 core transcript 或内部事件。
4. 所有具体 adapter 在各 package 的 composition root 中组装。
