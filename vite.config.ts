import { defineConfig } from "vite";
import { resolve } from "node:path";

// 仅构建前端到 dist/client；Worker 通过 [assets] 绑定提供静态资源。
export default defineConfig({
  root: "client",
  build: {
    outDir: resolve(__dirname, "dist/client"),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "client/index.html"),
    },
  },
});
