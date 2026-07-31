# Resources

Owns discovery and loading for serializable text resources such as instructions,
memory files, skills, prompt templates, references, system prompt text, and
diagnostics.

Resource selection for a specific turn belongs to `context/`.

`ResourceLoader` must not discover or register executable tools. Tools contain
runtime closures, permission semantics, and sandbox concerns; they belong to
`tools/` through `ToolRegistry`, `ToolCatalog`, and `ToolRuntime`.

The application directory convention is:

```text
agent/
  index.ts
  resources/
    instructions/
    memory/
    references/
    prompt-templates/
  skills/
  tools/
```

`agent/resources/` and `agent/skills/` are readable text inputs. `agent/tools/`
is executable code and stays outside the resource layer.
