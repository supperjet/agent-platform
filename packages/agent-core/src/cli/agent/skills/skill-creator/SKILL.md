---
name: skill-creator
description: Create or update agent skill packages under agent/skills. Use when the user asks to add a new skill, improve an existing skill, design SKILL.md instructions, choose whether content belongs in skills versus resources or tools, or validate skill package structure.
---

# Skill Creator

Create skills as small, auditable capability packages. A skill describes how the
agent should work on a repeatable class of tasks; it is not static background
knowledge and it is not executable tool behavior.

## Workflow

1. Clarify the skill's job only when the request does not already identify a
   clear task pattern, trigger, or target location.
2. Pick a stable lowercase hyphenated name. Prefer short verb-led names such as
   `review-code`, `write-skill`, or `triage-issue`.
3. Create a directory at `agent/skills/<skill-name>/` for application agents, or
   the equivalent `skills/<skill-name>/` folder under the current agent root.
4. Write `SKILL.md` with frontmatter containing `name` and `description`, then a
   concise instruction body.
5. Add support files only when they materially reduce repeated work:
   `references/` for optional context, `templates/` for reusable text, and
   `scripts/` only as inert support files unless a later trusted tool path
   explicitly executes them.
6. Validate by running the relevant loader tests or the full project check.

## SKILL.md Rules

Use this shape:

```md
---
name: skill-name
description: Do the task and name concrete situations that should trigger it.
---

# Skill Title

Follow imperative, task-focused instructions.
```

Keep the description specific because it is the selection surface. Put when to
use the skill in the description, not in a body section that may only load after
selection.

Keep the body short. Include only procedure, decision rules, and references to
support files. Do not add README, changelog, install guide, or process notes.

## Boundary Rules

- Put always-on static text in `resources/`, not in `skills/`.
- Put repeatable procedures and decision rules in `skills/`.
- Put executable behavior in `tools/`; skill scripts are support artifacts until
  a trusted tool or runtime explicitly runs them.
- Do not inject a skill into the base system prompt. Activation should create
  transient context for the current turn.

## Support Files

Use `references/` for detailed docs that should be loaded only when needed.
Mention each reference from `SKILL.md` and say when to read it.

Use `templates/` for reusable prompt or output text. Keep variables obvious and
document expected inputs near the template reference.

Use `scripts/` only when deterministic helper code is useful. Do not rely on a
script being executable unless the current runtime has an explicit trusted tool
path for running it.

## Validation

After editing, run the narrowest useful test first. For this repository, prefer:

```bash
npm test --workspace packages/agent-core -- skill-loader
```

Run `npm run check` before considering the implementation complete.
