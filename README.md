# SoulHub CLI

SoulHub CLI — 用于发现、安装和管理 AI Agent 灵魂（Soul）的命令行工具。支持从 SoulHub Registry 或本地目录安装单 Agent 和多 Agent 团队，兼容 OpenClaw 和 LightClaw。

## 安装

### 方式一：curl 一键安装（推荐）

无需安装 Node.js，自动下载对应平台的二进制文件：

```bash
curl -fsSL https://soulhub-1251783334.cos.ap-guangzhou.myqcloud.com/install.sh | bash
```

指定版本安装：

```bash
SOULHUB_VERSION=v1.0.1 curl -fsSL https://soulhub-1251783334.cos.ap-guangzhou.myqcloud.com/install.sh | bash
```

### 方式二：npm 安装

```bash
npm install -g soulhubcli
```

或使用 npx 直接运行：

```bash
npx soulhubcli <command>
```

## 命令一览

| 命令 | 说明 |
|------|------|
| `soulhub search <keyword>` | 搜索 Agent |
| `soulhub info <name>` | 查看 Agent 详细信息（identity、soul、skills 等） |
| `soulhub install <name>` | 从 Registry 安装 Agent 或团队（默认为 worker，安装到所有检测到的 claw） |
| `soulhub install <name> --main` | 安装为主 Agent |
| `soulhub install --from <source>` | 从本地目录、ZIP 文件或 URL 安装 |
| `soulhub list` | 列出已安装的 Agent |
| `soulhub update [name]` | 更新已安装的 Agent |
| `soulhub rollback` | 回滚到上一次安装状态 |

## 使用方法

### 搜索 Agent

```bash
soulhub search python
soulhub search "content writing"
```

### 安装 Agent

CLI 会自动识别目标是单 Agent 还是多 Agent 团队，无需手动区分。

**默认行为：安装为 Worker Agent，自动安装到所有检测到的 claw 目录。**

**从 Registry 安装：**

```bash
# 安装单 Agent（默认为 worker，安装到所有检测到的 claw）
soulhub install writer-wechat

# 安装为主 Agent
soulhub install writer-wechat --main

# 安装多 Agent 团队（调度 Agent + 工作 Agent）
soulhub install dev-squad
```

**从本地安装：**

```bash
# 从本地目录安装（自动识别单/多 Agent）
soulhub install --from ./my-agent/

# 从 ZIP 文件安装
soulhub install --from ./agent-team.zip

# 从 URL 安装
soulhub install --from https://example.com/agent-team.zip
```

**指定目标目录：**

```bash
# 安装到自定义目录（不依赖 OpenClaw/LightClaw 环境）
soulhub install writer-wechat --dir ./my-agents

# 指定 claw 安装目录（只安装到该 claw）
soulhub install writer-wechat --claw-dir ~/.lightclaw
```

### 列出已安装的 Agent

```bash
soulhub list
```

### 更新 Agent

```bash
soulhub update              # 更新全部
soulhub update ops-assistant # 更新指定 Agent
```

### 卸载 Agent

```bash
soulhub uninstall ops-assistant
```

## 安装行为说明

### 单 Agent 安装

- **默认安装为 Worker Agent**（子 agent），部署到 `workspace-<agentId>/` 目录
- 使用 `--main` 参数可安装为主 Agent，部署到 `workspace/` 目录
- **自动安装到所有检测到的 claw 目录**（OpenClaw / LightClaw），使用 `--claw-dir` 可指定单个 claw
- 如果目标目录已存在，CLI 会**自动备份**（复制到 `agentbackup/`）
- 仅覆盖 `IDENTITY.md`、`SOUL.md` 等灵魂文件，不影响 workspace 中的其他运行时文件
- 安装完成后自动重启 OpenClaw Gateway；若重启失败会提示手动重启

### 多 Agent 团队安装

- **调度 Agent（Dispatcher）** 作为主 Agent 安装到 `workspace/` 目录
- **工作 Agent（Worker）** 安装到各自的 `workspace-<agentId>/` 目录
- 自动配置多 Agent 之间的通信
- Worker Agent 自动注册到 claw 配置中
- 安装完成后自动重启 OpenClaw Gateway

## 配置

CLI 将配置存储在 `~/.soulhub/config.json`。

### 自定义 Registry

通过环境变量设置自定义 Registry 地址：

```bash
export SOULHUB_REGISTRY_URL=https://your-registry.example.com
```

### OpenClaw / LightClaw 目录

CLI 按以下优先级查找 claw 安装目录：

1. `--claw-dir` 命令行参数（指定时只安装到该 claw）
2. `OPENCLAW_HOME` / `LIGHTCLAW_HOME` 环境变量
3. 默认路径 `~/.openclaw`、`~/.lightclaw`

未指定 `--claw-dir` 时，CLI 会检测所有可用的 claw 目录并全部安装。

## 环境要求

- Node.js >= 18.0.0
- OpenClaw 或 LightClaw（可选，使用 `--dir` 参数时不需要）

## License

MIT
