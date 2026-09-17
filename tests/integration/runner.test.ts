import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";

let tmpDir: string;
let shimOutFile: string;
let origPath: string | undefined;

function setup() {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hub-runner-test-"));
  process.env.OMP_HUB_OMP_DIR = tmpDir;
  process.env.OMP_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
  process.env.OMP_HUB_DIR = path.join(tmpDir, "omp-hub");
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
  fs.mkdirSync(path.join(tmpDir, "agent"), { recursive: true });

  // Simulate a native omp profile active in the parent env: the runner must
  // strip it so the hub-managed PI_CODING_AGENT_DIR wins.
  process.env.OMP_PROFILE = "native-profile";
  process.env.PI_PROFILE = "native-profile";

  // Fake `omp` binary on PATH that dumps env + argv for assertions
  const binDir = path.join(tmpDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  shimOutFile = path.join(tmpDir, "shim-out.txt");
  const shim = path.join(binDir, "omp");
  fs.writeFileSync(
    shim,
    `#!/bin/sh
{
  printf 'PI_CODING_AGENT_DIR=%s\\n' "\${PI_CODING_AGENT_DIR-}"
  printf 'OMP_PROFILE=%s\\n' "\${OMP_PROFILE-}"
  printf 'PI_PROFILE=%s\\n' "\${PI_PROFILE-}"
  printf 'ANTHROPIC_API_KEY=%s\\n' "\${ANTHROPIC_API_KEY-}"
  printf 'KIMI_API_KEY=%s\\n' "\${KIMI_API_KEY-}"
  printf 'MY_PROVIDER_API_KEY=%s\\n' "\${MY_PROVIDER_API_KEY-}"
  printf 'ARGV=%s\\n' "$*"
} > "${shimOutFile}"
exit 0
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
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.PATH = origPath;
}

async function runCommand(cmd: Command, args: string[]) {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`process.exit(${code})`);
  });
  try {
    cmd.parse(["node", "omp-hub", ...args]);
  } catch {
    // process.exit throw is expected
  } finally {
    exitSpy.mockRestore();
  }
}

async function getRunCommand() {
  const mod = await import("../../src/profiles/index.js");
  return mod.runCommand();
}

async function addProfile(name: string, extra: string[] = []) {
  const mod = await import("../../src/profiles/index.js");
  const cmd = mod.profileCommand();
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit");
  });
  try {
    cmd.parse(["node", "omp-hub", "add", name, ...extra]);
  } catch {
    // ignore
  } finally {
    exitSpy.mockRestore();
  }
}

function readShimOutput(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(shimOutFile, "utf-8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

describe("run", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("exits with code 1 when no default is set and no profile given", async () => {
    const cmd = await getRunCommand();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a) => errors.push(a.join(" "));
    let exitCode = 0;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      exitCode = typeof code === "number" ? code : 1;
      throw new Error("process.exit");
    });
    try {
      cmd.parse(["node", "omp-hub", "-p", "hi"]);
    } catch {
      // expected
    } finally {
      exitSpy.mockRestore();
      console.error = origError;
    }
    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes("No default profile set"))).toBe(true);
  });

  it("launches omp with PI_CODING_AGENT_DIR pointing at the materialized profile dir", async () => {
    await addProfile("work", ["-p", "kimi-coding", "-m", "kimi-for-coding", "-t", "tok"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["work"]);

    const out = readShimOutput();
    expect(out.PI_CODING_AGENT_DIR).toBe(path.join(tmpDir, "omp-hub", "profiles", "work"));
  });

  it("does not write auth.json (omp uses agent.db credentials, tokens go via env)", async () => {
    await addProfile("work", ["-p", "kimi-coding", "-m", "kimi-for-coding", "-t", "tok"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["work"]);

    const out = readShimOutput();
    expect(fs.existsSync(path.join(out.PI_CODING_AGENT_DIR, "auth.json"))).toBe(false);
  });

  it("injects the profile token as <PROVIDER>_API_KEY", async () => {
    await addProfile("work", ["-p", "kimi", "-m", "kimi-for-coding", "-t", "tok"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["work"]);
    expect(readShimOutput().KIMI_API_KEY).toBe("tok");
  });

  it("passes the token via --api-key for kimi-code (env vars are ignored there)", async () => {
    await addProfile("sub", ["-p", "kimi-code", "-m", "k3", "-t", "kimi-tok"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["sub", "-p", "hi"]);
    const out = readShimOutput();
    expect(out.ARGV.startsWith("--api-key kimi-tok --model k3 -p hi")).toBe(true);
    // env var is still injected: omp subcommands (e.g. `omp models`) only read env
    expect(out.KIMI_API_KEY).toBe("kimi-tok");
  });

  it("uses the canonical env var for well-known providers", async () => {
    await addProfile("claude", ["-p", "anthropic", "-m", "claude-sonnet-4-6", "-t", "anthropic-tok"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["claude"]);
    const out = readShimOutput();
    expect(out.ANTHROPIC_API_KEY).toBe("anthropic-tok");
    expect(out.KIMI_API_KEY).toBe("");
  });

  it("falls back to the normalized env var for unknown providers", async () => {
    await addProfile("custom", ["-p", "my-provider", "-m", "m", "-t", "custom-tok"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["custom"]);
    expect(readShimOutput().MY_PROVIDER_API_KEY).toBe("custom-tok");
  });

  it("strips OMP_PROFILE and PI_PROFILE from the child env", async () => {
    await addProfile("work", ["-p", "kimi-coding", "-m", "m", "-t", "tok"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["work"]);
    const out = readShimOutput();
    expect(out.OMP_PROFILE).toBe("");
    expect(out.PI_PROFILE).toBe("");
  });

  it("passes extra args through to omp", async () => {
    await addProfile("work", ["-m", "m"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["work", "-p", "hello world", "--offline"]);
    expect(readShimOutput().ARGV).toBe("-p hello world --offline");
  });

  it("falls back to the default profile when the first arg is not a profile name", async () => {
    await addProfile("work", ["-m", "m"]);
    const useCmd = (await import("../../src/profiles/index.js")).useCommand();
    await runCommand(useCmd, ["work"]);

    const cmd = await getRunCommand();
    await runCommand(cmd, ["-p", "hi"]);
    const out = readShimOutput();
    expect(out.PI_CODING_AGENT_DIR).toBe(path.join(tmpDir, "omp-hub", "profiles", "work"));
    expect(out.ARGV).toBe("-p hi");
  });

  it("treats all args as omp args when no profiles exist and none match", async () => {
    const cmd = await getRunCommand();
    let error = "";
    const origError = console.error;
    console.error = (...a) => {
      error = a.join(" ");
    };
    try {
      cmd.parse(["node", "omp-hub", "--version"]);
    } catch {
      // expected: no default set
    } finally {
      console.error = origError;
    }
    expect(error).toContain("No default profile set");
  });

  it("launches plain omp without PI_CODING_AGENT_DIR for --built-in", async () => {
    await addProfile("work", ["-m", "m"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["--built-in", "-p", "hi"]);
    const out = readShimOutput();
    expect(out.PI_CODING_AGENT_DIR).toBe("");
    expect(out.ARGV).toBe("-p hi");
  });

  it("strips native profile env vars for --built-in too", async () => {
    await addProfile("work", ["-m", "m"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["--built-in", "-p", "hi"]);
    const out = readShimOutput();
    expect(out.OMP_PROFILE).toBe("");
    expect(out.PI_PROFILE).toBe("");
  });

  it("launches plain omp when the default is the built-in sentinel", async () => {
    await addProfile("work", ["-m", "m"]);
    const useCmd = (await import("../../src/profiles/index.js")).useCommand();
    await runCommand(useCmd, ["--built-in"]);

    const cmd = await getRunCommand();
    await runCommand(cmd, ["-p", "hi"]);
    expect(readShimOutput().PI_CODING_AGENT_DIR).toBe("");
  });

  it("generates models.yml with baseUrl for url profiles", async () => {
    await addProfile("px", ["-p", "kimi-coding", "-m", "m", "-t", "tok", "-u", "https://proxy.example.com"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["px"]);
    const out = readShimOutput();
    const models = parseYaml(fs.readFileSync(path.join(out.PI_CODING_AGENT_DIR, "models.yml"), "utf-8"));
    expect(models).toEqual({ providers: { "kimi-coding": { baseUrl: "https://proxy.example.com" } } });
  });

  it("materializes config.yml with the profile defaults", async () => {
    await addProfile("work", ["-p", "kimi-coding", "-m", "kimi-for-coding", "-t", "tok", "--thinking", "low"]);
    const cmd = await getRunCommand();
    await runCommand(cmd, ["work"]);
    const out = readShimOutput();
    const config = parseYaml(fs.readFileSync(path.join(out.PI_CODING_AGENT_DIR, "config.yml"), "utf-8"));
    expect(config).toMatchObject({
      defaultProvider: "kimi-coding",
      defaultModel: "kimi-for-coding",
      defaultThinkingLevel: "low",
    });
  });
});

