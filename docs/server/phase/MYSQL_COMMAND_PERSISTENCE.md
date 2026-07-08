# MySQL Command 持久化

## 目标

第一阶段只使用 MySQL 持久化 Command。现有内存 Dispatcher 保持不变；Redis Dispatcher 和独立 Worker 属于后续阶段。

```text
HTTP -> MySQL CommandRepository -> 内存 Dispatcher -> CommandRunner
```

未来演进为：

```text
HTTP -> MySQL CommandRepository -> Redis -> Worker -> CommandRunner
```

Redis 中只传递 `commandId`，Command 内容和最终状态以 MySQL 为准。

## 兼容性

迁移脚本位于 `packages/agent-server/migrations/001-create-commands.sql`。表结构只使用 InnoDB、`VARCHAR`、`LONGTEXT`、`BIGINT` 和普通索引，不依赖 MySQL 8 的 JSON、`SKIP LOCKED` 等能力。

时间以 Unix 毫秒保存，避免数据库和 Node.js 进程时区不一致。文本使用 `utf8mb4`。

## 配置与启动

### Docker 本地环境

本地开发默认仍使用内存 Repository，不需要启动 Docker。只在验证 MySQL Adapter 时执行：

```bash
npm run db:up
npm run db:migrate
npm run test:mysql
```

Compose 使用 MySQL 5.7.44，通过宿主机 `3307` 端口暴露，避免与本地 MySQL 的默认 `3306` 冲突。数据保存在命名 volume `agent-platform-mysql` 中，停止或重建容器不会自动删除数据。

```bash
npm run db:down
```

`db:down` 只停止并删除容器，不删除 volume。不要随意执行带 `--volumes` 的 Compose 删除命令。

真实数据库集成测试通过 `MYSQL_INTEGRATION_URL` 显式启用；普通 `npm test` 不依赖 Docker/MySQL。

如需连接其他测试库，可以覆盖默认地址：

```bash
MYSQL_INTEGRATION_URL=mysql://user:password@host:3306/database npm run test:mysql
```

### Server 配置

先执行 migration，然后设置：

```dotenv
STORAGE_MODE=dataBase
MYSQL_URL=mysql://user:password@host:3306/database
```

`STORAGE_MODE=dataBase` 时，服务创建 MySQL 连接池并使用 MySQL Adapter；该模式必须配置 `MYSQL_URL`。`STORAGE_MODE=inMemory` 时显式使用内存 Adapter，即使环境中存在基础设施 URL 也不会自动切换。

启动时会查询 `commands` 表。数据库不可访问或 migration 尚未执行时，服务启动失败，避免悄悄退回内存存储。

连接池由服务启动入口创建，并在 Fastify 关闭时释放。Repository 只依赖 `mysql2` 的 Pool，不依赖 Fastify，因此未来独立 Worker 可以复用同一实现。

## 当前限制

- Session 本身仍在内存中，重启后不能恢复 Agent 的对话上下文。
- 内存 Dispatcher 中尚未执行的任务会在进程退出时丢失。
- MySQL 中的 `queued` 或 `running` 记录暂不自动恢复。
- Redis 调度、任务确认、重试、租约和死信处理尚未实现。

因此本阶段解决的是 Command 记录和幂等信息的持久化，不代表完整的任务故障恢复已经完成。
