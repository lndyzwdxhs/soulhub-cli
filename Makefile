# SoulHub CLI - Makefile
# 用于构建开发版本并打包，方便在 Linux 服务器上测试

.PHONY: install build dev-build pack clean help

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
	@echo "📦 产物位置: $$(ls -1 soulhub-*.tgz 2>/dev/null)"
	@echo ""
	@echo "🚀 在 Linux 服务器上安装测试："
	@echo "   scp soulhub-*.tgz user@your-server:~/"
	@echo "   ssh user@your-server"
	@echo "   npm install -g ./soulhub-*.tgz"
	@echo "   soulhub --help"

# 打包为 tgz（npm pack 会生成 soulhub-<version>.tgz）
pack:
	npm pack

# 本地全局安装测试
local-install: build
	npm install -g .
	@echo "✅ 已全局安装，可以直接运行: soulhub --help"

# 本地卸载
local-uninstall:
	npm uninstall -g soulhub

# 清理构建产物
clean:
	rm -rf dist
	rm -f soulhub-*.tgz

# 类型检查
typecheck:
	npm run typecheck

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
	@echo "  make clean        - 清理构建产物"
	@echo "  make help         - 显示此帮助信息"
