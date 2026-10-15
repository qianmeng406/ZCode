// 仅用于融合档位菜单 harness 的最小 Vite 配置：alias、Tailwind 与 React 插件，
// 不引入应用级服务/入口。vite/@vitejs/plugin-react/@tailwindcss/vite 依赖 web 包的
// devDependencies（pnpm 严格隔离），从 packages/web/node_modules 解析：
// 启动：cd packages/web && pnpm exec vite --config ../ui/vite/harness.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const uiRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("../test/fixture", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
    },
  },
  server: { port: 5199, fs: { allow: [uiRoot] } },
});
