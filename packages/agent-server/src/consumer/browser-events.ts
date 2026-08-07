import type { AgentNotification } from "../messaging/events.js";

export type BrowserAgentEvent =
  | { type: "run_started"; sessionId: string }
  | { type: "run_aborted"; sessionId: string }
  | { type: "run_failed"; sessionId: string; errorCode: "AGENT_RUN_FAILED"; message: string }
  | { type: "message_started"; sessionId: string; messageId: string; role: "user" | "assistant"; text: string; messageScope?: "persistent" | "transient" | "unknown" }
  | { type: "assistant_delta"; sessionId: string; messageId: string; delta: string }
  | { type: "message_finished"; sessionId: string; messageId: string; role: "user" | "assistant"; text: string; messageScope?: "persistent" | "transient" | "unknown" }
  | { type: "tool_policy_checked"; sessionId: string; toolCallId: string; toolName: string; decision: string; reason?: string }
  | { type: "tool_approval_requested"; sessionId: string; toolCallId: string; toolName: string; title: string; message: string; risk?: "low" | "medium" | "high"; reason: string }
  | { type: "tool_approval_approved"; sessionId: string; toolCallId: string; toolName: string }
  | { type: "tool_approval_denied"; sessionId: string; toolCallId: string; toolName: string; reason: string }
  | { type: "tool_started"; sessionId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_progress"; sessionId: string; toolCallId: string; text: string }
  | { type: "tool_finished"; sessionId: string; toolCallId: string; isError: boolean; text: string; sourceIds: string[] }
  | { type: "skill_activation_decided"; sessionId: string; skillName: string; sourceLabel: string; sourceScope: "global" | "project" | "workspace" | "explicit"; decision: "activated" | "rejected"; selectionReason: "explicit_command" | "automatic"; reason: string; disableModelInvocation: boolean; diagnosticCount: number }
  | { type: "skill_policy_checked"; sessionId: string; skillName: string; policy: { kind: "reference" | "template" | "script"; label: string; sourceLabel: string; sourceScope: "global" | "project" | "workspace" | "explicit"; canRead: boolean; canInject: boolean; canExecute: boolean; reason: string } }
  | { type: "skill_composition_decided"; sessionId: string; requestedSkillNames: string[]; knownSkillNames: string[]; unknownSkillNames: string[]; decision: "rejected"; selectionReason: "explicit_command" | "automatic"; reason: string }
  | { type: "skill_script_policy_checked"; sessionId: string; skillName: string; scriptName: string; sourceLabel: string; sourceScope: "global" | "project" | "workspace" | "explicit"; sandboxKind: "virtual" | "local"; canExecute: boolean; reason: string }
  | { type: "skill_script_started"; sessionId: string; skillName: string; scriptName: string; sourceLabel: string; sandboxKind: "virtual" | "local"; cwd: string; timeoutMs: number }
  | { type: "skill_script_completed"; sessionId: string; skillName: string; scriptName: string; sandboxKind: "virtual" | "local"; exitCode: number | null; outcome: "succeeded" | "invalid_arguments" | "failed" | "timed_out"; durationMs: number; timedOut: boolean; truncated: boolean; stdoutPreview: string; stderrPreview: string }
  | { type: "skill_script_failed"; sessionId: string; skillName: string; scriptName: string; sandboxKind?: "virtual" | "local"; errorCode: "SCRIPT_REJECTED" | "SCRIPT_NOT_FOUND" | "SCRIPT_INVALID_ARGUMENTS" | "SCRIPT_EXECUTION_FAILED"; message: string; policyRejected: boolean }
  | { type: "run_finished"; sessionId: string };

export abstract class BrowserEventProjector {
  abstract project(event: AgentNotification): BrowserAgentEvent | undefined;
}

/** Applies browser disclosure policy without leaking that policy into Agent or session layers. */
export class DefaultBrowserEventProjector extends BrowserEventProjector {
  project(event: AgentNotification): BrowserAgentEvent | undefined {
    if (event.type === "message_delta") {
      return event.channel === "text"
        ? {
            type: "assistant_delta",
            sessionId: event.sessionId,
            messageId: event.messageId,
            delta: event.delta
          }
        : undefined;
    }

    if (event.type === "message_started" || event.type === "message_finished") {
      if (event.role !== "user" && event.role !== "assistant") {
        return undefined;
      }

      return { ...event, role: event.role };
    }

    return event;
  }
}
