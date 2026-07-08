# Command 事务提交与 Outbox 设计

## 1. 目标

解决以下故障窗口：

```text
Command 已写入 MySQL
        ↓
进程退出或 Redis 投递失败
        ↓
Command 永久停留在 queued，没有 Worker 收到任务
```

生产路径必须在一个 MySQL 事务中同时写入 Command 和待投递记录：

```text
BEGIN
  INSERT commands(status = queued)
  INSERT outbox_events(status = pending)
COMMIT
```

事务结果只能是两条记录同时存在或同时不存在。Redis 不参与该事务，也不是最终业务事实来源。

## 2. 模块与 seam

当前 `CommandRepository` 继续负责：

- 按 `commandId` 查询 Command；
- 更新执行状态；
- 为 CommandRunner 提供持久化能力。

不在 `CommandRepository` 中继续增加事务和 Outbox 方法。提交命令是另一项行为，应建立一个小 interface：

```ts
abstract class CommandSubmissionStore {
  abstract createQueuedIfAbsent(command: SubmitCommand): Promise<CreateCommandResult>;
}
```

该 interface 的不变量：

- 新 Command 返回 `created: true`，记录状态已经是 `queued`；
- 相同 `commandId` 和相同内容返回原记录，不重复创建投递记录；
- 相同 `commandId` 但内容不同，由 SessionApplication 转换为冲突错误；
- 返回成功表示 Command 已被当前 Adapter 的投递机制可靠接收；
- 调用方不知道事务、Outbox 表或 Redis 的存在。

两个 Adapter 使这个 seam 成为真实 seam：

- 内存 Adapter：保留快速本地开发和单元测试路径；状态是易失的，不承诺进程恢复。
- MySQL Adapter：在同一事务中写入 `commands` 与 `outbox_events`，承诺数据库级持久化。

`SessionApplication` 不再编排 `createIfAbsent()`、`save(queued)` 等多次写入，只调用一次 `createQueuedIfAbsent()`。

## 3. Outbox 表

第二份 migration 建议建立：

```sql
CREATE TABLE IF NOT EXISTS outbox_events (
  event_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  payload LONGTEXT NOT NULL,
  status VARCHAR(32) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  available_at_ms BIGINT NOT NULL,
  locked_by VARCHAR(128) NULL,
  locked_until_ms BIGINT NULL,
  last_error TEXT NULL,
  created_at_ms BIGINT NOT NULL,
  published_at_ms BIGINT NULL,
  PRIMARY KEY (event_id),
  UNIQUE KEY outbox_command_event_unique (aggregate_id, event_type),
  KEY outbox_delivery_idx (status, available_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

第一种事件固定为：

```text
event_type   = command.queued
aggregate_id = commandId
payload      = { "commandId": "..." }
status       = pending
```

`payload` 使用 LONGTEXT，以兼容当前 MySQL 版本。业务字段仍应使用独立列和索引，不能依赖解析 payload 进行任务扫描。

## 4. Outbox 状态

```text
pending ──投递成功──> published
   │
   └──投递失败──> pending（增加 attempts，推迟 available_at_ms）
```

`locked_by` 和 `locked_until_ms` 表示投递租约。当前 MySQL 不是 8.x，Adapter 使用短事务 `SELECT ... FOR UPDATE` 领取一条记录，不依赖 `SKIP LOCKED`。多个 Relay 可以正确竞争，但领取阶段会串行；当前单 Relay 规模下可以接受。

`published` 只表示任务已经交给当前 Dispatcher，不表示 Agent 已经执行成功。Command 的执行结果仍由：

```text
queued → running → succeeded | failed | cancelled
```

表达。

## 5. Relay 与重复投递

Outbox Relay 执行：

```text
读取/领取 pending Outbox
        ↓
向 ExecutionDispatcher 投递 commandId
        ↓
成功后标记 published
```

如果 Relay 已投递、但在标记 `published` 前退出，同一 Outbox 会再次投递。因此系统只能承诺“至少一次投递”，Worker 必须通过 MySQL 条件更新竞争 Command 执行权，不能假设消息只出现一次。

当前内存 Dispatcher 不能提供进程级持久化。Outbox Relay 可以先用它验证模块协作，但只有接入 Redis 并实现确认/重试后，才具备跨进程恢复能力。

## 6. 事务与幂等

MySQL Adapter 的 `createQueuedIfAbsent()` 流程：

1. 获取连接并开始事务；
2. 插入状态为 `queued` 的 Command；
3. 插入 `command.queued` Outbox；
4. 提交事务；
5. 若 Command 主键重复，回滚后读取原 Command 并返回 `created: false`；
6. 其他错误原样抛出，不得静默降级到内存。

Command 主键负责请求幂等，Outbox 的 `(aggregate_id, event_type)` 唯一索引负责投递记录幂等。

## 7. 验证范围

单元测试通过同一个 `CommandSubmissionStore` interface 验证：

- 新 Command 直接进入 queued；
- 相同 Command 重试不会产生第二次提交；
- 冲突内容可被 SessionApplication 识别；
- 调用方不再执行 accepted → queued 的两次保存。

真实 MySQL 集成测试验证：

- Command 与 Outbox 同时提交；
- 第二次相同提交只有一条 Command 和一条 Outbox；
- Outbox 插入失败会回滚 Command；
- Command 插入失败不会产生 Outbox；
- Unicode、长文本和连接释放正常。

## 8. 实施切片

1. `002-create-outbox-events.sql` 与真实 MySQL migration 验证。（已完成）
2. `CommandSubmissionStore` interface，以及内存/MySQL 两个 Adapter。（已完成）
3. SessionApplication 改为一次 `submit()`，删除 accepted → queued 的双写编排。（已完成）
4. 契约测试和事务回滚集成测试。（已完成）
5. Outbox Relay + 当前内存 Dispatcher。（已完成）
6. 使用 BullMQ/Redis 替换 Relay 的投递 Adapter。（已完成同进程 Worker 基础版）

本阶段不设计最终用户、Session、Message 表，也不把 Redis 或多个 Worker 一次性引入。业务表会在领域关系明确后通过后续 migration 增量建立。

当前 MySQL 模式在事务提交后只唤醒 Relay，由 Relay 领取 `pending` Outbox、重读 Command 并交给内存 Dispatcher；SessionApplication 不再直接调度。内存模式仍在提交后直接 enqueue，普通开发和单元测试不依赖 MySQL。

Relay 只 enqueue 状态仍为 `queued` 的 Command。对于升级前已经执行完成、但 Outbox 仍为 `pending` 的历史记录，Relay 只补标 `published`，避免服务升级后重复执行。

配置 `REDIS_URL` 后，Relay 将任务写入 BullMQ 后再标记 `published`。BullMQ 通过稳定 Job ID 去重，并负责执行确认、失败重试和进程退出后的待处理任务恢复；未配置 Redis 时仍使用原内存 Dispatcher。

当前 BullMQ Worker 与 HTTP Server 仍在同一进程，只完成了“任务不再保存在 Server 内存”的切片。下一步不能直接拆成独立 Worker：`SessionManager`、Agent runtime 和公开事件仍是进程内状态。应先明确并持久化 Worker 可恢复的 Session/Agent 上下文，再拆分 Worker composition root。
