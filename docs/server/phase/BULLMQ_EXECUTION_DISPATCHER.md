# BullMQ Queue 与独立 Worker

## 当前执行链

```text
Server 进程
HTTP → MySQL Command + Outbox（同一事务）
                  ↓
            Outbox Relay
                  ↓
      BullMQ Queue Producer / Redis
                  ↓
Worker 进程
      BullMQ Worker Consumer
                  ↓
     CommandRunner 从 MySQL 重读 Command
                  ↓
     StoredSessionManager 获取 Session 租约
                  ↓
            Agent Runtime
```

`BullMqExecutionDispatcher` 现在只负责向 Redis Queue 投递任务，不依赖 `CommandRunner`，也不会创建 BullMQ Worker。`BullMqCommandWorker` 只负责消费任务，并调用独立 Worker 进程中的 `CommandRunner`。

Relay 的 `enqueue()` 只在 Redis 接收 Job 后成功，因此 Server 在 Outbox 标记 `published` 后退出，Job 仍留在 Redis。Worker 没有启动时任务会排队；Worker 启动后继续消费，不会由 Server 自动降级执行。

## 进程职责

数据库模式的 Server 装配：

- Fastify HTTP/SSE Adapter
- MySQL Command、Outbox 和 Session 查询 Adapter
- Outbox Relay
- BullMQ Queue Producer

独立 Worker 装配：

- BullMQ Worker Consumer
- MySQL Command 和 Session Adapter
- `SessionCommandRunner`
- `StoredSessionManager`
- Agent RuntimeFactory
- `RedisCommandEventStream`

公开事件链路：

```text
Agent Runtime → RedisCommandEventStream → Redis Streams
                                             ↓
SSE Client ← PublicEventStream ← RedisPublicEventStream
```

Worker 的 `RedisCommandEventStream` 使用 `AsyncLocalStorage` 将 Agent 通知关联到正在执行的 `commandId`，再通过 `XADD` 写入有界 Stream。Server 的 `RedisPublicEventStream` 启动时重放保留窗口，随后阻塞读取新 entry，通过 Browser Event Projector 执行公开事件投影和脱敏，再通知 SSE listener。

Server 不再读取 `DEEPSEEK_API_KEY` 或创建 Agent runtime。Worker 独立读取模型配置，并可以通过 `WORKER_CONCURRENCY` 设置单进程并发容量。

## 关键行为

- Job 只包含 `commandId`、`sessionId` 和 `type`，完整 Command 由 Runner 从 MySQL 读取。
- `commandId` 的 SHA-256 作为稳定 Job ID；Outbox 重复投递不会创建第二个 Job。
- 默认失败重试 3 次，使用指数退避。
- Worker 可以并发处理不同任务；同一 Worker 内相同 Session 的 Prompt 串行。
- 多 Worker 之间由 MySQL Session 租约保证同一 Session 的独占执行。
- Agent 返回的模型执行失败会把 Command 标记为 `failed`，但视为一次已确认的 Job，不自动重复 Prompt。
- Runner 抛出的基础设施异常会使 Job 失败并触发 BullMQ 重试。
- Server 和 Worker 分别优雅关闭自己的 Queue Producer、Worker Consumer 与数据库连接池。

## 运行方式

无基础设施的本地模式：

```dotenv
STORAGE_MODE=inMemory
```

```bash
npm run dev:server
```

该模式保留 `InProcessExecutionDispatcher`，不需要独立 Worker。

数据库模式：

```dotenv
STORAGE_MODE=dataBase
MYSQL_URL=mysql://...
REDIS_URL=redis://127.0.0.1:6380
WORKER_CONCURRENCY=4
```

分别启动：

```bash
npm run dev:server
npm run dev:worker
```

真实 Redis 集成测试使用：

```bash
npm run test:redis
```

## 当前事件交付边界

Worker 事件通过 Redis Streams 到达 Server，并进入统一的 `PublicEventStream` seam。它提供有界恢复，不建立 MySQL 公开事件表：

- Stream 使用 `MAXLEN ~ 10000` 近似裁剪，Server 重启可重放当前保留窗口。
- Stream ID 是稳定 `eventId`；`sequence` 由各 Server 按 Session 的投影顺序重建。
- SSE handler 尚未消费 `Last-Event-ID`，浏览器内部自动重连不能精确补发断线窗口。
- MySQL 继续保存 Command、Session 和 Agent State，不保存公开事件。

若未来业务要求永久审计或精确断点续传，需要引入长期事件存储并处理 `Last-Event-ID`。跨 Worker 的 `steer`、`follow-up` 和 `abort` 精确路由仍需后续实现。
