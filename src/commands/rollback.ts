import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { createSpinner } from "../spinner.js";
import { logger } from "../logger.js";
import {
  loadBackupManifest,
  saveBackupManifest,
  findOpenClawDir,
  writeOpenClawConfig,
  restartOpenClawGateway,
  getMainWorkspaceDir,
  getWorkspaceDir,
  detectClawBrand,
  detectClawCommand,
  promptSelectClawDir,
} from "../utils.js";
import type { BackupRecord } from "../types.js";

export const rollbackCommand = new Command("rollback")
  .description("Rollback to a previous agent installation state")
  .option("--list", "List available rollback records")
  .option("--id <id>", "Rollback to a specific backup record by ID")
  .option(
    "--clawtype <type>",
    "Specify claw type: OpenClaw or LightClaw (case-insensitive)"
  )
  .action(async (options) => {
    try {
      if (options.list) {
        listBackupRecords();
      } else if (options.id) {
        await performRollback(options.id, options.clawtype);
      } else {
        // 默认回滚到最近一次安装前的状态
        await performRollback(undefined, options.clawtype);
      }
    } catch (error) {
      logger.errorObj("Rollback command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });

/**
 * 列出所有可用的备份记录
 */
function listBackupRecords(): void {
  const manifest = loadBackupManifest();

  if (manifest.records.length === 0) {
    console.log(chalk.yellow("No backup records found."));
    console.log(chalk.dim("  Backup records are created automatically when you install agents."));
    return;
  }

  console.log(chalk.bold("\nAvailable rollback records:\n"));
  console.log(
    chalk.dim(
      `  ${"ID".padEnd(20)} ${"Type".padEnd(20)} ${"Package".padEnd(20)} ${"Date".padEnd(22)} Items`
    )
  );
  console.log(chalk.dim("  " + "─".repeat(90)));

  for (const record of manifest.records) {
    const date = new Date(record.createdAt).toLocaleString();
    const typeLabel = formatInstallType(record.installType);
    const itemCount = record.items.length;

    console.log(
      `  ${chalk.cyan(record.id.padEnd(20))} ${typeLabel.padEnd(20)} ${chalk.white(record.packageName.padEnd(20))} ${chalk.dim(date.padEnd(22))} ${itemCount} backup(s)`
    );
  }

  console.log();
  console.log(chalk.dim("  Usage:"));
  console.log(chalk.dim("    soulhub rollback              # Rollback last installation"));
  console.log(chalk.dim("    soulhub rollback --id <id>    # Rollback to a specific record"));
  console.log();
}

/**
 * 执行回滚操作
 */
async function performRollback(
  recordId?: string,
  clawDir?: string
): Promise<void> {
  const manifest = loadBackupManifest();

  if (manifest.records.length === 0) {
    console.log(chalk.yellow("No backup records found. Nothing to rollback."));
    return;
  }

  // 查找目标记录
  let record: BackupRecord | undefined;
  if (recordId) {
    record = manifest.records.find((r) => r.id === recordId);
    if (!record) {
      console.error(chalk.red(`Backup record "${recordId}" not found.`));
      console.log(chalk.dim("  Use 'soulhub rollback --list' to see available records."));
      return;
    }
  } else {
    record = manifest.records[0]; // 最近一条
    console.log(
      chalk.dim(
        `Rolling back last installation: ${chalk.cyan(record.id)} (${record.packageName})`
      )
    );
  }

  const spinner = createSpinner(
    `Rolling back ${chalk.cyan(record.packageName)}...`
  ).start();

  const resolvedClawDir = clawDir
    ? (findOpenClawDir(clawDir) || record.clawDir)
    : (await promptSelectClawDir() || record.clawDir);
  if (!resolvedClawDir || !fs.existsSync(resolvedClawDir)) {
    spinner.fail(`OpenClaw/LightClaw directory not found: ${record.clawDir}`);
    return;
  }

  const brand = detectClawBrand(resolvedClawDir);

  // 1. 恢复 openclaw.json / lightclaw.json 快照
  if (record.openclawJsonSnapshot) {
    spinner.text = `Restoring ${brand.toLowerCase()}.json...`;
    try {
      const configObj = JSON.parse(record.openclawJsonSnapshot);
      writeOpenClawConfig(resolvedClawDir, configObj);
      logger.info(`${brand.toLowerCase()}.json restored from snapshot`, { recordId: record.id });
    } catch (err) {
      logger.error(`Failed to restore ${brand.toLowerCase()}.json`, { error: err });
      console.log(chalk.yellow(`  ⚠ Failed to restore ${brand.toLowerCase()}.json, skipping...`));
    }
  }

  // 2. 清理新安装的 worker 目录
  if (record.installedWorkerIds.length > 0) {
    spinner.text = "Removing installed workers...";
    for (const workerId of record.installedWorkerIds) {
      const workerDir = getWorkspaceDir(resolvedClawDir, workerId);
      if (fs.existsSync(workerDir)) {
        fs.rmSync(workerDir, { recursive: true, force: true });
        logger.info(`Removed installed worker directory`, { workerId, dir: workerDir });
      }
      // 同时清理 agents/ 下的目录
      const agentConfigDir = path.join(resolvedClawDir, "agents", workerId);
      if (fs.existsSync(agentConfigDir)) {
        fs.rmSync(agentConfigDir, { recursive: true, force: true });
      }
    }
  }

  // 3. 清理新安装的主 agent 文件（如果有备份的话，后续会恢复）
  if (record.installedMainAgent) {
    const mainWorkspace = getMainWorkspaceDir(resolvedClawDir);
    // 只有在有备份可恢复的情况下，才清理当前的主 workspace
    const hasMainBackup = record.items.some((item) => item.role === "main");
    if (hasMainBackup && fs.existsSync(mainWorkspace)) {
      spinner.text = "Cleaning current main workspace...";
      // 清空目录内容，但保留目录本身
      const entries = fs.readdirSync(mainWorkspace);
      for (const entry of entries) {
        fs.rmSync(path.join(mainWorkspace, entry), { recursive: true, force: true });
      }
    }
  }

  // 4. 恢复备份的目录
  let restoredCount = 0;
  for (const item of record.items) {
    if (!fs.existsSync(item.backupPath)) {
      logger.warn(`Backup path not found, skipping`, { backupPath: item.backupPath });
      console.log(chalk.yellow(`  ⚠ Backup not found: ${item.backupPath}, skipping...`));
      continue;
    }

    spinner.text = `Restoring ${chalk.cyan(item.agentId)} (${item.role})...`;

    if (item.method === "mv") {
      // mv 备份：将备份目录移回原位
      // 如果原位已有目录，先删除
      if (fs.existsSync(item.originalPath)) {
        fs.rmSync(item.originalPath, { recursive: true, force: true });
      }
      // 确保父目录存在
      fs.mkdirSync(path.dirname(item.originalPath), { recursive: true });
      fs.renameSync(item.backupPath, item.originalPath);
      logger.info(`Restored (mv back)`, { from: item.backupPath, to: item.originalPath });
    } else {
      // cp 备份：从备份目录复制回去
      if (fs.existsSync(item.originalPath)) {
        // 清空原目录
        const entries = fs.readdirSync(item.originalPath);
        for (const entry of entries) {
          fs.rmSync(path.join(item.originalPath, entry), { recursive: true, force: true });
        }
      } else {
        fs.mkdirSync(item.originalPath, { recursive: true });
      }
      fs.cpSync(item.backupPath, item.originalPath, { recursive: true });
      // 删除备份副本
      fs.rmSync(item.backupPath, { recursive: true, force: true });
      logger.info(`Restored (cp back)`, { from: item.backupPath, to: item.originalPath });
    }

    restoredCount++;
  }

  // 5. 从 manifest 中移除已回滚的记录
  manifest.records = manifest.records.filter((r) => r.id !== record!.id);
  saveBackupManifest(manifest);

  spinner.succeed(
    `Rolled back ${chalk.cyan.bold(record.packageName)} successfully! (${restoredCount} item(s) restored)`
  );

  // 6. 重启 OpenClaw/LightClaw Gateway
  const clawCmd = detectClawCommand();
  const brandName = clawCmd === "lightclaw" ? "LightClaw" : "OpenClaw";
  const restartSpinner = createSpinner(`Restarting ${brandName} Gateway...`).start();
  const result = restartOpenClawGateway();
  if (result.success) {
    restartSpinner.succeed(`${brandName} Gateway restarted successfully.`);
  } else {
    restartSpinner.warn(`Failed to restart ${brandName} Gateway.`);
    console.log(chalk.yellow(`  Reason: ${result.message}`));
    console.log(chalk.dim("  Please restart manually:"));
    console.log(chalk.dim(`    ${clawCmd} gateway restart`));
  }

  console.log();
}

/**
 * 格式化安装类型显示
 */
function formatInstallType(type: BackupRecord["installType"]): string {
  switch (type) {
    case "single-agent":
      return chalk.blue("Single Agent");
    case "team-registry":
      return chalk.magenta("Team (Registry)");
    case "team-local":
      return chalk.magenta("Team (Local)");
    case "single-agent-local":
      return chalk.blue("Agent (Local)");
    default:
      return type;
  }
}
