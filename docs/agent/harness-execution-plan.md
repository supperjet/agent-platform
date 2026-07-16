# Agent Core Harness 执行计划

## 1. 执行目标

基于 `harness-architecture.md`，把 `agent-core` 从当前“Pi runtime adapter 里混合装配逻辑”的形态，演进为一套可继续生长的 Harness：

```text
AgentCoreRuntimeFactory
  -> RuntimeAssembler
  -> AgentRuntimeSession
  -> TurnRunner
  -> AgentLoopAdapter
  -> Tool / Model / Conversation / Context 能力模块
```

第一阶段目标不是一次性实现完整 Memory、Skill、Compaction、Lifecycle 插件生态，而是建立一个稳定骨架：

> 一个 `AgentDefinition` 经过 `RuntimeAssembler` 装配，创建 `AgentRuntimeSession`，执行一轮 prompt，产生标准事件，导出状态，再恢复继续执行。

## 2. 当前迁移判断

当前 `agent-core` 已经有这些可复用基础：

| 当前文件 | 可迁移职责 |
| --- | --- |
| `contracts.ts` | 对外 runtime interface 和 event 类型 |
| `definition/agent-definition.ts` | `AgentDefinition` 校验和 instructions 解析 |
| `runtime/agent-runtime-factory.ts` | 当前 runtime factory |
| `runtime/conversation-state.ts` | 最小 state export/restore |
| `tools/tool-registry.ts` | 最小 tool definition registry，作为 ToolCatalog 输入 |
| `tools/tool-catalog.ts` | tool name 解析、元信息投影、runtime tools 输出 |

第一步不要推翻这些文件，而是把职责往新模块里“抽走”：

- 从 `PiAgentRuntimeFactory.create()` 抽出装配逻辑。
- 通过 `AgentLoopAdapter` 封装底层 Agent loop，runtime session 只依赖 `AgentLoop`。
- 保持对外 runtime contract 先不破。

## 3. 目录结构先行

当前目录结构是实验期自然长出来的，`runtime/`、`tools/`、`definition/` 里已经开始混合不同层次的职责。正式进入 Harness 重构前，先按 `harness-architecture.md` 的建议目录定版：

```text
packages/agent-core/src/
  index.ts

  definition/
    agent-definition.ts
    definition-resolver.ts

  runtime/
    agent-core-runtime.ts
    agent-core-runtime-factory.ts
    runtime-assembler.ts
    agent-runtime-session.ts
    turn-runner.ts
    agent-loop.ts
    agent-loop-adapter.ts
    event-hub.ts
    state-exporter.ts

  model/
    model-catalog.ts
    model-gateway.ts
    model-types.ts

  prompt/
    prompt-assembler.ts
    input-processor.ts
    prompt-template.ts

  resources/
    resource-catalog.ts
    skills.ts
    context-files.ts

  conversation/
    conversation-entry.ts
    conversation-store.ts
    conversation-projector.ts
    conversation-state.ts

  context/
    context-assembler.ts
    context-budget.ts

  tools/
    tool-definition.ts
    tool-registry.ts
    tool-catalog.ts
    tool-runtime.ts
    tool-adapter.ts
    operations/

  lifecycle/
    lifecycle-hooks.ts
    lifecycle-runner.ts

  policies/
    queue-policy.ts
    retry-policy.ts
    compaction-policy.ts
```

迁移原则：

- 目录代表模块职责，不代表实现先后。可以先放最小实现或兼容 wrapper，但文件必须落在最终职责位置。
- 不再新增“临时大文件”。如果一个能力属于 future phase，也先放到对应目录下的明确模块。
- `runtime/` 只放运行入口、装配、turn 编排、adapter、事件和 state 导出，不放 tool 细节、conversation 投影、prompt 拼接。
- `conversation/` 接管 state 恢复、entries、projection；旧 `runtime/conversation-state.ts` 应迁到这里。
- `model/` 接管模型引用、模型目录、provider gateway；旧 `models/deepseek.ts` 后续应作为 adapter 或测试 provider 迁入这里。
- `tools/` 保留 tool definition registry、tool catalog 和后续 tool runtime；测试/示例工具放到 CLI 或测试目录，不放在底层 registry 文件里。
- `index.ts` 只导出稳定 public surface，内部模块通过相对路径使用，不从根出口泄漏。

当前文件迁移映射：

| 当前文件 | 目标位置 | 说明 |
| --- | --- | --- |
| `contracts.ts` | `runtime/agent-core-runtime.ts` 或保留为 public contracts | 先保留兼容，最终 public runtime 类型应归到 runtime 模块 |
| `definition/agent-definition.ts` | `definition/agent-definition.ts` | 保留 |
| `runtime/agent-runtime-factory.ts` | 后续收口为稳定 runtime factory | 不再继续变大 |
| `runtime/conversation-state.ts` | `conversation/conversation-state.ts` | state 恢复导出属于 conversation |
| `runtime/messages.ts` | `conversation/` 或 `runtime/agent-loop-adapter.ts` | 按用途拆分，LLM message conversion 更靠近 adapter/projector |
| `tools/tool-registry.ts` | `tools/tool-registry.ts` | 保留 registry 作为 ToolCatalog 输入 |
| `cli/example-tools.ts` | `cli/example-tools.ts` | 示例工具不放在底层 tools registry 文件里 |
| `models/deepseek.ts` | `model/` | provider/model gateway adapter 方向 |

## 4. 阶段 0：冻结基线与目录骨架

目标：明确迁移前行为，同时先建立目标目录骨架，避免后续实现继续落到旧实验结构里。

工作项：

- 建立目标目录：
  - `runtime/`
  - `conversation/`
  - `context/`
  - `prompt/`
  - `model/`
  - `resources/`
  - `lifecycle/`
  - `policies/`
- 按迁移映射移动不会改变行为的文件：
  - `runtime/conversation-state.ts` -> `conversation/conversation-state.ts`
  - 后续 import 跟随调整。
- 对暂时无法移动的大文件加 TODO 或文件头说明：
  - `runtime/agent-runtime-factory.ts` 是待继续去 Pi 命名的兼容 factory。
- 记录当前 `PiAgentRuntimeFactory.create()` 的职责：
  - resolve instructions
  - create tool registry
  - restore messages
  - create Pi `Agent`
  - wrap api key resolver
  - subscribe global event listener
- 确认当前测试覆盖：
  - prompt 能执行。
  - runtime event 能订阅。
  - state 能 export/restore。
  - unknown tool / duplicate tool 行为明确。
- 补一个 characterization test：当前 factory 创建 runtime 后，`snapshot()`、`exportState()`、事件序列不因后续抽模块改变。

验收：

- `npm run typecheck` 通过。
- `npm test -- --test-name-pattern='runtime|AgentDefinition|tool|state'` 通过。
- 有一组测试锁住当前外部行为。
- 目标目录已经存在，并且后续新增模块必须进入目标目录。

## 5. 阶段 1：引入 RuntimeAssembler

目标：把“创建运行态所需材料”的职责从 `PiAgentRuntimeFactory` 里移出。

新增文件建议：

```text
packages/agent-core/src/runtime/runtime-assembler.ts
```

第一版 interface：

```ts
type RuntimeAssemblyInput = {
  sessionId: string;
  definition: AgentDefinition;
  state?: AgentConversationState;
  resolveApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  onApiKeyResolved?: () => void;
};

type RuntimeAssembly = {
  definition: AgentDefinition;
  systemPrompt: string;
  model: AgentModel;
  messages: AgentMessage[];
  tools: AgentTool[];
  getApiKey: (provider: string) => Promise<string | undefined>;
};
```

工作项：

- 新增 `assembleRuntime(input)` 或 `RuntimeAssembler` class。
- 移入：
  - `resolveAgentInstructions(definition)`
  - `createDefaultAgentToolRegistry().resolve(definition.toolNames)`
  - `restoreConversationMessages(state, definition.model.id)`
  - `getApiKey` wrapper
- `PiAgentRuntimeFactory.create()` 改为：
  - 调用 assembler。
  - 用 assembly 创建 Pi `Agent`。
  - 返回 `PiAgentRuntime`。

测试：

- assembler 可装配静态 instructions。
- assembler 可恢复 state messages。
- unknown tool 会失败。
- API key wrapper 在 resolve 到 key 时触发 `onApiKeyResolved`。
- runtime 既有行为不变。

验收：

- `PiAgentRuntimeFactory.create()` 不再直接调用 prompt/tool/state 装配函数。
- `PiAgentRuntimeFactory.create()` 只负责桥接 assembly 到 Pi Agent。

## 6. 阶段 2：命名 AgentRuntimeSession 与 AgentLoop

目标：参考 `pi/packages/coding-agent/src/core` 的分层，把“runtime facade”和“底层 Pi loop 适配”概念从命名和代码依赖上立住。

pi coding-agent 里有三个可参考层次：

- `agent-session-runtime.ts`：管理 session 切换、new、fork、import 等会话生命周期。
- `agent-session.ts`：单个 session 的执行 facade，构造时订阅底层 Agent 事件，并统一处理事件、队列、持久化、compaction、retry。
- `sdk.ts#createAgentSession()`：创建底层 Pi `Agent`，再交给 `AgentSession` 包装。

agent-core 当前阶段只借鉴后两层的拆法：factory 创建底层 Pi `Agent`，但 runtime session 不再直接依赖 Pi `Agent` 的完整 surface，而是依赖一个内部 `AgentLoop`。不要在本阶段引入 pi 的 session switching、fork/import、retry、compaction、extension hooks。

新增文件建议：

```text
packages/agent-core/src/runtime/agent-loop-adapter.ts
packages/agent-core/src/runtime/agent-loop.ts
packages/agent-core/src/runtime/agent-runtime-session.ts
```

迁移策略：

- 先不大改行为。
- 新增 `AgentRuntimeSession`，承接原 `PiAgentRuntime` 的会话 facade 职责。
- 抽出一个最小 `AgentLoop` interface，并提供真实 `AgentLoopAdapter`。
- `PiAgentRuntimeFactory` 创建 `AgentLoopAdapter` 再交给 runtime；底层 Pi `Agent` 只在 adapter 内部出现。
- `AgentRuntimeSession` 构造参数依赖 `AgentLoop`。
- `PiAgentRuntime` 临时保留为 `AgentRuntimeSession` 的兼容导出名。
- 事件转换、conversation graph sync、execution outcome 暂时仍留在 `AgentRuntimeSession`，后续阶段再拆到 `EventHub` / `StateExporter`。

第一版 adapter interface 建议：

```ts
export type AgentLoopSnapshot = {
  messages: readonly AgentMessage[];
  isStreaming: boolean;
  modelId: string;
};

export type AgentLoop = {
  prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  continue(): Promise<void>;
  steer(message: AgentMessage): void;
  followUp(message: AgentMessage): void;
  abort(): void;
  waitForIdle(): Promise<void>;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  snapshot(): AgentLoopSnapshot;
};
```

说明：

- `snapshot()` 是为了避免 runtime session 到处读 `agent.state.messages/isStreaming/model.id`。
- `continue()` 先进入 interface，但 `PiAgentRuntime` 本阶段可以不调用；这是为后续 retry/compaction/queued continuation 留出的底层 loop 能力。
- 不把 Pi `AgentState` 直接暴露给 runtime session，否则 adapter 只会变成浅包装。

工作项：

- 定义内部 `AgentLoop` interface。
- 新增 `AgentLoopAdapter`，封装真实 Pi `Agent`：
  - `prompt`
  - `continue`
  - `steer`
  - `followUp`
  - `abort`
  - `waitForIdle`
  - `subscribe`
  - `snapshot`
- `AgentRuntimeSession` 不直接依赖 Pi `Agent` 的全部 surface，而是依赖 `AgentLoop`。
- `AgentRuntimeSession.snapshot()` 改为读取 loop snapshot。
- `AgentRuntimeSession.exportState()` 和 conversation sync 改为读取 loop snapshot 的 messages/modelId。
- `AgentRuntimeSession.execute()` 改为委托 `TurnRunner`，由 `TurnRunner` 调用 loop 的 prompt/steer/followUp/abort/waitForIdle。
- 事件转换仍留在 runtime session，后续再移动到 `EventHub`。
- 保持 server 无感知；`AgentRuntimeFactory.create(sessionId, state?)` contract 不变。

`TurnRunner` 实现步骤：

当前第一版 `TurnRunner` 只是 command dispatcher，它的价值是先把 `AgentRuntimeSession.execute()` 从具体 loop 调用里解耦出来。后续要把它演进成 turn 生命周期编排器，但不要把 input、queue、retry、compaction、state export 的细节都写进一个大类。

目标流程：

```text
execute(command)
  -> InputProcessor.normalize(command)
  -> QueuePolicy.accept/merge/interrupt
  -> ContextAssembler.beforeRun()
  -> AgentLoopAdapter.run/prompt()
  -> waitForIdle()
  -> EventHub.readExecutionOutcome()
  -> RetryPolicy.decide()
  -> CompactionPolicy.decide()
  -> QueuePolicy.next()
  -> StateExporter.sync()
  -> finish
```

分步落地：

1. 保留当前最小 `TurnRunner`：
   - 支持 `prompt` / `steer` / `follow-up` / `abort` 四类 command。
   - `prompt` 负责调用 `loop.prompt()` 并等待 `loop.waitForIdle()`。
   - `steer` / `follow-up` 只进入底层 loop，不主动等待完整 run。
   - 通过 `afterTurn` hook 触发 conversation graph sync。
   - 通过 `readExecutionOutcome` 从外部读取 run 结果，不在 runner 内部解析 agent event。
2. 抽出 `EventHub` 后增强 runner 的 outcome 边界：
   - `TurnRunner` 不再读取 `AgentRuntimeSession` 内部字段，而是读取 `EventHub` 提供的 execution outcome。
   - run 失败、assistant error、agent end 等事件语义都由 `EventHub` 收敛。
   - `TurnRunner` 只根据 outcome 做下一步调度，不做 event conversion。
3. 抽出 `StateExporter` 后增强 after-turn 边界：
   - `afterTurn` 从匿名 hook 变成明确的 `StateExporter.syncFromLoop()`。
   - state export 和 conversation entries graph 同步不留在 runner 主流程里展开。
   - runner 只决定“什么时候同步”，不决定“怎么同步”。
4. 引入 no-op policy 和 context 入口：
   - 增加最小 `InputProcessor`，第一版只把 `AgentRuntimeCommand` 转成标准 user message/input，不做模板展开。
   - 增加 no-op `QueuePolicy`，第一版保持现有行为：prompt 运行中如何处理 queued command 暂不改变 server 行为。
   - 增加 no-op `ContextAssembler.beforeRun()`，第一版返回空 overlay，不改变静态 system prompt。
   - 增加 no-op `RetryPolicy` 和 `CompactionPolicy`，第一版只返回“不重试、不压缩”。
5. 最后把 runner 主流程改成 pipeline：
   - `TurnRunner.run()` 变成对这些步骤的顺序编排。
   - 每个步骤可单测；runner 测试只验证步骤顺序、分支和边界条件。
   - 不在本阶段引入真实 retry、真实 compaction、动态 system prompt 或 fork/import。

测试：

- fake loop 可以驱动 runtime event conversion。
- fake loop 可以验证 `prompt` command 调用 `prompt()` 后等待 `waitForIdle()`。
- `TurnRunner` 可以独立测试 command dispatch 和 after-turn hook。
- `TurnRunner` pipeline 测试使用 fake policy/context/exporter，验证调用顺序，不需要真实 provider。
- failed outcome 不由 `TurnRunner` 自己构造，必须来自 `EventHub` 或 fake outcome reader。
- `abort` 会调用 adapter abort。
- `steer/follow-up` 不启动完整 prompt run。
- `snapshot()` 不需要真实 provider 也能返回 message count、roles、running state、model id。
- `exportState()` 仍输出 conversation v1 entries graph，并且不需要测试走真实 provider。

本阶段明确不做：

- 不实现 `AgentSessionRuntime` 式 new/resume/fork/import。
- 不实现 retry、compaction、overflow recovery。
- 不实现 extension input/command/tool hooks。
- 不实现 dynamic system prompt per-turn overlay。
- 不拆 `EventHub` 和 `StateExporter`。
- 不改 `agent-server` 的 session manager 主流程。

验收：

- 底层 Pi Agent 被包在 adapter 后。
- runtime session 的测试不需要真实 provider。
- `agent-runtime-session.ts` 文件中不直接 import 或类型依赖 Pi `Agent`，只依赖 `AgentLoop` 以及 `AgentEvent` / `AgentMessage` 等事件和消息类型。
- `npm run check` 通过。

## 7. 阶段 3：拆出 EventHub 与 StateExporter

目标：让 `AgentRuntimeSession` 只做状态和命令调度，不承担事件转换和 state 拼装细节。

新增文件建议：

```text
packages/agent-core/src/runtime/event-hub.ts
packages/agent-core/src/runtime/state-exporter.ts
```

工作项：

- 已完成：把 `convertAgentEvent()` 迁到 `EventHub`。
- 已完成：把 message id sequencing 迁到 `EventHub`。
- 已完成：`TurnRunner` 通过 `EventHub.readExecutionOutcome()` 读取 run 结果，不再读取 session 内部字段。
- 已完成：把 `exportConversationState()` 调用收口到 `StateExporter`。
- 已完成：把 conversation entries graph sync 收口到 `StateExporter.syncFromSnapshot()`。
- `AgentRuntimeSession` 持有：
  - adapter
  - eventHub
  - stateExporter
  - turnRunner

测试：

- 已覆盖：`EventHub` 对 Pi message events 输出稳定 `AgentRuntimeEvent`。
- 已覆盖：assistant error 转成 `run_failed` 和 failed outcome。
- 待补：tool events 的 `EventHub` 直接测试。
- 已覆盖：state exporter 输出 schemaVersion/modelId/payload，并保持 entry id / leafId 递进。

验收：

- 已完成：`AgentRuntimeSession` 里没有大段事件转换 if/else。
- 已完成：state export 可独立测试。

## 8. 阶段 4：ConversationStore / ConversationProjector

目标：从当前“只恢复 `messages[]`”演进为 conversation entries + projection 的状态模型。第一版先建立边界，不提前实现完整 pi coding agent 的 JSONL session manager、branch、compaction 和 extension state。

### 8.1 与 pi coding agent 对齐的方向

pi coding agent 这一层的核心不是直接保存 `messages[]`，而是 `SessionManager`：

- 会话记录是 append-only `SessionEntry`，`message` 只是其中一种 entry。
- 每个 entry 有 `id`、`parentId`、`timestamp`，天然支持从当前 leaf 回溯出一条 active path。
- `buildSessionContext()` 负责把 entries 投影成 LLM/runtime 需要的 messages。
- 非 message 状态也在同一条会话日志里表达，例如 `model_change`、`thinking_level_change`、`compaction`、`branch_summary`、`custom`、`custom_message`、`label`、`session_info`。
- compaction 不是简单删除历史，而是用 compaction entry 表示摘要，并通过 `firstKeptEntryId` 控制哪些历史继续进入上下文。

agent-core 的第一版不直接复制完整 `SessionManager`，但边界要对齐：

- `ConversationStore` 管“发生过什么”，即 entries、leaf 和 restore/export。
- `ConversationProjector` 管“模型看到什么”，即从 active entries 投影出 runtime messages。
- `conversation-state.ts` 管持久化 state payload 的 schema 兼容。
- runtime/assembler 不再长期直接把裸 `messages[]` 当成唯一状态源。

新增文件建议：

```text
packages/agent-core/src/conversation/conversation-entry.ts
packages/agent-core/src/conversation/conversation-store.ts
packages/agent-core/src/conversation/conversation-projector.ts
packages/agent-core/src/conversation/conversation-state.ts
```

### 8.2 ConversationStore v1 范围

第一版只做静态、内存级 projection，不做文件持久化和自动 compaction。

v1 entry：

```ts
type ConversationEntry =
  | {
      type: "message";
      id: string;
      parentId: string | null;
      timestamp: string;
      message: AgentMessage;
    };
```

v1 snapshot：

```ts
type ConversationSnapshot = {
  entries: readonly ConversationEntry[];
  leafId: string | null;
  messages: readonly AgentMessage[];
  compatibility: {
    modelId: string;
    definitionId?: string;
  };
};
```

工作项：

- 新增 `conversation-entry.ts`，定义 v1 entry、snapshot 和 restore/export payload 类型。
- 新增 `conversation-projector.ts`，第一版只把 active message entries 投影成 `AgentMessage[]`。
- `ConversationStore.restore()` 输出 `ConversationSnapshot`，而不是只输出 `{ messages }`。
- 保留旧 state 兼容：
  - 如果 payload 是 `{ messages }`，恢复为 message entries。
  - 新 export 可以输出 `{ entries, leafId }`，但 runtime 对外 contract 暂不强行破坏。
- `RuntimeAssembler` 继续消费 `snapshot.messages`，不要直接知道 restore 细节。
- `PiAgentRuntime.exportState()` 先保持外部行为稳定；如果引入新 payload，必须兼容旧测试和旧状态。
- entry id 可以先用确定性递增/本地生成，不引入文件级 session id。

v1 暂不做：

- JSONL 文件持久化。
- branch/fork/label/session_info。
- compaction summary 替代历史。
- custom/custom_message extension state。
- thinking level 或 model change entry 的真实执行语义。
- context budget 和 token-based pruning。

测试：

- 旧 `{ messages }` state 仍能恢复为 entries，并投影成 messages。
- 新 `{ entries, leafId }` state 可以恢复，并按当前 leaf path 投影 messages。
- 空 state 输出空 entries、`leafId: null`、空 messages。
- model mismatch 继续失败，错误语义不退化。
- malformed payload 失败。
- `RuntimeAssembler` 通过 `ConversationStore` 拿到 messages，现有 runtime restore 行为不变。

验收：

- `ConversationStore` 管“发生过什么”。
- `ConversationProjector` 管“模型看到什么”。
- runtime/assembler 不直接调用 `restoreConversationMessages()`。
- `conversation-store.ts` 不包含 pi runtime 细节。
- `conversation-projector.ts` 不做 state schema 校验。

### 8.3 后续迭代计划

v2：active path 与 leaf

- entry 增加稳定 `parentId` 回溯逻辑。
- projector 按 leaf path 输出 messages，而不是简单线性 entries。
- 为 branch/fork 留接口，但不实现 UI/API。

v3：model/thinking/session metadata entries

- 增加 `model_change`、`thinking_level_change`、`session_info`。
- restore 时可以恢复 model compatibility 信息。
- ModelCatalog 后续可以消费 restored model hint。

v4：compaction-aware projection

- 增加 `compaction` entry。
- projector 按 pi 的思路保留最新 compaction summary + `firstKeptEntryId` 之后的 entries。
- compaction 生成仍归 `CompactionPolicy`/`TurnRunner`，store 只表达结果。

v5：custom state 与 custom message

- 增加 `custom_state`，用于 lifecycle/extension 在 resume 后重建内部状态，不进入 LLM context。
- 增加 `custom_message`，用于受控注入 LLM context。
- 明确 display/debug metadata 与 runtime context 的分离。

v6：持久化和 import/export

- 评估是否采用 pi 风格 JSONL append-only session file。
- 支持 session header、session id、cwd、created/modified。
- 支持从外部 state 导入、导出单条 active path。

## 9. 阶段 5：Core Tool Capability Layer

目标：把 tool 从“注册一组可调用函数”提升为 agent-core 的默认核心能力层。

这一层对标 `pi/packages/coding-agent/src/core/tools`，但不直接复制 coding-agent 的 UI、extension 和 session 绑定逻辑。agent-core 的 tool 层要保持 provider/runtime 中立：

- tool 定义、注册、解析、执行包装分离。
- 内置工具作为 agent 的默认核心能力，而不只服务 coding agent。
- 文件系统、shell、远程环境通过 `ToolOperations` 注入，而不是写死在工具函数里。
- 工具执行经过 `ToolRuntime`，统一承载 policy、approval、lifecycle events、progress update 和错误归一化。
- ToolRuntime 内部事件通过 runtime bridge 进入 `EventHub` / 公共事件流，方便后续 server/client 做全生命周期监听。

新增文件建议：

```text
packages/agent-core/src/tools/tool-definition.ts
packages/agent-core/src/tools/tool-catalog.ts
packages/agent-core/src/tools/tool-runtime.ts
packages/agent-core/src/tools/tool-adapter.ts
packages/agent-core/src/tools/built-in/
packages/agent-core/src/tools/operations/
packages/agent-core/src/tools/policy/
```

工作项：

- 保留 `AgentToolRegistry`，作为 tool definition 的注册容器。
- `ToolCatalog.resolve(toolRefs)` 输出：
  - active `AgentTool[]`
  - prompt snippets
  - prompt guidelines
- 建立默认内置工具集合：
  - `read`
  - `ls`
  - `grep`
  - `find`
  - `write`
  - `edit`
  - `bash`
- 建立 `ToolOperations`：
  - 隔离 fs/shell 等真实执行环境。
  - 第一版提供 local implementation。
  - 未来可以替换成 sandbox、remote workspace、container、browser fs 等实现。
- 建立 `ToolRuntime`：
  - 包装原始 tool `execute`。
  - 执行前做 policy 判断。
  - 需要时发起 approval。
  - 包装 `onUpdate` 并发出 progress event。
  - 执行后归一化 succeeded / failed / aborted / blocked 状态。
  - 发出 started / updated / finished / policy / approval lifecycle events。
- 建立 `ToolPolicy`：
  - 第一版只做足够实用的默认规则。
  - 默认 `write` / `edit` / `bash` 需要 approval。
  - 阻止敏感路径和高风险 shell 命令。
  - 保留 allow / block / requireApproval / rewrite 四类 decision。
- 把 ToolRuntime events 桥接到公共 runtime events：
  - `tool_started`
  - `tool_progress`
  - `tool_finished`
  - `tool_policy_checked`
  - `tool_approval_requested`
  - `tool_approval_approved`
  - `tool_approval_denied`
- CLI 提供两类验证入口：
  - 单工具执行：`--call-tool`
  - 完整 agent 执行：`--agent-playground`

测试：

- duplicate tool name 失败。
- unknown tool ref 失败。
- ToolRuntime before/after hooks 可执行。
- ToolRuntime 能发出 started / updated / finished 事件。
- ToolPolicy block 时 tool 不执行。
- ToolPolicy rewrite 能改写参数。
- approval approve 后继续执行。
- approval deny 后返回 blocked。
- EventHub 能把 ToolRuntime lifecycle event 转成公共 runtime event。
- CLI 能独立执行内置工具，并能在完整 agent playground 中走同一套 runtime path。

验收：

- 已完成：tool name 解析不在 RuntimeAssembler 里展开细节。
- 已完成：tool definition registry 和 runtime active tools 分离。
- 已完成：内置工具默认注册，可通过 profile/policy/definition 控制启用范围。
- 已完成：内置工具不直接绑定本地 fs/shell，而是依赖 `ToolOperations`。
- 已完成：ToolRuntime 是工具执行的统一入口。
- 已完成：ToolPolicy 与 beforeHook 分层清楚：
  - ToolPolicy 表达安全、权限、审批、参数改写等语义规则。
  - beforeHook 是低层生命周期扩展点。
- 已完成：ToolRuntime 内部事件进入公共事件桥。
- 已完成：CLI 可以验证单个工具和完整 agent 执行路径。
- 已完成：`npm run typecheck --workspace @agent-platform/agent-core` 通过。
- 已完成：`npm run test --workspace @agent-platform/agent-core` 通过。

当前进展：

- `ToolCatalog` 已完成静态装配层职责：
  - 从 definition 的 tool names 解析 active tools。
  - 输出 runtime 可执行 `tools`。
  - 输出 debug/UI/API-safe 的 `toolInfos`。
  - 收集 `promptSnippet`、`promptGuidelines`、`sourceInfo`。
  - `PromptAssembler` 已消费 tool prompt metadata。
- `ToolOperations` 已完成第一版：
  - `type.ts` 定义环境操作接口。
  - `local-tool-operations.ts` 提供 root-bound 本地实现。
  - 内置工具通过 operations 访问文件和 shell。
- `built-in` 已完成第一版：
  - 一个工具一个文件。
  - 默认覆盖 read / ls / grep / find / write / edit / bash。
  - 每个工具有中文注释，便于后续逐个对标 coding-agent 行为。
- `ToolRuntime` 已完成第一版：
  - before/after hooks。
  - onUpdate 包装。
  - lifecycle events。
  - policy / approval。
  - 结果状态归一化。
- `ToolPolicy` 已完成第一版：
  - 默认策略已足够支撑当前 CLI 和 playground 验证。
  - 暂不继续细化 DSL，避免提前设计过重。
- `EventHub` 已接入 ToolRuntime event bridge：
  - 使用 `preferToolRuntimeEvents` 避免和底层 pi-agent-core tool events 重复。
  - 公共事件契约已包含 policy/approval 事件。
- `run-agent-core.ts` 和 `agent-playground.ts` 已提供验证入口：
  - 直接调工具时可测试 policy、approval、tool cwd、tool args。
  - playground 中可测试完整 agent run、tool execution、runtime events 和 request timeout。

本阶段结论：

- tools 阶段已经形成 agent-core 的 core capability layer。
- 当前能力足以支撑后续 lifecycle、server/client approval UI、observability、sandbox/remote operations 的建设。
- 下一阶段不再继续扩大 tools 基础面，除非发现 coding-agent 对标中的明确行为缺口。

后续增强项：

- `renderCall` / `renderResult`：用于 UI、日志、导出中的工具调用展示，不影响工具执行主链路。
- 更细的 policy DSL：按 profile、workspace、风险等级、命令类别、路径类别组合规则。
- 更完整的 Tool Observability：
  - duration、status、policy decision、approval latency、失败类型、工具调用频率。
  - 用于调试、审计、性能分析和后续 server/client 可视化。
- sandbox / remote / container 版 `ToolOperations`。
- server/client 侧 approval 交互闭环。
- 工具结果结构化和 artifact 化。

## 10. 阶段 6：LifecycleRunner 内部化

目标：建立内部 hook 执行器，但不公开插件 API。

新增文件建议：

```text
packages/agent-core/src/lifecycle/lifecycle-hooks.ts
packages/agent-core/src/lifecycle/lifecycle-runner.ts
```

工作项：

- 定义第一版 hooks：
  - `onInput`
  - `beforeContext`
  - `beforeToolCall`
  - `afterToolCall`
  - `beforeCompaction`
  - `afterRun`
- `RuntimeAssembler` 创建 `LifecycleRunner`。
- 注入：
  - `InputProcessor`
  - `ContextAssembler`
  - `ToolRuntime`
  - `CompactionPolicy`
  - `TurnRunner`
- 第一版 adapters 只包含 no-op 和测试 fake。

测试：

- hook 按注册顺序执行。
- transform 结果会传给下一个 hook。
- block/cancel 会短路。
- hook error 会转成标准 failure 或 diagnostic。

验收：

- 能力模块显式调用 lifecycle。
- `LifecycleRunner` 负责顺序、合并、短路、错误处理。

## 11. 阶段 7：ContextAssembler / PromptAssembler 分离

目标：把长期 system prompt 与每轮上下文材料分开。

新增文件建议：

```text
packages/agent-core/src/prompt/prompt-assembler.ts
packages/agent-core/src/context/context-assembler.ts
packages/agent-core/src/context/context-budget.ts
```

工作项：

- `PromptAssembler` 只处理：
  - definition instructions
  - tool availability summary
  - stable policy text
  - resource prompt fragments
- `ContextAssembler` 处理：
  - conversation projection
  - command message
  - temporary context materials
  - `lifecycle.beforeContext`
- 第一版 `ContextBudget` 只估算，不裁剪。
- 引入动态 system prompt 能力，对齐 pi coding-agent：
  - 保存一份 stable/base `PromptPlan` 和 `baseSystemPrompt`。
  - 每轮执行前允许 lifecycle/extension 风格的 hook 基于 base prompt 返回临时 `systemPrompt` override。
  - 临时 override 只作用于当前 turn；turn 结束后恢复 base prompt。
  - hook 也可以追加 custom/context messages，但这属于 ContextAssembler，不写回 base prompt。
  - RuntimeSession/TurnRunner 负责把有效 system prompt 应用到底层 AgentLoopAdapter。

测试：

- changing active tools changes tool prompt summary。
- custom context hook can append messages。
- system prompt 不包含临时 skill 正文。
- per-turn systemPrompt override 只影响当前 turn，下一轮自动恢复 base prompt。
- dynamic systemPrompt hook 收到的是 base prompt 和结构化 PromptPlan，不需要重新解析 tools/resources。

验收：

- prompt 和 context 有独立测试。
- TurnRunner 每 turn 通过 ContextAssembler 获取最终 context。
- 动态 system prompt 是 per-turn overlay，不污染静态装配结果。

## 12. 阶段 8：QueuePolicy / RetryPolicy / CompactionPolicy

目标：把运行后处理从 TurnRunner 主流程里抽成策略。

新增文件建议：

```text
packages/agent-core/src/policies/queue-policy.ts
packages/agent-core/src/policies/retry-policy.ts
packages/agent-core/src/policies/compaction-policy.ts
```

工作项：

- `QueuePolicy`：
  - 管 steering/follow-up 队列。
  - 支持 one-at-a-time。
- `RetryPolicy`：
  - 判断可重试 assistant error。
  - 退避策略。
  - 与 abort signal 集成。
- `CompactionPolicy`：
  - 第一版支持手动 compact 的结构。
  - 后续支持 threshold 和 overflow recovery。

测试：

- steer 优先于 follow-up。
- retryable error 会 schedule retry。
- context overflow 不走普通 retry。
- compact cancel 不改变 conversation。

验收：

- TurnRunner 不包含大量策略 if/else。
- 策略可单独替换和测试。

## 13. 阶段 9：ResourceCatalog

目标：对齐 pi coding-agent 的 ResourceLoader 边界，但第一版只落“静态资源 -> prompt fragments/resource infos”的核心路径。

pi coding-agent 的 ResourceLoader 能力范围：

- `getSystemPrompt()`：可用自定义 system prompt 替换默认 prompt。
- `getAppendSystemPrompt()`：追加 system prompt 片段。
- `getAgentsFiles()`：加载 `AGENTS.md` / `CLAUDE.md` 等项目上下文文件。
- `getSkills()`：加载 skills，并在有 read tool 时格式化进 system prompt。
- `getPrompts()`：加载 prompt templates。
- `getThemes()`：加载 themes。
- `getExtensions()`：加载 extension runtime，并让 extensions 注册 tools、发现 resources、参与 session hooks。
- `extendResources()` / `reload()`：支持运行期扩展资源与重载。
- 输出 diagnostics/sourceInfo，避免资源冲突和来源不明。

我们第一版 ResourceCatalog v1 与 pi 的主要差距：

- 不扫描文件系统，不自动向上查找 `AGENTS.md` / `CLAUDE.md`。
- 不加载 skills、prompt templates、themes。
- 不加载 extensions，也不支持 extension `resources_discover`。
- 不支持 reload / extendResources。
- 不做 resource trust、package manager、路径 canonicalize。
- 不做“自定义 system prompt 替换默认 prompt”，只提供可组合的 prompt fragments。
- 不参与每轮动态 hook；动态 systemPrompt 放到后续 TurnRunner/LifecycleRunner 阶段。

v1 刻意保留的能力：

- definition 显式声明资源名。
- catalog 从静态 registry 中解析资源。
- 输出结构化 `promptFragments` 给 `PromptAssembler`。
- 输出 `resourceInfos` 给 CLI debug / UI / diagnostics。
- 校验未知资源、重复资源、空片段。
- 保留 sourceInfo/diagnostics 字段，为后续文件资源和 extension 资源留接口。

新增文件建议：

```text
packages/agent-core/src/resources/resource-catalog.ts
packages/agent-core/src/resources/context-files.ts
packages/agent-core/src/resources/skills.ts
packages/agent-core/src/prompt/prompt-template.ts
```

工作项：

- v1：静态 prompt fragments
  - 定义 `AgentResourceDefinition`：
    - `name`
    - `label`
    - `promptFragment`
    - `sourceInfo`
    - `diagnostics?`
  - 定义 `AgentResourceRegistry` / `ResourceCatalog`。
  - `AgentDefinition` 增加轻量 `resourceNames?: string[]`。
  - `DefinitionResolver` 规范化 resource names，校验重复和空值。
  - `ResourceCatalog.resolvePlan()` 输出：
    - `resourceNames`
    - `entries`
    - `resourceInfos`
    - `promptFragments`
  - `PromptAssembler` 把 `promptFragments` 合入 `PromptPlan.sections`。
  - CLI 增加 `--example-resources`、`--print-resources`，便于检查最终 system prompt。
- v2：项目上下文文件
  - 对齐 pi 的 `loadProjectContextFiles()`。
  - 支持按 cwd 和 agentDir 查找 `AGENTS.md` / `CLAUDE.md`。
  - 输出为带 path/sourceInfo 的 resource entry。
  - 默认只读，不打印 warning，diagnostics 交给调用方。
- v3：skills 与 prompt templates
  - 引入 `SkillDefinition` 和 `PromptTemplateDefinition`。
  - skills 不直接塞进临时 context，而是由 PromptAssembler/ContextAssembler 根据 active tools 和 budget 决定是否展示。
  - prompt templates 先作为可查询资源，不急着进入 runtime prompt。
- v4：运行期资源扩展
  - 增加 `extendResources()` / `reload()`。
  - 允许 lifecycle/extension runner 发现资源后刷新 ResourceCatalog。
  - 刷新后重建 base PromptPlan/baseSystemPrompt。
- v5：extension/resource sourceInfo 与 trust
  - 对齐 pi 的 extension resource sourceInfo。
  - 加入资源来源、scope、origin、baseDir。
  - 再考虑 trust/policy，而不是 v1 直接引入。

测试：

- v1：
  - duplicate resource name 失败。
  - unknown resource name 失败。
  - resource prompt fragment 进入 system prompt。
  - resourceInfos 不暴露运行时对象。
  - diagnostics 可收集。
- v2+：
  - context files 按 global -> ancestor -> cwd 顺序稳定合并。
  - 同一路径只加载一次。
  - unreadable file 生成 diagnostic。
- v3+：
  - prompt template expansion 可独立测试。

验收：

- 资源发现与上下文选择分离。
- v1 不引入文件扫描和 extension 复杂度，但类型和输出形状不阻断后续对齐 pi。
- PromptAssembler 只消费已解析资源，不自己加载资源。

## 14. 阶段 10：收口与命名清理

目标：让目录和公开出口符合架构文档。

工作项：

- 整理 `index.ts` exports：
  - 只导出稳定 public types。
  - 内部模块不误导出。
- 给内部模块加 `README` 或文件头说明职责。
- 删除或 deprecate 旧命名：
  - `AgentToolRegistry` 若已被 `ToolCatalog` 替代，则保留兼容 wrapper 或迁移测试。
  - `PiAgentRuntimeFactory` 若仍存在，应明确它只是 Pi adapter factory。
- 更新 `harness-architecture.md` 中与实际落地不一致的命名。

验收：

- public exports 小而清晰。
- 模块职责和测试边界对应。
- `npm run check` 通过。

## 15. 当前未完成的 Pi coding-agent 对标清单

本节记录截至当前阶段 `agent-core` 还没有完成的能力。判断标准不是“是否有同名模块”，而是是否已经具备 `pi/packages/coding-agent/src/core` 中对应能力的可运行行为、测试边界和后续可扩展入口。

### 15.1 内置 core runtime tools

当前状态：

- `ToolCatalog` 和 `AgentToolRegistry` 已支持静态工具注册、解析、prompt metadata 和 runtime tool 包装。
- 已建立 `agent-core` 自己的 core tool capability layer：这些工具是 agent 与运行环境交互的基础能力。调用方可以自由组合内置工具定义，coding-agent 只是其中一种高权限组合。
- 已对标 `coding-agent/src/core/tools/` 的核心能力边界，沉淀为 `agent-core` 内置 core runtime tools：
  - `read`
  - `write`
  - `edit`
  - `bash`
  - `grep`
  - `find`
  - `ls`
- 目录组织已经按以下边界落地：
  - `packages/agent-core/src/tools/` 根目录只放工具注册、装配、定义、catalog、operations、runtime 等 Harness 概念。
  - `packages/agent-core/src/tools/built-in/` 放内置工具实现。
  - 每个内置工具一个文件，例如 `built-in/read.ts`、`built-in/edit.ts`。
- 默认工具激活策略已对齐“自由组合优先”的方向，不引入固定 profile：
  - 调用方手动选择 `built-in` 工具 definitions。
  - 通过 `createAgentToolRegistry([...])` 注册自由组合。
  - `AgentDefinition.toolNames` 决定当前 agent 实际请求启用哪些工具。
  - `ToolCatalog` 负责解析 active tools，并可通过 enablement rules 继续收窄。
- 已补齐第一版工具共用能力：
  - root-bound 路径解析和 workspace 边界约束。
  - 输出截断。
  - 本地 fs/shell operations 抽象。
  - edit/write/bash 的 policy/approval 入口。
  - CLI 单工具执行验证入口。

剩余增强项：

- 更细的输出结构化 details。
- 文件 mutation queue，避免并发写入/编辑互相覆盖。
- 更完整的 edit diff/render utils。
- 更丰富的 bash executor 抽象，后续可切本地、SSH、容器或 sandbox。
- 后续继续支持 allowlist、exclude、no-tools、no-builtin-tools 等过滤策略。

验收：

- 已完成：每个内置工具可以通过 CLI 独立执行验证。
- 已完成：核心 ToolRuntime / ToolPolicy / EventHub bridge 有单元测试覆盖。
- 待增强：每个内置工具补更细粒度的独立单元测试。
- 持续要求：工具行为和错误语义优先参考 coding-agent 现有测试。
- 持续要求：工具定义只暴露给 LLM 必要 schema，不泄漏执行环境细节。

### 15.2 ToolRuntime 与工具生命周期

当前状态：

- 工具可以被解析并交给底层 Pi Agent 执行。
- 已实现 `ToolRuntime` 作为真实执行拦截层：
  - `beforeToolCall` hook。
  - `afterToolCall` hook。
  - block/cancel 工具调用。
  - policy block / approval。
  - rewrite 工具参数。
  - 标准化 tool failure。
- 已把工具执行环境从 tool definition 中拆出来：
  - `ToolOperations` 注入文件系统、shell、远程执行环境。
  - 工具不直接绑定 Node fs/process。
- 已与 `EventHub` 对齐：
  - tool started/progress/finished 事件保持稳定 public contract。
  - policy/approval 事件进入 public contract。
  - tool result details/sourceIds 不泄漏 provider 或底层 Agent 类型。

剩余增强项：

- after hook 对 result 的改写能力可以继续细化类型约束。
- hook error 的 failure 归因可以继续增强，区分 policy failure、tool failure、lifecycle failure。
- 公共事件可以继续补充 duration、decision、approval latency 等 observability 字段。

验收：

- 已完成：policy/before hook block 时工具不执行。
- 已完成：approval approve 后继续执行，approval deny 后 blocked。
- 已完成：ToolRuntime lifecycle event 能桥接到 public runtime event。
- 待增强：after hook 改写 content/details/isError 的类型和测试继续补细。
- 待增强：hook error 会转成标准 run failure 或 tool failure，并带更明确诊断。

### 15.3 LifecycleRunner / extension seam

当前状态：

- `LifecycleHooks` 只是 no-op 占位：`{ name: "default" }`。
- 还没有 hook 顺序、合并、短路、错误处理。

未完成：

- 实现内部 `LifecycleRunner`，先不公开插件 API。
- 支持第一批内部 hook：
  - `onInput`
  - `beforeRun`
  - `beforeContext`
  - `beforeToolCall`
  - `afterToolCall`
  - `afterMessage`
  - `beforeCompaction`
  - `afterRun`
- 对齐 coding-agent extension runner 的核心语义：
  - 可阻止事件。
  - 可修改事件。
  - 纯通知事件。
  - hook 顺序稳定。
  - hook 失败可诊断。

验收：

- hook 按注册顺序执行。
- transform 结果会传给下一个 hook。
- block/cancel 会短路。
- lifecycle 不依赖 client/server/UI。

### 15.4 InputProcessor / ContextAssembler

当前状态：

- `PromptAssembler` 已能构建静态 system prompt。
- `TurnRunner` 直接把 command text 转成 user message。
- 没有 per-turn context assembly。

未完成：

- 实现 `InputProcessor`：
  - command normalize。
  - prompt template expansion。
  - skill command expansion。
  - input hook 接入。
- 实现 `ContextAssembler`：
  - 从 `ConversationProjector` 获取当前消息路径。
  - 注入当前 command message。
  - 注入临时 context materials。
  - 注入 compaction summary / branch summary。
  - 执行 `beforeContext` hook。
  - 输出当前 turn 的 systemPrompt/messages/tools/metadata。
- 支持动态 system prompt：
  - base `PromptPlan` 不变。
  - 每轮允许生成临时 override。
  - turn 结束后恢复 base prompt。

验收：

- per-turn system prompt override 只影响当前 turn。
- 临时 context 不写回 base prompt。
- ContextAssembler 不负责加载资源，只消费 ResourceCatalog snapshot。

### 15.5 QueuePolicy / RetryPolicy / CompactionPolicy

当前状态：

- `RuntimePolicies` 只是常量占位：
  - `queue: "direct"`
  - `retry: "none"`
  - `compaction: "disabled"`
- `TurnRunner` 还不是完整 run coordinator。

未完成：

- 实现 `QueuePolicy`：
  - steering 优先于 follow-up。
  - one-at-a-time。
  - all。
  - queue_changed event。
- 实现 `RetryPolicy`：
  - 可重试错误识别。
  - 网络/连接丢失重试。
  - backoff。
  - abort signal 集成。
  - retry_scheduled event。
- 实现 `CompactionPolicy`：
  - token/context usage 判断。
  - context overflow recovery。
  - 手动 compact 入口。
  - before/after compaction hook。
  - compaction_started/finished event。

验收：

- `TurnRunner` 主流程只编排策略，不内联大量 if/else。
- retry 和 compaction 不破坏 conversation state。
- context overflow 不走普通 retry 分支。

### 15.6 ConversationStore 对齐 SessionManager

当前状态：

- v1 支持 message entry、leafId、旧 messages payload 兼容和 active path projection。
- `StateExporter` 可以把 loop snapshot 同步成 entry graph。

未完成：

- JSONL append-only 持久化：
  - session header。
  - session id。
  - cwd。
  - created/modified。
- branch/fork/tree navigation：
  - 从历史 entry 分叉。
  - 切换 leaf。
  - active path 导出。
- 非 message entries：
  - `model_change`
  - `thinking_level_change`
  - `compaction`
  - `branch_summary`
  - `custom`
  - `custom_message`
  - `label`
  - `session_info`
- compaction-aware projection：
  - 最新 compaction summary 进入上下文。
  - `firstKeptEntryId` 之前的历史被摘要替代。
- tool call/tool result 顺序合法性校验。

验收：

- 新旧 state 都可恢复。
- branch path projection 有独立测试。
- compaction entry 不删除历史，只改变 projection。

### 15.7 ResourceCatalog v2+

当前状态：

- v1 支持静态 resource registry 和 prompt fragments。
- 不扫描文件系统，不加载 skills/templates/extensions。

未完成：

- 项目上下文文件：
  - 按 cwd/ancestor/global 发现 `AGENTS.md`、`CLAUDE.md` 等。
  - 去重。
  - unreadable file diagnostic。
  - sourceInfo/path metadata。
- skills：
  - skill discovery。
  - frontmatter/metadata 校验。
  - collision precedence。
  - active tools 相关展示策略。
- prompt templates：
  - template discovery。
  - template expansion。
  - 与 InputProcessor 集成。
- runtime resource refresh：
  - `reload()`。
  - `extendResources()`。
  - extension resource discovery seam。
- trust/source scope：
  - user/global/project/extension/file 来源。
  - 项目信任后再加载项目级扩展资源。

验收：

- ResourceCatalog 只发现和读取资源。
- ContextAssembler 决定每轮哪些资源进入上下文。
- diagnostics 结构化返回，不直接打印或退出进程。

### 15.8 ModelCatalog / ModelGateway

当前状态：

- `ModelCatalog.resolve()` 只是返回 definition.model。
- `ModelGateway` 只包装 api key resolver。
- 实际模型调用仍主要委托底层 Pi Agent。

未完成：

- provider registry：
  - 内置 providers。
  - custom providers。
  - dynamic model refresh。
- auth 解析链：
  - 显式 apiKey。
  - OAuth token 和刷新。
  - 环境变量。
  - ADC/GCloud/AWS 等 provider-specific auth。
- stream/complete 标准化：
  - text/thinking/toolcall events。
  - provider error 转标准 stop reason。
  - token usage/cost。
- model resolver：
  - scoped model。
  - fallback 策略。
  - model capability 检查。

验收：

- TurnRunner 不读环境变量。
- provider 错误不泄漏 provider 私有结构。
- model mismatch/fallback 语义明确。

### 15.9 AgentSessionRuntime / cwd-bound services

当前状态：

- `agent-core` 只能创建单个 runtime session。
- 没有 coding-agent 风格的 session runtime 管理层。

未完成：

- new/resume/fork/import/switch session。
- cwd 切换时重建 services：
  - ResourceCatalog。
  - Tool operations。
  - settings。
  - trust。
  - extensions。
- session shutdown/start lifecycle。
- session-level diagnostics。

验收：

- 单个 `AgentRuntimeSession` 仍保持小 facade。
- session switching 不进入 server/client 专属概念。
- cwd-bound service rebuild 有清晰工厂边界。

### 15.10 Public surface 与命名收口

当前状态：

- `index.ts` 仍导出较多内部模块。
- `PiAgentRuntimeFactory` 命名还保留在 public surface。

未完成：

- 收口 public exports：
  - public runtime contracts。
  - definition input。
  - factory。
  - SDK 需要的 registry builders。
- 内部模块不从根出口泄漏。
- 去 Pi 命名：
  - `PiAgentRuntimeFactory` 改为兼容 alias 或 adapter-specific export。
  - 对外主命名统一为 `AgentCoreRuntimeFactory`。
- 更新架构文档和实际命名不一致的地方。

验收：

- public API 小而稳定。
- adapter-specific 命名不污染核心概念。
- `npm run check` 通过。

## 16. 推荐实施顺序

优先顺序：

1. 目标目录骨架与迁移映射
2. `RuntimeAssembler`
3. `ToolCatalog` 静态装配
4. `PromptAssembler` 静态装配
5. `ResourceCatalog v1` 静态 prompt fragments
6. `PromptAssembler` resource sections 与 CLI debug
7. `ConversationStore / Projector`
8. `AgentLoopAdapter`
9. `EventHub / StateExporter`
10. `LifecycleRunner`
11. `PromptAssembler / ContextAssembler` 动态 systemPrompt per-turn overlay
12. `ToolRuntime`
13. `Policies`
14. `ResourceCatalog v2+` 文件、skills、templates、extension/reload
15. 命名和 export 收口

这个顺序的原因：

- 目录先行，后续代码不会继续落到实验结构。
- 先把现有 runtime factory 瘦身，风险最小。
- 先把 definition/tool/resource/prompt 的静态装配层做实，后续执行层不需要直接依赖原始 definition。
- ResourceCatalog v1 只做 prompt fragments，是为了先对齐 pi 的资源进入 system prompt 的主路径，而不提前引入 extension/reload。
- 再处理状态和 Pi adapter，执行层可以消费稳定的 assembly。
- 动态 systemPrompt 必须等 TurnRunner/LifecycleRunner 有明确 per-turn 生命周期后再做，否则容易污染静态 PromptPlan。
- 最后再引入 ToolRuntime、policies 和 ResourceCatalog v2+，避免一开始把资源系统做成过宽的插件平台。

## 17. 每阶段通用验收

每个阶段都要满足：

- 不扩大 public interface，除非该阶段明确要求。
- 不把 server/client 概念引入 `agent-core`。
- 新模块有独立单元测试。
- 旧 runtime 行为有回归测试。
- `npm run typecheck` 通过。
- 若改动跨模块，跑相关 `npm test`。
- 新文件必须落在目标职责目录；不得为了方便继续扩大 `agent-runtime-factory.ts`。

## 18. 风险控制

主要风险：

- 抽象过早：先做 no-op seam 和 fake adapter，不先做插件生态。
- 文件过散：每拆一个模块必须迁移真实职责和测试，避免只有 wrapper。
- 目录先行但实现空心化：允许短期 skeleton，但每个阶段必须把真实职责迁入目标目录。
- 状态迁移破坏恢复：旧 `{ messages }` payload 必须保留兼容。
- 事件 contract 泄漏 Pi 类型：EventHub 必须隔离底层 AgentEvent。
- TurnRunner 重新变大：策略判断和能力动作要持续下沉到 policy/capability 模块。
