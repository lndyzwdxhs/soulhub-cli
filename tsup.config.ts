import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  dts: true,
  clean: true,
  // 将所有依赖 bundle 到输出文件中，解决 pkg 打包 ESM 模块的问题
  noExternal: [/.*/],
  // 排除 Node.js 内置模块
  platform: "node",
  target: "node20",
  // 生成 banner 添加 shebang
  banner: {
    js: "#!/usr/bin/env node",
  },
});
