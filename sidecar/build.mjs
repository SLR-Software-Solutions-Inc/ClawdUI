// Cross-platform esbuild driver. Replaces the shell-string `esbuild` invocation
// in package.json — Windows cmd parses single-quoted banner strings differently
// and breaks the build with "Must use outdir when there are multiple input files".
import { build } from "esbuild";

await build({
  entryPoints: ["index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/index.js",
  external: ["fsevents"],
  banner: {
    js: 'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "info",
});
