import commonjs from "@rollup/plugin-commonjs";
import nodeResolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.vulkan.roon-dialed-up.sdPlugin";

// The Roon Labs SDK packages (node-roon-api and friends) are old,
// dual-environment (browser/nw.js/Node) CommonJS code, full of runtime
// `typeof window`/`typeof require` feature detection and a dynamic
// `require('./sood.js')(...)` call inside node-roon-api itself. Rollup's
// CJS-to-ESM interop can't reliably represent that pattern (confirmed:
// bundling this dependency chain produces a "TypeError: ... is not a
// function" at runtime, deep inside node-uuid's RNG feature detection,
// even though the exact same code runs fine under plain unbundled Node
// `require()`). There's no upside to fighting that here: this is a real
// Node.js backend now, so these can just be genuine runtime dependencies
// resolved by Node's own (much more mature) module loader, the same way
// any hand-written Roon extension uses them, rather than forcing them
// through a browser-oriented bundler pipeline that this plugin no longer
// needs for its own code.
const ROON_PACKAGES = ["node-roon-api", "node-roon-api-transport", "node-roon-api-status", "node-roon-api-browse", "node-roon-api-image"];

// Also external: `ws`, which roon-connection.ts imports directly to hand
// node-roon-api the websocket implementation it was written for. It's
// already one of node-roon-api's own dependencies, so the copy step below
// ships it either way; keeping it external just means there's exactly one
// copy of it in play at runtime rather than a second bundled one.
const EXTERNAL_PACKAGES = [...ROON_PACKAGES, "ws", "pngjs", "opentype.js", "@resvg/resvg-wasm"];

/**
 * @type {import('rollup').RollupOptions}
 */
const config = {
	input: "src/plugin.ts",
	external: EXTERNAL_PACKAGES,
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		sourcemap: isWatching,
		sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
			return url.pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath)).href;
		}
	},
	plugins: [
		{
			name: "watch-externals",
			buildStart: function () {
				this.addWatchFile(`${sdPlugin}/manifest.json`);
			},
		},
		typescript({
			mapRoot: isWatching ? "./" : undefined
		}),
		nodeResolve({
			browser: false,
			exportConditions: ["node"],
			preferBuiltins: true
		}),
		commonjs(),
		!isWatching && terser(),
		{
			name: "emit-module-package-file",
			generateBundle() {
				this.emitFile({ fileName: "package.json", source: `{ "type": "module" }`, type: "asset" });
			}
		},
		{
			// Copies the externalized Roon SDK packages' actual source (plus
			// their own transitive deps: ip, node-uuid, ws) into the built
			// plugin folder, so Node's normal node_modules resolution finds
			// them next to bin/plugin.js at runtime. Only re-walks each
			// package the first time in a watch session; rebuild (or restart
			// watch) after changing a Roon SDK package version.
			name: "copy-roon-runtime-deps",
			writeBundle() {
				const dest = path.resolve(`${sdPlugin}/node_modules`);
				const seen = new Set();

				const copyPackage = (name) => {
					if (seen.has(name)) return;
					seen.add(name);

					const src = path.resolve("node_modules", name);
					if (!fs.existsSync(src)) return;

					fs.cpSync(src, path.join(dest, name), { recursive: true, dereference: true });

					const pkgJsonPath = path.join(src, "package.json");
					if (fs.existsSync(pkgJsonPath)) {
						const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
						for (const dep of Object.keys(pkg.dependencies ?? {})) {
							copyPackage(dep);
						}
					}
				};

				for (const name of EXTERNAL_PACKAGES) {
					copyPackage(name);
				}
			}
		}
	]
};

export default config;
