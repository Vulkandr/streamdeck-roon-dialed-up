// Cross-platform replacement for `rm -rf` + `mkdir`. Node's fs APIs behave
// identically on Windows, macOS, and Linux, so this sidesteps the shell
// entirely rather than depending on which shell npm happens to invoke the
// "scripts" entries through (cmd.exe on Windows by default, regardless of
// what shell you actually typed `npm run build` into).
const fs = require("fs");
const path = require("path");

const targets = [
  path.join(__dirname, "..", "com.vulkan.roon-dialed-up.sdPlugin"),
  path.join(__dirname, "..", "..", "Release"),
];

for (const target of targets) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

console.log("Clean complete.");
