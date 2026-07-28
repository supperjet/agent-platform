import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentConversationState } from "../contracts.js";

export type LocalConversationStateFile = {
  formatVersion: 1;
  sessionId: string;
  updatedAt: string;
  agentState: AgentConversationState;
  sessionInfo?: {
    cwd?: string;
    modelId?: string;
  };
};

export type LocalConversationStateStoreOptions = {
  stateFile: string;
  now?: () => Date;
};

export type LocalConversationStateSaveInput = {
  sessionId: string;
  agentState: AgentConversationState;
  sessionInfo?: LocalConversationStateFile["sessionInfo"];
};

export class LocalConversationStateStore {
  private readonly now: () => Date;

  constructor(private readonly options: LocalConversationStateStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<LocalConversationStateFile | undefined> {
    let content: string;
    try {
      content = await readFile(this.options.stateFile, "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
    return assertLocalConversationStateFile(JSON.parse(content));
  }

  async save(input: LocalConversationStateSaveInput): Promise<LocalConversationStateFile> {
    const file: LocalConversationStateFile = {
      formatVersion: 1,
      sessionId: input.sessionId,
      updatedAt: this.now().toISOString(),
      agentState: input.agentState,
      ...(input.sessionInfo === undefined ? {} : { sessionInfo: input.sessionInfo })
    };
    const directory = dirname(this.options.stateFile);
    const tempFile = `${this.options.stateFile}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(tempFile, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await rename(tempFile, this.options.stateFile);
    } catch (error) {
      await rm(tempFile, { force: true }).catch(() => {});
      throw error;
    }
    return file;
  }

  async delete(): Promise<boolean> {
    try {
      await rm(this.options.stateFile);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }
}

function assertLocalConversationStateFile(value: unknown): LocalConversationStateFile {
  if (!value || typeof value !== "object") {
    throw new Error("Local conversation state file must be an object.");
  }
  const candidate = value as LocalConversationStateFile;
  if (candidate.formatVersion !== 1) {
    throw new Error("Unsupported local conversation state file formatVersion.");
  }
  if (typeof candidate.sessionId !== "string" || !candidate.sessionId) {
    throw new Error("Local conversation state file requires sessionId.");
  }
  if (typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt))) {
    throw new Error("Local conversation state file requires updatedAt.");
  }
  assertAgentConversationState(candidate.agentState);
  return candidate;
}

function assertAgentConversationState(value: unknown): asserts value is AgentConversationState {
  if (!value || typeof value !== "object") {
    throw new Error("Local conversation state file requires agentState.");
  }
  const candidate = value as AgentConversationState;
  if (candidate.schemaVersion !== 2) {
    throw new Error("Local conversation state file requires AgentConversationState schemaVersion 2.");
  }
  if (typeof candidate.modelId !== "string" || !candidate.modelId) {
    throw new Error("Local conversation state file requires agentState.modelId.");
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    throw new Error("Local conversation state file requires agentState.payload.");
  }
}

function isNotFound(error: unknown): error is { code: "ENOENT" } {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}
