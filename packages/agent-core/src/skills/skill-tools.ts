import { Type } from "@earendil-works/pi-ai";
import type { TurnContext } from "../context/context-assembler.js";
import { defineAgentTool, type AnyAgentToolDefinition } from "../tools/tool-registry.js";
import {
  createSkillSupportRuntime,
  type SkillScriptRunResult,
  type SkillSupportReadResult,
  type SkillSupportRenderResult,
  type SkillSupportRuntimeOptions,
} from "./skill-support-runtime.js";
import type { SkillActivation } from "./skill-loader.js";

export const SKILL_READ_SUPPORT_FILE_TOOL_NAME = "skill_read_support_file";
export const SKILL_RENDER_TEMPLATE_TOOL_NAME = "skill_render_template";
export const SKILL_RUN_SCRIPT_TOOL_NAME = "skill_run_script";
export const SKILL_TOOL_NAMES = [
  SKILL_READ_SUPPORT_FILE_TOOL_NAME,
  SKILL_RENDER_TEMPLATE_TOOL_NAME,
  SKILL_RUN_SCRIPT_TOOL_NAME,
] as const;

export type ActiveSkillTracker = {
  setActiveSkills(skillNames: readonly string[]): void;
  clear(): void;
  isSkillActive(skillName: string): boolean;
  getActiveSkillNames(): readonly string[];
};

export type SkillToolDefinitionOptions = SkillSupportRuntimeOptions & {
  activeSkills?: Pick<ActiveSkillTracker, "isSkillActive" | "getActiveSkillNames">;
};

const readSupportFileParameters = Type.Object({
  skillName: Type.String({ description: "Name of the currently active skill." }),
  fileName: Type.String({ description: "Reference or template support file label to read." }),
});

const renderTemplateParameters = Type.Object({
  skillName: Type.String({ description: "Name of the currently active skill." }),
  templateName: Type.String({ description: "Template support file label or template name to render." }),
  variables: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: "Template variables keyed by variable name.",
  })),
});

const runScriptParameters = Type.Object({
  skillName: Type.String({ description: "Name of the currently active skill." }),
  scriptName: Type.String({ description: "Script support file label or script name to run." }),
  args: Type.Optional(Type.Array(Type.String(), {
    description: "Positional script arguments. Prefer namedArgs when the script manifest declares arg contracts.",
  })),
  namedArgs: Type.Optional(Type.Record(Type.String(), Type.String(), {
    description: "Structured script arguments keyed by arg name. Values are coerced and validated against the active script arg contract.",
  })),
});

export function createActiveSkillTracker(): ActiveSkillTracker {
  let activeSkillNames: readonly string[] = [];
  return {
    setActiveSkills(skillNames) {
      activeSkillNames = [...skillNames];
    },
    clear() {
      activeSkillNames = [];
    },
    isSkillActive(skillName) {
      return activeSkillNames.includes(skillName);
    },
    getActiveSkillNames() {
      return activeSkillNames;
    },
  };
}

export function createSkillToolDefinitions(
  options: SkillToolDefinitionOptions,
): readonly AnyAgentToolDefinition[] {
  const runtime = createSkillSupportRuntime(options);
  return [
    defineAgentTool({
      name: SKILL_READ_SUPPORT_FILE_TOOL_NAME,
      label: "Read Skill Support File",
      description: "Read a trusted support file from the currently active skill.",
      promptSnippet: "Read trusted reference or template files from the currently active skill.",
      promptGuidelines: [
        "Use skill_read_support_file only for files listed in the active skill's available_support_files manifest with read=\"yes\".",
        "Do not call this tool for inactive skills or scripts.",
      ],
      sourceInfo: { source: "builtin", label: "skill runtime" },
      parameters: readSupportFileParameters,
      async execute(_toolCallId, params) {
        assertActiveSkill(options.activeSkills, params.skillName);
        return formatReadResult(await runtime.read({
          skillName: params.skillName,
          fileName: params.fileName,
        }));
      },
    }),
    defineAgentTool({
      name: SKILL_RENDER_TEMPLATE_TOOL_NAME,
      label: "Render Skill Template",
      description: "Render a trusted template from the currently active skill.",
      promptSnippet: "Render templates from the currently active skill with explicit variables.",
      promptGuidelines: [
        "Use skill_render_template when the active skill manifest lists a template contract that should be instantiated.",
        "Pass every required template variable explicitly.",
      ],
      sourceInfo: { source: "builtin", label: "skill runtime" },
      parameters: renderTemplateParameters,
      async execute(_toolCallId, params) {
        assertActiveSkill(options.activeSkills, params.skillName);
        return formatRenderResult(await runtime.renderTemplate({
          skillName: params.skillName,
          templateName: params.templateName,
          ...(params.variables ? { variables: params.variables } : {}),
        }));
      },
    }),
    defineAgentTool({
      name: SKILL_RUN_SCRIPT_TOOL_NAME,
      label: "Run Skill Script",
      description: "Run an executable script from the currently active skill through the skill sandbox runtime.",
      promptSnippet: "Run skill scripts when the manifest lists a script with execute=\"yes\" and deterministic execution would help.",
      promptGuidelines: [
        "Use skill_run_script only for scripts listed in the active skill's available_support_files manifest with execute=\"yes\".",
        "Prefer read/render before script execution when static support files are enough.",
      ],
      sourceInfo: { source: "builtin", label: "skill runtime" },
      parameters: runScriptParameters,
      async execute(_toolCallId, params, signal) {
        assertActiveSkill(options.activeSkills, params.skillName);
        return formatRunResult(await runtime.runScript({
          skillName: params.skillName,
          scriptName: params.scriptName,
          ...(params.args ? { args: params.args } : {}),
          ...(params.namedArgs ? { namedArgs: params.namedArgs } : {}),
          ...(signal ? { signal } : {}),
        }));
      },
    }),
  ];
}

export function isSkillToolName(name: string): boolean {
  return (SKILL_TOOL_NAMES as readonly string[]).includes(name);
}

export function resolveSkillToolNamesForTurn(input: {
  context: TurnContext;
  baseToolNames: readonly string[];
}): readonly string[] {
  const baseToolNames = input.baseToolNames.filter((name) => !isSkillToolName(name));
  const activation = readSkillActivation(input.context.metadata.turn);
  if (!activation) return baseToolNames;
  const supportFiles = activation.supportFiles ?? [];
  const skillToolNames: string[] = [];
  if (supportFiles.some((file) => file.trustPolicy.canRead)) {
    skillToolNames.push(SKILL_READ_SUPPORT_FILE_TOOL_NAME);
  }
  if (supportFiles.some((file) => file.kind === "template" && file.trustPolicy.canRead)) {
    skillToolNames.push(SKILL_RENDER_TEMPLATE_TOOL_NAME);
  }
  if (supportFiles.some((file) => file.kind === "script" && file.trustPolicy.canExecute)) {
    skillToolNames.push(SKILL_RUN_SCRIPT_TOOL_NAME);
  }
  return [...baseToolNames, ...skillToolNames];
}

function readSkillActivation(
  metadata: Record<string, unknown> | undefined,
): SkillActivation | undefined {
  const value = metadata?.skillActivation;
  if (!value || typeof value !== "object") return undefined;
  const activation = value as Partial<SkillActivation>;
  if (typeof activation.name !== "string") return undefined;
  if (activation.supportFiles !== undefined && !Array.isArray(activation.supportFiles)) return undefined;
  return activation as SkillActivation;
}

function assertActiveSkill(
  activeSkills: SkillToolDefinitionOptions["activeSkills"],
  skillName: string,
) {
  if (!activeSkills) return;
  if (activeSkills.isSkillActive(skillName)) return;
  const activeSkillNames = activeSkills.getActiveSkillNames();
  throw new Error([
    `Skill is not active: ${skillName}.`,
    activeSkillNames.length
      ? `Active skills: ${activeSkillNames.join(", ")}.`
      : "No skill is active for the current turn.",
  ].join(" "));
}

function formatReadResult(result: SkillSupportReadResult) {
  if (result.status !== "completed") {
    throw new Error(result.message);
  }
  return {
    content: [{ type: "text" as const, text: result.file.content }],
    details: {
      skillName: result.skillName,
      fileName: result.fileName,
      sourceLabel: result.file.file.sourceInfo.label,
      kind: result.file.file.kind,
    },
  };
}

function formatRenderResult(result: SkillSupportRenderResult) {
  if (result.status !== "completed") {
    throw new Error(result.message);
  }
  return {
    content: [{ type: "text" as const, text: result.template.content }],
    details: {
      skillName: result.skillName,
      templateName: result.templateName,
      sourceLabel: result.template.sourceInfo.label,
      variables: result.template.variables,
    },
  };
}

function formatRunResult(result: SkillScriptRunResult) {
  if (result.status !== "completed") {
    throw new Error(result.message);
  }
  const sections = [
    `exit_code: ${result.exec.exitCode ?? "null"}`,
    `outcome: ${result.outcome}`,
    `timed_out: ${result.exec.timedOut ? "yes" : "no"}`,
    `truncated: ${result.exec.truncated ? "yes" : "no"}`,
    result.structuredOutput?.result !== undefined
      ? `<result_json>\n${JSON.stringify(result.structuredOutput.result)}\n</result_json>`
      : "",
    result.structuredOutput?.logs?.length
      ? `<logs>\n${result.structuredOutput.logs.join("\n")}\n</logs>`
      : "",
    result.exec.stdout ? `<stdout>\n${result.exec.stdout}\n</stdout>` : "",
    result.exec.stderr ? `<stderr>\n${result.exec.stderr}\n</stderr>` : "",
  ].filter(Boolean);
  return {
    content: [{ type: "text" as const, text: sections.join("\n") }],
    details: {
      skillName: result.skillName,
      scriptName: result.scriptName,
      sandboxKind: result.sandboxKind,
      exitCode: result.exec.exitCode,
      outcome: result.outcome,
      structuredOutput: result.structuredOutput,
      durationMs: result.exec.durationMs,
      timedOut: result.exec.timedOut,
      truncated: result.exec.truncated,
    },
  };
}
