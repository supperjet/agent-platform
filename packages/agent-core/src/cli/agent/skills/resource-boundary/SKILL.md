---
name: resource-boundary
description: Keep ResourceLoader, ResourceCatalog, and ToolCatalog responsibilities separate.
---

# Resource Boundary

Use this skill when validating whether a new agent capability belongs in
resources, skills, or tools.

- Text context belongs in `agent/resources/`.
- Repeatable task procedure belongs in `agent/skills/`.
- Executable behavior belongs in `agent/tools/`.
