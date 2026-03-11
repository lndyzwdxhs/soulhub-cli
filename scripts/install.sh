#!/bin/bash
set -euo pipefail

# SoulHub CLI 安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/lndyzwdxhs/soulhub-cli/main/scripts/install.sh | bash

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# GitHub 仓库信息
REPO="lndyzwdxhs/soulhub-cli"
BINARY_NAME="soulhub"
INSTALL_DIR="/usr/local/bin"

# COS 下载源（国内加速）
COS_BASE_URL="https://soulhub-1251783334.cos.ap-guangzhou.myqcloud.com"

info() {
    echo -e "${CYAN}ℹ${NC} $1"
}

success() {
    echo -e "${GREEN}✅${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error() {
    echo -e "${RED}❌${NC} $1"
    exit 1
}

# 检测操作系统
detect_os() {
    local os
    os="$(uname -s)"
    case "$os" in
        Linux*)  echo "linux" ;;
        Darwin*) echo "macos" ;;
        *)       error "不支持的操作系统: $os（仅支持 Linux 和 macOS）" ;;
    esac
}

# 检测 CPU 架构
detect_arch() {
    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)  echo "x64" ;;
        aarch64|arm64) echo "arm64" ;;
        *)             error "不支持的 CPU 架构: $arch（仅支持 x64 和 arm64）" ;;
    esac
}

# 检测下载工具
detect_downloader() {
    if command -v curl &> /dev/null; then
        echo "curl"
    elif command -v wget &> /dev/null; then
        echo "wget"
    else
        error "需要 curl 或 wget，请先安装其中一个"
    fi
}

# 下载文件
download_file() {
    local url="$1"
    local output="$2"
    local downloader
    downloader="$(detect_downloader)"

    if [[ "$downloader" == "curl" ]]; then
        curl -fsSL --retry 3 --retry-delay 2 -o "$output" "$url"
    else
        wget -q --tries=3 --timeout=20 -O "$output" "$url"
    fi
}

# 获取最新版本号
get_latest_version() {
    local tmp_file
    tmp_file="$(mktemp)"

    # 通过 GitHub API 获取最新 release
    download_file "https://api.github.com/repos/${REPO}/releases/latest" "$tmp_file"

    # 提取 tag_name
    local version
    version=$(grep '"tag_name"' "$tmp_file" | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    rm -f "$tmp_file"

    if [[ -z "$version" ]]; then
        error "无法获取最新版本号，请检查网络连接或访问 https://github.com/${REPO}/releases"
    fi

    echo "$version"
}

# 主逻辑
main() {
    echo ""
    echo -e "${BOLD}${CYAN}  ╔══════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}  ║     SoulHub CLI Installer        ║${NC}"
    echo -e "${BOLD}${CYAN}  ╚══════════════════════════════════╝${NC}"
    echo ""

    # 检测环境
    local os arch version
    os="$(detect_os)"
    arch="$(detect_arch)"
    info "检测到系统: ${BOLD}${os}/${arch}${NC}"

    # 获取版本（支持通过环境变量指定版本）
    if [[ -n "${SOULHUB_VERSION:-}" ]]; then
        version="${SOULHUB_VERSION}"
        info "使用指定版本: ${BOLD}${version}${NC}"
    else
        info "正在获取最新版本..."
        version="$(get_latest_version)"
        info "最新版本: ${BOLD}${version}${NC}"
    fi

    # 构造下载 URL
    # 二进制文件命名规则: soulhub-<os>-<arch>
    local filename="soulhub-${os}-${arch}"
    # COS 优先（国内快），GitHub 作为 fallback
    local cos_url="${COS_BASE_URL}/releases/${version}/${filename}"
    local github_url="https://github.com/${REPO}/releases/download/${version}/${filename}"

    info "正在下载 ${BOLD}${filename}${NC} ..."

    # 创建临时目录
    local tmp_dir
    tmp_dir="$(mktemp -d)"
    trap "rm -rf '$tmp_dir'" EXIT

    local tmp_file="${tmp_dir}/${BINARY_NAME}"

    # 优先从 COS 下载，失败则 fallback 到 GitHub
    if download_file "$cos_url" "$tmp_file" 2>/dev/null; then
        info "从 COS 加速源下载成功"
    elif download_file "$github_url" "$tmp_file" 2>/dev/null; then
        info "从 GitHub 下载成功"
    else
        error "下载失败，请检查网络连接或该版本是否存在对应平台的构建产物\n   COS: ${cos_url}\n   GitHub: ${github_url}"
    fi

    # 赋予执行权限
    chmod +x "$tmp_file"

    # 验证二进制文件
    if ! "$tmp_file" --version &> /dev/null; then
        warn "二进制文件验证失败，但仍将继续安装"
    fi

    # 安装到目标目录
    info "正在安装到 ${BOLD}${INSTALL_DIR}/${BINARY_NAME}${NC} ..."

    if [[ -w "$INSTALL_DIR" ]]; then
        mv "$tmp_file" "${INSTALL_DIR}/${BINARY_NAME}"
    else
        info "需要管理员权限来安装到 ${INSTALL_DIR}"
        sudo mv "$tmp_file" "${INSTALL_DIR}/${BINARY_NAME}"
        sudo chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
    fi

    # 验证安装
    if command -v "$BINARY_NAME" &> /dev/null; then
        echo ""
        success "SoulHub CLI ${version} 安装成功！"
        echo ""
        echo -e "  运行以下命令开始使用："
        echo -e "  ${BOLD}soulhub --help${NC}"
        echo ""
    else
        echo ""
        warn "安装完成，但 ${BINARY_NAME} 不在 PATH 中"
        echo -e "  请将 ${BOLD}${INSTALL_DIR}${NC} 添加到你的 PATH 环境变量："
        echo -e "  ${BOLD}export PATH=\"${INSTALL_DIR}:\$PATH\"${NC}"
        echo ""
    fi
}

main "$@"
