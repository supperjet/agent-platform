# Agent Core CLI

Development-only playground entry for testing `agent-core` without starting server or client.

## Start

Start the local agent playground:

```bash
npm run dev:core
```

The current CLI application entry is intentionally small: it always uses the default DeepSeek model and reads the API key from the project root `.env` or the process environment:

```dotenv
DEEPSEEK_API_KEY=...
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

`agent/index.ts` is the application entry point. It loads the default DeepSeek model, creates a `ResourceLoader` and a `ToolsLoader` for the agent directory, and passes the generated registries into `startAgentPlayground`.

`agent/main.ts` owns the playground runtime loop. Its `AgentPlaygroundOptions` accepts already-assembled runtime dependencies and the optional `conversationFile`; it does not discover resources, load models, or register tools.

`resources/` and `skills/` contain text resources for testing the application layout. `tools/` contains executable tool definitions exported from `tools/index.ts`.

Loader and registry responsibilities are separate:

- `ResourceLoader({ agentDir }).createRegistry()` discovers text resources and creates the resource registry.
- `ToolsLoader({ agentDir }).createRegistry()` registers core built-in tools, imports `tools/index.js`, and creates the tool registry.
- `startAgentPlayground` receives registries only; it does not expose loader parameters.

## Playground Commands

Inside the playground, ordinary input is sent as a prompt to the current runtime session. Slash commands control runtime configuration:

```text
/tools                 Show enabled tools.
/tools all             Enable all tools registered by the application entry.
/tools none            Disable all tools.
/tools inspect_runtime Enable selected registered tools.
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
/storage               Print the local conversation file path.
/context               Print the last assembled prompt context and budget diagnostics.
/snapshot              Print runtime snapshot.
/system                Print current assembled system prompt.
/reset                 Reset conversation session.
/exit                  Quit.
```

Slash-prefixed lines that are not playground commands, such as `/review target`, are sent to the runtime as prompts so `InputProcessor` slash metadata can be tested interactively.

## Conversation State

The playground stores local conversation state as a JSON snapshot. `AgentPlaygroundOptions.conversationFile` can override the location. By default, it reads and writes:

```text
<cwd>/.agent-platform/playground/sessions/agent-core-playground/state.json
```

Use `/storage` to print the exact path, `/save` to force a save, and `/delete` to remove the saved conversation file. The smoke test verifies that this saved state uses the entry graph payload and can be restored through `ConversationStore`:

```bash
npm run smoke:conversation
```
