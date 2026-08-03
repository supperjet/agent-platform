import type { AgentRuntimeCommand } from "../contracts.js";
import type { LifecycleRunner } from "../lifecycle/lifecycle-runner.js";
import {
  renderPromptTemplate,
  type PromptTemplateRegistry,
  type RenderedPromptTemplate,
} from "./prompt-template.js";

/**
 * InputProcessor 的处理输入。
 *
 * 这一层处理的是“外部 runtime command 进入 prompt 流程后的第一道门”。
 * 它不读取 conversation，不装配 context，也不调用模型；这些职责分别属于
 * ConversationStore / ContextAssembler / AgentLoopAdapter。
 */
export type InputProcessorInput = {
  command: AgentRuntimeCommand;
};

export type InputMetadata = Record<string, unknown> & {
  slashCommand?: string;
  inputMode?: string;
  selectedTemplate?: string;
  promptTemplate?: RenderedPromptTemplate;
  args?: Record<string, unknown>;
};

/**
 * InputProcessor 输出。
 *
 * - `ready`：输入应该继续进入 TurnRunner 后续流程。
 * - `handled`：输入已经被 lifecycle 或后续本地能力处理完，不进入 agent loop。
 */
export type ProcessedInput =
  | { status: "ready"; command: AgentRuntimeCommand; metadata?: InputMetadata }
  | { status: "handled" };

export type InputProcessorOptions = {
  /** 生命周期执行器；第一版只接入 onInput，后续 prompt template/skill 展开也会挂在这里。 */
  lifecycleRunner?: LifecycleRunner;
  /** 可选 prompt template registry；提供后 `/template <name> key=value` 会渲染模板。 */
  promptTemplateRegistry?: PromptTemplateRegistry;
};

/**
 * 把外部 AgentRuntimeCommand 处理成 TurnRunner 可以继续编排的输入。
 *
 * 执行流程：
 *
 * ```text
 * AgentRuntimeSession.execute(command)
 *   -> TurnRunner.run(command)
 *   -> InputProcessor.process(command)
 *      -> LifecycleRunner.onInput(command)
 *         -> continue: 保持 command 不变
 *         -> transform: 使用改写后的 command
 *         -> handled: 短路，不进入模型
 *   -> TurnRunner 根据 ProcessedInput 决定下一步
 * ```
 *
 * 当前版本做两件事：
 * - 执行 lifecycle onInput 归一化，并浅合并 hook metadata。
 * - 解析 prompt slash command 的第一批 core-level metadata。
 *
 * 后续 prompt template expansion、skill command expansion 和更完整的 input
 * metadata normalize 都应该继续落在这里，而不是塞回 TurnRunner。
 */
export class InputProcessor {
  constructor(private readonly options: InputProcessorOptions = {}) {}

  async process(input: InputProcessorInput): Promise<ProcessedInput> {
    const inputResult = await this.options.lifecycleRunner?.onInput({
      command: input.command,
    });

    if (inputResult?.action === "handled") {
      return { status: "handled" };
    }

    if (inputResult?.action === "transform") {
      const metadata = mergeInputMetadata(
        parseInputMetadata(inputResult.command),
        inputResult.metadata,
      );
      const templateMetadata = this.renderTemplateMetadata(inputResult.command, metadata);
      return {
        status: "ready",
        command: inputResult.command,
        ...(templateMetadata ? { metadata: templateMetadata } : {}),
      };
    }

    const metadata = mergeInputMetadata(
      parseInputMetadata(input.command),
      inputResult?.metadata,
    );
    const templateMetadata = this.renderTemplateMetadata(input.command, metadata);

    return {
      status: "ready",
      command: input.command,
      ...(templateMetadata ? { metadata: templateMetadata } : {}),
    };
  }

  private renderTemplateMetadata(
    command: AgentRuntimeCommand,
    metadata: InputMetadata | undefined,
  ): InputMetadata | undefined {
    if (!metadata || command.type !== "prompt") return metadata;
    if (metadata.slashCommand !== "template") return metadata;
    const registry = this.options.promptTemplateRegistry;
    if (!registry) return metadata;
    const rawArgs = readRawArgs(metadata);
    if (!rawArgs) return metadata;
    const invocation = parseTemplateInvocation(rawArgs);
    if (!invocation) return metadata;
    const template = registry.getDefinition(invocation.name);
    if (!template) {
      throw new Error(`Prompt template not found: ${invocation.name}`);
    }
    const rendered = renderPromptTemplate({
      template,
      variables: invocation.variables,
    });
    return mergeInputMetadata(metadata, {
      inputMode: "template",
      selectedTemplate: rendered.name,
      promptTemplate: rendered,
      args: {
        ...metadata.args,
        templateName: rendered.name,
        variables: rendered.variables,
      },
    });
  }
}

function parseInputMetadata(command: AgentRuntimeCommand): InputMetadata | undefined {
  if (command.type !== "prompt") return undefined;

  const match = command.text.match(/^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;

  const slashCommand = match[1];
  if (!slashCommand) return undefined;

  const rawArgs = match[2]?.trim() ?? "";
  return {
    slashCommand,
    ...(rawArgs ? { args: { raw: rawArgs } } : {}),
  };
}

function mergeInputMetadata(
  first: InputMetadata | undefined,
  second: Record<string, unknown> | undefined,
): InputMetadata | undefined {
  if (!first && !second) return undefined;
  return {
    ...first,
    ...second,
  };
}

function readRawArgs(metadata: InputMetadata): string | undefined {
  const raw = metadata.args?.raw;
  return typeof raw === "string" ? raw : undefined;
}

function parseTemplateInvocation(rawArgs: string): {
  name: string;
  variables: Record<string, string>;
} | undefined {
  const tokens = tokenizeTemplateArgs(rawArgs);
  const name = tokens.shift();
  if (!name) return undefined;
  const variables: Record<string, string> = {};
  for (const token of tokens) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error(`Prompt template variable must use key=value syntax: ${token}`);
    }
    const key = token.slice(0, separatorIndex).trim();
    const value = token.slice(separatorIndex + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new Error(`Prompt template variable name is invalid: ${key}`);
    }
    variables[key] = value;
  }
  return { name, variables };
}

function tokenizeTemplateArgs(rawArgs: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;

  for (let index = 0; index < rawArgs.length; index++) {
    const char = rawArgs[index];
    if (char === undefined) continue;
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new Error("Prompt template arguments contain an unterminated quote.");
  }
  if (current) tokens.push(current);
  return tokens;
}
