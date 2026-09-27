import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:7332" } },
  build: { outDir: "dist", emptyOutDir: true },
});
