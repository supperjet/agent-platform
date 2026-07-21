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
- slash command parser
- skill registry
- skill selector
- skill expansion
- active skill context injection
- prompt template expansion

`onInput` 和 lifecycle metadata 已经能承载 `/xxx ...` 这类入口，但还没有正式的输入协议和能力实现。

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

待完善：

- 增加最大队列长度保护，避免极端情况下事件堆积。
- hook error 转成更明确的 diagnostic 或 run failure。
- 区分 lifecycle failure、agent failure、tool failure。

### 4.2 Lifecycle Metadata

当前 metadata 已经浅合并，但 schema 仍由外部 hook 自己约定。

待完善：

- 为 slash command / skill 场景定义第一批公共 metadata key。
- 让 `InputProcessor` 输出结构化 metadata，而不是只靠 hook 闭包传递。
- 将 metadata 明确区分为 per-turn scratch state，不进入 conversation 持久状态，除非未来有明确 `custom_state` entry。

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

当前 v1 输入较轻：

```text
command
baseSystemPrompt
conversationMessages
```

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

- 给 `pendingLoopEvents` 增加最大长度保护。
- 明确 `afterMessage` 的错误归因和诊断策略。
- 更新 lifecycle/input/context README 和执行计划状态。
- 保持 `beforeCompaction` 为已定义未接线状态，等待 compaction 阶段消费。

验收：

- lifecycle hook 执行、短路、合并、改写都有测试。
- `afterMessage` 改写会影响公共事件和 exported state。
- `npm test --workspace @agent-platform/agent-core` 通过。

### 阶段 B：InputProcessor v2 / ContextAssembler v2

目标：先把输入处理和上下文组装变成稳定 core 能力，而不是直接进入业务能力定义。

建议顺序：

```text
InputProcessor metadata
  -> slash command 基础解析
  -> ContextAssembler 消费 metadata
  -> ContextBudget 预算结果进入 diagnostics
  -> lifecycle hooks 全链路消费检查
```

工作项：

- 扩展 `ProcessedInput`，允许携带结构化 metadata。
- 定义第一批 core-level metadata key，例如 slash command、input mode、selected template。
- 支持 `/xxx ...` 的基础解析，但暂不绑定具体业务 skill。
- `ContextAssembler` 接收 input metadata，并传给 `beforeRun / beforeContext`。
- `ContextAssembler` 输出清晰 diagnostics，包括 message 数量、字符预算、注入来源。
- 明确 metadata 是 per-turn scratch state，不默认进入 conversation 持久状态。

验收：

- `/review xxx` 这类输入可以被解析成 metadata。
- metadata 可被 `beforeRun` 或 `beforeContext` 消费并影响 prompt messages。
- ContextAssembler 的输入、输出、metadata 传递都有测试覆盖。

### 阶段 C：Queue / Turn Execution

目标：让 runtime 从“能执行一次”升级为“可靠连续执行”。

工作项：

- 实现 turn queue 的基础模型。
- 明确 running / idle / aborted / failed 状态流转。
- 明确 prompt / steer / follow-up / abort 在不同状态下的语义。
- 支持 command 排队、拒绝或合并的基础策略入口。
- 整理 `waitForIdle`、event flush、afterTurn 的时序。
- 为 pending event queue 增加最大长度保护。

验收：

- 并发 execute 不会破坏 conversation state。
- abort 后状态和事件一致。
- `afterRun` 在成功、失败、abort 路径都有稳定调用语义。

### 阶段 D：持久化与恢复

目标：建立 Agent 可靠运行的地基，让 conversation、run、event、tool call、
runtime state 可以保存、恢复、回放和诊断。

建议顺序：

```text
ConversationStore v2
  -> RunStore
  -> EventStore
  -> RuntimeStateStore
  -> snapshot / restore
```

工作项：

- 扩展 `ConversationStore`，支持 compaction、custom_state、session_info 等 entry。
- 新增 `RunStore`，记录 turn/run 的生命周期状态。
- 新增 `EventStore`，保存公共事件和关键诊断事件。
- 新增 `RuntimeStateStore`，保存 session 级状态和 snapshot。
- tool call / tool result 纳入可恢复记录。
- 定义 append-only session log 格式。

验收：

- session 可以从持久化 state 恢复出一致的 exported conversation。
- run failure 可以通过 RunStore / EventStore 定位原因。
- tool call / tool result 顺序在恢复后仍合法。

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
