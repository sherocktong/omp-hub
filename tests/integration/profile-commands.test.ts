import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";

let tmpDir: string;
let origPath: string | undefined;

function setup() {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hub-profile-test-"));
  process.env.OMP_HUB_OMP_DIR = tmpDir;
  process.env.OMP_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
  process.env.OMP_HUB_DIR = path.join(tmpDir, "omp-hub");
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");

  // Fake `omp` on PATH so model-catalog validation is deterministic (and fast)
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const shim = path.join(binDir, "omp");
  fs.writeFileSync(
    shim,
    `#!/bin/sh
echo '{"models":[{"provider":"kimi-coding","id":"kimi-for-coding"},{"provider":"kimi-coding","id":"k3"}]}'
`
  );
  fs.chmodSync(shim, 0o755);
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OMP_HUB_OMP_DIR;
  delete process.env.OMP_HUB_PROFILES_FILE;
  delete process.env.OMP_HUB_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.PATH = origPath;
}

// Helper: run a Commander command and capture stdout/stderr
async function runCommand(cmd: Command, args: string[]) {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errors.push(a.join(" "));

  const exitCode = await new Promise<number>((resolve) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      resolve(typeof code === "number" ? code : 1);
      throw new Error(`process.exit(${code})`);
    });
    try {
      cmd.parse(["node", "omp-hub", ...args]);
      resolve(0);
    } catch {
      // swallow the process.exit() throw
    } finally {
      exitSpy.mockRestore();
    }
  });

  console.log = origLog;
  console.error = origError;
  return { logs, errors, exitCode };
}

async function getProfileCommand() {
  const mod = await import("../../src/profiles/index.js");
  return mod.profileCommand();
}

function readProfilesFile() {
  return JSON.parse(fs.readFileSync(process.env.OMP_HUB_PROFILES_FILE!, "utf-8"));
}

// ---------------------------------------------------------------------------
// profile add
// ---------------------------------------------------------------------------

describe("profile add", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("creates a new profile with provider, model and token", async () => {
    const cmd = await getProfileCommand();
    await runCommand(cmd, ["add", "work", "-p", "kimi-coding", "-m", "kimi-for-coding", "-t", "sk-test-123"]);
    expect(readProfilesFile().profiles["work"]).toMatchObject({
      provider: "kimi-coding",
      model: "kimi-for-coding",
      models: ["kimi-for-coding"],
      token: "sk-test-123",
    });
  });

  it("creates a profile with multiple models (max 3)", async () => {
    const cmd = await getProfileCommand();
    await runCommand(cmd, ["add", "multi", "-m", "model-a", "-m", "model-b"]);
    expect(readProfilesFile().profiles["multi"].models).toEqual(["model-a", "model-b"]);
  });

  it("rejects more than 3 models", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["add", "toomany", "-m", "a", "-m", "b", "-m", "c", "-m", "d"]);
    expect(exitCode).toBe(1);
    expect(fs.existsSync(process.env.OMP_HUB_PROFILES_FILE!)).toBe(false);
  });

  it("stores url and thinking", async () => {
    const cmd = await getProfileCommand();
    await runCommand(cmd, ["add", "px", "-p", "kimi-coding", "-m", "m", "-u", "https://proxy.example.com", "--thinking", "high"]);
    expect(readProfilesFile().profiles["px"]).toMatchObject({
      url: "https://proxy.example.com",
      thinking: "high",
    });
  });

  it("accepts 'auto' as a thinking level", async () => {
    const cmd = await getProfileCommand();
    await runCommand(cmd, ["add", "auto", "--thinking", "auto"]);
    expect(readProfilesFile().profiles["auto"].thinking).toBe("auto");
  });

  it("rejects an invalid thinking level", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["add", "bad", "--thinking", "ultra"]);
    expect(exitCode).toBe(1);
    expect(fs.existsSync(process.env.OMP_HUB_PROFILES_FILE!)).toBe(false);
  });

  it("warns but allows an unknown provider id", async () => {
    const cmd = await getProfileCommand();
    const { errors } = await runCommand(cmd, ["add", "custom", "-p", "my-provider", "-m", "m"]);
    expect(errors.some((e) => e.includes("not a known omp provider"))).toBe(true);
    expect(readProfilesFile().profiles["custom"].provider).toBe("my-provider");
  });

  it("warns when a token is set without a provider", async () => {
    const cmd = await getProfileCommand();
    const { errors } = await runCommand(cmd, ["add", "implicit", "-m", "m", "-t", "tok"]);
    expect(errors.some((e) => e.includes("no provider set"))).toBe(true);
    expect(readProfilesFile().profiles["implicit"].provider).toBeUndefined();
  });

  it("warns when a model is not in omp's catalog", async () => {
    const cmd = await getProfileCommand();
    const { errors } = await runCommand(cmd, ["add", "ghost-model", "-m", "no-such-model-xyz"]);
    expect(errors.some((e) => e.includes("not in omp's catalog"))).toBe(true);
    expect(readProfilesFile().profiles["ghost-model"].model).toBe("no-such-model-xyz");
  });

  it("does not warn for catalog models", async () => {
    const cmd = await getProfileCommand();
    const { errors } = await runCommand(cmd, ["add", "real", "-m", "kimi-for-coding"]);
    expect(errors.some((e) => e.includes("not in omp's catalog"))).toBe(false);
  });

  it("does not warn when the catalog is empty (stale models.db)", async () => {
    // Rewrite the fake omp to report an empty catalog, as a stale agent dir does.
    const emptyShim = path.join(tmpDir, "bin", "omp");
    fs.writeFileSync(emptyShim, `#!/bin/sh\necho '{"models":[]}'\n`);
    fs.chmodSync(emptyShim, 0o755);
    const cmd = await getProfileCommand();
    const { errors } = await runCommand(cmd, ["add", "cached", "-m", "kimi-for-coding"]);
    expect(errors.some((e) => e.includes("not in omp's catalog"))).toBe(false);
    expect(readProfilesFile().profiles["cached"].model).toBe("kimi-for-coding");
  });

  it("updates an existing profile on second add", async () => {
    const cmd1 = await getProfileCommand();
    await runCommand(cmd1, ["add", "dev", "-m", "model-a"]);
    const cmd2 = await getProfileCommand();
    await runCommand(cmd2, ["add", "dev", "-t", "new-token"]);
    expect(readProfilesFile().profiles["dev"].token).toBe("new-token");
    expect(readProfilesFile().profiles["dev"].model).toBe("model-a");
  });

  it("writes profiles.json with 0600 permissions", async () => {
    const cmd = await getProfileCommand();
    await runCommand(cmd, ["add", "x", "-m", "m", "-t", "secret"]);
    const mode = fs.statSync(process.env.OMP_HUB_PROFILES_FILE!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("logs success message", async () => {
    const cmd = await getProfileCommand();
    const { logs } = await runCommand(cmd, ["add", "x", "-m", "m"]);
    expect(logs.some((l) => l.includes("saved"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// profile list
// ---------------------------------------------------------------------------

describe("profile list", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("prints a message when no profiles exist", async () => {
    const cmd = await getProfileCommand();
    const { logs } = await runCommand(cmd, ["list"]);
    expect(logs.some((l) => l.includes("No profiles"))).toBe(true);
  });

  it("masks tokens in the list output", async () => {
    const token = "sk-abcdefgh1234567890XYZW";
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "prod", "-t", token]);
    const c2 = await getProfileCommand();
    const { logs } = await runCommand(c2, ["list"]);
    expect(logs.some((l) => l.includes(token.slice(0, 8) + "..." + token.slice(-4)))).toBe(true);
    expect(logs.some((l) => l.includes(token))).toBe(false);
  });

  it("marks the default profile with an asterisk", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "alpha", "-m", "a"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["add", "beta", "-m", "b"]);
    const c3 = await getProfileCommand();
    await runCommand(c3, ["default", "alpha"]);
    const c4 = await getProfileCommand();
    const { logs } = await runCommand(c4, ["list"]);
    const alphaLine = logs.find((l) => l.includes("alpha"));
    expect(alphaLine).toBeDefined();
    expect(alphaLine).toMatch(/\*/);
  });
});

// ---------------------------------------------------------------------------
// profile view
// ---------------------------------------------------------------------------

describe("profile view", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("shows full token without masking", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "dev", "-t", "sk-very-long-secret-token-here"]);
    const c2 = await getProfileCommand();
    const { logs } = await runCommand(c2, ["view", "dev"]);
    expect(logs.some((l) => l.includes("sk-very-long-secret-token-here"))).toBe(true);
  });

  it("shows provider and thinking", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "dev", "-p", "anthropic", "-m", "claude-sonnet-4-6", "--thinking", "low"]);
    const c2 = await getProfileCommand();
    const { logs } = await runCommand(c2, ["view", "dev"]);
    expect(logs.some((l) => l.includes("Provider: anthropic"))).toBe(true);
    expect(logs.some((l) => l.includes("Thinking: low"))).toBe(true);
  });

  it("outputs JSON when --json flag is given", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "dev", "-m", "model-a"]);
    const c2 = await getProfileCommand();
    const { logs } = await runCommand(c2, ["view", "dev", "--json"]);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.name).toBe("dev");
    expect(parsed.model).toBe("model-a");
  });

  it("exits with code 1 for unknown profile", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["view", "nonexistent"]);
    expect(exitCode).toBe(1);
  });

  it("rejects viewing the built-in sentinel", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["view", "__builtin__"]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// profile remove
// ---------------------------------------------------------------------------

describe("profile remove", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("removes an existing profile and clears the default pointer", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "tmp", "-m", "m"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["default", "tmp"]);
    const c3 = await getProfileCommand();
    await runCommand(c3, ["remove", "tmp"]);
    const data = readProfilesFile();
    expect(data.profiles["tmp"]).toBeUndefined();
    expect(data.default).toBeUndefined();
  });

  it("removes the materialized profile dir", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "tmp", "-m", "m"]);
    const mat = await import("../../src/profiles/materializer.js");
    mat.materializeProfile("tmp", { model: "m" });
    expect(fs.existsSync(mat.profileDirFor("tmp"))).toBe(true);

    const c2 = await getProfileCommand();
    await runCommand(c2, ["remove", "tmp"]);
    expect(fs.existsSync(mat.profileDirFor("tmp"))).toBe(false);
  });

  it("exits with code 1 when profile does not exist", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["remove", "ghost"]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// profile rename
// ---------------------------------------------------------------------------

describe("profile rename", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("renames the profile and fixes the default pointer", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "old", "-m", "m"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["default", "old"]);
    const c3 = await getProfileCommand();
    await runCommand(c3, ["rename", "old", "new"]);
    const data = readProfilesFile();
    expect(data.profiles["old"]).toBeUndefined();
    expect(data.profiles["new"]).toMatchObject({ model: "m" });
    expect(data.default).toBe("new");
  });

  it("renames the materialized dir if present", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "old", "-m", "m"]);
    const mat = await import("../../src/profiles/materializer.js");
    mat.materializeProfile("old", { model: "m" });

    const c2 = await getProfileCommand();
    await runCommand(c2, ["rename", "old", "new"]);
    expect(fs.existsSync(mat.profileDirFor("old"))).toBe(false);
    expect(fs.existsSync(mat.profileDirFor("new"))).toBe(true);
  });

  it("fails when the target name already exists", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "a", "-m", "m"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["add", "b", "-m", "m"]);
    const c3 = await getProfileCommand();
    const { exitCode } = await runCommand(c3, ["rename", "a", "b"]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// profile default / use
// ---------------------------------------------------------------------------

describe("profile default", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("sets the default field", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "work", "-m", "m"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["default", "work"]);
    expect(readProfilesFile().default).toBe("work");
  });

  it("sets the built-in sentinel with --built-in", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["default", "--built-in"]);
    expect(readProfilesFile().default).toBe("__builtin__");
  });

  it("exits with code 1 for unknown profile", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["default", "nope"]);
    expect(exitCode).toBe(1);
  });

  it("exits with code 1 when no name given", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["default"]);
    expect(exitCode).toBe(1);
  });
});

describe("use", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("sets the default profile", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "work", "-m", "m"]);
    const mod = await import("../../src/profiles/index.js");
    const { logs } = await runCommand(mod.useCommand(), ["work"]);
    expect(logs.some((l) => l.includes("Default profile set to 'work'"))).toBe(true);
    expect(readProfilesFile().default).toBe("work");
  });

  it("supports --built-in", async () => {
    const mod = await import("../../src/profiles/index.js");
    await runCommand(mod.useCommand(), ["--built-in"]);
    expect(readProfilesFile().default).toBe("__builtin__");
  });
});

// ---------------------------------------------------------------------------
// profile update
// ---------------------------------------------------------------------------

describe("profile update", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("exits with code 1 when profile does not exist", async () => {
    const cmd = await getProfileCommand();
    const { exitCode } = await runCommand(cmd, ["update", "ghost", "-t", "tok"]);
    expect(exitCode).toBe(1);
  });

  it("updates token, url, thinking and provider", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "dev", "-m", "m"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["update", "dev", "-t", "tok2", "-u", "https://u.example.com", "--thinking", "max", "-p", "openai"]);
    expect(readProfilesFile().profiles["dev"]).toMatchObject({
      token: "tok2",
      url: "https://u.example.com",
      thinking: "max",
      provider: "openai",
    });
  });

  it("moves an existing model to position 1 with a single -m", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "dev", "-m", "model-a", "-m", "model-b"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["update", "dev", "-m", "model-b"]);
    expect(readProfilesFile().profiles["dev"].models[0]).toBe("model-b");
  });

  it("replaces all models when multiple -m flags given", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "dev", "-m", "old-model"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["update", "dev", "-m", "new-a", "-m", "new-b"]);
    expect(readProfilesFile().profiles["dev"].models).toEqual(["new-a", "new-b"]);
  });

  it("removes a model via --delete-model", async () => {
    const c1 = await getProfileCommand();
    await runCommand(c1, ["add", "dev", "-m", "keep", "-m", "remove-me"]);
    const c2 = await getProfileCommand();
    await runCommand(c2, ["update", "dev", "--delete-model", "remove-me"]);
    expect(readProfilesFile().profiles["dev"].models).toEqual(["keep"]);
  });
});
