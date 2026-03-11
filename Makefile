# SoulHub CLI - Makefile
# 用于构建开发版本并打包，方便在 Linux 服务器上测试

.PHONY: install build dev-build pack clean help typecheck local-install local-uninstall release build-binary

# 默认目标
all: dev-build

# 安装依赖
install:
	npm install

# 生产构建
build:
	npm run build

# 开发版本构建（安装依赖 + 构建 + 打包）
dev-build: install build pack
	@echo ""
	@echo "✅ 开发版本构建完成！"
	@echo "📦 产物位置: $$(ls -1 soulhubcli-*.tgz 2>/dev/null)"
	@echo ""
	@echo "🚀 在 Linux 服务器上安装测试："
	@echo "   scp soulhubcli-*.tgz user@your-server:~/"
	@echo "   ssh user@your-server"
	@echo "   npm install -g ./soulhubcli-*.tgz"
	@echo "   soulhub --help"

# 打包为 tgz（npm pack 会生成 soulhubcli-<version>.tgz）
pack:
	npm pack

# 本地全局安装测试
local-install: build
	npm install -g .
	@echo "✅ 已全局安装，可以直接运行: soulhub --help"

# 本地卸载
local-uninstall:
	npm uninstall -g soulhubcli

# 清理构建产物
clean:
	rm -rf dist
	rm -f soulhubcli-*.tgz

# 类型检查
typecheck:
	npm run typecheck

# 构建当前平台的独立二进制（本地测试用）
build-binary: build
	@OS=$$(uname -s | tr '[:upper:]' '[:lower:]'); \
	ARCH=$$(uname -m); \
	case "$$OS" in \
		darwin) OS="macos" ;; \
	esac; \
	case "$$ARCH" in \
		x86_64) ARCH="x64" ;; \
		aarch64|arm64) ARCH="arm64" ;; \
	esac; \
	echo "🔨 正在构建 soulhub-$$OS-$$ARCH ..."; \
	npx @yao-pkg/pkg dist/index.js --target node20-$$OS-$$ARCH --output soulhub-$$OS-$$ARCH --compress GZip; \
	echo "✅ 构建完成: soulhub-$$OS-$$ARCH"; \
	ls -lh soulhub-$$OS-$$ARCH

# 发版（用法: make release v=0.2.0）
release:
	@if [ -z "$(v)" ]; then \
		echo "❌ 请指定版本号，用法: make release v=0.2.0"; \
		exit 1; \
	fi
	@echo "🚀 开始发版 v$(v) ..."
	@# 更新 package.json 版本号（不创建 git tag 和 commit，版本相同则跳过）
	@current_version=$$(node -p "require('./package.json').version"); \
	if [ "$$current_version" = "$(v)" ]; then \
		echo "ℹ️  版本号已是 $(v)，跳过更新"; \
	else \
		npm version $(v) --no-git-tag-version; \
	fi
	@# 构建并验证
	npm run typecheck
	npm run build
	@node dist/index.js --help > /dev/null 2>&1 && echo "✅ CLI 验证通过" || (echo "❌ CLI 验证失败" && exit 1)
	@# 提交并推送（commit message 以 release: 开头会自动触发发布）
	git add .
	git commit -m "release: v$(v)"
	git push origin main
	@echo ""
	@echo "✅ 版本 v$(v) 已发布！"
	@echo "📦 GitHub Actions 将自动构建并发布到 npm"
	@echo "🔗 查看进度: https://github.com/lndyzwdxhs/soulhub-cli/actions"

# 帮助信息
help:
	@echo "SoulHub CLI Makefile"
	@echo ""
	@echo "可用目标："
	@echo "  make              - 等同于 make dev-build"
	@echo "  make install      - 安装依赖"
	@echo "  make build        - 构建项目"
	@echo "  make dev-build    - 安装依赖 + 构建 + 打包 tgz（推荐）"
	@echo "  make pack         - 仅打包为 tgz"
	@echo "  make local-install  - 本地全局安装测试"
	@echo "  make local-uninstall- 本地卸载"
	@echo "  make typecheck    - TypeScript 类型检查"
	@echo "  make build-binary - 构建当前平台的独立二进制"
	@echo "  make clean        - 清理构建产物"
	@echo "  make release v=x.y.z - 一键发版（修改版本+提交+推送，自动触发CI发布）"
	@echo "  make help         - 显示此帮助信息"
