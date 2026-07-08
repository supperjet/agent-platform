# agent-server

浏览器公开协议已冻结为 API v1；参见 [Public API v1](../../docs/phase/PUBLIC_API_V1.md)，运行时可通过 `GET /api/v1/openapi.json` 获取 OpenAPI 文档。

从 `hi-pi/src/lessons/15` 迁入的 Fastify Agent 后端，当前保留课程实现的模块 seam：

- `session/`：Session/Command interface、Application、Runner 与 Outbox Relay。
  - `session/memory/`：本地开发和单元测试使用的内存 Adapter，包括 InProcess Dispatcher。
  - `session/mysql/`：生产持久化使用的 MySQL Command/Outbox Adapter。
  - `session/redis/`：彼此独立的 BullMQ Queue Producer 与 Worker Consumer Adapter。
- `messaging/`：进程内 EventEmitter 事件总线。
- `consumer/`：HTTP、SSE 和公开事件投影。
- `runtime/`：DeepSeek 配置与消息构造。
- `observability/`：Pino 执行日志 Adapter；关联 Outbox、BullMQ Job 和 Command 生命周期。
- `utils/`：无业务状态的 HTTP/SSE、启动配置、数据库连接检查和进程生命周期工具。
- `bootstrap.ts`：HTTP Server composition root；数据库模式不创建 Agent runtime。
- `bootstrap-worker.ts`：独立 Worker composition root。

浏览器静态页面和浏览器 reducer 未迁入本 package；它们属于独立的 `agent-client`。

当前 server 仅暴露 v1 Session 协议；旧 `/api/agent/*` 路由已经移除。真实 Agent 实现已迁入 `agent-core`。`STORAGE_MODE=inMemory` 用于无基础设施的本地运行，由 Server 进程执行 Agent；`STORAGE_MODE=dataBase` 必须配置 MySQL 与 Redis，Server 只提交任务，`npm run dev:worker` 启动的独立进程负责恢复 Session 并调用 Agent Core。Worker 将关联 Command 的 Agent 事件追加到有界 Redis Stream，Server 启动时重放保留事件并持续阻塞读取，再通过统一的 `PublicEventStream` 接口向 HTTP 历史和 SSE 提供事件。认证和跨 Worker 控制命令路由留待后续改造。
