import { build } from "esbuild";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/index.cjs",
  external: ["pg-native", "bufferutil"],
  alias: {
    "@shared": path.resolve(__dirname, "shared"),
  },
  define: {
    "import.meta.dirname": JSON.stringify(__dirname),
  },
});

console.log("Build complete → dist/index.cjs");
