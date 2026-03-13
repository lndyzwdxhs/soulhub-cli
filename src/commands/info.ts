import { Command } from "commander";
import chalk from "chalk";
import { fetchIndex, downloadAgentPackage, CATEGORY_LABELS } from "../utils.js";
import { logger } from "../logger.js";

export const infoCommand = new Command("info")
  .description("Show details of an agent (identity, soul, skills, etc.)")
  .argument("<name>", "Agent name")
  .option("--identity", "Show IDENTITY.md content")
  .option("--soul", "Show SOUL.md content")
  .action(async (name: string, options) => {
    try {
      const index = await fetchIndex();
      const agent = index.agents.find((a) => a.name === name);

      if (!agent) {
        console.error(chalk.red(`Agent "${name}" not found.`));
        console.log(
          chalk.dim(`  Use 'soulhub search' to find available agents.`)
        );
        process.exit(1);
      }

      const category =
        CATEGORY_LABELS[agent.category] || agent.category;

      console.log();
      console.log(chalk.bold.cyan(`  ${agent.displayName}`));
      console.log(chalk.dim(`  ${agent.name} v${agent.version}`));
      console.log();
      console.log(`  ${agent.description}`);
      console.log();
      console.log(
        `  ${chalk.dim("Category:")}  ${category}`
      );
      console.log(
        `  ${chalk.dim("Author:")}    ${agent.author}`
      );
      console.log(
        `  ${chalk.dim("Tags:")}      ${agent.tags.join(", ")}`
      );
      console.log(
        `  ${chalk.dim("Min Claw:")}  ${agent.minClawVersion}`
      );
      console.log(
        `  ${chalk.dim("Downloads:")} ${agent.downloads}`
      );

      // Files
      console.log();
      console.log(chalk.dim("  Files:"));
      for (const [fileName, size] of Object.entries(agent.files)) {
        const sizeStr =
          size > 1024
            ? `${(size / 1024).toFixed(1)} KB`
            : `${size} B`;
        console.log(`    ${fileName} ${chalk.dim(`(${sizeStr})`)}`);
      }

      // Show file contents if requested
      if (options.identity || options.soul) {
        // 下载 agent 包到临时目录，然后读取文件内容
        const fs = await import("node:fs");
        const pkgDir = await downloadAgentPackage(name, agent.version);
        try {
          if (options.identity) {
            console.log();
            console.log(chalk.bold("  ── IDENTITY.md ──"));
            console.log();
            const identityPath = (await import("node:path")).default.join(pkgDir, "IDENTITY.md");
            if (fs.default.existsSync(identityPath)) {
              const content = fs.default.readFileSync(identityPath, "utf-8");
              console.log(
                content
                  .split("\n")
                  .map((l: string) => `  ${l}`)
                  .join("\n")
              );
            } else {
              console.log(chalk.dim("  (IDENTITY.md not found in package)"));
            }
          }

          if (options.soul) {
            console.log();
            console.log(chalk.bold("  ── SOUL.md ──"));
            console.log();
            const soulPath = (await import("node:path")).default.join(pkgDir, "SOUL.md");
            if (fs.default.existsSync(soulPath)) {
              const content = fs.default.readFileSync(soulPath, "utf-8");
              console.log(
                content
                  .split("\n")
                  .map((l: string) => `  ${l}`)
                  .join("\n")
              );
            } else {
              console.log(chalk.dim("  (SOUL.md not found in package)"));
            }
          }
        } finally {
          // 清理临时目录
          fs.default.rmSync(pkgDir, { recursive: true, force: true });
        }
      }

      console.log();
      console.log(
        chalk.dim(`  Install: soulhub install ${name}`)
      );
      console.log();
    } catch (error) {
      logger.errorObj("Info command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });
