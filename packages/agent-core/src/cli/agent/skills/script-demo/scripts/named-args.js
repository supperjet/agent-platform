import { env } from "node:process";

// 演示命名参数传递（skill-support-runtime 的 createSkillScriptEnv）：
//   SKILL_ARGS            -> 位置参数，以空格拼接成字符串
//   SKILL_ARGS_JSON       -> 位置参数数组，JSON 序列化
//   SKILL_NAMED_ARGS_JSON -> 命名参数对象（key=value 形式）
//   SKILL_INPUT_JSON      -> 统一的 { args, namedArgs } 视图
//
// 位置参数（args）：   positional
//   e.g. 运行脚本参数  alpha beta
// 命名参数（namedArgs）：
//   region=ap-east-1, counts=3

const args = JSON.parse(env.SKILL_ARGS_JSON ?? "[]");
const namedArgs = JSON.parse(env.SKILL_NAMED_ARGS_JSON ?? "{}");
const input = JSON.parse(env.SKILL_INPUT_JSON ?? "{}");

const structured = {
  status: "ok",
  result: {
    positional: args,
    positionalCount: args.length,
    named: namedArgs,
    inputViewMatches:
      input.args.length === args.length &&
      JSON.stringify(input.namedArgs) === JSON.stringify(namedArgs),
  },
};

console.log("script-demo: named-args from JS");
console.log("positional args: " + args.join(", "));
console.log("named args: " + JSON.stringify(namedArgs));
console.log("SKILL_RESULT_JSON:" + JSON.stringify(structured));
