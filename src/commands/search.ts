import { Command } from "commander";
import chalk from "chalk";
import { fetchIndex, CATEGORY_LABELS } from "../utils.js";
import { logger } from "../logger.js";

export const searchCommand = new Command("search")
  .description("Search for agents in the SoulHub registry")
  .argument("[query]", "Search query (matches name, description, tags)")
  .option("-c, --category <category>", "Filter by category")
  .option("-n, --limit <number>", "Max results to show", "20")
  .option("--json", "Output results in JSON format")
  .action(async (query: string | undefined, options) => {
    try {
      const index = await fetchIndex();
      let agents = index.agents;

      // Filter by category
      if (options.category) {
        agents = agents.filter(
          (a) => a.category === options.category
        );
      }

      // Filter by query
      if (query) {
        const q = query.toLowerCase();
        agents = agents.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            a.displayName.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q) ||
            a.tags.some((t) => t.toLowerCase().includes(q))
        );
      }

      // Limit results
      const limit = parseInt(options.limit, 10);
      const shown = agents.slice(0, limit);

      if (shown.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([], null, 2));
        } else {
          console.log(chalk.yellow("No agents found matching your query."));
          if (query) {
            console.log(
              chalk.dim(`  Try: soulhub search (without query to list all)`)
            );
          }
        }
        return;
      }

      // JSON 输出模式
      if (options.json) {
        const jsonOutput = shown.map((a) => ({
          name: a.name,
          displayName: a.displayName,
          version: a.version,
          description: a.description,
          category: a.category,
          tags: a.tags,
        }));
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      console.log(
        chalk.bold(`\n  Found ${agents.length} agent(s):\n`)
      );

      for (const agent of shown) {
        const category =
          CATEGORY_LABELS[agent.category] || agent.category;
        console.log(
          `  ${chalk.cyan.bold(agent.name)} ${chalk.dim(`v${agent.version}`)}`
        );
        console.log(
          `  ${agent.displayName} - ${agent.description}`
        );
        console.log(
          `  ${chalk.dim(`[${category}]`)} ${chalk.dim(agent.tags.join(", "))}`
        );
        console.log();
      }

      if (agents.length > limit) {
        console.log(
          chalk.dim(
            `  ... and ${agents.length - limit} more. Use --limit to show more.`
          )
        );
      }

      console.log(
        chalk.dim(`  Install: soulhub install <name>`)
      );
      console.log();
    } catch (error) {
      logger.errorObj("Search command failed", error);
      console.error(
        chalk.red(`Error: ${error instanceof Error ? error.message : error}`)
      );
      console.error(chalk.dim(`  See logs: ${logger.getTodayLogFile()}`));
      process.exit(1);
    }
  });
