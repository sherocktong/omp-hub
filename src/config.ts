import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import * as logger from "./logger.js";

export const OMP_DIR = process.env.OMP_HUB_OMP_DIR || path.join(os.homedir(), ".omp");
export const PROFILES_FILE = process.env.OMP_HUB_PROFILES_FILE || path.join(OMP_DIR, "profiles.json");
// Source agent dir: omp itself honours PI_CODING_AGENT_DIR, so omp-hub does too
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(OMP_DIR, "agent");
export const OMP_HUB_DIR = process.env.OMP_HUB_DIR || path.join(OMP_DIR, "omp-hub");
export const PROFILE_DIRS_DIR = path.join(OMP_HUB_DIR, "profiles");
export const AGENT_CONFIG_FILE = path.join(AGENT_DIR, "config.yml");

export function ensureFile(filePath: string, defaultContent: string): void {
  if (!fs.existsSync(filePath)) {
    logger.debug(`ensureFile: creating ${filePath}`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, defaultContent, "utf-8");
  }
}

export function readJson<T = unknown>(filePath: string): T {
  logger.debug(`readJson: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export function writeJson(filePath: string, data: unknown, mode?: number): void {
  logger.debug(`writeJson: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { mode });
}

export function readYaml<T = unknown>(filePath: string): T {
  logger.debug(`readYaml: ${filePath}`);
  return parseYaml(fs.readFileSync(filePath, "utf-8")) as T;
}

export function writeYaml(filePath: string, data: unknown, mode?: number): void {
  logger.debug(`writeYaml: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(data), { mode });
}

export function ensureProfilesFile(): void {
  ensureFile(PROFILES_FILE, '{"profiles":{}}\n');
}
