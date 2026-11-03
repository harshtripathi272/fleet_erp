import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/**
 * Writes a .br and a .gz copy beside every script and stylesheet the build makes. The API sends them to
 * browsers that accept them (src/middleware/precompressed.ts), at the best compression, with no work per request.
 */
function precompress(): Plugin {
  return {
    name: "precompress",
    apply: "build",
    writeBundle({ dir }) {
      const assets = join(dir!, "assets");
      for (const name of readdirSync(assets)) {
        if (!/\.(js|css|svg)$/.test(name)) continue;
        const file = readFileSync(join(assets, name));
        if (file.length < 1024) continue;
        writeFileSync(join(assets, `${name}.br`), brotliCompressSync(file, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
        writeFileSync(join(assets, `${name}.gz`), gzipSync(file, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), precompress()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // The app calls /api/v1/...; Vite forwards it to the API, so no CORS set-up is needed.
    proxy: { "/api": process.env.API_URL ?? "http://127.0.0.1:3000" },
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  build: {
    outDir: "dist",
    // Screens load on first use (see App.tsx and Office.tsx). The icons go in one small file of their own:
    // left alone, each icon two screens share becomes a file of a few hundred bytes, and every file is another
    // round trip on a slow mobile network.
    rollupOptions: { output: { manualChunks: (id) => (id.includes("/node_modules/lucide-react/") ? "icons" : undefined) } },
  },
  worker: { format: "es" },
});
