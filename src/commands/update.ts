import { Command } from "commander";
import chalk from "chalk";
import { createSpinner } from "../spinner.js";
import fs from "node:fs";
import {
  loadConfig,
  saveConfig,
  fetchIndex,
  downloadAgentPackage,
  copyAgentFilesFromPackage,
  backupAgentWorkspace,
  createBackupRecord,
  addBackupItem,
  commitBackupRecord,
} from "../utils.js";
import { logger } from "../logger.js";

export const updateCommand = new Command("update")
  .description("Update installed agents to latest versions")
  .argument("[name]", "Agent name to update (updates all if omitted)")
  .action(async (name?: string) => {
    try {
      const config = loadConfig();

      if (config.installed.length === 0) {
        console.log(chalk.yellow("\n  No agents installed.\n"));
        return;
      }

      const spinner = createSpinner("Checking for updates...").start();
      const index = await fetchIndex();

      const toUpdate = name
        ? config.installed.filter((a) => a.name === name)
        : config.installed;

      if (toUpdate.length === 0) {
        spinner.fail(`Agent "${name}" is not installed.`);
        return;
      }

      let updated = 0;

      for (const installed of toUpdate) {
        const remote = index.agents.find(
          (a) => a.name === installed.name
        );
        if (!remote) {
          spinner.text = `${installed.name}: not found in registry, skipping`;
          continue;
        }

        if (remote.version === installed.version) {
          continue; // Already up to date
        }

        spinner.text = `Updating ${chalk.cyan(installed.name)} (${installed.version} → ${remote.version})...`;

        // 备份当前 workspace（更新失败可回滚）
        const workspaceDir = installed.workspace;
        const backupDir = backupAgentWorkspace(workspaceDir);
        if (backupDir) {
          // 创建备份记录
          const backupRecord = createBackupRecord("single-agent", installed.name, workspaceDir);
          addBackupItem(backupRecord, {
            originalPath: workspaceDir,
            backupPath: backupDir,
            method: "cp",
            role: "worker",
            agentId: installed.name,
          });
          commitBackupRecord(backupRecord);
          logger.info(`Update backup created for ${installed.name}`, { backupDir });
        }

        // 下载新版 agent tar.gz 包并解压覆盖
        if (!fs.existsSync(workspaceDir)) {
          fs.mkdirSync(workspaceDir, { recursive: true });
        }

        const pkgDir = await downloadAgentPackage(installed.name, remote.version);
        copyAgentFilesFromPackage(pkgDir, workspaceDir);
        fs.rmSync(pkgDir, { recursive: true, force: true });

        // Update version in config
        installed.version = remote.version;
        installed.installedAt = new Date().toISOString();
        updated++;
      }

      saveConfig(config);

      if (updated === 0) {
        spinner.succeed("All agents are up to date.");
      } else {
        logger.info(`Updated ${updated} agent(s)`);
        spinner.succeed(`Updated ${updated} agent(s).`);
      }
      console.log();
    } catch (error) {
      logger.errorObj("Update command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });
