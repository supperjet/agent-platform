import { env } from "node:process";

// 演示 SkillSupportRuntime 的结构化输出协议（SKILL_RESULT_JSON: 前缀）。
//
// parseStructuredOutput（skill-support-runtime.ts）会取 stdout 最后一行：
//   - 若以 "SKILL_RESULT_JSON:" 开头，去掉前缀后把剩余内容当 JSON 解析；
//   - 解析出的对象只要含 status/result/logs/message/errorCode 之一，
//     就会被识别为 structuredOutput，从而走 <result_json>/<logs> 而非 <stdout>。
//
// 行为由 SKILL_ARGS_JSON 第一个参数控制：
//   ok     -> status:"ok"    + result（演示成功结构化结果）
//   logs   -> status:"ok"    + logs 数组（演示日志分离）
//   err    -> status:"error" + errorCode + message（演示失败，classify 判为 failed）

const args = JSON.parse(env.SKILL_ARGS_JSON ?? "[]");
const mode = String(args[0] ?? "ok");
const topic = String(args[1] ?? "vector-add");

const debugLines = [];
debugLines.push(`script-demo: structured-result from JS (mode=${mode}, topic=${topic})`);

// 一次性打印已收集的调试行（不重新 push 回 debugLines，避免死循环）。
function printDebug() {
  for (const line of debugLines) console.log(line);
}

// result 准备就绪时只把协议行打进 stdout 的最后一行，其余调试信息也是 stdout，
// 但最后一行必须是 SKILL_RESULT_JSON: 前缀，才能被正确解析。
const result = {
  mode,
  topic,
  items: [
    { id: 1, name: topic, enabled: true },
    { id: 2, name: `${topic}-extra`, enabled: false },
  ],
};

if (mode === "err") {
  const structured = {
    status: "error",
    errorCode: "UNSUPPORTED_MODE",
    message: `Unsupported mode: ${mode}`,
  };
  printDebug();
  console.log("SKILL_RESULT_JSON:" + JSON.stringify(structured));
  process.exit(2);
}

if (mode === "logs") {
  const structured = {
    status: "ok",
    logs: ["step 1: parsed arguments", "step 2: built result"],
    result: result.items.length,
  };
  printDebug();
  console.log("SKILL_RESULT_JSON:" + JSON.stringify(structured));
  process.exit(0);
}

if (mode === "plain") {
  // 故意不用 SKILL_RESULT_JSON 前缀，演示"只走 <stdout>、不产生结构化结果"。
  printDebug();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

if (mode === "silent") {
  // 完全不写 stdout：既不调试、也不输出 SKILL_RESULT_JSON，
  // 因此 structuredOutput 为 undefined、exec.stdout 为空串。
  // （可选）把诊断信息写到 stderr，验证"stdout 空但 stderr 有内容"。
  console.error("script-demo: structured-result silent mode (stdout intentionally empty)");
  process.exit(0);
}

// 默认 ok
const structured = {
  status: "ok",
  result,
};
printDebug();
console.log("SKILL_RESULT_JSON:" + JSON.stringify(structured));
process.exit(0);
