import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Profile } from "../../src/types.js";

let tmpDir: string;
let agentDir: string;
let mat: typeof import("../../src/profiles/materializer.js");

function setup() {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hub-mat-test-"));
  process.env.OMP_HUB_OMP_DIR = tmpDir;
  process.env.OMP_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
  process.env.OMP_HUB_DIR = path.join(tmpDir, "omp-hub");
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
  agentDir = path.join(tmpDir, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
}

async function load() {
  mat = await import("../../src/profiles/materializer.js");
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OMP_HUB_OMP_DIR;
  delete process.env.OMP_HUB_PROFILES_FILE;
  delete process.env.OMP_HUB_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
}

function readProfileConfig(dir: string): Record<string, unknown> {
  return parseYaml(fs.readFileSync(path.join(dir, "config.yml"), "utf-8")) as Record<string, unknown>;
}

const baseProfile: Profile = {
  provider: "kimi-coding",
  model: "kimi-for-coding",
  models: ["kimi-for-coding"],
  thinking: "high",
  token: "sk-test-token-1234567890",
  url: "https://proxy.example.com/coding",
};

describe("materializeProfile", () => {
  beforeEach(async () => {
    setup();
    await load();
  });
  afterEach(teardown);

  it("creates the profile dir and returns its path", () => {
    const dir = mat.materializeProfile("work", baseProfile);
    expect(dir).toBe(path.join(tmpDir, "omp-hub", "profiles", "work"));
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("never writes auth.json (omp v18 stores credentials in agent.db, not auth.json)", () => {
    const dir = mat.materializeProfile("work", baseProfile);
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  });

  it("writes config.yml with provider/model/thinking defaults", () => {
    const dir = mat.materializeProfile("work", baseProfile);
    const config = readProfileConfig(dir);
    expect(config.defaultProvider).toBe("kimi-coding");
    expect(config.defaultModel).toBe("kimi-for-coding");
    expect(config.defaultThinkingLevel).toBe("high");
  });

  it("preserves existing agent config keys while overriding defaults", () => {
    fs.writeFileSync(
      path.join(agentDir, "config.yml"),
      "theme: dark\ndefaultProvider: google\nsomeHook:\n  x: 1\n"
    );
    const dir = mat.materializeProfile("work", baseProfile);
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("dark");
    expect(config.someHook).toEqual({ x: 1 });
    expect(config.defaultProvider).toBe("kimi-coding");
  });

  it("falls back to legacy settings.json when the source has no config.yml", () => {
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ theme: "dark", defaultProvider: "anthropic" })
    );
    const dir = mat.materializeProfile("work", baseProfile);
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("dark");
    expect(config.defaultProvider).toBe("kimi-coding");
  });

  it("does not inherit source defaultProvider/defaultModel/defaultThinkingLevel when the profile lacks them", () => {
    fs.writeFileSync(
      path.join(agentDir, "config.yml"),
      "theme: dark\ndefaultProvider: kimi-coding\ndefaultModel: kimi-for-coding\ndefaultThinkingLevel: high\n"
    );
    const dir = mat.materializeProfile("bare", { token: "tok-123" });
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("dark");
    expect(config.defaultProvider).toBeUndefined();
    expect(config.defaultModel).toBeUndefined();
    expect(config.defaultThinkingLevel).toBeUndefined();
  });

  it("lets an explicit profile.settings defaultProvider/defaultModel through", () => {
    const dir = mat.materializeProfile("custom", {
      settings: { defaultProvider: "google", defaultModel: "gemini-2.5-pro" },
    });
    const config = readProfileConfig(dir);
    expect(config.defaultProvider).toBe("google");
    expect(config.defaultModel).toBe("gemini-2.5-pro");
  });

  it("merges profile.settings over the source agent config", () => {
    fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: dark\nnotify: true\n");
    const dir = mat.materializeProfile("work", {
      ...baseProfile,
      settings: { theme: "light", nested: { a: 1 } },
    });
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("light");
    expect(config.nested).toEqual({ a: 1 });
    expect(config.notify).toBe(true);
    // Source file untouched
    const source = parseYaml(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")) as Record<string, unknown>;
    expect(source.theme).toBe("dark");
    expect(source.nested).toBeUndefined();
  });

  it("deletes a source config key when profile.settings sets it to null", () => {
    fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: dark\nkeep: 1\n");
    const dir = mat.materializeProfile("work", {
      ...baseProfile,
      settings: { theme: null },
    });
    const config = readProfileConfig(dir);
    expect(config.theme).toBeUndefined();
    expect(config.keep).toBe(1);
  });

  it("lets the provider/model/thinking fields win over profile.settings for their keys", () => {
    const dir = mat.materializeProfile("work", {
      ...baseProfile,
      settings: { defaultModel: "other-model", extra: "x" },
    });
    const config = readProfileConfig(dir);
    expect(config.defaultModel).toBe("kimi-for-coding");
    expect(config.extra).toBe("x");
  });

  it("preserves omp runtime state from the existing profile config.yml", () => {
    fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: dark\nlastChangelogVersion: 18.0.0\n");
    const dir = mat.materializeProfile("work", baseProfile);
    // Simulate omp writing runtime state during a session
    const profileConfig = path.join(dir, "config.yml");
    const existing = parseYaml(fs.readFileSync(profileConfig, "utf-8")) as Record<string, unknown>;
    existing.theme = "claude-code-light/claude-code-dark-ansi";
    existing.lastChangelogVersion = "18.2.0";
    existing.modelThinkingLevels = { "kimi-coding/kimi-for-coding": "low" };
    existing.tuiMode = "fullscreen";
    fs.writeFileSync(profileConfig, stringifyYaml(existing));

    // Re-materialize: omp-written state must survive, not be reset from source
    mat.materializeProfile("work", baseProfile);
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("claude-code-light/claude-code-dark-ansi");
    expect(config.lastChangelogVersion).toBe("18.2.0");
    expect(config.modelThinkingLevels).toEqual({ "kimi-coding/kimi-for-coding": "low" });
    expect(config.tuiMode).toBe("fullscreen");
  });

  it("keeps profile config over source edits on re-materialization", () => {
    fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: dark\nstatusbar:\n  enabled: false\n");
    const dir = mat.materializeProfile("work", baseProfile);
    const profileConfig = path.join(dir, "config.yml");
    const existing = parseYaml(fs.readFileSync(profileConfig, "utf-8")) as Record<string, unknown>;
    existing.theme = "claude-code-dark";
    existing.statusbar = { enabled: true, preset: "full" };
    existing.customKey = { any: "thing" };
    fs.writeFileSync(profileConfig, stringifyYaml(existing));

    // User edits the source config — the profile file must win
    fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: light\nstatusbar:\n  enabled: false\n");
    mat.materializeProfile("work", baseProfile);
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("claude-code-dark");
    expect(config.statusbar).toEqual({ enabled: true, preset: "full" });
    expect(config.customKey).toEqual({ any: "thing" });
  });

  it("lets profile.settings overrides win over preserved profile config", () => {
    const dir = mat.materializeProfile("work", {
      ...baseProfile,
      settings: { theme: "light" },
    });
    const profileConfig = path.join(dir, "config.yml");
    const existing = parseYaml(fs.readFileSync(profileConfig, "utf-8")) as Record<string, unknown>;
    existing.theme = "claude-code-dark";
    fs.writeFileSync(profileConfig, stringifyYaml(existing));

    mat.materializeProfile("work", { ...baseProfile, settings: { theme: "light" } });
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("light");
  });

  it("regenerates from source when the existing profile config.yml is corrupt", () => {
    fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: dark\n");
    const dir = mat.materializeProfile("work", baseProfile);
    const profileConfig = path.join(dir, "config.yml");
    fs.writeFileSync(profileConfig, "{{{{ not yaml");

    expect(() => mat.materializeProfile("work", baseProfile)).not.toThrow();
    const config = readProfileConfig(dir);
    expect(config.theme).toBe("dark");
    expect(config.defaultProvider).toBe("kimi-coding");
  });

  it("writes models.yml with a baseUrl override for the profile provider", () => {
    const dir = mat.materializeProfile("work", baseProfile);
    const models = parseYaml(fs.readFileSync(path.join(dir, "models.yml"), "utf-8"));
    expect(models).toEqual({ providers: { "kimi-coding": { baseUrl: "https://proxy.example.com/coding" } } });
  });

  it("writes models.yml under the agent defaultProvider when the profile has no provider", () => {
    fs.writeFileSync(path.join(agentDir, "config.yml"), "defaultProvider: kimi-coding\n");
    const dir = mat.materializeProfile("implicit-url", { model: "kimi-k2.7", url: "https://api.kimi.com/coding/" });
    const models = parseYaml(fs.readFileSync(path.join(dir, "models.yml"), "utf-8"));
    expect(models).toEqual({ providers: { "kimi-coding": { baseUrl: "https://api.kimi.com/coding/" } } });
  });

  it("writes models.yml under the provider/model id prefix when present", () => {
    const dir = mat.materializeProfile("prefixed", { model: "openai/gpt-5.2", url: "https://proxy.example.com" });
    const models = parseYaml(fs.readFileSync(path.join(dir, "models.yml"), "utf-8"));
    expect(models).toEqual({ providers: { openai: { baseUrl: "https://proxy.example.com" } } });
  });

  it("warns and skips models.yml when no provider can be determined", () => {
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    try {
      const dir = mat.materializeProfile("noprovider", { model: "m", url: "https://x.example.com" });
      expect(fs.existsSync(path.join(dir, "models.yml"))).toBe(false);
      expect(errors.some((e) => e.includes("no provider could be determined"))).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  it("removes a stale models.yml when the profile url is removed", () => {
    const dir = mat.materializeProfile("work", baseProfile);
    expect(fs.existsSync(path.join(dir, "models.yml"))).toBe(true);
    mat.writeModelsFile(dir, { provider: "kimi-coding", token: "t" });
    expect(fs.existsSync(path.join(dir, "models.yml"))).toBe(false);
  });

  it("symlinks shared agent dirs and files into the profile dir", () => {
    fs.mkdirSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "# agents");
    const dir = mat.materializeProfile("work", baseProfile);

    for (const name of ["extensions", "sessions", "skills", "AGENTS.md"]) {
      const link = path.join(dir, name);
      expect(fs.existsSync(link)).toBe(true);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(agentDir, name)));
    }
  });

  it("refreshes stale symlinks on re-materialization", () => {
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    const dir = mat.materializeProfile("work", baseProfile);
    // Simulate a stale symlink pointing at a moved location
    const sessionsLink = path.join(dir, "sessions");
    fs.rmSync(sessionsLink);
    fs.symlinkSync("/nonexistent-old-path", sessionsLink, "junction");

    mat.refreshSharedLinks(dir);
    expect(fs.realpathSync(sessionsLink)).toBe(fs.realpathSync(path.join(agentDir, "sessions")));
  });

  it("replaces a stale copied dir with a symlink on re-materialization", () => {
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(agentDir, "sessions", "shared.jsonl"), "{}");
    const dir = mat.materializeProfile("work", baseProfile);
    // Simulate a leftover from a copy fallback: a real dir instead of a link
    fs.rmSync(path.join(dir, "sessions"));
    fs.mkdirSync(path.join(dir, "sessions"));
    fs.writeFileSync(path.join(dir, "sessions", "stale-copy.jsonl"), "{}");

    mat.refreshSharedLinks(dir);
    const link = path.join(dir, "sessions");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(agentDir, "sessions")));
    expect(fs.existsSync(path.join(link, "shared.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(link, "stale-copy.jsonl"))).toBe(false);
  });

  it("is idempotent", () => {
    mat.materializeProfile("work", baseProfile);
    const dir = mat.materializeProfile("work", baseProfile);
    expect(fs.existsSync(path.join(dir, "config.yml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "models.yml"))).toBe(true);
  });
});

describe("removeProfileDir", () => {
  beforeEach(async () => {
    setup();
    await load();
  });
  afterEach(teardown);

  it("removes the profile dir without following symlinks", () => {
    fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
    const dir = mat.materializeProfile("work", baseProfile);
    expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(true);

    mat.removeProfileDir("work");
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(agentDir, "sessions"))).toBe(true);
  });

  it("is a no-op for a missing profile dir", () => {
    expect(() => mat.removeProfileDir("ghost")).not.toThrow();
  });
});
