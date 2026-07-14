/**
 * 工具输出默认最多保留的行数。
 *
 * 这个限制用于保护模型上下文和事件流，避免 read/bash/grep 等工具一次性
 * 返回过大的内容。
 */
export const DEFAULT_TOOL_MAX_LINES = 2_000;

/**
 * 工具输出默认最多保留的 UTF-8 字节数。
 */
export const DEFAULT_TOOL_MAX_BYTES = 50 * 1024;

/**
 * 一次截断操作的完整结果。
 *
 * 除了截断后的 `content`，还保留原始大小、输出大小、命中的限制类型等
 * metadata。调用方可以把这些 details 放进 tool result，供 UI/debug/后续
 * ToolRuntime 判断使用。
 */
export type ToolTruncation = {
  /** 截断后的内容。 */
  content: string;
  /** 是否发生了截断。 */
  truncated: boolean;
  /** 触发截断的限制类型；未截断时为 null。 */
  truncatedBy: "lines" | "bytes" | null;
  /** 原始内容总行数。 */
  totalLines: number;
  /** 原始内容总 UTF-8 字节数。 */
  totalBytes: number;
  /** 输出内容行数。 */
  outputLines: number;
  /** 输出内容 UTF-8 字节数。 */
  outputBytes: number;
  /** 本次使用的最大行数限制。 */
  maxLines: number;
  /** 本次使用的最大字节限制。 */
  maxBytes: number;
};

/**
 * 调用方可覆盖的截断限制。
 */
export type ToolTruncationOptions = {
  maxLines?: number;
  maxBytes?: number;
};

/**
 * 从头部保留内容。
 *
 * 适合 read 文件：文件开头通常包含 imports、类型定义、模块上下文等信息。
 */
export function truncateHead(content: string, options: ToolTruncationOptions = {}): ToolTruncation {
  return truncate(content, "head", options);
}

/**
 * 从尾部保留内容。
 *
 * 适合 bash/test 输出：命令失败原因、测试总结、最后的错误堆栈通常在末尾。
 */
export function truncateTail(content: string, options: ToolTruncationOptions = {}): ToolTruncation {
  return truncate(content, "tail", options);
}

/**
 * 把字节数格式化成更适合展示的单位。
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 统一截断实现。
 *
 * 设计要点：
 * - 同时检查行数和 UTF-8 字节数，先命中的限制决定 `truncatedBy`。
 * - 尽量只返回完整行，避免把代码/日志切成半行导致模型误读。
 * - `head` 和 `tail` 共用同一套大小统计和 metadata 输出。
 */
function truncate(
  content: string,
  direction: "head" | "tail",
  options: ToolTruncationOptions
): ToolTruncation {
  const maxLines = options.maxLines ?? DEFAULT_TOOL_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_TOOL_MAX_BYTES;
  const lines = splitLines(content);
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(content, "utf-8");

  // 内容同时落在行数和字节限制内时，直接原样返回，并记录完整 metadata。
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      maxLines,
      maxBytes
    };
  }

  // tail 截断通过反转行数组复用同一套收集逻辑，最后再反转回来。
  const sourceLines = direction === "head" ? lines : [...lines].reverse();
  const kept: string[] = [];
  let outputBytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (const line of sourceLines) {
    // 已达到行数上限时停止。
    if (kept.length >= maxLines) {
      truncatedBy = "lines";
      break;
    }

    // 统计加入这一行后的 UTF-8 字节数；非首行要额外计算换行符。
    const separatorBytes = kept.length === 0 ? 0 : 1;
    const lineBytes = Buffer.byteLength(line, "utf-8") + separatorBytes;

    // 如果加入整行会超过字节上限，则停止。这里故意不返回半行。
    if (outputBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    kept.push(line);
    outputBytes += lineBytes;
  }

  const ordered = direction === "head" ? kept : kept.reverse();
  const output = ordered.join("\n");
  return {
    content: output,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: ordered.length,
    outputBytes: Buffer.byteLength(output, "utf-8"),
    maxLines,
    maxBytes
  };
}

/**
 * 用于统计行数的 split。
 *
 * 如果内容以换行结尾，`String.split("\n")` 会产生一个额外空字符串；这里
 * 把它去掉，避免把“末尾换行”误算成额外一行。
 */
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}
