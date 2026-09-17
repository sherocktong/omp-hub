import { Command, Argument } from "commander";
import { ZSH_COMPLETION } from "./zsh.js";
import { BASH_COMPLETION } from "./bash.js";
import { safeAction } from "../logger.js";

export function completionCommand(): Command {
  return new Command("completion")
    .description("Print shell completion script")
    .addArgument(new Argument("<shell>", "Shell type: bash or zsh").choices(["bash", "zsh"]))
    .action(safeAction((shell: string) => {
      switch (shell) {
        case "zsh":
          process.stdout.write(ZSH_COMPLETION);
          break;
        case "bash":
          process.stdout.write(BASH_COMPLETION);
          break;
        default:
          console.error(`Unsupported shell: ${shell}. Use 'bash' or 'zsh'.`);
          process.exit(1);
      }
    }));
}
