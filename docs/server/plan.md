# Agent Server 生产化改造计划

## 1. 目标与职责边界

`agent-server` 负责后端接口、Session 生命周期、命令派发、事件交付、安全与运维；Tool、Memory、Context、Workflow、模型运行时等 Agent 能力归属 `agent-core`；`agent-client` 只依赖 server 的公开 HTTP/SSE 协议。

目标是将当前单进程实现逐步改造成可持久化、可恢复、可扩容、可观测的生产服务，同时保持模块接口小而稳定。

最终目标状态已经确定为：

```text
负载均衡
   ↓
无状态 Agent Server × N
   ↓
共享 MySQL + Redis
   ↓
Agent Worker × M
```

- Server 只负责公开 HTTP/SSE 协议、鉴权、查询、持久化提交和任务投递，不持有不可恢复的业务状态。
- MySQL 是 Command、Session、公开 Event 和投递记录的事实来源。
- Redis 负责跨进程任务传递、执行协调和实时事件分发，不作为最终业务事实来源。
- Worker 负责恢复 Session 上下文、执行 Agent、更新 MySQL 状态并发布事件。
- Server 和 Worker 都可以使用同一代码库构建镜像并独立扩容；容器可以随时替换，业务状态不能依赖容器内存。

## 2. 当前差距

- Command 已具备 MySQL Adapter、migration、真实 MySQL 集成测试和重启验证。
- Session 与 Agent 对话上下文已持久化到 MySQL，Worker 可按 Command 恢复；业务消息历史与长期记忆尚未建模。
- Dispatcher 已拆成 Server 内的 BullMQ Queue Producer 和独立 Worker Consumer。
- Worker 事件通过有界 Redis Stream 跨实例传播；Server 可以在重启后重放 Stream 保留窗口内的事件。
- Command 创建和 Outbox 已在同一 MySQL 事务提交；Relay 负责向 BullMQ 至少一次投递。
- SSE 已有 `eventId` 和 `sequence`，但缺少持久化、断线续传和历史/实时无缝衔接。
- 缺少认证、租户隔离、限流、超时、健康检查和可观测性。
- Agent、Tool 和模型实现已迁入 core；数据库模式仅由独立 Worker 创建 runtime。

### 2.1 代码扫描结果

| 状态 | 当前实现 | 目标归属 | 判断 |
| --- | --- | --- | --- |
| Command | `MySqlCommandRepository` 已实现，另有内存 Adapter | MySQL | seam 已真实存在；下一步应验证真实数据库，而不是继续抽象 Repository |
| Session | MySQL `sessions` + 可恢复 Agent state + 执行租约 | MySQL + Worker 恢复 | 基础闭环已完成；业务历史与压缩策略待设计 |
| 待执行任务 | Server Queue Producer + 独立 BullMQ Worker | Redis | 进程边界已拆分；待验证进程重启恢复 |
| Agent 执行 | 独立 Worker 内的 `SessionCommandRunner` | 独立 Worker | 已迁移；跨 Worker 控制命令路由待完成 |
| 内部事件 | Worker `RedisCommandEventStream` | Redis Streams | 已支持跨进程传播和保留窗口内补发 |
| 公开事件 | `PublicEventStream`，内存与 Redis 两种 Adapter | Redis Stream 重放 + Server 实时投影 | Stream ID 作为稳定 `eventId`，`sequence` 按保留窗口重建 |
| Composition root | `bootstrap.ts` 注入 Repository/Dispatcher | Server 与 Worker 分别组装 | seam 方向正确，不需要引入 `@fastify/mysql` 绑定业务模块 |

扫描后的当前结论：

1. MySQL Command、Session 和 Outbox 的真实集成闭环已经建立。
2. Transactional Outbox 已先于 BullMQ 投递落地，避免 Command 提交后永久丢任务。
3. Server Queue Producer 与独立 Worker Consumer 已完成进程解耦。
4. Session/Agent State、执行租约、续租和 fencing 已支持多 Worker 互斥执行。
5. Redis Streams 已提供跨 Server 的有界事件恢复；永久审计、精确 SSE 断点续传仍需要 MySQL 公开事件存储或其他长期日志。

## 3. 目标架构

```text
Client
  ↓
Load Balancer
  ↓
Stateless Server × N
  ├── HTTP command/query
  └── SSE delivery
        ↓
  MySQL + Redis
        ↓
Worker × M
  └── AgentCoreGateway → agent-core
```

MySQL 保存可恢复的业务事实；Redis 承担任务传递、跨实例协调和有界事件流。BullMQ Job 只携带 `commandId` 等定位信息，Worker 从 MySQL 读取完整 Command，并可由 MySQL/outbox 重建。Agent 运行事件当前只保留在 Redis Stream 窗口内，尚不能从 MySQL 重建，这是第一版明确保留的可靠性差距。

Docker 用于构建一致、可替换的 Server/Worker 运行环境和本地依赖环境，但不承担状态一致性职责。开发阶段可以用 Docker Compose 启动 MySQL/Redis；生产环境可以使用公司的托管 MySQL/Redis。

## 4. 实施阶段

### 阶段 0：冻结公开协议

状态：已完成基础版本。

- 统一命令入口：`POST /api/v1/sessions/:sessionId/commands`。
- 请求字段：`commandId`、`type`、`text?`；接收后立即返回 `202`。
- 提供 Session 查询、事件历史和 SSE 接口。
- 事件统一包含 `eventId`、`sequence`、`sessionId`、`commandId`、`type`、`occurredAt`、`payload`。
- 定义稳定错误码和 OpenAPI 文档。
- 建立 client/server 契约测试。

验收：client 不再依赖旧 `/api/agent/*` 路由，协议测试通过。

### 阶段 1：建立 Session 应用模块

状态：已完成基础版本，包括 Command 幂等、内存异步 Dispatcher 和 CommandRunner 拆分。

- Session 相关 domain、application 和 Adapter 保持聚合在当前 `session/` 模块，避免为了分层增加目录和浅模块。
- 由 `SessionApplication` 统一处理校验、幂等、状态迁移和能力派发。
- Command 状态：`accepted | queued | running | succeeded | failed | cancelled`。
- Session 状态：`idle | running | failed | closed`。
- 使用领域错误替代字符串匹配错误。
- Agent runtime、Tool 和模型能力已迁入 `agent-core`；server 只依赖 core 的执行 interface和内部事件。

验收：HTTP、后台执行器和测试均通过 `SessionApplication` 接口操作会话。

### 阶段 2A：MySQL Command 真实闭环

状态：已完成基础版本，真实 MySQL 5.7.44 集成测试通过。

- 提供本地 Docker Compose MySQL，固定与公司环境兼容的版本，配置持久 volume 和 healthcheck。
- 提供明确的 migration 执行命令，不依赖开发者手工复制 SQL。
- 使用真实 MySQL 运行 `MySqlCommandRepository` 契约测试，覆盖创建、重复提交、更新、查询和重启后读取。
- 验证 `MYSQL_URL` 配置、启动 fail-fast、连接池关闭和 Unicode/长文本行为。
- 本地开发仍允许显式使用内存 Adapter；生产配置不得在 MySQL 失败时静默降级。

验收：一条 Command 写入后重启 Server 仍可查询；重复 `commandId` 不产生第二条记录；集成测试可用一条命令重复执行。

### 阶段 2B：事务提交与可靠投递

状态：migration、事务提交 Adapter、轻量 MySQL Outbox Relay 和 BullMQ 投递 Adapter 已完成，详见 `docs/phase/COMMAND_OUTBOX_DESIGN.md`。

- 将 Command 创建、queued 状态和 outbox 记录放在同一个 MySQL 事务中。
- 建立 `outbox_events` 表和投递状态，避免“MySQL 已提交、Redis 未投递”的丢任务窗口。
- 用一个提交模块隐藏事务细节，HTTP 调用方不直接编排多次 Repository 写入。
- 保留 in-memory Adapter，用相同接口进行快速测试。

验收：Redis 暂时不可用时 Command 仍可靠记录，恢复后可以从 outbox 补投且不会产生重复业务执行。

### 阶段 3：Redis Dispatcher 与独立 Worker

状态：BullMQ Queue Producer 与独立 Worker 进程已拆分；Redis Streams 跨进程事件交付与重放已完成。

- Outbox Relay 已将 `commandId` 投递到 BullMQ，使用稳定 Job ID 去重。
- Worker 已支持失败重试、退避、优雅关闭和同 Session Prompt 串行。
- `start-server.ts` 在数据库模式下只装配 Queue Producer，不创建 Agent runtime 或 BullMQ Worker。
- `start-worker.ts` 独立装配 BullMQ Worker、CommandRunner、StoredSessionManager 和 Agent runtime。
- `STORAGE_MODE=inMemory` 继续由 Server 使用进程内 Dispatcher，作为本地快速开发路径；数据库模式不会在 Worker 缺失时自动降级。
- Worker 未启动时，已提交 Command 保留在 Redis 队列中，直到 Worker 启动后消费。
- Worker 事件写入有界 Redis Stream，Server 重放并持续读取，再由 `PublicEventStream` 投影并推送 SSE。
- 当前接受进程、Redis 或 SSE 断线窗口内的事件丢失，不建立公开事件表，也不承诺重连补发。

- 首先部署单个 Worker，Redis 只传递 `commandId`，完整 Command 和状态以 MySQL 为准。
- Worker 成功执行后确认任务；失败时记录可重试、永久性或结果不确定错误。
- 支持重试退避、pending/lease 恢复、死信、优雅关闭和基本队列指标。
- HTTP Server 不再创建 Agent runtime，也不在本进程运行 CommandRunner。

验收：关闭任意 Server 不影响已提交任务；单 Worker 重启后未确认任务可恢复。

### 阶段 4：Session 与 Agent 上下文持久化

状态：Agent 实现已迁入 `agent-core`；Session 状态恢复/保存以及分布式执行租约获取、续期、释放、过期接管和 fencing 已完成。跨 Worker 控制命令路由尚未完成。

- 建立 `sessions` 和可恢复的 Agent 对话/运行上下文存储。
- Session 更新使用版本号或行锁控制并发。
- 明确同一 Session 只能由一个 Worker 持有执行权，不同 Session 可以并行。
- Worker 每次执行前从共享存储恢复上下文，执行后持久化新状态。

验收：Worker 重启或任务切换到另一 Worker 后，会话上下文连续且同一 Session 不会并发执行。

### 阶段 5：可靠事件、跨实例 SSE

状态：Redis 实时分发已完成；以下可靠存储与断点续传需求延后，只有业务明确要求事件不可丢失时才实施。

- 建立 `session_events` 表，公开事件先可靠写入 MySQL。
- 为每个 Session 维护单调递增 `sequence` 和稳定 `eventId`。
- 支持 `Last-Event-ID` 或 `after` 游标断点续传。
- 建连时完成“订阅实时事件、读取历史、补齐间隙”的无丢失切换。
- 增加心跳、连接上限、慢消费者处理和事件去重。
- 使用 Redis 在多个 Server 之间分发实时事件，MySQL 提供历史补读和最终一致性。
- SSE 仅发布经过投影和脱敏的公开事件。

验收：断网、重启和实例切换后事件不丢失、不乱序，客户端可安全去重。

### 阶段 6：多 Server / 多 Worker 扩容验证

- Server 不再持有不可恢复的 Session、Command 队列或事件历史。
- 在负载均衡后启动至少两个 Server 和两个 Worker，取消粘性会话依赖。
- 验证 Server/Worker 滚动重启、水平扩缩容、Redis 短暂故障和 MySQL 连接恢复。
- 通过压测确定 Server/Worker 数量、连接池大小、Worker 并发和模型提供方限流。

验收：任意单个 Server/Worker 被替换时，请求、任务和 SSE 均可恢复且不发生不可接受的重复副作用。

### 阶段 7：安全与多租户

- 认证后从身份上下文获取 `tenantId`、`userId`，所有查询强制附带租户条件。
- 限制请求体、文本长度、Session 数量和并发命令数。
- 增加限流、CORS 白名单、安全响应头和 Tool 允许列表。
- 密钥由环境或 Secret Manager 注入，不进入事件、日志或 client。
- 记录必要的安全审计事件。

验收：跨租户访问、敏感信息泄漏、恶意输入和过载测试通过。

### 阶段 8：可观测性与运维

状态：已完成 Pino 基础结构化执行日志；健康检查、指标和 Trace 尚未开始。

- 提供 `/health/live` 和 `/health/ready`。
- 结构化日志关联 `requestId`、`tenantId`、`sessionId`、`commandId`。
- 采集请求延迟、错误率、排队/执行时间、执行并发、SSE 连接及模型/Tool 错误指标。
- 使用 OpenTelemetry 串联 HTTP、派发、Agent 和 Tool trace。
- 制定优雅关闭、数据保留、归档、备份和恢复流程。

验收：一次失败可从请求追踪到 Command、Agent 执行和持久化事件。

### 阶段 9：测试与发布

- 覆盖领域状态机单元测试、repository 集成测试、HTTP/SSE 契约测试和端到端测试。
- 必测场景：重复 commandId、同 Session 并发、执行中 abort、进程退出、SSE 重连、依赖故障、跨租户访问和慢客户端。
- 采用数据库迁移先行、应用后发布；旧接口通过兼容 adapter 短期保留，client 切换后删除。

验收：`npm run check`、集成测试和生产 smoke test 全部通过，并具备明确回滚步骤。

## 5. 交付顺序

1. 已完成：协议统一、SessionApplication、Command 幂等、内存 Dispatcher、CommandRunner、MySQL Command Adapter。
2. 已完成：Docker MySQL 真实集成测试、migration、事务 outbox 和 Redis Dispatcher 基础版。
3. 已完成：Session/Agent 上下文持久化，以及执行租约的获取、续期、释放、过期接管和 fencing。
4. 已完成：拆分独立 Worker composition root；待完成真实进程重启恢复验证。
5. 当前：Redis 实时事件分发已完成；跨 Worker 控制命令路由与多实例验证是下一步。事件持久化和 SSE 恢复按业务需求延后。
6. 完成生产化：安全、多租户、可观测性、压测、发布和灾备。

## 6. 暂缓项与原则

- `STORAGE_MODE=inMemory` 显式装配内存 Session、Command 和进程内 Dispatcher；`STORAGE_MODE=dataBase` 必须同时配置 MySQL 与 Redis，Server 只装配 Queue Producer。
- `dataBase` 模式必须配置 `MYSQL_URL`；基础设施 URL 不会让 `inMemory` 模式隐式切换 Adapter。
- `createApplication` 只接收存储模式、Agent runtime 和进程配置；内存与数据库 Adapter 分别由 bootstrap 内部的 `createMemoryApplication`、`createStoreApplication` 初始化，进程入口不直接依赖具体持久化实现。

- 在 MySQL 真实持久化闭环完成前，不引入 Redis Dispatcher。
- 不用 Redis 替代 MySQL 保存最终业务事实；Redis 数据必须可从 MySQL/outbox 恢复。
- 不通过粘性会话掩盖 Server 内存状态；它最多用于迁移期，不是最终架构。
- 多 Worker 前必须先解决 Session 上下文恢复和同 Session 独占执行。
- 不在 server 重复实现 Tool、Memory、Context 或 Workflow。
- 不为了测试暴露内部接口；生产和测试通过相同应用接口验证行为。
- 每一阶段保持可部署、可回滚，并在进入下一阶段前满足验收标准。
