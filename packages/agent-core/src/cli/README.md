# Agent Core CLI

Development-only playground entry for testing `agent-core` without starting server or client.

## Start

Start the local agent playground:

```bash
npm run dev:core
```

Use the faux provider for local shell testing without an API key:

```bash
npm run dev:core -- --faux
```

Real provider mode uses DeepSeek and reads the nearest `.env` from the current working directory or its parent directories:

```dotenv
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL_ID=deepseek-v4-flash
```

Optional startup flags:

```bash
npm run dev:core -- --model deepseek-v4-flash
npm run dev:core -- --request-timeout-ms 600000
npm run dev:core -- --tools read,ls,grep
npm run dev:core -- --resources runtime_notes,prompt_rules
npm run dev:core -- --playground-state-file /tmp/agent-state.json
npm run dev:core -- --playground-compaction-summarizer llm
```

## Application Boundary

The CLI uses the same application agent directory convention planned for later `agent-core` consumers:

```text
src/cli/agent/
  index.ts
  main.ts
  resources/
    instructions/
    memory/
    references/
    prompt-templates/
  skills/
  tools/
```

`agent/index.ts` is the application entry point. It loads the model, registers resources, registers tools, and passes those assembled dependencies into `startAgentPlayground`.

`agent/main.ts` owns the playground runtime loop. Its `AgentPlaygroundOptions` accepts already-assembled runtime dependencies and startup settings; it does not discover resources, load models, or register tools.

`resources/` and `skills/` contain text resources for testing the application layout. `tools/` contains executable tool definitions and stays outside the ResourceLoader boundary.

## Playground Commands

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

Slash-prefixed lines that are not playground commands, such as `/review target`, are sent to the runtime as prompts so `InputProcessor` slash metadata can be tested interactively.

## Conversation State

The playground stores local conversation state as a JSON snapshot. By default, it reads and writes:

```text
<cwd>/.agent-platform/playground/sessions/agent-core-playground/state.json
```

Use `/storage` to print the exact path, `/save` to force a save, and `/delete` to remove the saved state. The smoke test verifies that this saved state uses the entry graph payload and can be restored through `ConversationStore`:

```bash
npm run smoke:conversation
```
