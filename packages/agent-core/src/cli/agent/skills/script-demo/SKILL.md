---
name: script-demo
description: Test SkillSupportRuntime script execution from the CLI agent. Demonstrates sandbox environments, argument passing, and structured output via virtual and local sandbox examples.
disable_model_invocation: false
---

# Script Demo

Use this skill only to verify `/skill run` behavior in the CLI agent.

Scripts are grouped by the skill-script capability they demonstrate.

## 1. Environment (sandbox & env vars)

- `hello.sh`: `VirtualSandbox`, bash. Simplest script; echoes the arguments passed
  via `$SKILL_ARGS_JSON`.
- `local-info.sh`: `LocalProcessSandbox`, bash, declared via frontmatter `sandbox: local`.
  Prints the real local working directory and arguments.
- `local-env.js`: `LocalProcessSandbox`, node. Shows which process env vars leak into
  the sandbox (only allowed vars, no runtime secrets).

## 2. Argument passing

- `args-json.js`: reads the positional args array from `$SKILL_ARGS_JSON` and reports
  the count.
- `named-args.js`: demonstrates the full argument envelope:
  `$SKILL_ARGS` (string), `$SKILL_ARGS_JSON` (array), `$SKILL_NAMED_ARGS_JSON` (key=value),
  and `$SKILL_INPUT_JSON` (`{ args, namedArgs }`).
- `stdin-input.js`: reads raw input lines from stdin (not from argv) and splits them.

## 3. Result output

- `structured-result.js`: shows the structured output protocol (`SKILL_RESULT_JSON:`
  prefix on the last stdout line). First arg selects the mode:
  - `ok` -> `status:"ok"` + `result` (default)
  - `logs` -> `status:"ok"` + `logs` array
  - `err` -> `status:"error"` + `errorCode` + `message`, exit code 2
  - `plain` -> no prefix; JSON goes to `<stdout>` only
  - `silent` -> stdout intentionally empty; `structuredOutput` stays undefined and
    `exec.stdout` is empty (diagnostics go to stderr)
