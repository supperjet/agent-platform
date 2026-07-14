/**
 * 工具层需要的最小 stat 形状。
 *
 * 这里不直接暴露 Node 的 `fs.Stats` 类型，是为了让远程/容器/测试环境
 * 可以提供自己的轻量实现，只要能回答“是不是目录/文件”即可。
 */
export type ToolPathStat = {
  isDirectory(): boolean;
  isFile(): boolean;
};

/**
 * 所有 ToolOperations 方法共用的执行选项。
 *
 * 目前只包含 `signal`，用于把 agent loop 的取消请求传到文件系统、远程执行器
 * 或沙箱适配层。后续如果需要 tracing/policy token，也可以从这里扩展。
 */
export type ToolOperationOptions = {
  signal?: AbortSignal | undefined;
};

/**
 * 命令执行结果的标准形状。
 *
 * `bash` 工具只依赖这个结构，因此本地 shell、SSH、容器 exec 都可以
 * 适配成同样的返回值。
 */
export type ToolCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/**
 * 命令执行选项。
 *
 * `timeoutMs` 用于避免长时间挂起；`signal` 用于把上层 abort 传递到底层
 * 命令执行实现。
 */
export type ToolExecuteOptions = ToolOperationOptions & {
  timeoutMs?: number;
};

/**
 * 内置工具和执行环境之间的适配接口。
 *
 * built-in 工具只表达工具语义，例如 read/edit/bash；具体动作发生在哪里、
 * 以什么权限发生、如何限制路径，都由 ToolOperations 决定。这样同一套
 * 工具可以运行在本地文件系统、远程 SSH、容器或测试 fake 环境中。
 */
export type ToolOperations = {
  /** 工具执行环境的当前工作目录。 */
  cwd: string;
  /** 允许访问的根目录集合。所有 resolvePath 结果都必须落在这些 roots 内。 */
  roots: readonly string[];
  /** 把用户传入路径解析成执行环境中的绝对路径，并做边界检查。 */
  resolvePath(path: string): string;
  /** 读取 UTF-8 文本文件。 */
  readFile(path: string, options?: ToolOperationOptions): Promise<string>;
  /** 写入 UTF-8 文本文件，必要时创建父目录。 */
  writeFile(path: string, content: string, options?: ToolOperationOptions): Promise<void>;
  /** 获取路径状态，用于判断文件/目录。 */
  stat(path: string, options?: ToolOperationOptions): Promise<ToolPathStat>;
  /** 判断路径是否存在。 */
  exists(path: string, options?: ToolOperationOptions): Promise<boolean>;
  /** 读取目录条目名称。 */
  readdir(path: string, options?: ToolOperationOptions): Promise<readonly string[]>;
  /** 创建目录及必要父目录。 */
  mkdirp(path: string, options?: ToolOperationOptions): Promise<void>;
  /** 执行命令并返回 stdout/stderr/exitCode。 */
  execute(command: string, options?: ToolExecuteOptions): Promise<ToolCommandResult>;
};
