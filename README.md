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
| `soulhub search [query]` | 搜索 Agent 模板（匹配名称、描述、标签） |
| `soulhub search -c <category>` | 按分类筛选搜索结果 |
| `soulhub search -n <number>` | 限制搜索结果数量（默认 20） |
| `soulhub search --json` | 以 JSON 格式输出搜索结果 |
| `soulhub info <name>` | 查看 Agent 详细信息（identity、soul、skills 等） |
| `soulhub info <name> --identity` | 显示 IDENTITY.md 内容 |
| `soulhub info <name> --soul` | 显示 SOUL.md 内容 |
| `soulhub info <name> --json` | 以 JSON 格式输出 Agent 详情 |
| `soulhub install <name>` | 从 Registry 安装 Agent 或团队（交互式：选择角色和目标 Claw） |
| `soulhub install <name> --role main` | 安装为主 Agent（跳过角色选择） |
| `soulhub install <name> --role worker` | 安装为 Worker Agent（跳过角色选择） |
| `soulhub install <name> --claw-type <type>` | 指定 claw 类型（跳过 claw 选择） |
| `soulhub install <name> --dir <path>` | 安装到指定目录（不依赖 claw 环境） |
| `soulhub install <name> -y` | 跳过所有确认提示（自动确认） |
| `soulhub install --from <source>` | 从本地目录、ZIP 文件或 URL 安装 |
| `soulhub list` | 列出已安装的 Agent |
| `soulhub list --json` | 以 JSON 格式输出已安装的 Agent |
| `soulhub update [name]` | 更新已安装的 Agent（不传名称则更新全部） |
| `soulhub uninstall <name>` | 卸载 Agent（同时删除相关备份） |
| `soulhub uninstall <name> --keep-files` | 卸载但保留 workspace 文件 |
| `soulhub uninstall <name> -y` | 卸载 Agent（跳过确认提示） |
| `soulhub rollback` | 交互式选择回滚到某次安装前的状态 |
| `soulhub rollback --list` | 列出所有可用的回滚记录 |
| `soulhub rollback --last <n>` | 回滚倒数第 n 次安装（1 = 最近一次） |
| `soulhub rollback --id <id>` | 按 ID 回滚到指定的备份记录 |
| `soulhub rollback --claw-type <type>` | 指定回滚的目标 claw 类型 |
| `soulhub rollback --last <n> -y` | 回滚并跳过确认提示 |

### 全局选项

| 选项 | 说明 |
|------|------|
| `--verbose` | 启用详细调试日志 |
| `--version` | 显示版本号 |
| `--help` | 显示帮助信息 |

## 使用方法

### 搜索 Agent

```bash
soulhub search python
soulhub search "content writing"

# 按分类筛选
soulhub search -c development

# 限制结果数量
soulhub search writer -n 5

# JSON 格式输出（适合 CI/管道集成）
soulhub search writer --json
```

### 安装 Agent

CLI 会自动识别目标是单 Agent 还是多 Agent 团队，无需手动区分。

**默认行为：交互式安装。** CLI 会提示用户选择安装角色（主 Agent / Worker Agent）以及目标 Claw 目录（单选）。通过命令行参数可跳过交互，实现完全非交互式安装。

**从 Registry 安装：**

```bash
# 交互式安装（会提示选择角色和 claw 目录）
soulhub install writer-wechat

# 指定角色，仍交互选择 claw 目录
soulhub install writer-wechat --role main
soulhub install writer-wechat --role worker

# 指定 claw 类型，仍交互选择角色
soulhub install writer-wechat --claw-type LightClaw

# 完全非交互式安装
soulhub install writer-wechat --role worker --claw-type OpenClaw

# 完全非交互式安装（主 Agent，-y 跳过确认）
soulhub install writer-wechat --role main --claw-type OpenClaw -y

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
```

### 查看 Agent 详情

```bash
soulhub info writer-xiaohongshu

# 查看 IDENTITY.md 和 SOUL.md 内容
soulhub info writer-xiaohongshu --identity --soul

# JSON 格式输出
soulhub info writer-xiaohongshu --json
```

### 列出已安装的 Agent

```bash
soulhub list

# JSON 格式输出
soulhub list --json
```

### 更新 Agent

```bash
soulhub update              # 更新全部
soulhub update ops-assistant # 更新指定 Agent
```

### 卸载 Agent

卸载时，如果存在相关备份记录，CLI 会提示用户确认，因为卸载操作会同时删除该 Agent 的所有备份文件，删除后将无法回滚。使用 `-y` 参数可跳过确认。

```bash
soulhub uninstall ops-assistant

# 跳过确认提示
soulhub uninstall ops-assistant -y
```

使用 `--keep-files` 参数可保留 workspace 文件，仅从安装记录中移除：

```bash
soulhub uninstall ops-assistant --keep-files
```

### 回滚安装

每次安装操作都会自动创建备份记录，支持回滚到安装前的状态。

```bash
# 交互式选择：展示所有备份记录，选择要回滚的项
soulhub rollback

# 查看所有可用的回滚记录
soulhub rollback --list

# 非交互式：回滚最近一次安装
soulhub rollback --last 1

# 非交互式：回滚最近一次安装（跳过确认）
soulhub rollback --last 1 -y

# 非交互式：回滚倒数第 2 次安装
soulhub rollback --last 2

# 按 ID 回滚到指定记录
soulhub rollback --id <record-id>
```

## 安装行为说明

### 交互式安装流程

未指定 `--role` 和 `--claw-type` 参数时，CLI 进入交互式安装：

1. 展示 Agent 基本信息（名称、版本、描述、分类、标签）
2. 提示选择安装角色：**Main Agent** 或 **Worker Agent**
3. 安装为 Main Agent 时，警告将覆盖当前 workspace 内容（人格文件会被替换，记忆不受影响），需用户确认（或使用 `-y` 跳过）
4. 提示单选目标 Claw 目录（OpenClaw / LightClaw），一次只安装到一个 Claw
5. 执行安装、注册，并提示用户重启

### 单 Agent 安装

- 安装为 **Worker Agent** 时，部署到 `workspace-<agentId>/` 目录
- 安装为 **Main Agent** 时，部署到 `workspace/` 目录，会覆盖已有人格文件
- 安装前自动备份已有内容到 `~/.soulhub/backups/<claw>/`（按 claw 类型分目录存储）
- 仅覆盖 `IDENTITY.md`、`SOUL.md` 等灵魂文件，不影响 workspace 中的其他运行时文件
- 安装完成后提示用户重启 OpenClaw/LightClaw Gateway

### 多 Agent 团队安装

- **调度 Agent（Dispatcher）** 作为主 Agent 安装到 `workspace/` 目录
- **工作 Agent（Worker）** 安装到各自的 `workspace-<agentId>/` 目录
- 安装前自动备份存量子 Agent（mv 方式移走已有 worker 目录）
- 自动配置多 Agent 之间的通信
- Worker Agent 自动注册到 claw 配置中
- 安装完成后提示用户重启 OpenClaw/LightClaw Gateway

### 备份与回滚

- 备份文件存储在 `~/.soulhub/backups/<claw>/` 目录下，按 claw 类型（如 `openclaw`、`lightclaw`）分目录管理
- 备份清单记录在 `~/.soulhub/backup-manifest.json` 中
- 每次安装都会自动创建备份记录，包含 agent 文件和 claw 配置快照
- 回滚时自动恢复备份文件和 claw 配置，并重启 Gateway
- 卸载 Agent 时会同时清理相关备份记录和备份文件

## 配置

CLI 将配置存储在 `~/.soulhub/config.json`。

### 自定义 Registry

通过环境变量设置自定义 Registry 地址：

```bash
export SOULHUB_REGISTRY_URL=https://your-registry.example.com
```

### OpenClaw / LightClaw 目录

CLI 按以下优先级查找 claw 安装目录：

1. `--claw-type` 命令行参数（指定时只安装到该 claw）
2. `--dir` 命令行参数（直接指定目标目录，不依赖 claw 环境）
3. `OPENCLAW_HOME` / `LIGHTCLAW_HOME` 环境变量
4. 默认路径 `~/.openclaw`、`~/.lightclaw`

未指定 `--claw-type` 或 `--dir` 时，CLI 会检测所有可用的 Claw 目录，多个时交互式单选（一次只安装到一个 Claw）。

## 环境要求

- Node.js >= 18.0.0
- OpenClaw 或 LightClaw（可选，使用 `--dir` 参数时不需要）

## License

MIT
