import { Command } from "commander";
import { createRequire } from "module";
import { profileCommand, useCommand, runCommand } from "./profiles/index.js";
import { completionCommand } from "./complete/index.js";
import { installGlobalExceptionHandlers, setLogLevel } from "./logger.js";

const _require = createRequire(import.meta.url);
const { version } = _require("../package.json") as { version: string };

// --verbose flag on the raw argv (actions run during parse, so check up front)
if (process.argv.includes("--verbose")) {
  setLogLevel("DEBUG");
} else if (process.env.OMP_HUB_LOG_LEVEL) {
  setLogLevel(process.env.OMP_HUB_LOG_LEVEL);
}

installGlobalExceptionHandlers();

const program = new Command();

program
  .name("omp-hub")
  .description("Manage omp (oh-my-pi) coding agent profiles (provider, model, token, base URL)")
  .version(version);

program.addCommand(profileCommand());
program.addCommand(useCommand());
program.addCommand(runCommand());
program.addCommand(completionCommand());

try {
  program.parse();
} catch (err) {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
