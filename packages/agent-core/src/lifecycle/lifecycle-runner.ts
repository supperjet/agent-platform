import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentRuntimeCommand,
} from "../contracts.js";
import type {
  AfterMessageHookInput,
  AfterMessageHookResult,
  AfterRunHookInput,
  AfterToolCallHookInput,
  AfterToolCallHookResult,
  BeforeCompactionHookInput,
  BeforeCompactionHookResult,
  BeforeContextHookInput,
  BeforeContextHookResult,
  BeforeRunHookInput,
  BeforeRunHookResult,
  BeforeToolCallHookInput,
  BeforeToolCallHookResult,
  InputHookInput,
  InputHookResult,
  LifecycleHooks,
} from "./lifecycle-hooks.js";

export type LifecycleRunner = {
  onInput(input: InputHookInput): Promise<InputHookResult>;
  beforeRun(input: BeforeRunHookInput): Promise<BeforeRunHookResult>;
  beforeContext(input: BeforeContextHookInput): Promise<BeforeContextHookResult>;
  beforeToolCall(input: BeforeToolCallHookInput): Promise<BeforeToolCallRunnerResult>;
  afterToolCall(input: AfterToolCallHookInput): Promise<AfterToolCallHookResult>;
  afterMessage(input: AfterMessageHookInput): Promise<AfterMessageHookResult>;
  beforeCompaction(input: BeforeCompactionHookInput): Promise<BeforeCompactionHookResult>;
  afterRun(input: AfterRunHookInput): Promise<void>;
};

export type BeforeToolCallRunnerResult =
  | { status: "allowed"; args: unknown }
  | { status: "blocked"; reason: string };

export function createLifecycleRunner(hooks: LifecycleHooks = {}): LifecycleRunner {
  return {
    async onInput(input: InputHookInput): Promise<InputHookResult> {
      let currentCommand: AgentRuntimeCommand = input.command;
      let transformed = false;

      for (const hook of hooks.onInput ?? []) {
        const result = await hook({ command: currentCommand });
        if (!result || result.action === "continue") continue;
        if (result.action === "handled") return result;
        currentCommand = result.command;
        transformed = true;
      }

      return transformed
        ? { action: "transform", command: currentCommand }
        : { action: "continue" };
    },

    async beforeRun(input: BeforeRunHookInput): Promise<BeforeRunHookResult> {
      let currentSystemPrompt = input.systemPrompt;
      let currentMetadata = input.metadata;
      const messages: AgentMessage[] = [];
      let modified = false;

      for (const hook of hooks.beforeRun ?? []) {
        const result = await hook({
          ...input,
          systemPrompt: currentSystemPrompt,
          ...(currentMetadata ? { metadata: currentMetadata } : {}),
        });
        if (!result) continue;
        if (result.systemPrompt !== undefined) {
          currentSystemPrompt = result.systemPrompt;
          modified = true;
        }
        if (result.messages?.length) {
          messages.push(...result.messages);
          modified = true;
        }
        if (result.metadata) {
          currentMetadata = result.metadata;
          modified = true;
        }
      }

      return modified
        ? {
            ...(messages.length ? { messages } : {}),
            ...(currentSystemPrompt !== input.systemPrompt ? { systemPrompt: currentSystemPrompt } : {}),
            ...(currentMetadata ? { metadata: currentMetadata } : {}),
          }
        : undefined;
    },

    async beforeContext(input: BeforeContextHookInput): Promise<BeforeContextHookResult> {
      let currentSystemPrompt = input.systemPrompt;
      let currentMessages: readonly AgentMessage[] = input.messages;
      let currentMetadata = input.metadata;
      let modified = false;

      for (const hook of hooks.beforeContext ?? []) {
        const result = await hook({
          systemPrompt: currentSystemPrompt,
          messages: currentMessages,
          ...(currentMetadata ? { metadata: currentMetadata } : {}),
        });
        if (!result) continue;
        if (result.systemPrompt !== undefined) {
          currentSystemPrompt = result.systemPrompt;
          modified = true;
        }
        if (result.messages !== undefined) {
          currentMessages = result.messages;
          modified = true;
        }
        if (result.metadata) {
          currentMetadata = result.metadata;
          modified = true;
        }
      }

      return modified
        ? {
            ...(currentSystemPrompt !== input.systemPrompt ? { systemPrompt: currentSystemPrompt } : {}),
            ...(currentMessages !== input.messages ? { messages: currentMessages } : {}),
            ...(currentMetadata ? { metadata: currentMetadata } : {}),
          }
        : undefined;
    },

    async beforeToolCall(input: BeforeToolCallHookInput): Promise<BeforeToolCallRunnerResult> {
      let currentArgs = input.args;

      for (const hook of hooks.beforeToolCall ?? []) {
        const result = normalizeBeforeToolCallResult(
          await hook({
            ...input,
            args: currentArgs,
          }),
        );
        if (!result.allow) {
          return {
            status: "blocked",
            reason: result.reason ?? "Tool call blocked.",
          };
        }
        if (result.hasArgs) {
          currentArgs = result.args;
        }
      }

      return { status: "allowed", args: currentArgs };
    },

    async afterToolCall(input: AfterToolCallHookInput): Promise<AfterToolCallHookResult> {
      let currentStatus = input.status;
      let currentResult = input.result;
      let currentError = input.error;
      let modified = false;

      for (const hook of hooks.afterToolCall ?? []) {
        const result = await hook({
          ...input,
          status: currentStatus,
          ...(currentResult ? { result: currentResult } : {}),
          ...(currentError ? { error: currentError } : {}),
        });
        if (!result) continue;
        if (result.status !== undefined) {
          currentStatus = result.status;
          modified = true;
        }
        if (result.result !== undefined) {
          currentResult = result.result;
          modified = true;
        }
        if (result.error !== undefined) {
          currentError = result.error;
          modified = true;
        }
      }

      return modified
        ? {
            status: currentStatus,
            ...(currentResult ? { result: currentResult } : {}),
            ...(currentError ? { error: currentError } : {}),
          }
        : undefined;
    },

    async afterMessage(input: AfterMessageHookInput): Promise<AfterMessageHookResult> {
      let currentMessage = input.message;
      let currentMetadata = input.metadata;
      let modified = false;

      for (const hook of hooks.afterMessage ?? []) {
        const result = await hook({
          message: currentMessage,
          ...(currentMetadata ? { metadata: currentMetadata } : {}),
        });
        if (!result) continue;
        if (result.message) {
          currentMessage = result.message;
          modified = true;
        }
        if (result.metadata) {
          currentMetadata = result.metadata;
          modified = true;
        }
      }

      return modified
        ? {
            ...(currentMessage !== input.message ? { message: currentMessage } : {}),
            ...(currentMetadata ? { metadata: currentMetadata } : {}),
          }
        : undefined;
    },

    async beforeCompaction(input: BeforeCompactionHookInput): Promise<BeforeCompactionHookResult> {
      let currentInstructions: string | undefined;
      let currentMetadata = input.metadata;

      for (const hook of hooks.beforeCompaction ?? []) {
        const result = await hook({
          ...input,
          ...(currentMetadata ? { metadata: currentMetadata } : {}),
        });
        if (!result) continue;
        if (result.cancel) return result;
        if (result.instructions !== undefined) {
          currentInstructions = result.instructions;
        }
        if (result.metadata) {
          currentMetadata = result.metadata;
        }
      }

      return currentInstructions !== undefined || currentMetadata
        ? {
            ...(currentInstructions !== undefined ? { instructions: currentInstructions } : {}),
            ...(currentMetadata ? { metadata: currentMetadata } : {}),
          }
        : undefined;
    },

    async afterRun(input: AfterRunHookInput): Promise<void> {
      for (const hook of hooks.afterRun ?? []) {
        await hook(input);
      }
    },
  };
}

function normalizeBeforeToolCallResult(result: BeforeToolCallHookResult): {
  allow: boolean;
  hasArgs: boolean;
  args?: unknown;
  reason?: string;
} {
  if (result === undefined) return { allow: true, hasArgs: false };
  if (typeof result === "boolean") return { allow: result, hasArgs: false };
  return {
    allow: result.allow ?? true,
    hasArgs: Object.hasOwn(result, "args"),
    ...(Object.hasOwn(result, "args") ? { args: result.args } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}
