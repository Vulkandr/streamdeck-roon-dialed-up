// Action-list icon: a signal/pulse mark (dot with two arcs), white on transparent,
// drawn in the same weight as the other 20px action icons.
const { initWasm, Resvg } = require("@resvg/resvg-wasm"); const fs = require("fs"); const path = require("path");
const ROOT = process.argv[2];
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round">
  <circle cx="20" cy="24" r="3.2" fill="#ffffff" stroke="none"/>
  <path d="M12.5 16.5a10.6 10.6 0 0 1 15 0"/>
  <path d="M7.5 11a17.7 17.7 0 0 1 25 0"/>
</svg>`;
(async () => {
  await initWasm(fs.readFileSync(path.join(ROOT, "node_modules/@resvg/resvg-wasm/index_bg.wasm")));
  const out = path.join(ROOT, "com.vulkan.roon-dialed-up.sdPlugin/imgs/actions");
  for (const [name, w] of [["status-action@2x.png", 40], ["status-action.png", 20]]) {
    fs.writeFileSync(path.join(out, name), new Resvg(icon, { fitTo: { mode: "width", value: w } }).render().asPng());
  }
  // Default key image (before the plugin's first draw): an unlit gray light.
  const key = fs.readFileSync("/tmp/status-key.svg", "utf8");
  for (const [name, w] of [["status-key@2x.png", 144], ["status-key.png", 72]]) {
    fs.writeFileSync(path.join(out, name), new Resvg(key, { fitTo: { mode: "width", value: w } }).render().asPng());
  }
  console.log("icons written");
})();
