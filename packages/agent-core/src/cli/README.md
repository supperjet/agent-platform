# Agent Core CLI

用于测试 `agent-core` 的开发专用 playground 入口，无需启动 server 或 client。

## 启动

启动本地 agent playground：

```bash
npm run dev:core
```

当前的 CLI 应用入口刻意保持精简：它始终使用默认的 DeepSeek 模型，并从项目根目录的 `.env` 文件或进程环境中读取 API key：

```dotenv
DEEPSEEK_API_KEY=...
```

## 应用边界

CLI 使用和未来 `agent-core` 消费者相同的应用 agent 目录约定：

```text
src/cli/agent/
  index.ts
  main.ts
  resources/
    instructions/
    memory/
    references/
  prompt/
    templates/
    system/
  skills/
  tools/
```

`agent/index.ts` 是应用入口点。它加载默认的 DeepSeek 模型，为 agent 目录创建 `ResourceLoader`、`PromptTemplateLoader` 和 `ToolsLoader`，并把生成的 registry 传入 `startAgentPlayground`。

`agent/main.ts` 拥有 playground 的运行时循环。它的 `AgentPlaygroundOptions` 接收已经组装好的运行时依赖和可选的 `conversationFile`；它不发现资源、不加载模型、也不注册工具。

`resources/` 里存放默认进入上下文的文本资源。`prompt/templates/` 里存放按需渲染成 user prompt 的任务模板，`prompt/system/` 是未来 prompt 装配配置的预留目录。`skills/` 里存放可激活能力说明，`tools/` 里存放从 `tools/index.ts` 导出的可执行工具定义。

Loader 和 registry 的职责是分离的：

- `ResourceLoader({ agentDir }).createRegistry()` 发现文本资源并创建资源 registry。
- `PromptTemplateLoader({ agentDir }).createRegistry()` 发现 `prompt/templates/` 下的任务模板并创建模板 registry。
- `ToolsLoader({ agentDir }).createRegistry()` 注册核心内置工具、导入 `tools/index.js`，并创建工具 registry。
- `startAgentPlayground` 只接收 registries，不暴露 loader 参数。

## Playground 命令

在 playground 内，普通输入会作为 prompt 发送给当前运行时会话。以斜杠开头的命令用于控制运行时配置：

```text
/tools                 显示已启用的工具。
/tools all             启用应用入口注册的所有工具。
/tools none            禁用所有工具。
/tools inspect_runtime 启用选定的已注册工具。
/templates             显示发现到的 prompt templates。
/template review       打印某个 prompt template 的内容。
/policy on|off         切换默认 ToolPolicy。
/approve ask|always|never  设置审批策略。
/events on|off|json    切换 AgentRuntime 和 ToolRuntime 事件打印。
/eventlog [runId]      打印存储的 EventStore 记录。
/toolcalls [runId]     打印投影后的工具调用恢复记录。
/runtime               打印运行时状态快照和恢复评估。
/runtimelog            打印追加式运行时日志条目。
/compact status        打印压缩（compaction）设置。
/compact run [keep N]  手动压缩更早的对话消息。
/compact auto on|off   切换自动复合压缩。
/compact auto protect N 自动压缩运行时保护最近的 N 条消息。
/compact summarizer llm|fallback  选择 LLM 驱动或确定性兜底的摘要方式。
/lifecycle on|off|json 切换 LifecycleRunner 钩子的日志记录。
/runs                  打印存储的 RunStore 记录。
/state                 打印导出的对话状态。
/save                  把对话状态保存到本地存储。
/delete                删除已保存的本地对话状态。
/storage               打印本地对话文件路径。
/context               打印最近一次组装的 prompt 上下文和预算诊断。
/snapshot              打印运行时快照。
/system                打印当前组装的 system prompt。
/reset                 重置对话会话。
/exit                  退出。
```

斜杠开头但不是 playground 命令的行，例如 `/review target`，会被作为 prompt 发送给运行时，这样就可以交互式地测试 `InputProcessor` 的斜杠元数据。

## 对话状态

playground 把本地对话状态存储为 JSON 快照。`AgentPlaygroundOptions.conversationFile` 可以覆盖存储位置。默认情况下，它读写：

```text
<cwd>/.agent-platform/playground/sessions/agent-core-playground/state.json
```

用 `/storage` 打印确切路径，用 `/save` 强制保存，用 `/delete` 移除已保存的对话文件。smoke 测试会验证这个已保存的状态使用 entry graph payload，并且可以通过 `ConversationStore` 恢复：

```bash
npm run smoke:conversation
```
