import { env } from "node:process";

const skillArgsJson = env.SKILL_ARGS_JSON ?? "[]";
const args = JSON.parse(skillArgsJson);

console.log("script-demo: args-json from JS");
console.log(JSON.stringify({
  count: args.length,
  args,
}));
