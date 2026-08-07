const args = JSON.parse(process.env.SKILL_ARGS_JSON ?? "[]");

console.log("script-demo: local-env from JS");
console.log(JSON.stringify({
  cwd: process.cwd(),
  args,
  hasPath: Boolean(process.env.PATH),
  leakedSecret: Boolean(process.env.SKILL_RUNTIME_SECRET),
}));
