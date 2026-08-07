import assert from "node:assert/strict";
import test from "node:test";
import { DefaultBrowserEventProjector } from "../consumer/browser-events.js";
import { InMemoryPublicEventStream } from "../consumer/public-event-stream.js";

test("records correlated events and notifies only the matching Session", async () => {
  const events = new InMemoryPublicEventStream(new DefaultBrowserEventProjector());
  const received: string[] = [];
  events.subscribe("session-1", (event) => received.push(event.type));

  await events.run("session-1", "command-1", async () => {
    events.accept({ type: "run_started", sessionId: "session-1" });
  });

  assert.deepEqual(received, ["run_started"]);
  assert.deepEqual(events.read("session-1").map(({ commandId, sequence }) => ({
    commandId,
    sequence
  })), [{ commandId: "command-1", sequence: 1 }]);
});

test("projects skill diagnostics into public event history", async () => {
  const events = new InMemoryPublicEventStream(new DefaultBrowserEventProjector());

  await events.run("session-1", "command-1", async () => {
    events.accept({
      type: "skill_activation_decided",
      sessionId: "session-1",
      skillName: "review",
      sourceLabel: "skills/review/SKILL.md",
      sourceScope: "project",
      decision: "activated",
      selectionReason: "explicit_command",
      reason: "Skill activated by explicit /skill use command.",
      disableModelInvocation: false,
      diagnosticCount: 0,
    });
    events.accept({
      type: "skill_policy_checked",
      sessionId: "session-1",
      skillName: "review",
      policy: {
        kind: "script",
        label: "review.sh",
        sourceLabel: "skills/review/scripts/review.sh",
        sourceScope: "project",
        canRead: false,
        canInject: false,
        canExecute: false,
        reason: "scripts require SkillRuntime and ToolRuntime approval before they can be read or executed",
      },
    });
  });

  const history = events.read("session-1");
  assert.deepEqual(history.map((event) => event.type), [
    "skill_activation_decided",
    "skill_policy_checked",
  ]);
  assert.deepEqual(history[0]?.payload, {
    skillName: "review",
    sourceLabel: "skills/review/SKILL.md",
    sourceScope: "project",
    decision: "activated",
    selectionReason: "explicit_command",
    reason: "Skill activated by explicit /skill use command.",
    disableModelInvocation: false,
    diagnosticCount: 0,
  });
  assert.deepEqual(history[1]?.payload, {
    skillName: "review",
    policy: {
      kind: "script",
      label: "review.sh",
      sourceLabel: "skills/review/scripts/review.sh",
      sourceScope: "project",
      canRead: false,
      canInject: false,
      canExecute: false,
      reason: "scripts require SkillRuntime and ToolRuntime approval before they can be read or executed",
    },
  });
});

test("projects skill composition diagnostics into public event history", async () => {
  const events = new InMemoryPublicEventStream(new DefaultBrowserEventProjector());

  await events.run("session-1", "command-1", async () => {
    events.accept({
      type: "skill_composition_decided",
      sessionId: "session-1",
      requestedSkillNames: ["review", "lint"],
      knownSkillNames: ["review"],
      unknownSkillNames: ["lint"],
      decision: "rejected",
      selectionReason: "explicit_command",
      reason: "Multiple skill activation is not supported yet; v1 allows one active skill per prompt turn.",
    });
  });

  assert.deepEqual(events.read("session-1").map((event) => ({
    type: event.type,
    payload: event.payload,
  })), [{
    type: "skill_composition_decided",
    payload: {
      requestedSkillNames: ["review", "lint"],
      knownSkillNames: ["review"],
      unknownSkillNames: ["lint"],
      decision: "rejected",
      selectionReason: "explicit_command",
      reason: "Multiple skill activation is not supported yet; v1 allows one active skill per prompt turn.",
    },
  }]);
});
