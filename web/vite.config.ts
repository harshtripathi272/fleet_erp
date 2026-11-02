import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // The app calls /api/v1/...; Vite forwards it to the API, so no CORS set-up is needed.
    proxy: { "/api": process.env.API_URL ?? "http://127.0.0.1:3000" },
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  build: { outDir: "dist" },
  worker: { format: "es" },
});
