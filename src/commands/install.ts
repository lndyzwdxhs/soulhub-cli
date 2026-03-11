import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  fetchIndex,
  fetchAgentFile,
  fetchRecipeFile,
  findOpenClawDir,
  getWorkspaceDir,
  getMainWorkspaceDir,
  checkMainAgentExists,
  recordInstall,
  checkOpenClawInstalled,
  backupAgentWorkspace,
  registerAgentToOpenClaw,
  readSoulHubPackage,
  detectPackageKind,
  configureMultiAgentCommunication,
  addAgentToOpenClawConfig,
  restartOpenClawGateway,
} from "../utils.js";
import type { SoulHubPackage } from "../types.js";

export const installCommand = new Command("install")
  .description("Install an agent or team from the SoulHub registry")
  .argument("[name]", "Agent or team name to install")
  .option("--from <source>", "Install from a local directory, ZIP file, or URL")
  .option(
    "--dir <path>",
    "Target directory (defaults to OpenClaw workspace)"
  )
  .option(
    "--claw-dir <path>",
    "OpenClaw installation directory (overrides OPENCLAW_HOME env var, defaults to ~/.openclaw)"
  )
  .action(async (name: string | undefined, options) => {
    try {
      if (options.from) {
        // 从本地目录/ZIP/URL 安装，自动识别单/多 agent
        await installFromSource(options.from, options.dir, options.clawDir);
      } else if (name) {
        // 从 registry 安装，自动识别是 agent 还是 recipe
        await installFromRegistry(name, options.dir, options.clawDir);
      } else {
        console.error(chalk.red("Please specify an agent or team name, or use --from to install from a local source."));
        console.log(chalk.dim("  Examples:"));
        console.log(chalk.dim("    soulhub install writer-wechat          # 从 registry 安装单 agent"));
        console.log(chalk.dim("    soulhub install dev-squad              # 从 registry 安装团队"));
        console.log(chalk.dim("    soulhub install --from ./agent-team/   # 从本地目录安装"));
        process.exit(1);
      }
    } catch (error) {
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      process.exit(1);
    }
  });

// ==========================================
// 从 Registry 安装（自动识别 agent / recipe）
// ==========================================

/**
 * 从 registry 安装，自动识别是单 agent 还是 team recipe
 */
async function installFromRegistry(
  name: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = ora(`Checking registry for ${chalk.cyan(name)}...`).start();

  const index = await fetchIndex();

  // 先检查是否是 agent
  const agent = index.agents.find((a) => a.name === name);
  // 再检查是否是 recipe
  const recipe = index.recipes.find((r) => r.name === name);

  if (agent && !recipe) {
    spinner.stop();
    await installSingleAgent(name, targetDir, clawDir);
  } else if (recipe) {
    spinner.stop();
    await installRecipeFromRegistry(name, recipe, targetDir, clawDir);
  } else {
    spinner.fail(`"${name}" not found in registry.`);
    console.log(chalk.dim("  Use 'soulhub search' to find available agents and teams."));
  }
}

// ==========================================
// 单 Agent 安装
// ==========================================

/**
 * 安装单个 agent（安装到主 workspace）
 */
async function installSingleAgent(
  name: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = ora(`Checking environment...`).start();

  // 1. 检查 OpenClaw 是否安装
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
    spinner.text = chalk.dim(`OpenClaw detected: ${clawCheck.clawDir || "via PATH"}`);
  }

  // 2. 查询 registry 获取 agent 信息
  spinner.text = `Fetching agent ${chalk.cyan(name)}...`;
  const index = await fetchIndex();
  const agent = index.agents.find((a) => a.name === name);
  if (!agent) {
    spinner.fail(`Agent "${name}" not found in registry.`);
    console.log(chalk.dim("  Use 'soulhub search' to find available agents."));
    return;
  }

  // 3. 确定目标目录
  let workspaceDir: string;
  if (targetDir) {
    workspaceDir = path.resolve(targetDir);
  } else {
    const resolvedClawDir = findOpenClawDir(clawDir);
    if (!resolvedClawDir) {
      spinner.fail("OpenClaw workspace directory not found.");
      printOpenClawInstallHelp();
      return;
    }
    // 单 agent 安装到主 workspace
    workspaceDir = getMainWorkspaceDir(resolvedClawDir);
  }

  // 4. 检查主 agent 是否已存在，备份
  if (!targetDir) {
    const resolvedClawDir = findOpenClawDir(clawDir)!;
    const mainCheck = checkMainAgentExists(resolvedClawDir);
    if (mainCheck.hasContent) {
      spinner.warn(
        `Existing main agent detected. Backing up workspace...`
      );
      const backupDir = backupAgentWorkspace(workspaceDir);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
      }
    }
  } else {
    // 自定义目录也做备份
    const backupDir = backupAgentWorkspace(workspaceDir);
    if (backupDir) {
      console.log(chalk.yellow(`  ⚠ Existing agent backed up to: ${backupDir}`));
    }
  }

  // 5. 确保 workspace 目录存在 + 更新 openclaw.json
  //    备份是 cp（原目录不动），所以如果目录已存在无需重建
  //    不使用 openclaw agents add（那是给子 agent 用的，"main" 是保留 id）
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  if (!targetDir) {
    spinner.text = `Registering ${chalk.cyan(agent.displayName)} as main agent...`;
    const resolvedClawDir = findOpenClawDir(clawDir)!;
    addAgentToOpenClawConfig(resolvedClawDir, "main", name, true);
    spinner.text = chalk.dim(`Main agent registered in openclaw.json`);
  }

  // 6. 下载 IDENTITY.md 和 SOUL.md 覆盖默认模板
  spinner.text = `Downloading ${chalk.cyan(agent.displayName)} soul files...`;
  await downloadAgentFiles(name, workspaceDir, spinner);

  // 7. 保存 manifest
  await saveAgentManifest(name, agent, workspaceDir);

  // 8. 记录安装
  recordInstall(name, agent.version, workspaceDir);

  spinner.succeed(
    `${chalk.cyan.bold(agent.displayName)} installed as main agent!`
  );
  console.log();
  console.log(`  ${chalk.dim("Location:")} ${workspaceDir}`);
  console.log(`  ${chalk.dim("Version:")}  ${agent.version}`);
  console.log(`  ${chalk.dim("Type:")}     ${chalk.blue("Single Agent (Main)")}`);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway();
  }
  console.log();
}

// ==========================================
// 多 Agent Team 安装（从 Registry Recipe）
// ==========================================

/**
 * 从 registry recipe 安装多 Agent 团队
 */
async function installRecipeFromRegistry(
  name: string,
  recipe: { name: string; displayName: string; agents: string[]; version?: string },
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = ora(`Installing team ${chalk.cyan(recipe.displayName)}...`).start();

  // 1. 检查 OpenClaw 是否安装
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
  }

  const resolvedClawDir = targetDir ? path.resolve(targetDir) : findOpenClawDir(clawDir);
  if (!resolvedClawDir) {
    spinner.fail("OpenClaw workspace directory not found.");
    printOpenClawInstallHelp();
    return;
  }

  // 2. 下载并解析 soulhub.yaml
  spinner.text = `Fetching team configuration...`;
  let pkg: SoulHubPackage;
  try {
    const soulhubYamlContent = await fetchRecipeFile(name, "soulhub.yaml");
    pkg = yaml.load(soulhubYamlContent) as SoulHubPackage;
  } catch {
    spinner.fail(`Failed to fetch soulhub.yaml for recipe "${name}". Recipe packages must include a soulhub.yaml file.`);
    return;
  }

  // 3. 安装 dispatcher（主 agent）
  if (pkg.dispatcher) {
    spinner.text = `Installing dispatcher ${chalk.blue(pkg.dispatcher.name)}...`;
    await installDispatcher(pkg.dispatcher, resolvedClawDir, clawDir, targetDir, spinner);
  }

  // 4. 安装 worker agents
  const index = await fetchIndex();
  const workerIds: string[] = [];

  for (const worker of pkg.agents || []) {
    spinner.text = `Installing worker ${chalk.cyan(worker.name)}...`;

    const agentName = worker.dir || worker.name; // dir 可能是 registry 中的 template 名
    const agentId = worker.name; // agentId 可能是自定义短名

    const workerDir = targetDir
      ? path.join(resolvedClawDir, `workspace-${agentId}`)
      : getWorkspaceDir(resolvedClawDir, agentId);

    // 备份
    const backupDir = backupAgentWorkspace(workerDir);
    if (backupDir) {
      console.log(chalk.yellow(`  ⚠ Existing ${agentId} backed up to: ${backupDir}`));
    }

    // 注册 worker agent
    if (!targetDir) {
      const regResult = registerAgentToOpenClaw(agentId, workerDir, clawDir);
      if (!regResult.success) {
        console.log(chalk.yellow(`  ⚠ Failed to register ${agentId}: ${regResult.message}`));
        continue;
      }
    } else {
      fs.mkdirSync(workerDir, { recursive: true });
    }

    // 从 registry 下载 agent 文件（用 template/dir 名称去下载）
    await downloadAgentFiles(agentName, workerDir, spinner);

    // 保存 manifest
    const agentInfo = index.agents.find((a) => a.name === agentName);
    if (agentInfo) {
      await saveAgentManifest(agentName, agentInfo, workerDir);
    }

    recordInstall(agentId, recipe.version || "1.0.0", workerDir);
    workerIds.push(agentId);
  }

  // 5. 配置多 agent 通信
  if (!targetDir) {
    spinner.text = "Configuring multi-agent communication...";
    const dispatcherId = "main"; // 主 agent 固定 id 为 "main"
    configureMultiAgentCommunication(resolvedClawDir, dispatcherId, workerIds);
  }

  spinner.succeed(
    `Team ${chalk.cyan.bold(recipe.displayName)} installed! (1 dispatcher + ${workerIds.length} workers)`
  );
  printTeamSummary(pkg, workerIds);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway();
  }
}

// ==========================================
// 从本地目录/ZIP/URL 安装（自动识别）
// ==========================================

/**
 * 从本地源安装，自动识别单/多 agent
 */
async function installFromSource(
  source: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = ora("Analyzing package...").start();

  // 处理不同的源类型
  let packageDir: string;
  let tempDir: string | null = null;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    // URL 来源 — 下载到临时目录
    spinner.text = "Downloading package...";
    const response = await fetch(source);
    if (!response.ok) {
      spinner.fail(`Failed to download: ${response.statusText}`);
      return;
    }
    // 下载 ZIP 文件
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("zip") || source.endsWith(".zip")) {
      const JSZip = (await import("jszip")).default;
      const arrayBuffer = await response.arrayBuffer();
      const zip = await JSZip.loadAsync(arrayBuffer);
      tempDir = path.join(process.env.HOME || "/tmp", ".soulhub", "tmp", `pkg-${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      await extractZipToDir(zip, tempDir);
      packageDir = tempDir;
    } else {
      spinner.fail("Unsupported URL content type. Expected ZIP file.");
      return;
    }
  } else if (source.endsWith(".zip")) {
    // 本地 ZIP 文件
    spinner.text = "Extracting ZIP file...";
    const JSZip = (await import("jszip")).default;
    const zipData = fs.readFileSync(path.resolve(source));
    const zip = await JSZip.loadAsync(zipData);
    tempDir = path.join(process.env.HOME || "/tmp", ".soulhub", "tmp", `pkg-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZipToDir(zip, tempDir);
    packageDir = tempDir;
  } else {
    // 本地目录
    packageDir = path.resolve(source);
    if (!fs.existsSync(packageDir)) {
      spinner.fail(`Directory not found: ${packageDir}`);
      return;
    }
  }

  // 自动识别包类型
  const kind = detectPackageKind(packageDir);
  spinner.text = `Detected package type: ${chalk.blue(kind)}`;

  if (kind === "agent") {
    spinner.stop();
    await installSingleAgentFromDir(packageDir, targetDir, clawDir);
  } else if (kind === "team") {
    spinner.stop();
    await installTeamFromDir(packageDir, targetDir, clawDir);
  } else {
    spinner.fail("Cannot determine package type. Expected soulhub.yaml or IDENTITY.md.");
  }

  // 清理临时目录
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 从本地目录安装单个 agent
 */
async function installSingleAgentFromDir(
  packageDir: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = ora("Installing single agent...").start();

  // 读取 soulhub.yaml 或推断元信息
  const pkg = readSoulHubPackage(packageDir);
  const agentName = pkg?.name || path.basename(packageDir);

  // 1. 检查 OpenClaw
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
  }

  // 2. 确定目标目录（主 workspace）
  let workspaceDir: string;
  if (targetDir) {
    workspaceDir = path.resolve(targetDir);
  } else {
    const resolvedClawDir = findOpenClawDir(clawDir);
    if (!resolvedClawDir) {
      spinner.fail("OpenClaw workspace directory not found.");
      return;
    }
    workspaceDir = getMainWorkspaceDir(resolvedClawDir);
  }

  // 3. 备份
  if (!targetDir) {
    const resolvedClawDir = findOpenClawDir(clawDir)!;
    const mainCheck = checkMainAgentExists(resolvedClawDir);
    if (mainCheck.hasContent) {
      spinner.warn("Existing main agent detected. Backing up...");
      const backupDir = backupAgentWorkspace(workspaceDir);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
      }
    }
  }

  // 4. 确保 workspace 目录存在 + 注册主 agent 到 openclaw.json
  //    备份是 cp（原目录不动），所以如果目录已存在无需重建
  if (!fs.existsSync(workspaceDir)) {
    fs.mkdirSync(workspaceDir, { recursive: true });
  }
  if (!targetDir) {
    spinner.text = `Registering ${chalk.cyan(agentName)} as main agent...`;
    const resolvedClawDir = findOpenClawDir(clawDir)!;
    addAgentToOpenClawConfig(resolvedClawDir, "main", agentName, true);
  }

  // 5. 复制 IDENTITY.md 和 SOUL.md
  spinner.text = `Copying soul files...`;
  copyAgentFilesFromDir(packageDir, workspaceDir);

  recordInstall(agentName, pkg?.version || "local", workspaceDir);

  spinner.succeed(`${chalk.cyan.bold(agentName)} installed as main agent!`);
  console.log();
  console.log(`  ${chalk.dim("Location:")} ${workspaceDir}`);
  console.log(`  ${chalk.dim("Source:")}   ${packageDir}`);
  console.log(`  ${chalk.dim("Type:")}     ${chalk.blue("Single Agent (Main)")}`);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway();
  }
  console.log();
}

/**
 * 从本地目录安装多 Agent 团队
 */
async function installTeamFromDir(
  packageDir: string,
  targetDir?: string,
  clawDir?: string
): Promise<void> {
  const spinner = ora("Installing team...").start();

  // 1. 读取包描述
  const pkg = readSoulHubPackage(packageDir);
  if (!pkg || pkg.kind !== "team") {
    spinner.fail("Invalid team package. Missing soulhub.yaml.");
    return;
  }

  // 2. 检查 OpenClaw
  if (!targetDir) {
    const clawCheck = checkOpenClawInstalled(clawDir);
    if (!clawCheck.installed) {
      spinner.fail("OpenClaw is not installed.");
      printOpenClawInstallHelp();
      return;
    }
  }

  const resolvedClawDir = targetDir ? path.resolve(targetDir) : findOpenClawDir(clawDir);
  if (!resolvedClawDir) {
    spinner.fail("OpenClaw workspace directory not found.");
    return;
  }

  // 3. 安装 dispatcher（主 agent → workspace）
  if (pkg.dispatcher) {
    spinner.text = `Installing dispatcher ${chalk.blue(pkg.dispatcher.name)}...`;

    const mainWorkspace = targetDir
      ? path.join(resolvedClawDir, "workspace")
      : getMainWorkspaceDir(resolvedClawDir);

    // 备份
    if (!targetDir) {
      const mainCheck = checkMainAgentExists(resolvedClawDir);
      if (mainCheck.hasContent) {
        spinner.warn("Existing main agent detected. Backing up...");
        const backupDir = backupAgentWorkspace(mainWorkspace);
        if (backupDir) {
          console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
        }
      }
    }

    // 确保 workspace 目录存在 + 更新 openclaw.json
    //    备份是 cp（原目录不动），所以如果目录已存在无需重建
    if (!fs.existsSync(mainWorkspace)) {
      fs.mkdirSync(mainWorkspace, { recursive: true });
    }
    if (!targetDir) {
      addAgentToOpenClawConfig(resolvedClawDir, "main", pkg.dispatcher.name, true);
    }

    // 复制 dispatcher 文件
    const dispatcherSourceDir = path.join(packageDir, pkg.dispatcher.dir);
    if (fs.existsSync(dispatcherSourceDir)) {
      copyAgentFilesFromDir(dispatcherSourceDir, mainWorkspace);
    }

    recordInstall("dispatcher", pkg.version || "local", mainWorkspace);
  }

  // 4. 安装 worker agents
  const workerIds: string[] = [];

  for (const worker of pkg.agents || []) {
    const agentId = worker.name;
    const agentDir = worker.dir || worker.name;

    spinner.text = `Installing worker ${chalk.cyan(agentId)}...`;

    const workerWorkspace = targetDir
      ? path.join(resolvedClawDir, `workspace-${agentId}`)
      : getWorkspaceDir(resolvedClawDir, agentId);

    // 备份
    const backupDir = backupAgentWorkspace(workerWorkspace);
    if (backupDir) {
      console.log(chalk.yellow(`  ⚠ Existing ${agentId} backed up to: ${backupDir}`));
    }

    // 注册 worker
    if (!targetDir) {
      const regResult = registerAgentToOpenClaw(agentId, workerWorkspace, clawDir);
      if (!regResult.success) {
        console.log(chalk.yellow(`  ⚠ Failed to register ${agentId}: ${regResult.message}`));
        continue;
      }
    } else {
      fs.mkdirSync(workerWorkspace, { recursive: true });
    }

    // 复制 worker 文件
    const workerSourceDir = path.join(packageDir, agentDir);
    if (fs.existsSync(workerSourceDir)) {
      copyAgentFilesFromDir(workerSourceDir, workerWorkspace);
    }

    recordInstall(agentId, pkg.version || "local", workerWorkspace);
    workerIds.push(agentId);
  }

  // 5. 配置多 agent 通信
  if (!targetDir && workerIds.length > 0) {
    spinner.text = "Configuring multi-agent communication...";
    configureMultiAgentCommunication(resolvedClawDir, "main", workerIds);
  }

  spinner.succeed(
    `Team ${chalk.cyan.bold(pkg.name)} installed! (${pkg.dispatcher ? "1 dispatcher + " : ""}${workerIds.length} workers)`
  );
  printTeamSummary(pkg, workerIds);

  // 重启 OpenClaw Gateway
  if (!targetDir) {
    await tryRestartGateway();
  }
}

// ==========================================
// 辅助函数
// ==========================================

/**
 * 从 registry 下载 agent 的 IDENTITY.md、SOUL.md 等文件
 */
async function downloadAgentFiles(
  agentName: string,
  workspaceDir: string,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  // 确保目标目录存在
  fs.mkdirSync(workspaceDir, { recursive: true });

  // 核心文件（IDENTITY.md 和 SOUL.md），下载失败时抛出错误
  const coreFiles = ["IDENTITY.md", "SOUL.md"];
  for (const fileName of coreFiles) {
    const content = await fetchAgentFile(agentName, fileName);
    fs.writeFileSync(path.join(workspaceDir, fileName), content);
    spinner.text = `Downloaded ${fileName}`;
  }

  // 可选的模板文件，下载失败时静默跳过
  const optionalFiles = ["USER.md.template", "TOOLS.md.template"];
  for (const fileName of optionalFiles) {
    try {
      const content = await fetchAgentFile(agentName, fileName);
      const actualName = fileName.replace(".template", "");
      fs.writeFileSync(path.join(workspaceDir, actualName), content);
    } catch {
      // 静默跳过
    }
  }
}

/**
 * 保存 agent manifest 文件
 */
async function saveAgentManifest(
  agentName: string,
  agent: { name: string; displayName: string; description: string; category: string; tags: string[]; version: string; author: string },
  workspaceDir: string
): Promise<void> {
  try {
    const manifestContent = await fetchAgentFile(agentName, "manifest.yaml");
    fs.writeFileSync(path.join(workspaceDir, "manifest.yaml"), manifestContent);
  } catch {
    const manifest = {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      category: agent.category,
      tags: agent.tags,
      version: agent.version,
      author: agent.author,
    };
    fs.writeFileSync(path.join(workspaceDir, "manifest.yaml"), yaml.dump(manifest));
  }
}

/**
 * 从本地目录复制 agent 文件（IDENTITY.md, SOUL.md 等）
 */
function copyAgentFilesFromDir(sourceDir: string, targetDir: string): void {
  const filesToCopy = ["IDENTITY.md", "SOUL.md", "USER.md", "TOOLS.md", "AGENTS.md", "HEARTBEAT.md"];
  for (const fileName of filesToCopy) {
    const sourcePath = path.join(sourceDir, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(sourcePath, path.join(targetDir, fileName));
    }
  }
}

/**
 * 安装 dispatcher（从 registry 下载）
 */
async function installDispatcher(
  dispatcher: { name: string; dir: string },
  resolvedClawDir: string,
  clawDir?: string,
  targetDir?: string,
  spinner?: ReturnType<typeof ora>
): Promise<void> {
  const mainWorkspace = targetDir
    ? path.join(resolvedClawDir, "workspace")
    : getMainWorkspaceDir(resolvedClawDir);

  // 备份
  if (!targetDir) {
    const mainCheck = checkMainAgentExists(resolvedClawDir);
    if (mainCheck.hasContent) {
      if (spinner) spinner.warn("Existing main agent detected. Backing up...");
      const backupDir = backupAgentWorkspace(mainWorkspace);
      if (backupDir) {
        console.log(chalk.yellow(`  ⚠ Existing main agent backed up to: ${backupDir}`));
      }
    }
  }

  // 确保 workspace 目录存在 + 更新 openclaw.json
  //    备份是 cp（原目录不动），所以如果目录已存在无需重建
  if (!fs.existsSync(mainWorkspace)) {
    fs.mkdirSync(mainWorkspace, { recursive: true });
  }
  if (!targetDir) {
    addAgentToOpenClawConfig(resolvedClawDir, "main", dispatcher.name, true);
  }

  // 从 registry 下载 dispatcher 文件
  const templateName = dispatcher.dir || dispatcher.name;
  if (spinner) spinner.text = `Downloading dispatcher files...`;
  await downloadAgentFiles(templateName, mainWorkspace, spinner || ora());

  recordInstall("dispatcher", "1.0.0", mainWorkspace);
}

/**
 * 将 ZIP 文件解压到目录
 */
async function extractZipToDir(
  zip: import("jszip"),
  targetDir: string
): Promise<void> {
  const entries = Object.entries(zip.files);
  for (const [relativePath, file] of entries) {
    const fullPath = path.join(targetDir, relativePath);
    if (file.dir) {
      fs.mkdirSync(fullPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      const content = await file.async("nodebuffer");
      fs.writeFileSync(fullPath, content);
    }
  }
}

/**
 * 打印 OpenClaw 安装帮助信息
 */
function printOpenClawInstallHelp(): void {
  console.log(chalk.dim("  Please install OpenClaw first, or use one of the following options:"));
  console.log(chalk.dim("  --claw-dir <path>    Specify OpenClaw installation directory"));
  console.log(chalk.dim("  --dir <path>         Specify agent target directory directly"));
  console.log(chalk.dim("  OPENCLAW_HOME=<path> Set environment variable"));
  console.log(chalk.dim("  Visit: https://github.com/anthropics/openclaw for installation instructions."));
}

/**
 * 打印团队安装概览
 */
function printTeamSummary(pkg: SoulHubPackage, workerIds: string[]): void {
  console.log();
  if (pkg.dispatcher) {
    console.log(`  ${chalk.blue("⚡ [Dispatcher]")} ${chalk.cyan(pkg.dispatcher.name)} → ${chalk.dim("workspace/")}`);
  }
  for (const id of workerIds) {
    console.log(`  ${chalk.dim("  ✓ [Worker]")}    ${chalk.cyan(id)} → ${chalk.dim(`workspace-${id}/`)}`);
  }
  console.log();
  console.log(`  ${chalk.dim("Type:")}     ${chalk.blue("Multi-Agent Team")}`);
  if (pkg.routing && pkg.routing.length > 0) {
    console.log(`  ${chalk.dim("Routing:")}  ${pkg.routing.length} rules configured`);
  }
  console.log();
}

/**
 * 尝试重启 OpenClaw Gateway
 * 成功时显示成功提示，失败时提示用户手动重启
 */
async function tryRestartGateway(): Promise<void> {
  const restartSpinner = ora("Restarting OpenClaw Gateway...").start();
  const result = restartOpenClawGateway();
  if (result.success) {
    restartSpinner.succeed("OpenClaw Gateway restarted successfully.");
  } else {
    restartSpinner.warn("Failed to restart OpenClaw Gateway.");
    console.log(chalk.yellow(`  Reason: ${result.message}`));
    console.log(chalk.dim("  Please restart manually:"));
    console.log(chalk.dim("    openclaw gateway restart"));
  }
}


