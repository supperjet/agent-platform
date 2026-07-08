# Session 持久化数据结构

## 本轮范围

第一版定义 Session 的持久化记录、存储接口、MySQL 表和 `MySqlSessionStore` Adapter，并通过 `StoredSessionManager` 接入执行链。未配置 MySQL 时继续使用原有内存 Session Manager。

多 Worker 执行租约和自动续期已接入 Prompt 执行链。用户与租户关系、业务消息历史和公开事件仍留给后续阶段。

## SessionRecord

`SessionRecord` 保存两类信息：

- Server 拥有的 Session 元数据：状态、模型、消息数量、版本和时间。
- Agent Core 拥有的 `AgentConversationState`：Server 仅序列化和恢复，不读取其 `payload`。

`agentState` 可以为空，表示 Session 已存在，但尚未产生可恢复的 Agent 快照。

## 执行租约

### 角色模型

> Session 是可持续复用的“客户档案”，Command 是一次具体工作，Worker 是临时负责这次工作的执行者。

三者不是一一绑定关系：

- 一个 Session 会跨越多轮对话长期存在，并持续保存可恢复的 Agent 上下文。
- 每次 Prompt 都会产生一条新的 Command，代表本轮需要完成的具体工作。
- Worker 只在执行某条 Command 期间临时持有该 Session；执行结束并释放租约后，下一条 Command 可以由任意 Worker 接手。

因此，续租不是让 Worker 永久占有 Session，也不是预先领取下一条 Command。它只表示：当前 Worker 仍然存活，并且当前 Command 尚未执行结束。

### 租约字段

执行租约由三个必须共同出现或共同为空的字段组成：

- `executingCommandId`：当前获得 Session 执行权的 Command。
- `leaseOwner`：持有执行权的 Worker 实例。
- `leaseUntil`：执行权的到期时间；Worker 失联后，其他 Worker 可以在到期后接管。

已有 Session 通过条件 `UPDATE` 原子竞争租约；新 Session 在创建时同时写入租约。执行成功、失败或抛出异常时，最终状态保存会一起释放租约。租约被其他 Worker 持有时，本次 Command 执行失败并交由队列重试；租约过期后允许其他 Worker 接管。

Session `version` 同时充当 fencing token：租约过期后，新 Worker 获取租约会推进版本，因此旧 Worker 无法用旧版本覆盖状态。当前默认租约为五分钟，Worker 每隔约三分之一租期续约。续约只能由相同的 Command 和 Worker 完成，过期租约不能复活；续约失败会终止 runtime，且旧 Worker 不再保存最终状态。

### Prompt 执行链

一条 Prompt Command 的完整生命周期如下：

```text
BullMQ 将 Command 交给有执行容量的 Worker
  -> CommandRunner 从 MySQL 读取 Command，并标记为 running
  -> StoredSessionManager 接收 sessionId、commandId 和 prompt text
  -> promptSessions 防止同一 Worker 内的相同 Session 重复进入
  -> 从 MySQL 查询 Session
     -> Session 不存在：创建 Runtime，并创建一个已持有租约的 Session
     -> Session 已存在：通过条件 UPDATE 原子竞争执行租约
  -> 获得租约后，从 agentState 恢复 Runtime
  -> 将 Runtime 放入 activeSessions，供本 Worker 内的控制命令访问
  -> 启动续租器并执行 Prompt
  -> 每隔约三分之一租期延长 leaseUntil
  -> Prompt 完成后停止续租，并确认租约仍属于当前 Worker
  -> 成功时保存新 agentState；失败时保留执行前的 agentState
  -> 清除 executingCommandId、leaseOwner、leaseUntil，释放 Session
  -> 更新 Command 的最终状态
```

租约获取使用 MySQL 条件 `UPDATE` 完成。只有 Session 没有租约或原租约已经到期时，数据库才会更新成功；多个 Worker 同时竞争时只有一个能获得执行权。

执行期间，无论 Command 最终成功、返回失败还是抛出异常，Manager 都会停止续租并进入收尾流程。只有确认租约仍属于当前 Worker，才能保存最终 Session 状态。正常完成后，Session 回到 `idle`，租约字段被清空，下一条 Command 到来时重新选择 Worker。

### 长时间 Command 与自动续租

所有 Prompt 都使用同一套续租机制。短 Command 通常在第一次续租之前已经完成，计时器会在收尾时直接清除；长 Command 则必须周期性续租，避免执行时间超过租期后被其他 Worker 误判为失联。

以默认配置为例：

```text
租约有效期：5 分钟
续租间隔：约 1 分 40 秒
每次续租：leaseUntil = 当前时间 + 5 分钟
```

续租必须同时匹配 `sessionId`、`executingCommandId` 和 `leaseOwner`，并且旧租约尚未过期。如果续租失败或数据库请求异常：

1. 当前 Worker 将租约标记为已丢失。
2. 当前 Runtime 收到 `abort`。
3. 续租循环停止。
4. 当前 Worker 不再保存最终 Agent 状态。

这可以阻止已经失去执行权的旧 Worker 覆盖接管者写入的新状态。`version` 乐观锁则构成第二道 fencing 防线。

### Worker 空闲与 Session 可执行是两件事

当前没有在 MySQL 中维护 `worker_status` 或“是否空闲”字段。Worker 的执行容量由 BullMQ 根据本进程正在运行的 Job 数和 `concurrency` 管理：

```text
运行中的 Job 数 < concurrency  -> Worker 仍可接收 Job
运行中的 Job 数 = concurrency  -> Worker 暂时不再取新 Job
```

BullMQ 判断的是“哪个 Worker 有接单容量”，MySQL 租约判断的是“这个 Session 是否允许该 Worker 执行”。完整判断顺序是：

```text
BullMQ 把 Command 分配给有容量的 Worker
  -> Worker 尝试获取对应 Session 的数据库租约
  -> 获取成功才执行
  -> 获取失败则由任务失败/重试策略处理
```

因此不需要把频繁变化的 Worker 忙闲状态持久化到业务数据库；Session 的独占执行权才是需要持久化和并发保护的业务事实。

## 并发版本

`version` 是 Session 记录的乐观锁版本，不是 `AgentConversationState.schemaVersion`：

- `version` 防止多个写入者静默覆盖同一 Session。
- `schemaVersion` 描述 Agent Core 状态数据的格式版本。

`SessionStore.save(session, expectedVersion)` 只有在数据库当前版本等于 `expectedVersion` 时才能成功，返回 `false` 表示发生并发修改。

`MySqlSessionStore` 已实现创建、重复创建读取、按 ID 查询和乐观锁保存。真实 MySQL 集成测试可通过 `MYSQL_INTEGRATION_URL` 启用。

`StoredSessionManager` 在 Prompt 执行前恢复 `agentState`，成功后保存新状态；执行失败时保留执行前状态，避免持久化不完整上下文。Session 查询已经改为异步，因此 HTTP Server 可以直接从共享 MySQL 读取，而不依赖本进程缓存。

当前控制命令只路由到同一进程内正在执行的 runtime。跨 Worker 的控制命令路由仍属于下一阶段。

## agent_state

MySQL 使用 `LONGTEXT` 保存完整的 `AgentConversationState` JSON。它是恢复 Agent 所需的最小工作状态，不承担永久执行历史或跨 Session 长期记忆。

第一版不拆分内部消息和工具结果，因为这些属于 Agent Core 的私有运行时结构。后续的上下文压缩、摘要和 Memory 能力也由 Agent Core 演进，不要求 Server 修改表结构。
