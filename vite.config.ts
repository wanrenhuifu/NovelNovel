import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // CodeMirror 含 search/markdown 等扩展后约 520KB，超过 Vite 默认 500KB 警告阈值
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // 把大体积 vendor 拆出主 chunk：CodeMirror（编辑器）、React 运行时各自独立缓存
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("@codemirror") || id.includes("@lezer")) return "codemirror";
          if (
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react/") ||
            id.includes("node_modules/scheduler")
          )
            return "react";
        },
      },
    },
  },
});
