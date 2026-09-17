import { Command } from "commander";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import {
  PROFILES_FILE,
  ensureProfilesFile,
  readJson,
  writeJson,
} from "../config.js";
import type { ProfilesData, Profile } from "../types.js";
import { OMP_PROVIDERS, THINKING_LEVELS } from "../types.js";
import { BUILT_IN_DEFAULT, execOmp, execOmpBuiltIn, resolveOmpBinary } from "./runner.js";
import { profileDirFor, materializeProfile, removeProfileDir } from "./materializer.js";
import { safeAction } from "../logger.js";
import * as logger from "../logger.js";

function maskToken(token: string): string {
  if (!token) return "(unset)";
  if (token.length <= 12) return token;
  return token.slice(0, 8) + "..." + token.slice(-4);
}

function formatModels(p: Profile): string {
  const models = p.models || (p.model ? [p.model] : []);
  if (models.length === 0) return "(unset)";
  const joined = models.join(", ");
  if (joined.length > 28) {
    return models[0] + ", +" + (models.length - 1) + " more";
  }
  return joined;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function warnUnknownProvider(provider?: string): void {
  if (provider && !OMP_PROVIDERS.includes(provider)) {
    console.error(`Warning: '${provider}' is not a known omp provider id. Continuing anyway.`);
  }
}

function validateThinking(thinking?: string): void {
  if (thinking && !THINKING_LEVELS.includes(thinking)) {
    throw new Error(
      `Invalid thinking level '${thinking}'. Valid levels: ${THINKING_LEVELS.join(", ")}.`
    );
  }
}

function warnMissingProvider(p: Profile): void {
  if ((p.token || p.url) && !p.provider) {
    console.error(
      "Warning: no provider set (-p). At run time the token/url will be keyed under " +
        "your default omp provider (or the provider/model id prefix), which may not be what you intend."
    );
  }
}

/**
 * Returns the models (of the given list) that omp's catalog does not know.
 * Unknown models fail at request time with a confusing auth error, so warn early.
 * Returns an empty list (silently) when the omp binary can't be queried.
 *
 * The catalog omp reports depends on the agent dir it runs against: without a
 * profile dir it only lists the default provider's models, which would
 * false-positive flag every other provider's models. So when a profile name
 * is given, point PI_CODING_AGENT_DIR at the profile's materialized dir (or
 * strip an inherited PI_CODING_AGENT_DIR if the dir doesn't exist yet).
 */
export function findUnknownModels(models: string[], profileName?: string): string[] {
  let binary: string;
  try {
    binary = resolveOmpBinary();
  } catch {
    return [];
  }
  const env = { ...process.env };
  if (profileName) {
    const dir = profileDirFor(profileName);
    if (fs.existsSync(dir)) {
      env.PI_CODING_AGENT_DIR = dir;
    } else {
      delete env.PI_CODING_AGENT_DIR;
    }
  }
  const result = spawnSync(binary, ["models", "--json"], { encoding: "utf-8", env });
  if (result.status !== 0 || !result.stdout) {
    return [];
  }
  let parsed: { models?: unknown[] };
  try {
    parsed = JSON.parse(result.stdout) as { models?: unknown[] };
  } catch {
    return [];
  }
  // An empty catalog means omp's models.db cache has nothing to validate
  // against (e.g. a stale agent dir), not that every model is unknown —
  // skip validation rather than warn about every model.
  if (!parsed.models || parsed.models.length === 0) return [];
  const known = new Set<string>();
  for (const entry of parsed.models || []) {
    if (entry && typeof entry === "object") {
      const m = entry as Record<string, unknown>;
      const provider = typeof m.provider === "string" ? m.provider : undefined;
      for (const key of ["id", "name", "model"]) {
        const value = m[key];
        if (typeof value === "string" && value) {
          known.add(value);
          if (provider) known.add(`${provider}/${value}`);
        }
      }
    } else if (typeof entry === "string") {
      known.add(entry);
    }
  }
  return models.filter(m => m && !known.has(m));
}

function warnUnknownModels(models: string[], profileName?: string): void {
  const unknown = findUnknownModels(models, profileName);
  if (unknown.length > 0) {
    console.error(
      `Warning: ${unknown.length === 1 ? "model" : "models"} not in omp's catalog: ${unknown.join(", ")}. ` +
        "Requests for unknown models may fail with a misleading auth error."
    );
  }
}

interface ProfileOptions {
  model?: string[];
  deleteModel?: string[];
  token?: string;
  url?: string;
  provider?: string;
  thinking?: string;
  set?: string[];
  unset?: string[];
}

/** Parse a key=value string into a JSON value when possible (numbers, booleans,
 * null, objects, arrays, quoted strings), falling back to the raw string. */
function parseSetValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function applySetOption(p: Profile, kv: string): void {
  const idx = kv.indexOf("=");
  if (idx === -1) {
    throw new Error(`Error: --set expects key=value, got '${kv}'.`);
  }
  const key = kv.slice(0, idx).trim();
  if (!key) {
    throw new Error(`Error: --set expects a non-empty key, got '${kv}'.`);
  }
  p.settings = p.settings || {};
  p.settings[key] = parseSetValue(kv.slice(idx + 1));
}

function applyUnsetOption(p: Profile, key: string): void {
  if (p.settings) {
    delete p.settings[key];
    if (Object.keys(p.settings).length === 0) {
      delete p.settings;
    }
  }
}

function applyProfileOptions(p: Profile, opts: ProfileOptions): void {
  if (opts.token) p.token = opts.token;
  if (opts.url) p.url = opts.url;
  if (opts.provider) {
    warnUnknownProvider(opts.provider);
    p.provider = opts.provider;
  }
  if (opts.thinking) {
    validateThinking(opts.thinking);
    p.thinking = opts.thinking;
  }
  if (opts.set) {
    for (const kv of opts.set) applySetOption(p, kv);
  }
  if (opts.unset) {
    for (const key of opts.unset) applyUnsetOption(p, key);
  }
}

const MODEL_OPTION = "-m, --model <model>";
const TOKEN_OPTION = "-t, --token <token>";
const URL_OPTION = "-u, --url <url>";
const PROVIDER_OPTION = "-p, --provider <id>";
const THINKING_OPTION = "--thinking <level>";
const SET_OPTION = "--set <key=value>";
const UNSET_OPTION = "--unset <key>";
const SET_DESCRIPTION =
  "config.yml override (repeatable); value parsed as JSON when possible (e.g. --set foo=null removes foo)";

export function profileCommand(): Command {
  const profile = new Command("profile")
    .description("Manage omp agent profiles");

  // --- add ---
  profile
    .command("add")
    .description("Add or update a profile")
    .argument("<name>", "Profile name")
    .option(MODEL_OPTION, "Model ID - can be used multiple times (max 3)", collect, [])
    .option(TOKEN_OPTION, "API key / token")
    .option(URL_OPTION, "Base URL (works for any provider via models.yml override)")
    .option(PROVIDER_OPTION, "omp provider id (e.g. kimi-code, anthropic, openai)")
    .option(THINKING_OPTION, `Thinking level: ${THINKING_LEVELS.join("|")}`)
    .option(SET_OPTION, SET_DESCRIPTION, collect, [])
    .option(UNSET_OPTION, "remove a config.yml override - can be used multiple times", collect, [])
    .action(safeAction((name: string, opts: ProfileOptions) => {
      const models = opts.model && opts.model.length > 0 ? opts.model : undefined;
      if (models && models.length > 3) {
        throw new Error("Error: A profile can have at most 3 models.");
      }
      validateThinking(opts.thinking);
      warnUnknownProvider(opts.provider);

      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);
      const profile = data.profiles[name] || {};

      if (models) {
        profile.models = models;
        profile.model = models[0];
      }
      applyProfileOptions(profile, opts);
      warnMissingProvider(profile);
      if (models) {
        // Materialize first so the catalog check runs against this profile's
        // agent dir (omp models only lists the default provider's models).
        try {
          materializeProfile(name, profile);
        } catch (err) {
          logger.debug(`profile add: materialize before model check failed: ${err}`);
        }
        warnUnknownModels(models, name);
      }

      data.profiles[name] = profile;
      writeJson(PROFILES_FILE, data, 0o600);
      fs.chmodSync(PROFILES_FILE, 0o600);
      logger.debug(`profile add: wrote ${PROFILES_FILE}`);
      console.log(`Profile '${name}' saved.`);
    }));

  // --- update ---
  profile
    .command("update")
    .description("Update fields of an existing profile")
    .argument("<name>", "Profile name (must already exist)")
    .option(MODEL_OPTION, "Model ID - can be used multiple times", collect, [])
    .option("-d, --delete-model <model>", "Remove model ID - can be used multiple times", collect, [])
    .option(TOKEN_OPTION, "API key / token")
    .option(URL_OPTION, "Base URL")
    .option(PROVIDER_OPTION, "omp provider id")
    .option(THINKING_OPTION, `Thinking level: ${THINKING_LEVELS.join("|")}`)
    .option(SET_OPTION, SET_DESCRIPTION, collect, [])
    .option(UNSET_OPTION, "remove a config.yml override - can be used multiple times", collect, [])
    .action(safeAction((name: string, opts: ProfileOptions) => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);
      if (!data.profiles[name]) {
        throw new Error(`Profile '${name}' not found. Use 'profile add' to create it.`);
      }
      const p = data.profiles[name];

      const providedModels = opts.model && opts.model.length > 0 ? opts.model : undefined;
      const modelsToDelete = opts.deleteModel && opts.deleteModel.length > 0 ? opts.deleteModel : undefined;

      if (modelsToDelete) {
        const toRemove = new Set(modelsToDelete);
        const currentModels = p.models || (p.model ? [p.model] : []);
        const newModels = currentModels.filter(m => !toRemove.has(m));
        const removedCount = currentModels.length - newModels.length;

        if (removedCount === 0) {
          console.log(`No matching models to remove from profile '${name}'.`);
        } else if (newModels.length === 0) {
          delete p.models;
          delete p.model;
          console.log(`Removed all models from profile '${name}'.`);
        } else {
          p.models = newModels;
          p.model = newModels[0];
          console.log(`Removed ${removedCount} model(s) from profile '${name}'.`);
        }
      }

      if (providedModels) {
        if (providedModels.length === 1) {
          const modelToSet = providedModels[0];
          const currentModels = p.models || (p.model ? [p.model] : []);
          const existingIndex = currentModels.indexOf(modelToSet);

          if (existingIndex !== -1) {
            currentModels.splice(existingIndex, 1);
            currentModels.unshift(modelToSet);
            p.models = currentModels;
            p.model = modelToSet;
            console.log(`Selected existing model '${modelToSet}' (position ${existingIndex + 1} -> 1).`);
          } else {
            currentModels.unshift(modelToSet);
            p.models = currentModels;
            p.model = modelToSet;
            console.log(`Added and selected new model '${modelToSet}'.`);
          }
        } else {
          p.models = providedModels;
          p.model = providedModels[0];
        }
      }

      const finalModels = p.models || (p.model ? [p.model] : []);
      if (finalModels.length > 3) {
        throw new Error("Error: A profile can have at most 3 models.");
      }

      applyProfileOptions(p, opts);
      warnMissingProvider(p);
      if (providedModels || modelsToDelete) {
        warnUnknownModels(p.models || (p.model ? [p.model] : []), name);
      }

      writeJson(PROFILES_FILE, data, 0o600);
      fs.chmodSync(PROFILES_FILE, 0o600);
      logger.debug(`profile update: wrote ${PROFILES_FILE}`);
      console.log(`Profile '${name}' updated.`);
    }));

  // --- list ---
  profile
    .command("list")
    .description("List all profiles")
    .action(safeAction(() => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);
      const profiles = data.profiles;
      const names = Object.keys(profiles);
      if (names.length === 0) {
        console.log("No profiles defined. Use 'profile add' to create one.");
        return;
      }
      const def = data.default || "";
      const fmt = (marker: string, name: string, model: string, provider: string, thinking: string, token: string, url: string) =>
        `${marker.padEnd(2)}  ${name.padEnd(20)}  ${model.padEnd(30)}  ${provider.padEnd(22)}  ${thinking.padEnd(10)}  ${token.padEnd(20)}  ${url}`;

      console.log(fmt("", "NAME", "MODEL(S)", "PROVIDER", "THINKING", "TOKEN", "URL"));
      console.log(fmt("", "----", "--------", "--------", "---------", "-----", "---"));
      for (const name of names) {
        const p = profiles[name];
        const marker = name === def ? "* " : "  ";
        console.log(fmt(
          marker,
          name,
          formatModels(p),
          p.provider || "(default)",
          p.thinking || "(default)",
          maskToken(p.token || ""),
          p.url || "(default)",
        ));
      }
    }));

  // --- view ---
  profile
    .command("view")
    .description("View full details of a profile (token unmasked)")
    .argument("<name>", "Profile name")
    .option("-j, --json", "Output as JSON")
    .action(safeAction((name: string, opts: { json?: boolean }) => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);

      if (name === BUILT_IN_DEFAULT) {
        throw new Error(`'${BUILT_IN_DEFAULT}' is not a stored profile. Use 'omp-hub run --built-in' or 'omp-hub use --built-in' to run omp with your existing config.`);
      }

      const p = data.profiles[name];
      if (!p) {
        throw new Error(`Profile '${name}' not found.`);
      }
      if (opts.json) {
        console.log(JSON.stringify({ name, ...p }, null, 2));
      } else {
        console.log(`Name:     ${name}`);
        console.log(`Provider: ${p.provider || "(default)"}`);
        console.log(`Model:    ${p.model || "(unset)"}`);
        if (p.models && p.models.length > 0) {
          console.log(`Models:`);
          for (const m of p.models) {
            console.log(`  - ${m}`);
          }
        }
        console.log(`Thinking: ${p.thinking || "(default)"}`);
        console.log(`Token:    ${p.token || "(unset)"}`);
        console.log(`URL:      ${p.url || "(default)"}`);
        if (p.settings && Object.keys(p.settings).length > 0) {
          console.log(`Settings overrides:`);
          for (const [key, value] of Object.entries(p.settings)) {
            console.log(`  ${key} = ${JSON.stringify(value)}`);
          }
        }
      }
    }));

  // --- remove ---
  profile
    .command("remove")
    .description("Remove a profile")
    .argument("<name>", "Profile name")
    .action(safeAction((name: string) => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);
      if (!data.profiles[name]) {
        throw new Error(`Profile '${name}' not found.`);
      }
      delete data.profiles[name];
      if (data.default === name) {
        delete data.default;
      }
      writeJson(PROFILES_FILE, data, 0o600);
      fs.chmodSync(PROFILES_FILE, 0o600);
      removeProfileDir(name);
      logger.debug(`profile remove: wrote ${PROFILES_FILE}`);
      console.log(`Profile '${name}' removed.`);
    }));

  // --- rename ---
  profile
    .command("rename")
    .description("Rename a profile")
    .argument("<oldName>", "Current profile name")
    .argument("<newName>", "New profile name")
    .action(safeAction((oldName: string, newName: string) => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);
      if (!data.profiles[oldName]) {
        throw new Error(`Profile '${oldName}' not found.`);
      }
      if (data.profiles[newName]) {
        throw new Error(`Profile '${newName}' already exists. Choose a different name.`);
      }
      data.profiles[newName] = data.profiles[oldName];
      delete data.profiles[oldName];
      if (data.default === oldName) {
        data.default = newName;
      }
      writeJson(PROFILES_FILE, data, 0o600);
      fs.chmodSync(PROFILES_FILE, 0o600);

      const oldDir = profileDirFor(oldName);
      if (fs.existsSync(oldDir)) {
        removeProfileDir(newName);
        fs.renameSync(oldDir, profileDirFor(newName));
      }

      console.log(`Profile '${oldName}' renamed to '${newName}'.`);
    }));

  // --- default ---
  profile
    .command("default")
    .description("Set the default profile")
    .option("--built-in", "Use your existing omp config as default (no profile)")
    .argument("[name]", "Profile name to set as default (required unless --built-in)")
    .action(safeAction((name: string | undefined, opts: { builtIn?: boolean }) => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);

      if (opts.builtIn) {
        data.default = BUILT_IN_DEFAULT;
        writeJson(PROFILES_FILE, data, 0o600);
        fs.chmodSync(PROFILES_FILE, 0o600);
        logger.debug(`profile default: wrote ${PROFILES_FILE}`);
        console.log("Default set to built-in (your existing omp config).");
        return;
      }

      if (!name) {
        throw new Error("Profile name is required. Use --built-in to run omp with your existing config.");
      }

      if (!data.profiles[name]) {
        throw new Error(`Profile '${name}' not found.`);
      }
      data.default = name;
      writeJson(PROFILES_FILE, data, 0o600);
      fs.chmodSync(PROFILES_FILE, 0o600);
      logger.debug(`profile default: wrote ${PROFILES_FILE}`);
      console.log(`Default profile set to '${name}'.`);
    }));

  return profile;
}

export function useCommand(): Command {
  return new Command("use")
    .description("Set a profile as the default")
    .option("--built-in", "Use your existing omp config as default (no profile)")
    .argument("[name]", "Profile name (required unless --built-in)")
    .action(safeAction((name: string | undefined, opts: { builtIn?: boolean }) => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);

      if (opts.builtIn) {
        data.default = BUILT_IN_DEFAULT;
        writeJson(PROFILES_FILE, data, 0o600);
        fs.chmodSync(PROFILES_FILE, 0o600);
        logger.debug(`use: wrote ${PROFILES_FILE}`);
        console.log("Default set to built-in (your existing omp config).");
        return;
      }

      if (!name) {
        throw new Error("Profile name is required. Use --built-in to run omp with your existing config.");
      }

      if (!data.profiles[name]) {
        throw new Error(`Profile '${name}' not found.`);
      }

      data.default = name;
      writeJson(PROFILES_FILE, data, 0o600);
      fs.chmodSync(PROFILES_FILE, 0o600);
      logger.debug(`use: wrote ${PROFILES_FILE}`);
      console.log(`Default profile set to '${name}'.`);
    }));
}

export function runCommand(): Command {
  return new Command("run")
    .description("Launch omp using the default or a specified profile")
    .option("--built-in", "Use your existing omp config (no profile)")
    .allowUnknownOption()
    .argument("[args...]", "Optional profile name followed by extra arguments passed to omp")
    .action(safeAction((args: string[], opts: { builtIn?: boolean }) => {
      ensureProfilesFile();
      const data = readJson<ProfilesData>(PROFILES_FILE);

      if (opts.builtIn) {
        execOmpBuiltIn(args);
        return;
      }

      let profileName = "";
      let ompArgs: string[];

      if (args.length > 0 && data.profiles[args[0]]) {
        profileName = args[0];
        ompArgs = args.slice(1);
      } else {
        profileName = data.default || "";
        ompArgs = args;
      }

      if (profileName === BUILT_IN_DEFAULT) {
        execOmpBuiltIn(ompArgs);
        return;
      }

      if (!profileName) {
        throw new Error("No default profile set. Use 'omp-hub use <name>' or 'omp-hub use --built-in' first.");
      }

      const p = data.profiles[profileName];
      logger.debug(`run: launching omp with profile '${profileName}', args=[${ompArgs.join(", ")}]`);
      execOmp(profileName, p, ompArgs);
    }));
}
