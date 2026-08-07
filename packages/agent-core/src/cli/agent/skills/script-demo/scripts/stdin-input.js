import { readFileSync } from "node:fs";

// 演示从 stdin 读取输入数据（沙箱 exec 通过 stdin 灌入脚本正文/schema，
// 脚本也可以从 stdin 读用户提供的原始输入）。
//
// 这个例子读取 stdin（一行 raw 输入），统计行数与字节数，
// 并用命名参数指定分隔符触发按行拆分。

const raw = readFileSync(0, "utf8");
const separator = process.env.SKILL_NAMED_ARGS_JSON
  ? (JSON.parse(process.env.SKILL_NAMED_ARGS_JSON).separator ?? "\n")
  : "\n";

const lines = raw.split(separator).filter((line) => line.length > 0);

const structured = {
  status: "ok",
  result: {
    lineCount: lines.length,
    byteLength: Buffer.byteLength(raw, "utf8"),
    lines,
  },
};

console.log("script-demo: stdin-input from JS");
console.log(`stdin bytes: ${Buffer.byteLength(raw, "utf8")}`);
console.log("SKILL_RESULT_JSON:" + JSON.stringify(structured));
