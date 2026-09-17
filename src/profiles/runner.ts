import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Profile } from "../types.js";
import { PROVIDER_API_KEY_ARG, providerTokenEnvVar } from "../types.js";
import { AGENT_CONFIG_FILE, AGENT_DIR, readYaml } from "../config.js";
import { materializeProfile, resolveEffectiveProvider } from "./materializer.js";
import * as logger from "../logger.js";

export const BUILT_IN_DEFAULT = "__builtin__";

const WIN_OMP = process.platform === "win32" ? "omp.cmd" : "omp";

/** Find the `omp` binary on PATH; throws with an install hint if missing. */
export function resolveOmpBinary(): string {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, WIN_OMP);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep searching
    }
  }
  throw new Error(
    "Could not find the 'omp' binary on PATH. Install omp first: https://omp.sh"
  );
}

/**
 * omp's built-in profile mechanism (--profile / OMP_PROFILE / PI_PROFILE)
 * would isolate state on its own terms and fight the hub-managed
 * PI_CODING_AGENT_DIR, so it is always stripped from the child env.
 */
function stripProfileEnv(env: Record<string, string | undefined>): void {
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;
}

function sourceDefaultProvider(): string | undefined {
  try {
    if (fs.existsSync(AGENT_CONFIG_FILE)) {
      const config = readYaml<{ defaultProvider?: string }>(AGENT_CONFIG_FILE);
      return config?.defaultProvider;
    }
  } catch {
    // fall through
  }
  try {
    const legacy = path.join(AGENT_DIR, "settings.json");
    if (fs.existsSync(legacy)) {
      return (JSON.parse(fs.readFileSync(legacy, "utf-8")) as { defaultProvider?: string })
        .defaultProvider;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * omp v18 stores credentials in the agent dir's agent.db (auth_credentials
 * table); a fresh profile dir has none, so env-var keys are honoured. Inject
 * the profile token as `<PROVIDER>_API_KEY` for the effective provider.
 * Returns the env var name used, or undefined when nothing was injected.
 */
function injectTokenEnv(
  env: Record<string, string | undefined>,
  profileName: string,
  p: Profile
): string | undefined {
  if (!p.token) return undefined;
  const provider = resolveEffectiveProvider(p, {
    defaultProvider: sourceDefaultProvider(),
  });
  if (!provider) {
    console.error(
      `Warning: profile '${profileName}' has a token but no provider could be determined ` +
        "(no -p flag, no provider/model id, no defaultProvider in agent config). " +
        "The token was not injected; omp will not find it."
    );
    return undefined;
  }
  const envVar = providerTokenEnvVar(provider);
  env[envVar] = p.token;
  return envVar;
}

export function execOmpBuiltIn(extraArgs: string[]): void {
  const binary = resolveOmpBinary();
  const cmd = [binary, ...extraArgs];

  // No PI_CODING_AGENT_DIR override: run against whatever the user already has.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.PI_CODING_AGENT_DIR;
  stripProfileEnv(env);

  logger.info(`Launching omp with built-in config: binary=${binary}`);

  const result = spawnSync(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}

export function execOmp(profileName: string, p: Profile, extraArgs: string[]): void {
  const dir = materializeProfile(profileName, p);
  const binary = resolveOmpBinary();

  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_CODING_AGENT_DIR: dir,
  };
  stripProfileEnv(env);

  const models = p.models || (p.model ? [p.model] : []);
  const provider = p.token
    ? resolveEffectiveProvider(p, { defaultProvider: sourceDefaultProvider() })
    : undefined;

  // Profile-supplied args go BEFORE user args so explicit user flags win.
  // Providers in PROVIDER_API_KEY_ARG only accept the token via --api-key
  // (never from env); omp requires an explicit --model whenever --api-key
  // is passed, so the profile's first model goes with it.
  const profileArgs: string[] = [];
  let tokenEnvVar: string | undefined;
  if (p.token && provider && PROVIDER_API_KEY_ARG.has(provider)) {
    if (models[0]) {
      profileArgs.push("--api-key", p.token, "--model", models[0]);
      // Also inject the provider's env var: omp subcommands like `omp models`
      // only read env vars, not the --api-key flag (the launch/auth path uses
      // the flag — env-var auth alone is client-side-rejected for these).
      tokenEnvVar = providerTokenEnvVar(provider);
      env[tokenEnvVar] = p.token;
    } else {
      console.error(
        `Warning: profile '${profileName}' uses provider '${provider}', whose token must be ` +
          `passed via omp's --api-key flag — and --api-key requires an explicit model. ` +
          `Set one with: omp-hub profile update ${profileName} -m <model>`
      );
    }
  } else {
    tokenEnvVar = injectTokenEnv(env, profileName, p);
  }

  const cmd = [binary, ...profileArgs, ...extraArgs];

  logger.info(
    `Launching omp with profile '${profileName}': provider=${p.provider || "(default)"} model=${models[0] || "(default)"} thinking=${p.thinking || "(default)"} url=${p.url || "(default)"} tokenEnv=${tokenEnvVar || "(none)"} apiKeyArg=${profileArgs.length > 0} dir=${dir} binary=${binary}`
  );

  const result = spawnSync(cmd[0], cmd.slice(1), {
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  process.exit(result.status ?? 1);
}
