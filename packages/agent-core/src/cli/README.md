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

`agent/index.ts` 是应用入口点。它加载默认的 DeepSeek 模型，为 agent 目录创建 `ResourceLoader`、`PromptTemplateLoader`、`SkillLoader` 和 `ToolsLoader`，并把生成的 registry 传入 `startAgentPlayground`。

`agent/main.ts` 拥有 playground 的运行时循环。它的 `AgentPlaygroundOptions` 接收已经组装好的运行时依赖和可选的 `conversationFile`；它不发现资源、不加载模型、也不注册工具。

`resources/` 里存放默认进入上下文的文本资源。`prompt/templates/` 里存放按需渲染成 user prompt 的任务模板，`prompt/system/` 是未来 prompt 装配配置的预留目录。`skills/` 里存放可激活能力说明，`tools/` 里存放从 `tools/index.ts` 导出的可执行工具定义。

Prompt template 支持一个很薄的 frontmatter，用于 `/templates` 列表和变量校验：

```md
---
description: Review a code change with findings-first output.
variables:
  target: Code path, module, or change to review
  focus: Review focus, such as tests or regressions
---

Review {{target}} with focus {{focus}}.
```

模板仍然不会进入 base system prompt。执行 `/template review target=src focus=tests` 时，渲染结果会作为本轮 transient user message 合并进 messages；原始 `/template ...` 输入仍作为可持久化用户消息写回 conversation。

Skill 使用 `agent/skills/**/SKILL.md` 目录能力包约定。V1 发现 metadata、正文 instructions 和 `references/`、`templates/`、`scripts/` 支持文件清单；显式执行 `/skill <name>` 查看详情时才读取允许读取的支持文件内容，显式执行 `/skill use <name> ...` 时会把 skill instructions、支持文件 manifest、存在的 `references/` 内容，以及用 `key=value` 渲染后的 skill 内 `templates/` 作为本轮 transient context 注入。manifest 只包含 kind、label、source、runtime policy、template 变量契约和 script metadata，不代表文件已读取或脚本已执行。`scripts/` 不会被 prompt 激活读取或注入；通过 `/skill run <skill> <script> ...` 或模型工具 `skill_run_script` 进入 skill runtime 时，支持的脚本默认可执行，只有脚本 metadata 显式声明 `execute: false` 才关闭执行。support symlink 会被 loader 的 trust policy 拒绝并返回 diagnostics。启动时会向 stderr 打印 SkillLoader diagnostics，`/skills` 会展示 loader diagnostics，`/skill <name>` 会展示支持文件的 runtime policy 和读取 diagnostics。不会自动选择 skill：

显式 `/skill use` 会发布可审计 runtime events：`skill_activation_decided`
记录激活或拒绝原因，`skill_policy_checked` 记录每个支持文件的 read / inject /
execute 运行期策略。CLI 的 `/events` 可以观察实时事件，`/eventlog [runId]`
可以查看保存在 EventStore 里的同一批记录。

显式 `/skill run` 不调用模型，也不注入 prompt。脚本 metadata 可以省略；默认值按文件后缀推断：

- `.sh` / `.bash`：`interpreter: bash`，`sandbox: virtual`
- `.js` / `.mjs` / `.cjs`：`interpreter: node`，`sandbox: local`
- `timeout_ms`：`5000`
- `output_limit_bytes`：`1048576`

需要覆盖默认值时，可以使用脚本文件顶部 frontmatter；`.js` 文件应使用注释
frontmatter，保证文件本身仍是合法 JavaScript：

```sh
---
sandbox: virtual
timeout_ms: 1000
output_limit_bytes: 65536
---
echo "$SKILL_ARGS_JSON"
```

```js
/*---
sandbox: local
interpreter: node
timeout_ms: 1000
output_limit_bytes: 65536
---*/
const args = JSON.parse(process.env.SKILL_ARGS_JSON ?? "[]");
console.log(args);
```

脚本可以声明第一版参数契约，格式是 `arg_<name>: <type> required|optional <description>`。
支持的类型包括 `string`、`number`、`boolean`、`string[]`、`number[]`、`boolean[]`
和 `json`：

```js
/*---
sandbox: local
arg_numbers: number[] required Numbers to sum
---*/
const input = JSON.parse(process.env.SKILL_INPUT_JSON ?? "{}");
const numbers = input.namedArgs.numbers;
console.log(JSON.stringify({ status: "ok", result: { sum: numbers.reduce((a, b) => a + b, 0) } }));
```

`/skill run math sum numbers=1,2,3` 和模型工具 `skill_run_script` 的 `namedArgs`
都会先按契约校验 / 转换，再注入 `SKILL_NAMED_ARGS_JSON` 和 `SKILL_INPUT_JSON`。
脚本 stdout 最后一行如果是 JSON envelope（或带 `SKILL_RESULT_JSON:` 前缀），runtime
会解析为结构化输出。推荐 envelope：

```json
{ "status": "ok", "result": { "sum": 6 }, "logs": ["parsed 3 numbers"] }
```

exit code `0` 会归类为 `succeeded`，`2` 会归类为 `invalid_arguments`，超时归类为
`timed_out`，其余非零退出归类为 `failed`。

要显式禁止某个脚本执行，可以写 `execute: false`。local 执行必须来自脚本 metadata
或文件后缀推断出的 `sandbox: local`，且 `LocalProcessSandbox` 只继承 allowlist
env；用户参数通过 `SKILL_ARGS`、`SKILL_ARGS_JSON`、`SKILL_NAMED_ARGS_JSON` 和
`SKILL_INPUT_JSON` 传入脚本。SkillSupportRuntime 会发布
`skill_script_policy_checked`、`skill_script_started`、
`skill_script_completed` 和 `skill_script_failed` 审计事件。

Skill support file 的按需契约入口已接入第一版 CLI 调试路径和模型工具路径：

- `/skill read <skill> <file>`：通过 `SkillSupportRuntime` 读取一个 policy
  允许 read 的支持文件。`scripts/` 因为 `read=no` 会被拒绝。
- `/skill render <skill> <template> key=value...`：通过 `SkillSupportRuntime`
  渲染一个 policy 允许 read 的 skill template，并复用 prompt-template 的变量校验。
- `/skill run <skill> <script> ...`：通过 `SkillSupportRuntime.runScript()` 执行一个 policy 允许
  execute 的 script。
- `skill_read_support_file` / `skill_render_template` / `skill_run_script`：作为通用
  skill tools 注册到 ToolRegistry，但 CLI 的普通 `/tools` 开关不直接启用它们；
  每个 prompt turn 会根据 active skill manifest 动态暴露本轮需要的 read / render /
  run tool schema。执行时仍会检查当前 prompt turn 是否激活了对应 skill，再复用同一套
  read / render / run policy。

这三组入口对应 manifest 中的可发现契约。CLI 入口用于人工调试；模型工具入口的返回值作为
tool result 回到同一轮模型上下文，由模型继续决定如何回答。当前实现是“静态 registry +
per-turn tools override”：ToolRegistry 仍是启动时仓库，真正暴露给模型的本轮 tools
由 RuntimeAssembler / TurnRunner 在 context 装配后根据 active skill 动态解析。

当前每个 prompt turn 只允许一个 active skill。显式组合写法如
`/skill use review,lint ...` 或 `/skill use review+lint ...` 会在 prompt 注入前
返回 `INPUT_REJECTED`，并发布 `skill_composition_decided` 审计事件。普通
`/skill use review src/file` 仍把 `src/file` 作为 skill arguments。

```md
---
name: review
description: Review code changes and report findings first.
disable_model_invocation: true
---

## Instructions

Report findings first, ordered by severity.
```

`disable-model-invocation` 也会作为兼容别名解析，但 CLI 展示统一使用
`disable_model_invocation`。声明 `disable_model_invocation: true` 的 skill 不会通过
prompt 注入执行；需要执行确定性脚本时使用 `/skill run`。

Loader 和 registry 的职责是分离的：

- `ResourceLoader({ agentDir }).createRegistry()` 发现文本资源并创建资源 registry。
- `PromptTemplateLoader({ agentDir }).createRegistry()` 发现 `prompt/templates/` 下的任务模板并创建模板 registry。
- `SkillLoader({ agentDir }).createRegistry()` 发现 `skills/**/SKILL.md` 能力包并创建 skill registry。
- `ToolsLoader({ agentDir }).createRegistry()` 注册核心内置工具、导入 `tools/index.js`，并创建工具 registry。
- `startAgentPlayground` 只接收 registries，不暴露 loader 参数。

## Playground 命令

在 playground 内，普通输入会作为 prompt 发送给当前运行时会话。以斜杠开头的命令用于控制运行时配置：

```text
/tools                 显示已启用的工具。
/tools all             启用应用入口注册的所有工具。
/tools none            禁用所有工具。
/tools inspect_runtime 启用选定的已注册工具。
/templates             显示发现到的 prompt templates、描述和变量名。
/template review       打印某个 prompt template 的详情和内容。
/template review target=src focus=tests
                       渲染模板变量，并把结果作为本轮临时 message 合并进上下文。
/skills                显示发现到的 skills、描述和来源。
/skill review          打印某个 skill 的 instructions、支持文件清单和支持文件内容。
/skill use review src target=src
                       激活某个 skill，并把 instructions、references/ 和渲染后的 templates/ 注入本轮临时上下文。
/skill use review,lint target=src
                       当前会拒绝多 skill 组合，并记录 skill_composition_decided 审计事件。
/skill read review checklist.md
                       读取一个 policy 允许 read 的 skill support file。
/skill render review finding target=src
                       渲染一个 policy 允许 read 的 skill template。
/skill run review collect arg
                       执行一个 policy 允许 execute 的 skill script。
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
