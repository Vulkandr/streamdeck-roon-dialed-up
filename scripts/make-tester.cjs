// Makes a side-by-side test copy of the built plugin: a second plugin called
// "Roon: Dialed Up Tester" with its own UUID, so it installs next to the real
// one (separate keys, settings and Roon extension) instead of replacing it.
//
//   npm run build && node scripts/make-tester.cjs
//   npx streamdeck pack com.vulkan.roon-dialed-up-tester.sdPlugin --force
//
// The copy is regenerated from scratch every time; never edit it by hand.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "com.vulkan.roon-dialed-up.sdPlugin");
const DST = path.join(ROOT, "com.vulkan.roon-dialed-up-tester.sdPlugin");
const FROM = "com.vulkan.roon-dialed-up";
const TO = "com.vulkan.roon-dialed-up-tester";

if (!fs.existsSync(path.join(SRC, "bin", "plugin.js"))) {
	console.error("bin/plugin.js is missing: run `npm run build` first");
	process.exit(1);
}

fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, {
	recursive: true,
	filter: (p) => !/[\\/](logs|roon-state\.json)$/.test(p),
});

// Rewrite the plugin id wherever it appears in text files (manifest, the
// built plugin, the settings panel). Binary files are left alone.
const TEXT = /\.(json|js|cjs|mjs|html|css)$/;
let changed = 0;
(function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules") walk(p);
			continue;
		}
		if (!TEXT.test(entry.name)) continue;
		const text = fs.readFileSync(p, "utf8");
		if (!text.includes(FROM)) continue;
		fs.writeFileSync(p, text.split(FROM).join(TO));
		changed++;
	}
})(DST);

const manifestPath = path.join(DST, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.Name = "Roon: Dialed Up Tester";
manifest.Category = "Roon: Dialed Up Tester";
// Stream Deck won't reinstall a plugin over the same version, so the tester's
// build number comes from the clock: every build installs over the last one.
manifest.Version = manifest.Version.replace(/\.\d+$/, `.${Math.floor(Date.now() / 60000) % 100000}`);
manifest.Description = `TEST BUILD of ${manifest.Name.replace(" Tester", "")}. ${manifest.Description ?? ""}`.trim();
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");

console.log(`tester plugin written to ${path.basename(DST)} (${changed} files rewritten, UUID ${TO})`);
