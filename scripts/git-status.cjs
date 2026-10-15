const cp = require("node:child_process");
const parts = [];

const gitExe = process.platform === "win32" ? "git.exe" : "git";
const p = cp.spawn(gitExe, ["status", "--short"], {
  cwd: "D:\\synq67\\synqmusic",
  env: Object.assign({}, process.env, { GIT_EDITOR: "false" }),
});

p.stdout.on("data", (d) => parts.push(d.toString()));
p.stderr.on("data", (d) => parts.push("[stderr] " + d.toString()));
p.on("close", (code) => {
  console.log("git status --short exit", code);
  console.log(parts.join(""));
  process.exit(code || 0);
});
p.on("error", (e) => {
  console.error("spawn error", e.message);
  process.exit(1);
});
