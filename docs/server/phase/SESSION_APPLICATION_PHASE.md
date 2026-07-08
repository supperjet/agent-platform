# 阶段 1：建立 Session 应用模块

## 状态

第一轮垂直切片已完成，对应提交：`3cd68fe refactor: add session application layer`。

本阶段的目标是让 HTTP Adapter 不再直接编排 Session 操作，由 `SessionApplication` 统一承接命令提交、Session 查询、状态迁移和后续能力派发。

## 改造前

Fastify 直接依赖 `SessionManager`，并在路由内判断 Command 类型：

```text
Fastify
  ├── sessions.prompt()
  ├── sessions.steer()
  ├── sessions.followUp()
  └── sessions.abort()
```

这会导致幂等、状态迁移、持久化和异步派发逻辑继续堆积在 HTTP Adapter 或 SessionManager 中。

## 当前结构

```text
Fastify HTTP Adapter
        ↓
SessionApplication
  ├── CommandRepository
  └── SessionManager
          ↓
      AgentRuntime
```

composition root 负责选择当前实现：

- `InProcessSessionApplication`
- `InMemoryCommandRepository`
- `InMemorySessionManager`

Fastify 只依赖 `SessionApplication` interface，不再直接调用 `SessionManager`。

相关实现按业务能力聚合在 `packages/agent-server/src/session/`。顶层不再按 `application/`、`domain/`、`persistence/` 技术层拆散；后续只有在 Session 模块内部复杂度明显增长时，才考虑增加子目录。

## 已完成内容

### 1. 领域语言

在根目录 `CONTEXT.md` 中确定：

- Session：一段连续的 Agent 对话和执行范围。
- Command：客户端在某个 Session 内发起的一次操作。
- Command 被 accepted 只表示 Server 接受处理责任，不表示执行成功。

Command 状态定义为：

```text
accepted | queued | running | succeeded | failed | cancelled
```

Session 状态定义为：

```text
idle | running | failed | closed
```

### 2. SessionApplication interface

应用层提供统一入口：

```ts
abstract class SessionApplication {
  abstract submitCommand(command: SubmitCommand): Promise<SubmittedCommand>;
  abstract getSession(sessionId: string): SessionView | undefined;
  abstract getCommand(commandId: string): Promise<CommandRecord | undefined>;
}
```

HTTP、后台执行器和后续测试应通过该 interface 操作 Session 和 Command。

### 3. Command Repository

建立 `CommandRepository` interface 和 `InMemoryCommandRepository` adapter。

当前同步执行流程记录：

```text
accepted → running → succeeded
                    ↘ failed
```

Command 记录包含：

- `commandId`
- `sessionId`
- `type`
- `text?`
- `status`
- `createdAt`
- `updatedAt`

`CommandRepository.createIfAbsent()` 提供原子占位：相同 `commandId` 和相同内容的顺序或并发重试不会重复执行；相同 ID 的不同内容返回 `409 COMMAND_CONFLICT`。

### 4. Fastify Adapter

命令提交和 Session 查询已改为调用 `SessionApplication`。Command 类型分派和缺少文本的业务校验已移入应用层。

`InvalidCommandError` 由 HTTP Adapter 映射为稳定的 `400 INVALID_COMMAND`，公开 v1 协议保持不变。

### 5. 测试

新增应用层行为测试，验证：

- Command 通过统一应用 interface 提交。
- Session 通过统一应用 interface 查询。
- Command 最终状态被记录为 `succeeded`。
- 原有 HTTP 契约和 Agent 执行行为保持不变。

验收时全仓 13 项测试通过。

### 6. In-process Execution Dispatcher

`SessionApplication` 在原子创建 Command 后保存 `queued`，交给单进程 Dispatcher，并立即返回 `202`。Dispatcher 负责更新 `running` 和终态：

```text
accepted → queued → running → succeeded | failed
```

同一 Session 的 Prompt 串行执行，不同 Session 可在全局并发上限内并行；`steer`、`follow-up` 和 `abort` 作为控制命令可在 Prompt 运行期间直接派发。关闭 Server 时先停止接收新任务并等待内存队列 drain，再停止公开事件监听。

Dispatcher 只负责“何时运行”；`SessionCommandRunner` 负责“如何运行”，包括读取 Command、状态迁移、事件上下文和 Session runtime 调用。

当前验收覆盖 HTTP 非阻塞接收、Command 状态更新、同 Session 串行、跨 Session 并行、控制命令直达、幂等重试、事件 `commandId` 关联和优雅关闭；全仓 22 项测试通过。

## 当前限制

- Dispatcher 和执行队列仍在 HTTP 进程内，进程异常退出会丢失排队任务。
- Command 和 Session 仍存放在单进程内存中。
- Command 状态更新不是数据库事务。
- `SessionManager` 仍承担现有 Agent runtime 生命周期，尚未替换为 Repository 和 AgentCoreGateway。
- `AsyncLocalStorage` 仍用于当前单进程 Command 与公开事件关联。

## 后续任务

1. 建立显式 Command 状态迁移规则和领域错误。
2. 使用 MySQL 持久化 Session、Command 和事件，以 Redis Dispatcher/Worker 落实跨进程调度、幂等与恢复。
3. Agent runtime 能力已迁移至 `agent-core`，server 通过 core 的执行 interface调用。

## 固定路径约束

后续改造保留以下路径，不再重命名或移动：

- `packages/agent-server/src/consumer/contracts.ts`
- `packages/agent-server/src/utils/`
