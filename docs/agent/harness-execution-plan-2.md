# Agent Core Harness 执行计划 2

本文是 `harness-execution-plan.md` 的阶段性续篇，用来记录当前
`agent-core` 已经落地的能力、仍未实现的能力、已有但需要补强的缺口，
以及下一阶段推荐实施顺序。

本文的规划判断是：短期先完善 `agent-core` 自身的核心运行能力，
暂不优先抽象业务能力包。业务 Agent 的定义、能力包、领域工具集合等，
应当建立在 core 的输入处理、上下文组装、生命周期、队列、持久化、
压缩、记忆和策略治理都相对稳定之后。

## 0. 核心完成目标

`agent-core` 的核心能力完成，不等于已经实现某一种具体业务 Agent。
它的目标是提供一条可复用的通用运行闭环：

```text
输入处理
  -> 上下文组装
  -> 模型调用
  -> 工具执行
  -> 生命周期扩展
  -> 队列 / 中断 / 恢复
  -> 会话 / 运行状态持久化
  -> 上下文预算 / 压缩
  -> 基础记忆
  -> 策略治理
```

当这条闭环稳定后，业务层再通过 tools、resources、prompt templates、
context providers、lifecycle hooks、policies 等方式装入业务能力。

因此当前阶段的优先级是：

```text
先补 agent-core 的可靠运行核心
  -> 再补长期上下文能力
  -> 最后抽象业务能力定义
```

## 1. 当前总体状态

项目已经从“Pi runtime adapter 混合装配逻辑”推进到 Harness v1 骨架：

```text
PiAgentRuntimeFactory
  -> RuntimeAssembler
     -> DefinitionResolver
     -> ResourceCatalog
     -> ToolCatalog
     -> PromptAssembler
     -> ModelCatalog / ModelGateway
     -> ConversationStore / ConversationProjector
     -> ToolRuntime
     -> LifecycleHooks
     -> RuntimePolicies
  -> AgentLoopAdapter
  -> AgentRuntimeSession
     -> TurnRunner
     -> InputProcessor
     -> ContextAssembler
     -> EventHub
     -> StateExporter
```

当前已经具备一个可运行闭环：

```text
AgentDefinition
  -> RuntimeAssembler 装配
  -> AgentRuntimeSession 创建
  -> execute(prompt)
  -> InputProcessor.onInput
  -> ContextAssembler.beforeRun / beforeContext
  -> AgentLoopAdapter 执行
  -> ToolRuntime 包装工具调用
  -> EventHub 发布公共事件
  -> StateExporter 导出 conversation state
```

## 2. 已实现能力

### 2.1 构建层

已实现：

- `RuntimeAssembler`：把 definition、resources、tools、prompt、model、conversation、lifecycle、policies 装配成运行态材料。
- `DefinitionResolver`：校验和规范化 `AgentDefinition`。
- `ResourceCatalog v1`：静态 resource registry，输出 prompt fragments / resource infos。
- `ToolCatalog`：解析 tool names，输出 active tools、tool metadata、prompt snippets/guidelines。
- `PromptAssembler`：生成长期 `systemPrompt`。
- `ConversationStore`：恢复 conversation state，兼容旧 `{ messages }` payload。
- `ConversationProjector`：把 active message entries 投影成 LLM messages。
- `ModelCatalog v1`：返回 definition model。
- `ModelGateway v1`：封装 API key resolver。
- `RuntimePolicies`：已有占位结构，当前为 `queue: "direct"`、`retry: "none"`、`compaction: "disabled"`。

### 2.2 运行层

已实现：

- `AgentLoopAdapter`：隔离底层 `@earendil-works/pi-agent-core` Agent。
- `AgentRuntimeSession`：对外 runtime facade。
- `TurnRunner`：支持 `prompt / steer / follow-up / abort`。
- `EventHub`：把底层 AgentEvent / ToolRuntimeEvent 转成公共 runtime events。
- `StateExporter`：把 loop snapshot 同步成 conversation entry graph 并导出 state。
- `InputProcessor v1`：接入 `lifecycle.onInput`，支持 `continue / transform / handled`。
- `ContextAssembler v1`：接入 `beforeRun / beforeContext`，支持 per-turn system prompt overlay 和临时 messages。
- `ContextBudget v1`：估算 message count 和字符数，不裁剪。

### 2.3 Tool 能力层

已实现：

- 内置工具：`read / write / edit / bash / grep / find / ls`。
- `ToolOperations`：本地 fs/shell 操作抽象，工具不直接绑定 Node fs/process。
- `ToolRuntime`：统一包裹工具执行。
- `ToolPolicy`：支持 allow / block / requireApproval / rewrite。
- Approval 事件和 policy 事件进入公共事件流。
- `beforeToolCall / afterToolCall` 已统一挂到 `LifecycleRunner`。
- CLI 和 playground 能验证单工具与完整 agent path。

### 2.4 Lifecycle v1

已实现 hooks：

- `onInput`
- `beforeRun`
- `beforeContext`
- `beforeToolCall`
- `afterToolCall`
- `afterMessage`
- `beforeCompaction`
- `afterRun`

实际接入：

```text
InputProcessor       -> onInput
ContextAssembler     -> beforeRun / beforeContext
ToolRuntime          -> beforeToolCall / afterToolCall
AgentRuntimeSession  -> afterMessage
TurnRunner           -> afterRun
```

当前语义：

- hook 按注册顺序串行执行。
- transform 结果传给后续 hook。
- block / handled / cancel 类结果可以短路对应流程。
- metadata 使用浅合并，后写同名 key 覆盖前值，不同 key 保留。
- `afterMessage` 是可改写 hook，会先消费替换 message，再发布公共事件和同步 state。
- `afterMessage` 允许改写内容，但不允许改变 message role。

## 3. 未实现能力

### 3.1 Policy 层

未实现：

- `QueuePolicy`
- `RetryPolicy`
- `CompactionPolicy`

当前 `TurnRunner` 仍然是直接执行 command，没有真实运行中队列、重试、压缩后继续。

### 3.2 Compaction

已有：

- `ContextBudget v1`
- `beforeCompaction` hook 定义和 runner 方法

未实现：

- 自动阈值压缩。
- context overflow recovery。
- 手动 compact command。
- compaction entry。
- compaction summary projection。
- `beforeCompaction` 的真实调用点。

### 3.3 ResourceCatalog v2+

当前只是静态 registry 资源。

未实现：

- 自动扫描 `AGENTS.md` / `CLAUDE.md`。
- context files discovery。
- skills discovery。
- prompt templates discovery。
- resource reload。
- `extendResources()`。
- extension resource discovery。
- trust/source scope。

### 3.4 Skill / Prompt Template

未实现：

- `prompt-template.ts`
- 正式 slash command 输入协议
- skill registry
- skill selector
- skill expansion
- active skill context injection
- prompt template expansion

已具备的基础：

- `InputProcessor` 已支持 `/xxx ...` 的基础解析，并把结果放入 per-turn
  metadata。
- lifecycle hooks 已可基于 metadata 临时调整 system prompt 或追加本轮
  context message。
- 这类临时注入默认是 `transient` scope，可通过 `/context` 调试，不污染
  conversation state。

因此当前不建议马上实现完整 skill registry 或 prompt template renderer。
现阶段应把 slash command 视为 metadata 入口，等 Queue / Turn Execution
语义稳定后，再把 template、skill selection、skill context injection
正式抽象出来。

### 3.5 Model 层

当前 `ModelCatalog` 和 `ModelGateway` 仍然很薄。

未实现：

- provider registry。
- custom provider。
- auth chain。
- token usage / cost。
- provider error 标准化。
- stream / complete 标准接口。
- model fallback。
- capability check。

### 3.6 SessionRuntime

当前只能创建单个 runtime session。

未实现：

- new / resume / fork / import / switch session。
- cwd 切换时重建 resources/tools/settings/trust/extensions。
- session-level lifecycle。
- JSONL append-only 持久化。

### 3.7 持久化与恢复

当前 `ConversationStore` 只支持基础 conversation state 恢复，运行状态、
事件、工具调用记录和 session 快照还没有形成可恢复的持久化层。

阶段 D 需要先确认持久化策略：`agent-core` 只定义可恢复状态的语义和
导入导出契约，具体存储介质由运行方式决定。server 部署可以使用数据库，
本地直接运行可以使用文件或 SQLite，CLI/SDK 也可以由调用方接管状态保存。
详见“阶段 D：持久化与恢复”中的 Persistence Strategy 小节。

未实现：

- `RunStore`：保存每次 run / turn 的状态、开始结束时间、失败原因。
- `EventStore`：保存公共事件和关键内部事件，支持回放与诊断。
- `RuntimeStateStore`：保存 session runtime snapshot、队列状态、abort 状态。
- tool call / tool result 持久化。
- lifecycle metadata 的运行期记录策略。
- compaction result 持久化。
- runtime snapshot / restore。
- append-only session log。

持久化优先级高于长期记忆。没有持久化，后续的压缩、恢复、审计、
调试和多 session 管理都会缺少稳定地基。

### 3.8 Memory

当前没有长期记忆能力。需要注意：memory 不等于 conversation history。
conversation history 是原始对话记录，memory 是从会话中提炼出来、
可在未来任务中复用的长期上下文。

未实现：

- `MemoryStore`
- memory entry schema。
- memory extraction。
- memory retrieval。
- memory ranking / filtering。
- memory 与 ContextAssembler 的接入点。
- memory 的写入确认、更新和删除机制。
- memory 与 compaction summary 的关系。

第一版 memory 可以先只设计接口和存储结构，不急于实现复杂自动提取。

### 3.9 Public Surface 收口

当前 `index.ts` 仍导出较多内部模块。

未实现：

- 对外主命名从 `PiAgentRuntimeFactory` 收口到 `AgentCoreRuntimeFactory`。
- public exports 收窄到稳定 SDK surface。
- 内部模块不再从根出口泄漏。
- 文档命名与实际代码命名统一。

## 4. 已有但待完善

### 4.1 Lifecycle 事件队列

`afterMessage` 为了支持异步改写，`AgentRuntimeSession` 内部维护了 `pendingLoopEvents` 队列。

已补强：

- 增加最大队列长度保护，避免极端情况下事件堆积。
- `afterMessage` hook error 会包装为 `LifecycleEventProcessingError`，
  并标记 `stage: "afterMessage"`。
- `pendingLoopEvents` 溢出会包装为 `LifecycleEventProcessingError`，
  并标记 `stage: "loopEventQueue"`。
- `TurnRunner` 在 input/context/loop/event flush/state sync 失败且还没有
  发出终态通知时，会调用 `afterRun({ status: "failed" })`。

仍待完善：

- 区分 lifecycle failure、agent failure、tool failure。

### 4.2 Lifecycle Metadata

当前 metadata 已经浅合并，并已开始定义第一批 core-level input metadata。

已补强：

- `InputProcessor` 输出结构化 `metadata`，当前支持：
  - `slashCommand`
  - `inputMode`
  - `selectedTemplate`
  - `args.raw`
- `/review xxx` 这类 prompt 输入会被解析为 slash metadata，但不改变原始
  prompt 文本。
- `LifecycleRunner.onInput` 支持 hook 返回 metadata，并按注册顺序浅合并。
- `ContextAssembler` 接收 input metadata，并传给 `beforeRun` /
  `beforeContext`。
- `TurnRunner` 会把合并后的 hook metadata 传给 `afterRun`。
- metadata 已明确为 per-turn scratch state，不写入 conversation 持久状态。

仍待完善：

- 为 skill selector / prompt template expansion 补更具体的 metadata schema。

建议形态：

```ts
type ProcessedInput = {
  status: "ready";
  command: AgentRuntimeCommand;
  metadata?: {
    slashCommand?: string;
    selectedSkill?: string;
    args?: Record<string, unknown>;
  };
};
```

### 4.3 ContextAssembler

当前输入包括：

```text
command
baseSystemPrompt
conversationMessages
metadata
```

已补强：

- `ContextAssembler` 消费 `InputProcessor` 输出的 per-turn metadata。
- `beforeRun / beforeContext` 可以读取并继续合并 metadata。
- 输出 `metadata.diagnostics`，当前包含：
  - `budget`
  - `injectedSources`
- 输出 prompt message persistence scope，区分用户输入这类 `persistent`
  message 和 hook 注入的 `transient` run-local context。
- `AgentRuntimeSession.inspectContext()` 和 playground `/context` 可以查看最近
  一次 assembled context；`/state` 只展示 exported conversation state。
- 公共 runtime message events 携带 `messageScope`，当前支持 `persistent` /
  `transient` / `unknown`。client 可以保留 transient 事件用于调试，但不把它
  当作普通 transcript message 展示。

文档目标中还应逐步消费：

- definition
- resources snapshot
- active tools
- budget
- compaction summary
- memory
- skills
- branch summary

### 4.4 ConversationStore

当前只实现 message entry。

待完善：

- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom_state`
- `custom_message`
- `label`
- `session_info`
- branch/fork/tree navigation
- tool call/tool result 顺序合法性校验

### 4.5 Runtime Persistence

待完善：

- conversation state 与 runtime state 分层。
- run / turn / event / tool call 的统一记录模型。
- session 恢复时重建 loop snapshot、message overrides、pending 状态。
- StateExporter 与持久化层的职责划分。
- 测试 append-only log 回放后的 exported state 一致性。

### 4.6 Memory 接入点

待完善：

- memory 作为 ContextAssembler 的输入来源，而不是直接写入 system prompt。
- memory extraction 可以由 lifecycle、后台任务或显式 command 触发。
- memory retrieval 需要可解释 diagnostics，说明为什么某条 memory 被选中。
- memory 不应默认写入 conversation，除非产生显式 memory entry 或 custom state。

### 4.7 Tool 层

待完善：

- 每个内置工具更细的独立测试。
- edit diff/render utils。
- file mutation queue，避免并发写入/编辑互相覆盖。
- bash executor 抽象增强。
- tool observability：duration、approval latency、failure type。
- sandbox / remote / container 版 `ToolOperations`。

## 5. 下一阶段推荐实施顺序

### 阶段 A：收尾 Runtime / Lifecycle v1

目标：把刚完成的 lifecycle、input、context 打磨成稳定边界。

工作项：

- 给 `pendingLoopEvents` 增加最大长度保护。已完成。
- 明确 `afterMessage` 的错误归因和诊断策略。已完成第一版，
  当前使用 `LifecycleEventProcessingError` 标记 `afterMessage` 与
  `loopEventQueue`。
- 更新 lifecycle/input/context README 和执行计划状态。已更新 lifecycle
  README 和本文状态；input/context 在阶段 B 进入 metadata 与 diagnostics
  时继续更新。
- 保持 `beforeCompaction` 为已定义未接线状态，等待 compaction 阶段消费。

验收：

- lifecycle hook 执行、短路、合并、改写都有测试。
- `afterMessage` 改写会影响公共事件和 exported state。
- `afterMessage` 失败和 loop event queue 溢出都有测试。
- 失败路径会触发 `afterRun({ status: "failed" })`。
- `npm test --workspace @agent-platform/agent-core` 通过。

### 阶段 B：InputProcessor v2 / ContextAssembler v2

目标：先把输入处理和上下文组装变成稳定 core 能力，而不是直接进入业务能力定义。

当前状态：已完成。阶段 B 的边界是提供 metadata、diagnostics、run-local
context injection、prompt message persistence scope 和 debug inspection。
它不包含正式 skill registry、prompt template expansion 或业务能力包。

建议顺序：

```text
InputProcessor metadata
  -> slash command 基础解析
  -> ContextAssembler 消费 metadata
  -> ContextBudget 预算结果进入 diagnostics
  -> lifecycle hooks 全链路消费检查
```

工作项：

- 扩展 `ProcessedInput`，允许携带结构化 metadata。已完成。
- 定义第一批 core-level metadata key，例如 slash command、input mode、selected template。已完成第一版。
- 支持 `/xxx ...` 的基础解析，但暂不绑定具体业务 skill。已完成。
- `ContextAssembler` 接收 input metadata，并传给 `beforeRun / beforeContext`。已完成。
- `ContextAssembler` 输出清晰 diagnostics，包括 message 数量、字符预算、注入来源。已完成第一版。
- 明确 metadata 是 per-turn scratch state，不默认进入 conversation 持久状态。已完成。
- 明确 lifecycle 注入 messages 是 run-local context，不默认进入 conversation
  持久状态，并提供 `/context` 查看入口。已完成。

验收：

- `/review xxx` 这类输入可以被解析成 metadata。已覆盖。
- metadata 可被 `beforeRun` 或 `beforeContext` 消费并影响 prompt messages。已覆盖。
- hook 注入 message 会影响本轮模型输入，但不会污染 `/state` 或下一轮 loop
  history。已覆盖。
- runtime message events 会携带 `messageScope`，client transcript 可以过滤
  transient context，同时保留事件日志。已覆盖。
- ContextAssembler 的输入、输出、metadata 传递都有测试覆盖。已覆盖。

明确延后：

- 不在阶段 B 实现完整 skill registry。
- 不在阶段 B 实现 prompt template renderer。
- 不在阶段 B 定义业务 capability pack。
- 这些能力依赖 turn queue、持久化、资源发现和 context budget 更稳定后再做。

### 阶段 C：Queue / Turn Execution

目标：让 runtime 从“能执行一次”升级为“可靠连续执行”。

要解决的问题：

- 当前 `AgentRuntimeSession.execute()` 直接调用 `TurnRunner.run()`，没有
  session-level execution state。多个 execute 并发进入时，prompt assembly、
  loop event flush、transient context cleanup 和 state export 可能交错。
- `prompt / steer / follow-up / abort` 已有命令类型，但它们在 idle、running、
  aborting、failed 等状态下的语义还没有明确契约。
- `abort` 目前只是向底层 loop 发送请求；它和当前 turn、queued turns、事件
  flush、`afterRun` 通知之间的关系还没有稳定定义。
- 阶段 B 引入了 prompt message scope 和 transient cleanup，因此阶段 C 必须
  保证每个 turn 的 event、cleanup、state export、afterRun 顺序一致。

核心产物不是复杂策略系统，而是 `Turn Execution Semantics v1`：

```text
external command
  -> read execution state
  -> classify command semantics
  -> create/reject/merge queue item
  -> execute one active turn
  -> flush loop events
  -> cleanup run-local context
  -> export state
  -> notify afterRun exactly once
  -> advance next queue item
```

### 阶段 C.1：Turn Execution Semantics v1

建议先定义并测试以下契约，再实现更复杂 policy。

当前状态：已完成第一版 session-level execution controller。它先覆盖 prompt
FIFO queue、handled input 短路、idle control command reject、running
control command 转发、active abort request 转发和 running snapshot。
active prompt 收到 abort 后，当前 prompt turn 会在 loop idle 和事件/state
收尾后返回 `{ status: "aborted" }`，触发 `afterRun({ status: "aborted" })`，
并在公共事件流中发布 `run_aborted`。

状态模型：

- `idle`：没有 active turn，可以立即启动 prompt turn。
- `running`：有 active prompt turn；新输入必须被明确判定为 queue、steer、
  follow-up、reject 或 abort。
- `aborting`：已收到 abort 请求，等待底层 loop 进入 idle 并完成事件收尾。
- `failed`：上一轮执行失败，但 session 仍可接受新的 prompt；失败原因需要可
  诊断，不能污染下一轮 transient context。

默认命令语义：

- `prompt` + `idle`：立即启动一个新 turn。
- `prompt` + `running`：默认排队，后续可由 `QueuePolicy` 改成 reject 或 merge。
- `steer` + `running`：发送给当前 active turn，不创建新的 queued turn。
- `steer` + `idle`：默认 reject，因为没有 active turn 可 steer。
- `follow-up` + `running`：追加到当前 loop 的 follow-up 通道，不创建完整 prompt
  turn；后续可以再明确是否需要排队语义。
- `follow-up` + `idle`：默认当作新 prompt 或 reject 需要二选一。建议 v1 先
  reject，避免把 follow-up 偷偷降级成普通 prompt。
- `abort` + `running`：进入 `aborting`，请求底层 loop abort。
- `abort` + `idle`：返回 succeeded，但不产生新的 run。

默认队列策略：

- v1 只支持 FIFO prompt queue。
- 同一时间最多一个 active prompt turn。
- queued prompt 在前一轮完成完整收尾后再启动。
- abort 默认只影响 active turn，不自动丢弃 queued prompts；是否清空队列留给
  后续 `QueuePolicy`。
- 队列需要最大长度，溢出返回 failed/rejected outcome，并产生可诊断事件或错误。

每个 prompt turn 的收尾顺序：

```text
loop.waitForIdle()
  -> flush pending loop events
  -> apply afterMessage replacements
  -> publish scoped message events
  -> cleanup transient prompt messages from loop history
  -> StateExporter sync/export
  -> afterRun(success | failed | aborted)
  -> mark idle or start next queued prompt
```

需要特别保证：

- `afterRun` 每个 accepted turn 只调用一次。
- handled input 可以不进入 queue，但仍要有一致 outcome。
- rejected input 不应污染 conversation state。
- transient prompt messages 只属于创建它们的 turn，不跨 turn 泄漏。
- failed/aborted turn 结束后，下一轮 prompt 仍能正常组装 context。

工作项：

- 实现 turn queue 的基础模型。已完成第一版 FIFO prompt queue。
- 明确 running / idle / aborted / failed 状态流转。已完成第一版，
  当前状态保存在 `AgentRuntimeSession`。
- 明确 prompt / steer / follow-up / abort 在不同状态下的语义。已完成第一版：
  prompt 可排队，idle steer/follow-up rejected，running steer/follow-up 转发，
  idle abort no-op，running abort 转发到底层 loop。
- 支持 command 排队、拒绝或合并的基础策略入口。已完成 queue/reject 基础；
  merge 留给后续 `QueuePolicy`。
- 整理 `waitForIdle`、event flush、afterTurn 的时序。已沿用阶段 B 的 prompt
  turn 收尾顺序；active prompt abort 会在收尾后归因为 aborted。
- 为 turn queue 增加最大长度保护。已完成。

验收：

- 并发 execute 不会破坏 conversation state。
- abort 后状态和事件一致。已覆盖 running snapshot、abort request、active turn
  aborted outcome、`run_aborted` 事件和 queued prompt 后续启动。
- `afterRun` 在成功、失败、abort 路径都有稳定调用语义。已覆盖。
- queued prompt 按 FIFO 顺序执行，且每轮 transient context 互相隔离。FIFO 已覆盖；
  transient 隔离由阶段 B 测试继续保护。
- running 状态下的 steer/follow-up 不会被误写成新的持久 prompt turn。已覆盖。

### 阶段 D：持久化与恢复

目标：建立 Agent 可靠运行的地基，让 conversation、run、event、tool call、
runtime state 可以保存、恢复、回放和诊断。

#### Persistence Strategy

持久化要先分清两个层次：

- `agent-core` 负责定义恢复语义，不绑定数据库、文件系统或某个 server。
- runtime 宿主负责选择持久化介质，并决定保存时机、并发控制和生命周期。

`agent-core` 应当拥有的契约：

- `exportState()` 导出可恢复的 conversation state。
- runtime factory 支持通过 `restoredState` 创建等价会话。
- state schema 带版本号，后续允许 migration。
- 明确哪些 message / entry 会进入 state，哪些只是本轮 transient context。
- 定义 success、aborted、failed、handled input 的状态写入语义。

`agent-core` 不应当拥有的职责：

- 不直接依赖 MySQL、Postgres、Redis、SQLite 或本地路径。
- 不保存 provider API key、approval 临时决策、活动中的 AbortSignal。
- 不把公共事件流直接等同于 conversation state。
- 不要求所有运行方式都使用同一种 session store。

不同执行方式的推荐策略：

- Server 托管模式：由 `agent-server` 的 `SessionStore` 持久化 session 状态、
  executing command、run outcome、agent state 和 message count。数据库可以是
  MySQL / Postgres / Redis 等，核心要求是有一致的 session lease 和状态更新。
- 本地长期会话模式：由本地 adapter 使用文件或 SQLite 保存 state，例如
  `.agent-platform/sessions/<sessionId>.json`。写入应当是原子替换，并在同一
  session 并发运行时加锁或拒绝。
- CLI 一次性模式：优先提供 `--state-in` / `--state-out` 这类显式入口，
  不默认隐式污染用户目录。
- Playground 模式：可以提供显式 `/save` / `/load` 或启动参数绑定本地 state，
  用于调试恢复语义；是否自动保存应保持可配置。
- SDK 嵌入模式：默认由调用方保存 `exportState()` 的结果，并在下次构造
  runtime 时传回 `restoredState`。

保存时机：

- prompt 成功完成后，保存最新 `exportState()`。
- prompt 被 abort 后，保存已经确认可持久化的输入和清理后的 state，不保存
  abort 过程中产生的临时 assistant error / tool artifact。
- prompt 失败后，默认保留失败前的稳定 state；失败详情进入 run/event 记录。
- handled input 不进入 prompt queue，也不生成新的 prompt turn；如果未来允许
  handler 写状态，必须通过显式 outcome 表达。
- transient lifecycle messages、per-turn metadata 和活动执行状态不写入
  conversation state。

持久化失败语义：

- turn 执行完成不等于 state 已经 durable commit。只有 conversation state
  写入成功后，宿主才能把该 turn 标记为已持久化完成。
- 如果 state 写入失败，例如磁盘满、权限错误、数据库连接中断或事务提交失败，
  runtime 应返回明确的 commit failure outcome，或者由宿主把 session 标记为
  `dirty` / `commit_failed`，避免对外宣称该 turn 已稳定保存。
- 写入失败后可以做有限重试，但重试必须有边界。超过重试次数后，应保留内存中
  最新 `exportState()` 作为 best-effort recovery material，并暴露给宿主决定
  是否再次保存、导出到备用位置或提示用户。
- EventStore 可以作为诊断和补偿线索，记录 state commit failed、失败原因、
  command id、run id、目标 state version 等信息；但 EventStore 不应被当作
  conversation state 的唯一真相来源。
- 下次恢复时，如果发现 session 处于 `dirty` / `commit_failed`，应优先尝试
  恢复最后一次成功 commit 的 state，并把未提交 run 标记为需要人工或宿主策略
  决定是否 replay / discard / repair。
- server 托管模式应尽量把 run outcome、agent state、message count 和 session
  status 放在同一个事务或等价原子更新中。本地文件模式应使用临时文件加
  atomic rename，避免写出半个 JSON state。

Run / Event / Runtime state 的边界：

- Conversation state 是恢复后继续对话所需的最小事实记录。
- RunStore 记录某次 turn 的执行状态、开始结束时间、失败或 abort 原因。
- EventStore 记录可回放和诊断的公共事件，不作为 LLM 上下文的唯一来源。
- RuntimeStateStore 只保存 session 级运行快照，例如队列、lease、当前命令等；
  不能假设活动中的工具调用可以跨进程原地恢复。

阶段 D 的第一步不是选择某个数据库，而是把上面的契约测试化：同一份
conversation state 在 server、本地、CLI 或 SDK 宿主中，都能恢复出一致的
可继续运行会话。

#### 可执行步骤

阶段 D 不应一次性实现完整持久化系统，而应按“语义先行、宿主接入随后”
拆成可验收的小步。

```text
D.0 recovery semantics tests
  -> D.1 ConversationStore v2 schema
  -> D.2 state commit contract
  -> D.3 server persistence alignment
  -> D.4 local persistence adapter
  -> D.5 RunStore / EventStore interfaces
  -> D.6 tool call recovery record
  -> D.7 RuntimeStateStore / append-only log
```

##### D.0 恢复语义测试

目标：先把已有 runtime 的恢复边界测试化，不引入新存储。

当前状态：已完成第一版。已覆盖 success restore、entry graph 顺序、
transient context、aborted turn、failed turn 和 handled input 的恢复边界。

工作项：

- 覆盖 `exportState()` 后通过 `restoredState` 创建 runtime 的等价恢复。已完成。
- 覆盖 restored conversation entry graph 的 parent/leaf 顺序。已完成。
- 覆盖 transient lifecycle context 不进入恢复 state。已完成。
- 覆盖 aborted turn 不把 abort 过程中的 assistant error / tool artifact 写入
  conversation state。已完成。
- 覆盖 failed turn 默认保留失败前稳定 state，不把失败 prompt 或 assistant error
  写入 conversation state。已完成。
- 覆盖 handled input 不进入 prompt queue，也不产生新的 prompt turn。已完成。

验收：

- `agent-core` 测试能证明同一份 exported state 恢复后继续对话语义一致。已覆盖。
- success / aborted / failed / handled 的 state 边界都有明确测试。已覆盖。

##### D.1 ConversationStore v2 schema

目标：把 conversation state 从单一 messages 扩展为版本化 entry graph。

当前状态：已完成第一版。`AgentConversationState` 已收口为 v2-only entry
graph，不再支持旧 `{ messages }` payload 或 legacy `type/timestamp/message`
entry。`message` entry 会投影为 LLM messages，`compaction`、`custom_state`、
`session_info` 和未知 future entry 会保留在 state 中，但不会默认进入 prompt
projection。

工作项：

- 为 conversation state 增加 schema/version 字段。已完成，当前仅支持
  `schemaVersion: 2`。
- 明确 entry 基础字段：`id`、`parentId`、`kind`、`createdAt`、`payload`。已完成。
- 保留 message entry 作为当前对话恢复的主路径。已完成。
- 预留 `compaction` entry，用于保存被压缩历史的语义摘要。已完成 schema。
- 预留 `custom_state` entry，用于保存 namespace 隔离的结构化 agent/extension
  状态。已完成 schema。
- 预留 `session_info` entry，用于保存 cwd、agent definition、model/resource
  compatibility 等恢复环境信息。已完成 schema。
- `ConversationProjector` 对未知 entry kind 采取保守策略：不投影为 LLM
  message，但保留在 exported state 中。已完成。

验收：

- 旧 `{ messages }` payload 和 legacy entry 不再支持，恢复入口只接受 v2
  entry graph。已完成。
- 新 entry graph 可以导出、导入，并保持 leaf/parent 关系。已覆盖。
- 未接线的 entry kind 不破坏 prompt projection。已覆盖。

##### D.2 State Commit Contract

目标：定义 turn 完成后“写入成功/失败”的一致 outcome。

当前状态：已完成第一版。`AgentExecutionOutcome` 增加 `commit_failed`，
`agent-server` 的 `StoredSessionManager` 在 runtime turn 已完成但 final
state commit 失败时，不再返回 `succeeded`，而是返回 `commit_failed` outcome。
如果持久化介质仍可写，会尽力把 session 标记为 `commit_failed`，并保存本轮
best-effort exported state；如果 marker 也写不进去，调用方仍能从 command
outcome 看到 commit failure，不会误以为已经 durable commit。

工作项：

- 明确 `AgentExecutionOutcome` 是否需要新增 `commit_failed`，或由宿主层把
  session 标记为 `dirty` / `commit_failed`。已完成，当前两者都做：
  command outcome 使用 `commit_failed`，session marker 使用 `commit_failed`。
- 定义 durable commit 成功前，command 不能被宣称为 fully persisted。已完成。
- 定义 state commit 失败时的有限重试、best-effort exported state 暴露方式。
  已完成第一版：final clean save 失败后做一次 best-effort `commit_failed`
  marker 保存；复杂 retry policy 留给后续 Store/Policy 层。
- 定义 last committed state 与 in-memory latest state 的关系。已完成第一版：
  clean commit 失败后不标记 idle clean；若 marker 保存成功，session 保存
  best-effort exported state 并进入 `commit_failed`。
- 为 state write failure 增加 fake store 测试，例如磁盘满或数据库断开。已完成。

验收：

- state 写入失败不会静默返回 succeeded。已覆盖。
- 下次恢复能识别 `dirty` / `commit_failed` session，并回到最后一次成功
  commit 的 state。已完成第一版识别和 marker；“回到最后一次成功 commit”
  的 repair/replay 策略留给 D.5/D.7。
- EventStore/RunStore 可以记录 commit failure 诊断线索，但不会被误当成
  conversation truth。边界已明确；实际 Run/EventStore 写入留给 D.5。

##### D.3 Server Persistence Alignment

目标：让 `agent-server` 的 session 存储语义与 core 恢复契约一致。

当前状态：已完成第一版。`StoredSessionManager` 的 success / aborted /
failed / commit failure 路径已经对齐 core 恢复契约：成功与 abort 会保存
runtime 导出的 v2 conversation state，失败会保留执行前稳定 state，final
state commit 失败会返回 `commit_failed` outcome 并尽力把 session 标记为
`commit_failed`。server 查询/API 会如实暴露 `commit_failed`，新的 prompt
不会继续恢复执行 unresolved commit failure session，避免在 repair/replay
策略完成前把不稳定 state 当成 clean truth 推进。

工作项：

- 检查 `StoredSessionManager` 当前 prompt success / aborted / failed 的保存时机。
  已完成。
- 确认 aborted prompt 会保存清理后的 state。已覆盖。
- 确认 failed prompt 默认保留失败前稳定 state，并记录失败 outcome。已覆盖。
- 把 run outcome、agent state、message count、session status 尽量放入同一事务
  或等价原子更新。已完成第一版：`SessionStore.save` 使用单次 version-guarded
  replace，MySQL adapter 落到单条 `UPDATE ... WHERE session_id = ? AND version = ?`。
- 增加 state write failure 测试，验证 session status 不会被错误标记为 idle
  clean。已覆盖。
- 明确 unresolved `commit_failed` session 的恢复前行为。已完成第一版：
  session discovery 可见 `commit_failed`，但 prompt lease acquisition 会排除
  `commit_failed`，`StoredSessionManager` 返回 `SESSION_COMMIT_FAILED`。

验收：

- server session 从数据库恢复后，conversation state 与 core exported state
  一致。已覆盖 v2 entry graph 恢复和 MySQL adapter opaque state round-trip。
- 数据库写入失败时，session 状态明确，不会丢 turn 又显示成功。
  已覆盖，返回 `commit_failed`，且 session/API 不显示 idle clean。

##### D.4 Local Persistence Adapter

目标：为本地长期会话和 playground/CLI 验证提供最小可用持久化。

当前状态：已完成第一版。新增本地 JSON snapshot store，`agent-core` 的
store 只接收显式 `stateFile`，不内置 `.agent-platform` 路径策略；
playground composition 负责把默认路径解析为
`<cwd>/.agent-platform/playground/sessions/agent-core-playground/state.json`。
playground 启动时会尝试恢复该文件，prompt 成功或 abort 后会自动保存，并
提供 `/save`、`/delete`、`/storage` 方便调试本地状态。

工作项：

- 定义 local state file 格式和默认目录策略。已完成第一版：
  state file 使用 JSON object，包含 `formatVersion: 1`、`sessionId`、
  `updatedAt`、`agentState` 和可选 `sessionInfo`；默认目录策略只放在
  playground 层。
- 实现 atomic write：临时文件写入成功后 rename 替换正式 state。已完成。
- 提供本地 state load/save/delete adapter。已完成。
- 为 playground 添加保存和删除命令。已完成，另有 `/storage` 查看路径。
- 提供显式 state file 覆盖入口。已完成：
  `--playground-state-file <path>`。

验收：

- 本地 JSON state 可以保存、恢复和删除。已覆盖。
- 不存在 state file 时恢复返回空，不阻止 playground 启动。已覆盖。
- 不支持旧 conversation schema 的本地文件会被拒绝。已覆盖。
- playground 本地路径策略不污染 `agent-core` 的 conversation state schema。
- 处理 corrupted JSON、version mismatch、权限错误和磁盘满。
- playground 支持显式 `/save` / `/load`，或启动参数绑定 state file。
- CLI 支持 `--state-in` / `--state-out`，默认不隐式写用户目录。

验收：

- 本地保存后重启 playground/CLI 可以恢复 conversation。
- 写半截文件不会破坏上一次成功 state。
- 文件损坏时有明确诊断，不会静默创建错误会话。

##### D.5 RunStore / EventStore Interfaces

目标：把恢复 state 和诊断记录分开。

当前状态：已完成第一版。`agent-core` 新增 `RunStore` / `EventStore`
接口及内存参照实现。RunStore 记录 command/run 的生命周期、终态 outcome
和 commit failure 诊断入口；EventStore 记录 run 内事件流，按 run sequence
稳定回放，也支持按 session 时间线查看。EventStore 明确是 UI 回放、审计和
故障定位来源，不作为恢复 LLM conversation 的主事实来源。playground 已接入
内存 RunStore/EventStore，并提供 `/runs` 和 `/eventlog [runId]` 做真实输出
验证；`/state` 等查看命令不会创建新的 run 记录。

工作项：

- 定义 `RunStore` 接口：run id、command id、status、startedAt、endedAt、
  outcome、failure/abort/commit failure reason。已完成。
- 定义 `EventStore` 接口：event id、run id、sequence、type、payload、
  createdAt。已完成，并预留 `retention: "required" | "diagnostic"`。
- 明确哪些公共事件必须保存，哪些 debug event 可以按宿主策略采样。已完成
  第一版：接口层支持 required/diagnostic 标记，具体采样策略由宿主 adapter
  决定。
- 保证 EventStore 可用于回放 UI/诊断，但不是恢复 LLM conversation 的主来源。
  已完成，边界写入类型注释和契约测试。

验收：

- run failure 可以通过 RunStore / EventStore 定位到原因。已覆盖
  `commit_failed` 诊断记录。
- event replay 顺序稳定，且不会改变 exported conversation state。已覆盖
  顺序回放；EventStore 与 ConversationStore 已保持接口分离。
- playground faux 模式可以真实输出 RunStore / EventStore 记录。已覆盖。

##### D.6 Tool Call Recovery Record

目标：记录工具调用事实，但不承诺跨进程恢复活动中的工具执行。

当前状态：已完成第一版。`agent-core` 新增 `AgentToolCallRecord` 与
`projectToolCallRecordsFromEvents(...)`，从 EventStore 的工具事件流投影出
工具调用恢复记录。记录包含 tool name、call id、args 摘要、status、
startedAt、endedAt、result/error 摘要和关联事件 id；它只用于 UI、审计、
诊断和恢复判定，不写入 conversation state，也不作为 LLM 上下文事实来源。
如果恢复时看到 `tool_started` 但没有对应 `tool_finished`，projection 会把该
调用标记为 `aborted` 且 `interrupted: true`，不会暴露为 running 或尝试继续
原进程。playground 已接入 `/toolcalls [runId]`，可从同一份 EventStore 事件流
查看投影后的工具调用恢复记录。

工作项：

- 定义 tool call / tool result 的持久化记录字段：tool name、call id、args
  摘要、status、startedAt、endedAt、result/error 摘要。已完成。
- 明确工具结果是否进入 conversation state 由 message entry 决定；tool record
  主要用于审计、诊断和 UI。已完成。
- aborted turn 中未完成工具调用标记为 aborted/cancelled，不恢复为 running。
  已完成第一版：缺少 terminal event 的工具调用标记为 `aborted`。
- 在 playground 中加入查看入口。已完成：`/toolcalls [runId]`。

验收：

- tool call / tool result 顺序在 EventStore 中合法。已覆盖。
- 恢复后不会尝试原地继续一个已经中断的工具进程。已覆盖。

##### D.7 RuntimeStateStore / Append-only Log

目标：为后续多 session、队列恢复和审计留下稳定入口。

工作项：

- 定义 session runtime snapshot：session id、status、active command、
  queued prompts、last committed state version、dirty flag。
- 定义 append-only session log 的最小格式。
- 明确恢复时 active command 的处理：默认标记 interrupted/unknown，不自动重放。
- 后续再接入 lease、fork、import/switch session。

验收：

- session 可以从 runtime snapshot 判断是否 clean、dirty、interrupted。
- queued prompts 的恢复策略明确：恢复、丢弃或交给宿主策略选择。
- append-only log 能辅助审计，但不替代 canonical conversation state。

### 阶段 E：ContextBudget / Compaction

目标：让上下文预算和压缩成为 runtime 的正式能力。

建议顺序：

```text
ContextBudget v2
  -> manual compact command
  -> compaction entry
  -> beforeCompaction 接线
  -> threshold / overflow compaction
```

工作项：

- `ContextBudget` 从字符估算升级为 token 预算接口。
- 支持手动 compact command。
- ConversationProjector 支持 compaction entry。
- 接入 `beforeCompaction`。
- compaction result 写入持久化层。
- context overflow 触发压缩恢复，而不是普通 retry。

验收：

- 压缩前后 conversation state 合法。
- compaction summary 能参与后续 ContextAssembler。
- `beforeCompaction` 的结果被真实消费。

### 阶段 F：Memory v1

目标：实现长期上下文的最小闭环。

建议顺序：

```text
MemoryStore interface
  -> manual memory write/read
  -> memory retrieval
  -> ContextAssembler 注入
  -> extraction hook 预留
```

工作项：

- 定义 memory entry schema。
- 实现 `MemoryStore` 接口和 in-memory adapter。
- 支持按 scope / tag / relevance 查询 memory。
- ContextAssembler 接入 memory retrieval 结果。
- 明确 memory 与 conversation、compaction summary 的区别。
- 暂缓复杂自动提取，先保留 lifecycle 或后台任务入口。

验收：

- 指定 memory 可以进入下一轮上下文。
- memory 注入来源可诊断。
- memory 不会无意污染 conversation history。

### 阶段 G：ResourceCatalog v2

目标：从静态 registry 资源升级为 workspace resource layer。

工作项：

- 扫描 `AGENTS.md` / `CLAUDE.md`。
- 支持 context files discovery。
- 支持 prompt templates discovery。
- 支持 resource reload。
- 增加 diagnostics。
- playground 增加资源/template debug 输出。

验收：

- ResourceCatalog 只发现和读取资源。
- ContextAssembler 决定每轮哪些资源进入上下文。
- diagnostics 结构化返回，不直接打印或退出进程。

### 阶段 H：Policies

目标：把权限、预算、重试、压缩、工具安全等治理能力从主流程中抽离出来。

建议顺序：

```text
Tool / Model policy 收口
  -> RetryPolicy v1
  -> CompactionPolicy v1
  -> QueuePolicy v1
```

工作项：

- 工具执行前后策略与 lifecycle 的职责分离。
- `RetryPolicy v1`：可重试 provider error + backoff。
- `CompactionPolicy v1`：接管 threshold / overflow compaction。
- `QueuePolicy v1`：接管排队、拒绝、合并、打断语义。
- policy diagnostics 进入 event / run record。

验收：

- `TurnRunner` 只做策略编排，不内联大量 if/else。
- retry 和 compaction 不破坏 conversation state。
- policy 决策可追踪、可测试。

### 阶段 I：Prompt Template / Skill 输入入口

目标：在 InputProcessor v2 的基础 parser 之上，把 prompt template 和 skill
变成正式 core 扩展能力。

启动条件：

- 阶段 C 的 turn queue 和 abort/steer/follow-up 语义已经稳定。
- 阶段 D 的持久化边界已经明确，至少知道 template/skill 运行痕迹是否进入
  run/event store。
- ResourceCatalog v2 至少定义了 template/skill 文件发现与 trust/source
  scope 的职责边界。

在这些条件满足前，只保留阶段 B 已实现的薄入口：slash command metadata
加 lifecycle hook 消费。

建议顺序：

```text
prompt/prompt-template.ts
  -> template registry / expansion
  -> skill descriptor / selection
  -> InputProcessor 输出 template / skill metadata
  -> ContextAssembler 注入 template / skill context
  -> playground 示例验证
```

工作项：

- 复用阶段 B 的 slash command 基础解析。
- 实现 prompt template registry / expansion v1。
- 实现 skill descriptor / selection v1。
- 扩展 `ProcessedInput` 的 metadata，让 template / skill 有稳定字段。
- `ContextAssembler` 消费 template / skill metadata 并注入对应上下文。
- 在 CLI playground 中增加 `/template`、`/skill` 或示例 hook。

验收：

- `/review xxx` 这类输入可以被解析并转成 metadata。
- metadata 可被 `beforeRun` 或 `beforeContext` 消费。
- template/skill 展开不污染 base system prompt。

### 阶段 J：业务能力定义 / Capability Pack

目标：在 core 核心能力稳定后，再抽象业务能力的装配模型。

工作项：

- 定义 `AgentCapabilityPack`。
- 允许 pack 提供 tools、resources、prompt templates、context providers、lifecycle hooks、policies。
- 定义 pack merge / conflict / diagnostics 规则。
- 实现 data-analysis / coding / customer-support 等示例 pack。
- 文档说明 core 与业务 pack 的职责边界。

验收：

- 业务 pack 不需要修改 runtime 主流程即可接入。
- 多个 pack 的工具、资源、hook、policy 可以组合。
- core 不内置具体业务场景逻辑。

### 阶段 K：Public API 与命名收口

目标：从开发期内部导出收束到稳定 SDK surface。

工作项：

- 引入或重命名为 `AgentCoreRuntimeFactory`。
- `PiAgentRuntimeFactory` 保留为兼容 alias 或 adapter-specific export。
- 收窄 `index.ts` exports。
- 内部模块通过相对路径使用，不从根出口泄漏。
- 更新架构文档命名。

验收：

- public API 小而稳定。
- adapter-specific 命名不污染核心概念。
- `npm run check` 通过。

## 6. 当前优先级判断

短期不建议直接进入业务能力包，也不建议马上进入完整 Policy。
原因是这两者都会依赖 core 的运行闭环。如果输入、上下文、队列、持久化、
压缩和记忆的接口还不稳定，业务 pack 和 policy 都会被迫反复调整。

推荐下一步：

```text
Runtime/Lifecycle v1 小收尾
  -> InputProcessor v2 / ContextAssembler v2
  -> Queue / Turn Execution
  -> 持久化与恢复
  -> ContextBudget / Compaction
  -> Memory v1
  -> ResourceCatalog v2
  -> Policies
  -> Prompt Template / Skill
  -> Capability Pack
  -> Public API 收口
```

这个顺序的判断是：

- 先完成可运行和可靠运行能力。
- 再补长期上下文能力，包括 compaction 和 memory。
- 然后再补资源发现、策略治理、template/skill 等更高层能力。
- 最后才抽象业务能力定义，避免把未稳定的 core 过早包装起来。

做完这些后，`agent-core` 可以认为已经完成通用 Agent Runtime 的核心能力。
后续业务 Agent 的开发重点将转为定义工具、资源、上下文、策略和 lifecycle hooks，
而不是继续改 runtime 主流程。
