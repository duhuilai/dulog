import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 使用固定端口，避免与 dev 服务器冲突
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
  },
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
  },
});
