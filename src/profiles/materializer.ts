import fs from "node:fs";
import path from "node:path";
import {
  AGENT_CONFIG_FILE,
  AGENT_DIR,
  PROFILE_DIRS_DIR,
  readYaml,
  writeYaml,
} from "../config.js";
import type { AgentConfigData, ModelsFileData, Profile } from "../types.js";
import * as logger from "../logger.js";

// Directories/files shared from the source agent dir into every profile dir.
// Dirs are symlinked so user edits (extensions, skills, sessions) stay live.
const SHARED_DIR_LINKS = ["extensions", "skills", "plugins", "sessions"];
const SHARED_FILE_LINKS = ["AGENTS.md"];

export function profileDirFor(name: string): string {
  return path.join(PROFILE_DIRS_DIR, name);
}

/**
 * Read the source agent config.yml as a plain object. Falls back to a legacy
 * settings.json (pi heritage: omp migrates it to config.yml on first run) so
 * users coming from pi still get their settings seeded.
 */
function readSourceConfig(): AgentConfigData {
  if (fs.existsSync(AGENT_CONFIG_FILE)) {
    try {
      const parsed = readYaml<AgentConfigData>(AGENT_CONFIG_FILE);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      logger.warn(`readSourceConfig: could not parse ${AGENT_CONFIG_FILE}, ignoring`, err);
      return {};
    }
  }
  const legacy = path.join(AGENT_DIR, "settings.json");
  if (fs.existsSync(legacy)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(legacy, "utf-8")) as AgentConfigData;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      logger.warn(`readSourceConfig: could not parse legacy ${legacy}, ignoring`, err);
    }
  }
  return {};
}

/**
 * Provider used to key models.yml (and token injection) when the profile has
 * no explicit provider: profile.provider, then a "provider/model" id prefix,
 * then the user's defaultProvider from their agent config.
 */
export function resolveEffectiveProvider(profile: Profile, config: AgentConfigData): string | undefined {
  if (profile.provider) return profile.provider;
  const models = profile.models || (profile.model ? [profile.model] : []);
  const first = models[0];
  if (first && first.includes("/")) return first.split("/")[0];
  return config.defaultProvider;
}

/**
 * Write <dir>/config.yml: copy of the source agent config with
 * profile.settings overrides merged in and defaultProvider/defaultModel/
 * defaultThinkingLevel taken solely from the profile's dedicated fields
 * (which win for their own keys) — these are profile-scoped and are NOT
 * inherited from the source agent config, where omp persists the user's
 * last selection. A null value in profile.settings deletes the key, so a
 * profile can drop a setting inherited from the agent config.
 *
 * On re-materialization, every key already in the profile's own
 * config.yml is preserved (omp persists user state there at runtime),
 * rather than being reset from the source — EXCEPT `extensions`, which
 * is always mirrored from the source config: extension state lives in
 * the shared extensions/ dir (symlinked), so a profile's stale copy
 * would otherwise shadow enable/disable changes made under the default
 * config. Other source settings only fill in keys the profile is missing.
 */
export function writeConfigFile(dir: string, profile: Profile): void {
  const settings = readSourceConfig();

  // Extensions are shared state (the extensions/ dir is symlinked into every
  // profile), so the source config's list is authoritative: capture it before
  // the existing-profile overlay below, which must not let a stale per-profile
  // copy win. Skipped when the source doesn't define it at all (e.g. the
  // source file is missing), so we never wipe the profile's list blindly.
  const sourceExtensions = settings.extensions;

  // Profile-scoped keys: never inherit the source agent config's values.
  // omp persists the user's last provider/model/thinking selection into the
  // active agent dir, so the source copy may carry another profile's (or a
  // built-in omp session's) defaults. A profile dir carries these keys only
  // when the profile itself defines them (dedicated fields or settings map)
  // or omp previously wrote them into the profile's own config.yml.
  delete settings.defaultProvider;
  delete settings.defaultModel;
  delete settings.defaultThinkingLevel;

  // Keep everything omp (or the user) wrote into the profile's config.yml
  // during previous sessions. `extensions` is the exception: when the source
  // defines it, it always wins (synced below) instead of the stale copy.
  // All comparisons here are shallow — only first-level keys are considered;
  // a profile-owned top-level key wins wholesale and nested keys are never
  // merged or filled in from the source.
  const profileConfigFile = path.join(dir, "config.yml");
  if (fs.existsSync(profileConfigFile)) {
    try {
      const existing = readYaml<AgentConfigData>(profileConfigFile);
      if (existing && typeof existing === "object") {
        for (const [key, value] of Object.entries(existing)) {
          if (key === "extensions" && sourceExtensions !== undefined) continue;
          settings[key] = value;
        }
        logger.debug(`writeConfigFile: preserved existing keys from ${profileConfigFile}`);
      }
    } catch (err) {
      logger.warn(`writeConfigFile: could not read existing ${profileConfigFile}, regenerating`, err);
    }
  }

  // Always mirror the source's extension list, even if the profile's
  // config.yml already has one — extension toggles made under the default
  // config must propagate to already-materialized profiles.
  if (sourceExtensions !== undefined) {
    settings.extensions = sourceExtensions;
  }

  if (profile.settings) {
    for (const [key, value] of Object.entries(profile.settings)) {
      if (value === null) {
        delete settings[key];
      } else {
        settings[key] = value;
      }
    }
  }

  const models = profile.models || (profile.model ? [profile.model] : []);
  if (profile.provider) settings.defaultProvider = profile.provider;
  if (models[0]) settings.defaultModel = models[0];
  if (profile.thinking) settings.defaultThinkingLevel = profile.thinking;

  writeYaml(profileConfigFile, settings);
  logger.debug(`writeConfigFile: wrote ${profileConfigFile}`);
}

/**
 * Write <dir>/models.yml overriding the profile provider's baseUrl.
 * omp reads this even for built-in providers — the only way to redirect
 * providers (e.g. kimi-code) that have no *_BASE_URL env var.
 * Deleted when the profile has no url.
 */
export function writeModelsFile(dir: string, profile: Profile): void {
  const file = path.join(dir, "models.yml");
  if (!profile.url) {
    fs.rmSync(file, { force: true });
    return;
  }
  const provider = resolveEffectiveProvider(profile, readSourceConfig());
  if (!provider) {
    console.error(
      "Warning: profile has a url but no provider could be determined " +
        "(no -p flag, no provider/model id, no defaultProvider in agent config). " +
        "models.yml baseUrl override was not written."
    );
    return;
  }
  const data: ModelsFileData = { providers: { [provider]: { baseUrl: profile.url } } };
  writeYaml(file, data);
  logger.debug(`writeModelsFile: wrote ${file}`);
}

function removeStaleLink(linkPath: string): void {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.rmSync(linkPath, { force: true });
    } else if (stat.isDirectory()) {
      // Stale copy fallback from a previous run. Leaving it would make every
      // future run hit EEXIST on the symlink and fall back to copying the whole
      // source dir again — and the stale copy would shadow the shared source.
      // The canonical content lives in the source we're about to link.
      logger.info(`refreshSharedLinks: replacing copied dir with link: ${linkPath}`);
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    // does not exist
  }
}

function linkOrCopy(target: string, linkPath: string, isDir: boolean): void {
  removeStaleLink(linkPath);
  if (!fs.existsSync(target)) return; // nothing to share
  try {
    fs.symlinkSync(target, linkPath, isDir ? "junction" : "file");
  } catch (err) {
    logger.warn(`Symlink failed for ${target}, falling back to copy`, err);
    if (isDir) {
      fs.cpSync(target, linkPath, { recursive: true });
    } else {
      fs.copyFileSync(target, linkPath);
    }
  }
}

/** (Re)create symlinks from a profile dir into the source agent dir. */
export function refreshSharedLinks(dir: string): void {
  for (const name of SHARED_DIR_LINKS) {
    linkOrCopy(path.join(AGENT_DIR, name), path.join(dir, name), true);
  }
  for (const name of SHARED_FILE_LINKS) {
    linkOrCopy(path.join(AGENT_DIR, name), path.join(dir, name), false);
  }
}

/**
 * Materialize (or refresh) the isolated agent dir for a profile and return its path.
 * Idempotent; called on every `omp-hub run` so it tracks the user's current
 * config, extensions, skills and sessions.
 */
export function materializeProfile(name: string, profile: Profile): string {
  const dir = profileDirFor(name);
  fs.mkdirSync(dir, { recursive: true });
  writeConfigFile(dir, profile);
  writeModelsFile(dir, profile);
  refreshSharedLinks(dir);
  return dir;
}

/** Delete a profile's materialized dir. Symlinks are unlinked, never followed. */
export function removeProfileDir(name: string): void {
  const dir = profileDirFor(name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    logger.debug(`removeProfileDir: removed ${dir}`);
  }
}
