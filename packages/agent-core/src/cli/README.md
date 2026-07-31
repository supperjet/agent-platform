# Agent Core CLI

Development-only terminal entry for testing `agent-core` without starting server or client.

## Text Mode

Run one prompt and print the assistant text:

```bash
npm run dev:core -- "你好，测试一下"
```

Real provider mode uses DeepSeek and automatically reads the nearest `.env` from the current working directory or its parent directories:

```dotenv
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL_ID=deepseek-v4-flash
```

Then run:

```bash
npm run dev:core -- "解释一下当前 runtime"
```

Optional model override:

```bash
npm run dev:core -- --model deepseek-v4-flash "测试模型"
```

Provider request timeout override:

```bash
npm run dev:core -- --request-timeout-ms 600000 "测试较慢请求"
npm run dev:core -- --agent-playground --request-timeout-ms 600000
```

Shell environment variables still take precedence over `.env`, and `--model` takes precedence over both.

## Faux Mode

Use a local faux provider. This does not require an API key and is useful for testing the Harness pipeline:

```bash
npm run dev:core -- --faux "测试运行链路"
```

Custom faux response:

```bash
npm run dev:core -- --faux --faux-response "本地假模型响应" "任意 prompt"
```

## JSON Event Mode

Output `AgentRuntimeEvent` as JSON lines:

```bash
npm run dev:core -- --json "测试 json 输出"
```

With faux provider:

```bash
npm run dev:core -- --json --faux --faux-response "JSON OK" "测试 json 输出"
```

This is the closest current equivalent to Pi's `--mode json`: it is single-shot, terminal-friendly, and useful for inspecting event order during refactors.

## Agent Runtime Playground

Start an interactive playground for the full AgentRuntime execution path:

```bash
npm run dev:core -- --agent-playground
```

For local shell testing without a provider key:

```bash
npm run dev:core -- --faux --agent-playground
```

Inside the playground, ordinary input is sent as a prompt to the current runtime session. Slash commands control runtime configuration:

```text
/tools                 Show enabled tools.
/tools all             Enable built-in tools.
/tools none            Disable all tools.
/tools read,ls,grep    Enable selected tools.
/policy on|off         Toggle default ToolPolicy.
/approve ask|always|never
/events on|off|json    Toggle AgentRuntime and ToolRuntime event printing.
/eventlog [runId]      Print stored EventStore records.
/toolcalls [runId]     Print projected tool call recovery records.
/runtime               Print runtime state snapshot and recovery assessment.
/runtimelog            Print append-only runtime log entries.
/compact status        Print compaction settings.
/compact run [keep N]  Manually compact older conversation messages.
/compact auto on|off   Toggle automatic composite compaction.
/compact auto protect N
                       Protect N latest messages when auto compaction runs.
/compact summarizer llm|fallback
                       Choose LLM-driven or deterministic fallback summaries.
/lifecycle on|off|json Toggle LifecycleRunner hook logging.
/cwd <path>            Rebuild runtime with a new ToolOperations cwd.
/runs                  Print stored RunStore records.
/state                 Print exported conversation state.
/save                  Save conversation state to local storage.
/delete                Delete the saved local conversation state.
/storage               Print the local state file path.
/context               Print the last assembled prompt context and budget diagnostics.
/snapshot              Print runtime snapshot.
/system                Print current assembled system prompt.
/reset                 Reset conversation session.
/exit                  Quit.
```

Slash-prefixed lines that are not playground commands, such as `/review target`,
are sent to the runtime as prompts so `InputProcessor` slash metadata can be
tested interactively.

When `/lifecycle on` or `/lifecycle json` is enabled, the playground hooks also
consume `/review` metadata: `beforeRun` adds a review-specific system prompt
overlay, and `beforeContext` appends a review context message for the turn.
The injected review message is run-local context: it is visible through
`/context`, but it is not written to `/state`.
Runtime message events include `messageScope`, so consumers can keep transient
context in debug logs without rendering it as conversation transcript.
`/context` also prints budget diagnostics for the last assembled prompt,
including estimated input tokens, available input budget, pressure status, and
largest message contributors. Automatic composite compaction is off by default;
enable it with `/compact auto on`, and adjust the protected recent-message
window with `/compact auto protect N`. The playground default targets about 70% context
pressure and uses role-aware, largest-first, and token-budget source selection.
Compaction summaries use the deterministic fallback summarizer by default; switch
to the model-backed summarizer with `/compact summarizer llm`, or start the
playground with `--playground-compaction-summarizer llm`.

The playground also records prompt execution into in-memory RunStore and
EventStore instances. Use `/runs` to inspect prompt run outcomes, and
`/eventlog` or `/eventlog <runId>` to inspect stored runtime events.
Use `/toolcalls` or `/toolcalls <runId>` to inspect projected tool call recovery
records from the same EventStore stream. The playground also records a
session-level runtime snapshot and append-only runtime log; use `/runtime` to
inspect clean/dirty/interrupted recovery assessment, and `/runtimelog` to inspect
the audit log. `/compact run` creates a compact command run record and appends a
compaction entry to the exported conversation state when there are older messages
to summarize.
When automatic compaction is enabled with `/compact auto on`, pressured prompt
turns can append a compaction entry before the prompt is sent to the model.
Inspection commands such as `/state`, `/context`, `/runs`, `/eventlog`,
`/toolcalls`, `/runtime`, and `/runtimelog` do not create new run records.

The playground stores local conversation state as a JSON snapshot. By default,
it reads and writes:

```text
<cwd>/.agent-platform/playground/sessions/agent-core-playground/state.json
```

Use `/storage` to print the exact path, `/save` to force a save, and `/delete`
to remove the saved state. The playground also attempts to restore this file on
startup and saves after successful or aborted prompt turns. To override the file:

```bash
npm run dev:core -- --agent-playground --playground-state-file /tmp/agent-state.json
```

This mode exercises the whole path: `AgentDefinition -> RuntimeAssembler -> LifecycleRunner -> AgentLoop -> ToolRuntime -> ToolPolicy -> ToolOperations -> EventHub -> ConversationState`.

Lifecycle logging is useful while developing hook boundaries:

```text
/lifecycle on
hello lifecycle
```

For machine-readable hook traces:

```text
/lifecycle json
请使用 read 工具读取 package.json
```

Prompt execution currently logs `onInput`, `beforeRun`, `beforeContext`, `afterMessage`, and `afterRun`. Tool execution logs `beforeToolCall` and `afterToolCall` when the model calls a tool. Manual `/compact run` execution logs `beforeCompaction` and `afterRun`.

### Lifecycle Hook Examples

The playground's `/lifecycle on|json` command installs logging hooks. In a real composition root or test, pass `LifecycleHooks` into the factory and the same hook set into `ToolRuntime` through `createLifecycleRunner(...)`:

```ts
import {
  PiAgentRuntimeFactory,
  createLifecycleRunner,
  createToolRuntime,
  type LifecycleHooks,
} from "@agent-platform/agent-core";

const lifecycleHooks: LifecycleHooks = {
  onInput: [
    ({ command }) => {
      if (command.type === "prompt" && command.text === "/health") {
        console.log("runtime ok");
        return { action: "handled" };
      }

      if (command.type === "prompt" && command.text.startsWith("/review ")) {
        return {
          action: "transform",
          command: {
            type: "prompt",
            text: `请 review 这个目标，优先指出 bug、风险和缺失测试：${command.text.slice("/review ".length)}`,
          },
        };
      }

      return { action: "continue" };
    },
  ],

  beforeRun: [
    ({ systemPrompt }) => ({
      systemPrompt: `${systemPrompt}\n\n本轮临时要求：回答前先说明你检查了哪些上下文。`,
    }),
  ],

  beforeContext: [
    ({ messages }) => ({
      messages: [
        ...messages,
        {
          role: "user",
          content: "临时上下文：本轮优先遵守 agent-core/core-server/client 的包边界。",
          timestamp: Date.now(),
        },
      ],
    }),
  ],

  beforeToolCall: [
    ({ tool, args }) => {
      if (tool.name !== "bash") return;
      const command = typeof args === "object" && args && "command" in args
        ? String(args.command)
        : "";

      if (command.includes("git reset --hard")) {
        return {
          allow: false,
          reason: "lifecycle blocked destructive git reset.",
        };
      }
    },
  ],

  afterToolCall: [
    ({ result }) => {
      if (!result) return;
      return {
        result: {
          ...result,
          content: result.content.map((block) => {
            if (block.type !== "text") return block;
            return {
              ...block,
              text: block.text.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]"),
            };
          }),
        },
      };
    },
  ],

  afterRun: [
    ({ status }) => {
      console.log(`[lifecycle] run finished: ${status}`);
    },
  ],
};

const toolRuntime = createToolRuntime({
  lifecycleRunner: createLifecycleRunner(lifecycleHooks),
});

const factory = new PiAgentRuntimeFactory({
  definition,
  toolRegistry,
  resourceRegistry,
  toolRuntime,
  lifecycleHooks,
  resolveApiKey,
});
```

Useful patterns:

- `onInput`: expand slash commands, normalize prompt text, or handle local commands without calling the model.
- `beforeRun`: add per-run system prompt overrides or internal messages.
- `beforeContext`: append temporary memory, skill text, or run-local context. Current `TurnRunner` wiring requires preserving the existing conversation prefix.
- `beforeToolCall`: block risky tool calls or rewrite tool args.
- `afterToolCall`: redact secrets, normalize details, or mark unsafe output as an error.
- `afterMessage`: observe finalized messages and extract memory/artifact candidates.
- `afterRun`: cleanup and diagnostics.

## Conversation State

Print the exported `AgentConversationState` after a run:

```bash
npm run dev:core -- --faux --json --print-state "测试 conversation graph"
```

The final JSON line should use the entry graph payload:

```json
{
  "schemaVersion": 2,
  "modelId": "...",
  "payload": {
    "entries": [],
    "leafId": null
  }
}
```

For a non-empty run, `payload.entries` contains message entries and `payload.leafId` points to the active leaf entry. The old `payload.messages` format is not supported.

Run the smoke check for this contract:

```bash
npm run smoke:conversation
```

The script runs the faux CLI, parses the final exported state, verifies the entry graph payload, and restores it through `ConversationStore`.

## Tools

Enable host-registered tools by comma-separated name. For local prompt assembly testing, the CLI can register example tools:

```bash
npm run dev:core -- --example-tools --tools inspect_runtime,read_note "使用已注册工具回答"
```

The CLI registers built-in tool definitions for local testing. In prompt mode, only names passed through `--tools` are exposed to the model. `--example-tools` adds CLI-only test tools.

### Direct Tool Execution

Execute a registered tool directly without calling the model:

```bash
npm run dev:core -- --call-tool read --tool-args '{"path":"package.json","limit":5}'
```

The direct mode uses the built-in ToolOperations layer and ToolRuntime lifecycle events. By default it also uses the default ToolPolicy, so mutation tools and bash require approval:

```bash
npm run dev:core -- --call-tool write --tool-cwd /private/tmp --approve-tool-call --tool-args '{"path":"agent-core-cli-tool-test.txt","content":"hello\n"}'
npm run dev:core -- --call-tool bash --approve-tool-call --tool-args '{"command":"pwd"}'
```

Use `--tool-cwd <path>` to choose the ToolOperations root. When omitted, the CLI uses the directory where `npm run dev:core` was invoked.

Print registered tool metadata without running the model:

```bash
npm run dev:core -- --example-tools --print-tools
```

Limit the printed metadata to selected tools:

```bash
npm run dev:core -- --example-tools --tools inspect_runtime,read_note --print-tools
```

## Resources

Enable host-registered resources by comma-separated name. For local prompt assembly testing, the CLI can register example resources:

```bash
npm run dev:core -- --example-resources --resources runtime_notes,prompt_rules --print-system-prompt
```

The CLI does not register resources by default. `--example-resources` registers CLI-only static prompt resources and does not affect the core default resource registry.

Print registered resource metadata without running the model:

```bash
npm run dev:core -- --example-resources --print-resources
```

Limit the printed metadata to selected resources:

```bash
npm run dev:core -- --example-resources --resources runtime_notes --print-resources
```

## System Prompt

Print the assembled system prompt without running the model:

```bash
npm run dev:core -- --example-tools --tools inspect_runtime,read_note,list_capabilities --print-system-prompt
```

Use this to inspect how `ToolCatalog` metadata is rendered into `Available tools` and `Guidelines`, and how `ResourceCatalog` prompt fragments enter the static system prompt.

## Stdin

If no prompt argument is provided, the CLI reads from stdin:

```bash
echo "从 stdin 输入" | npm run dev:core -- --faux
```
