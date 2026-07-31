# Resources

`resources/` 负责 agent 文本资源的发现、读取、规范化和 prompt/debug 投影。
这一层的核心约束是：

```text
ResourceLoader 的产物必须是可序列化、可审计、无执行闭包的文本资源。
```

可执行工具不属于 Resource 层。工具有参数 schema、执行函数、权限、审批、
sandbox 和观测语义，必须走 `tools/` 下的 `ToolRegistry`、`ToolCatalog` 和
`ToolRuntime`。

## 模块分工

### ResourceLoader

`ResourceLoader` 只做文本资源加载：

- 发现约定目录里的文本文件。
- 读取 `.md` / `.txt` 内容。
- 根据目录推断 `LoadedResourceKind`。
- 生成稳定 `name`、`label`、`sourceInfo`、`priority`、`loadedAt`。
- 返回 `LoadedResourceSnapshot`，包含 `resources` 和结构化 `diagnostics`。

它不做这些事：

- 不注册 tools。
- 不执行工具。
- 不调用模型。
- 不写入 memory。
- 不做 conversation 存储或 compaction。
- 不决定某轮应该动态召回哪些资源。

### ResourceCatalog

`ResourceCatalog` 只消费 `AgentResourceRegistry`。文件发现已经在
`ResourceLoader({ agentDir }).createRegistry()` 阶段完成。

Catalog 负责：

- 校验 resource name。
- 输出 `promptFragments` 给 `PromptAssembler`。
- 输出 `resourceInfos`、`contextFilePaths`、`skillNames`、`diagnostics` 给调试和 UI。

Catalog 不负责文件扫描；文件扫描只属于 `ResourceLoader`。

## Agent 应用目录约定

后期 agent 应用推荐使用固定目录区分资源类型：

```text
agent/
  index.ts
  resources/
    instructions/
      AGENTS.md
    memory/
      MEMORY.md
    references/
      architecture.md
    prompt-templates/
      review.md
  skills/
    debugging/
      SKILL.md
  tools/
    query-ticket.ts
```

约束：

- `agent/index.ts` 是 agent 应用入口和 composition root，只声明 definition、
  model、启用资源、启用 skills、启用 tools、policies、lifecycle hooks 和
  runtime options。
- `agent/resources/` 只放可序列化文本资源。
- `agent/skills/` 放 `SKILL.md` 风格能力说明。当前只发现和读取，选择与展开留给
 后续 Skill/InputProcessor/ContextAssembler 阶段。
- `agent/tools/` 放可执行工具定义，不进入 `ResourceLoader` 或 `ResourceCatalog`。

## LoadedResourceKind

第一版资源类型：

- `instruction`：稳定规则和工作方式，例如 `AGENTS.md` / `CLAUDE.md`。
  表达“应该怎么工作”。
- `memory`：长期事实和偏好，例如 `MEMORY.md`。
  表达“已经知道什么”。第一版只读，不自动写入。
- `reference`：普通参考材料，例如项目文档、架构说明、领域背景。
  表达“可参考的信息”，不是规则，也不是长期记忆。
- `prompt-template`：可由 slash command 或输入处理选择的提示模板。
  ResourceLoader 只加载模板文本，不执行模板展开。
- `skill`：可按需展开的能力说明，例如 `SKILL.md`。
  ResourceLoader 只负责发现和读取，不负责选择或激活。
- `system-prompt`：替换基础 system prompt 的文本来源。
- `append-system-prompt`：追加到基础 system prompt 的文本来源。

当前 `ResourceLoader` 支持以下目录：

| 目录 | kind | 是否直接注入 prompt |
|---|---|---|
| `resources/instructions/` | `instruction` | 是 |
| `resources/memory/` | `memory` | 是 |
| `resources/references/` | `reference` | 是 |
| `resources/prompt-templates/` | `prompt-template` | 否 |
| `skills/` | `skill` | 否 |

`prompt-template` 和 `skill` 会被 `ResourceLoader.load()` 发现，但
`createRegistry()` 不会把它们注册成直接注入 prompt 的资源。后续选择与展开应由
Skill / Prompt Template 模块处理。

## Prompt 边界

`ResourceLoader.createRegistry()` 会给可直接注入的文件资源包上边界：

```xml
<project_instructions source="...">
...
</project_instructions>

<memory_context source="...">
...
</memory_context>

<reference_context source="...">
...
</reference_context>
```

这样模型可以区分：

- `instruction`：规则和工作方式。
- `memory`：长期事实和偏好。
- `reference`：普通参考资料。

## 加载流程

```text
agent/index.ts
  -> new ResourceLoader({ agentDir })
  -> createRegistry()
  -> RuntimeAssembler
  -> ResourceCatalog.load(...)
  -> PromptAssembler.assemble(...)
  -> systemPrompt
```

registry resources 仍然可用：

```text
AgentDefinition.resourceNames
  -> AgentResourceRegistry
  -> ResourceCatalog.resolveForDefinition(...)
```

应用入口不直接手写 resource registry。推荐流程是：

```text
new ResourceLoader({ agentDir })
  -> load text resources
  -> createRegistry()
  -> ResourceCatalog.resolveForDefinition(...)
```

`createAgentResourceRegistry(...)` 仍是低层构造函数，供 loader 内部、测试和高级
SDK 场景使用；普通 `agent/index.ts` 只指定目录。

Tool 层保持平行但独立：

```text
new ToolsLoader({ agentDir })
  -> import agent/tools/index.js
  -> createRegistry()
  -> ToolCatalog.resolveForDefinition(...)
```

ToolsLoader 不能借用 ResourceLoader，因为工具包含执行函数和运行时策略，不能进入
可序列化 resource snapshot。

## Diagnostics

Resource 层不会直接打印错误或退出进程。读取失败、重复资源、不支持的目录项等
都会进入 `ResourceDiagnostic`：

- `missing-root`
- `read-failed`
- `unsupported-entry`
- `duplicate-resource`

上层可以选择把 diagnostics 展示在 playground、server logs、debug API 或 UI 中。

## 后续方向

- 支持 global / workspace / project / explicit 多 scope。
- 支持 frontmatter 覆盖 `kind`、`priority`、`label`、`scope`。
- 支持 resource reload。
- 支持 `system-prompt` / `append-system-prompt` 文件发现。
- 支持 prompt-template expansion 和 skill activation，但这些能力应在对应模块中
  实现，而不是放进 ResourceLoader。
