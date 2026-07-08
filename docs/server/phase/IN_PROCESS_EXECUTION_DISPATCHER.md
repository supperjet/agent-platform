# In-process Execution Dispatcher 运行说明

## 定位

`InProcessExecutionDispatcher` 是第一版单进程、内存型 Command 调度器。它将 HTTP 接收与 Agent 执行解耦：

```text
HTTP
  ↓ 保存 queued
  ↓ dispatch(commandId)
  ↓ 立即返回 202

Dispatcher
  ↓ 后台执行 Agent
  ↓ 更新 running / succeeded / failed
```

它负责 Prompt 排队、并发控制、控制命令直达、Command 状态更新、错误收敛和优雅关闭，但不提供持久化恢复和跨进程调度。

## 依赖

Dispatcher 只依赖一个执行 interface：

- `CommandRunner`：根据 `commandId` 完成一次 Command 执行。

当前 composition root 选择：

- `InMemoryCommandRepository`
- `SessionCommandRunner`
- `InProcessExecutionDispatcher`

Dispatcher 只决定 Command 何时运行；`SessionCommandRunner` 负责从 Repository 重新读取 Command、更新状态、建立事件上下文并调用 Session runtime。这样调度规则与执行细节彼此独立。

## 内部状态

### active

```ts
Set<Promise<void>>
```

保存已经安排或正在执行的后台任务，用于清理、错误收敛和关闭时等待 drain。

### activePromptSessions

```ts
Set<string>
```

记录当前正在执行 Prompt 的 Session。它保证同一个 Session 同时最多运行一个 Prompt。

### pendingPrompts

```ts
Array<{ commandId: string; sessionId: string }>
```

保存等待执行的 Prompt。队列允许跳过暂时被占用的 Session，让其他 Session 的 Prompt 继续运行。

### maxConcurrency

限制全局同时运行的 Prompt 数量，默认值为 `4`。`steer`、`follow-up` 和 `abort` 不占用 Prompt 并发槽位。

### closing

开始关闭后设置为 `true`，用于拒绝新的 dispatch，同时允许已有队列继续 drain。

## dispatch 流程

`dispatch(commandId)` 首先检查 Dispatcher 是否正在关闭，然后从 Repository 读取 Command。

Prompt 会进入等待队列：

```text
prompt → pendingPrompts → drainPrompts()
```

控制命令不会排在 Prompt 后面：

```text
steer / follow-up / abort → start() → 立即后台执行
```

这样可以避免 Prompt 尚未结束时，`abort` 因排队而失去作用。

## Prompt 调度规则

`drainPrompts()` 在未达到 `maxConcurrency` 时，从等待队列选择第一个当前没有活动 Prompt 的 Session。

例如：

```text
正在运行：session-1

等待队列：
1. session-1 / command-2
2. session-2 / command-3
```

`command-2` 暂时不能运行，但 `command-3` 可以运行。因此 Dispatcher 会先启动 `session-2`，同时保持 `session-1` 内部串行。

最终规则是：

- 同一 Session 的 Prompt 串行。
- 不同 Session 的 Prompt 在全局并发上限内并行。
- 控制命令绕过 Prompt 队列。

## 后台任务启动

`start()` 使用 Promise 微任务安排执行：

```ts
Promise.resolve().then(() => execute(commandId));
```

因此 `dispatch()` 不会等待 Agent 完成。任务 Promise 会立即加入 `active`，任务结束后：

1. 从 `active` 删除。
2. 释放对应的 Prompt Session。
3. 再次调用 `drainPrompts()` 启动后续任务。

后台异常由 `onError` 收敛，避免产生未处理的 Promise rejection；Runner 会先把 Command 更新为 `failed`。

## Command 执行与状态

`SessionApplication` 在 dispatch 前完成：

```text
accepted → queued
```

CommandRunner 执行时完成：

```text
queued → running → succeeded | failed
```

执行步骤：

1. Runner 重新读取 Command。
2. 保存 `running`。
3. 调用 Session runtime。
4. 根据执行回执保存 `succeeded` 或 `failed`。
5. 异常时保存 `failed`，再交给 `onError`。

`SessionCommandRunner` 负责将 Command 类型映射到：

```text
SessionManager.prompt()
SessionManager.steer()
SessionManager.followUp()
SessionManager.abort()
```

## 事件上下文

CommandRunner 通过注入的 `runInContext(command, operation)` 显式建立执行上下文。当前 composition root 将其连接到：

```ts
publicEvents.run(
  command.sessionId,
  command.commandId,
  operation
);
```

这样即使同一 Session 的第二个 Prompt 延迟启动，它产生的公开事件仍然关联自己的 `commandId`，不会继承前一个任务的上下文。

这是当前单进程 Adapter 的过渡方案。未来跨进程 Worker 应显式携带 `sessionId`、`commandId` 和执行上下文，不能依赖 HTTP 的异步调用链。

## 优雅关闭

`close()` 的流程：

1. 设置 `closing = true`，拒绝新任务。
2. 继续启动已进入队列的 Prompt。
3. 等待活动任务逐个完成。
4. 直到 `pendingPrompts` 和 `active` 都为空。

Fastify 关闭顺序为：

```text
停止接受请求
→ SessionApplication.close()
→ Dispatcher drain
→ InMemoryPublicEventStream.close()
```

先 drain 再停止事件监听，确保关机期间最后产生的 Agent 事件仍能进入公开事件账本。

## 当前限制

- Dispatcher 与 HTTP 位于同一个 Node.js 进程。
- 队列、Command 和 Session 都保存在内存中。
- 进程异常退出会丢失排队和运行中的任务。
- 多个 Server 实例无法共享队列。
- `onError` 尚未接入结构化日志和指标。
- 没有租约、超时、自动重试和进程重启恢复。

后续生产实现会保留 `ExecutionDispatcher` interface，使用 Redis 任务传递和独立 Worker 替换当前内存 Adapter；完整 Command 和最终状态仍以 MySQL 为准。
