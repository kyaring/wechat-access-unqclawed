import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  // bundle all dependencies into a single file
  noExternal: [
    "ws",
    "fast-xml-parser",
    "undici",
    "zod",
    "centrifuge",
  ],
  // openclaw is provided by host; qrcode-terminal is optional (dynamic import)
  external: ["openclaw", "qrcode-terminal"],
  // keep readable for debugging
  minify: false,
  sourcemap: true,
});
