import type { AnyAgentToolDefinition } from "../tool-registry.js";
import type { ToolOperations } from "../operations/index.js";
import { createBashToolDefinition } from "./bash.js";
import { createEditToolDefinition } from "./edit.js";
import { createFindToolDefinition } from "./find.js";
import { createGrepToolDefinition } from "./grep.js";
import { createLsToolDefinition } from "./ls.js";
import { createReadToolDefinition } from "./read.js";
import { createWriteToolDefinition } from "./write.js";

export { createBashToolDefinition } from "./bash.js";
export { createEditToolDefinition } from "./edit.js";
export { createFindToolDefinition } from "./find.js";
export { createGrepToolDefinition } from "./grep.js";
export { createLsToolDefinition } from "./ls.js";
export { createReadToolDefinition } from "./read.js";
export { createWriteToolDefinition } from "./write.js";

// agent-core 默认内置工具集合。CLI/上层 runtime 可以基于这份名单做展示或白名单校验。
export const CORE_BUILT_IN_TOOL_NAMES = [
  "read",
  "ls",
  "grep",
  "find",
  "write",
  "edit",
  "bash"
] as const;

/**
 * 创建完整的默认内置工具定义集合。
 *
 * 这里故意只是“便利组合”，不是 profile/policy 系统；调用方如果要自由搭配，
 * 可以直接 import 单个 createXToolDefinition 并手动传给 createAgentToolRegistry。
 */
export function createBuiltInToolDefinitions(operations: ToolOperations): readonly AnyAgentToolDefinition[] {
  return [
    createReadToolDefinition(operations),
    createLsToolDefinition(operations),
    createGrepToolDefinition(operations),
    createFindToolDefinition(operations),
    createWriteToolDefinition(operations),
    createEditToolDefinition(operations),
    createBashToolDefinition(operations)
  ];
}
