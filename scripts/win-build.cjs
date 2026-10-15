const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cwd = "D:\\synq67\\synqmusic";
const logPath = path.join(cwd, "desktop-dist", "win-build.log");

const log = fs.openSync(logPath, "a");
function w(line) {
  fs.writeSync(log, `${new Date().toISOString()} ${line}\n`);
}

w("START win build cwd=" + cwd);

const npm = spawn("npm.cmd", ["run", "build"], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: Object.assign({}, process.env, { FORCE_COLOR: "0" }),
});

npm.on("error", (err) => {
  w("[npm run build] spawn error: " + err.message);
  process.exit(1);
});

let npmOut = "";
let npmErr = "";
npm.stdout.on("data", (d) => { npmOut += d.toString(); w("[npm run build] " + d.toString().replace(/\n$/, "")); });
npm.stderr.on("data", (d) => { npmErr += d.toString(); w("[npm run build stderr] " + d.toString().replace(/\n$/, "")); });

npm.on("close", (code) => {
  w("[npm run build] exit code " + code);
  if (code !== 0) {
    w("[npm run build] STDOUT:\n" + npmOut);
    w("[npm run build] STDERR:\n" + npmErr);
    process.exit(code || 1);
  }
  w("[npm run build] succeeded; starting electron-builder");

  // Regenerate a correct public/logo.ico from the PNG source of truth right
  // before packaging. The repo's electron-builder.yml now uses the PNG for the
  // Electron icon and NSIS installer icons, but a correct ICO is still useful
  // as a fallback and to make sure no stale/broken ico is ever shipped.
  try {
    require("./fix-logo-ico.cjs");
    w("[prebuild] regenerated public/logo.ico from public/logo.png");
  } catch (e) {
    w("[prebuild] WARNING could not regenerate logo.ico: " + e.message);
  }

  const eb = spawn("npx.cmd", ["electron-builder", "--config", "electron-builder.yml", "--win"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: Object.assign({}, process.env, { FORCE_COLOR: "0" }),
  });

  eb.on("error", (err) => {
    w("[electron-builder] spawn error: " + err.message);
    process.exit(1);
  });

  let ebOut = "";
  let ebErr = "";
  eb.stdout.on("data", (d) => { ebOut += d.toString(); w("[electron-builder] " + d.toString().replace(/\n$/, "")); });
  eb.stderr.on("data", (d) => { ebErr += d.toString(); w("[electron-builder stderr] " + d.toString().replace(/\n$/, "")); });

  eb.on("close", (ebCode) => {
    w("[electron-builder] exit code " + ebCode);
    if (ebCode !== 0) {
      w("[electron-builder] STDOUT:\n" + ebOut);
      w("[electron-builder] STDERR:\n" + ebErr);
    }
    fs.closeSync(log);
    process.exit(ebCode || 0);
  });
});
