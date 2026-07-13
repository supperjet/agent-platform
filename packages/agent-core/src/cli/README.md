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

## Conversation State

Print the exported `AgentConversationState` after a run:

```bash
npm run dev:core -- --faux --json --print-state "测试 conversation graph"
```

The final JSON line should use the entry graph payload:

```json
{
  "schemaVersion": 1,
  "modelId": "...",
  "payload": {
    "entries": [],
    "leafId": null
  }
}
```

For a non-empty run, `payload.entries` contains message entries and `payload.leafId` points to the active leaf entry. New exports should not use the legacy `payload.messages` format, though restore remains backward-compatible with old saved sessions.

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

The CLI does not register built-in tools by default. `--example-tools` registers CLI-only test tools and does not affect the core default tool registry.

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
