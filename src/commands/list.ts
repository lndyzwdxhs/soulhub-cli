import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, CATEGORY_LABELS } from "../utils.js";
import { logger } from "../logger.js";

export const listCommand = new Command("list")
  .description("List installed agents")
  .alias("ls")
  .option("--json", "Output results in JSON format")
  .action(async (options) => {
    try {
      const config = loadConfig();

      if (config.installed.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow("\n  No agents installed yet.\n"));
          console.log(
            chalk.dim("  Install one: soulhub install <name>")
          );
          console.log(
            chalk.dim("  Browse all:  soulhub search\n")
          );
        }
        return;
      }

      // JSON 输出模式
      if (options.json) {
        const jsonOutput = config.installed.map((a) => ({
          name: a.name,
          version: a.version,
          installedAt: a.installedAt,
          workspace: a.workspace,
        }));
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      console.log(
        chalk.bold(`\n  Installed agents (${config.installed.length}):\n`)
      );

      for (const agent of config.installed) {
        const date = new Date(agent.installedAt).toLocaleDateString();
        console.log(
          `  ${chalk.cyan.bold(agent.name)} ${chalk.dim(`v${agent.version}`)}`
        );
        console.log(
          `  ${chalk.dim("Installed:")} ${date}  ${chalk.dim("Location:")} ${agent.workspace}`
        );
        console.log();
      }
    } catch (error) {
      logger.errorObj("List command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });
