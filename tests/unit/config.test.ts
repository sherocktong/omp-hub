import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

function setup() {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-hub-config-test-"));
  process.env.OMP_HUB_OMP_DIR = tmpDir;
  process.env.OMP_HUB_PROFILES_FILE = path.join(tmpDir, "profiles.json");
  process.env.OMP_HUB_DIR = path.join(tmpDir, "omp-hub");
  process.env.PI_CODING_AGENT_DIR = path.join(tmpDir, "agent");
}

function teardown() {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.OMP_HUB_OMP_DIR;
  delete process.env.OMP_HUB_PROFILES_FILE;
  delete process.env.OMP_HUB_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
}

async function getConfig() {
  return import("../../src/config.js");
}

describe("config paths", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("defaults profiles file under the omp dir", async () => {
    delete process.env.OMP_HUB_PROFILES_FILE;
    vi.resetModules();
    const config = await getConfig();
    expect(config.PROFILES_FILE).toBe(path.join(tmpDir, "profiles.json"));
  });

  it("honours env overrides for all paths", async () => {
    const config = await getConfig();
    expect(config.PROFILES_FILE).toBe(path.join(tmpDir, "profiles.json"));
    expect(config.OMP_HUB_DIR).toBe(path.join(tmpDir, "omp-hub"));
    expect(config.AGENT_DIR).toBe(path.join(tmpDir, "agent"));
    expect(config.PROFILE_DIRS_DIR).toBe(path.join(tmpDir, "omp-hub", "profiles"));
    expect(config.AGENT_CONFIG_FILE).toBe(path.join(tmpDir, "agent", "config.yml"));
  });
});

describe("readJson / writeJson / ensureFile", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("ensureFile creates parent dirs and default content", async () => {
    const config = await getConfig();
    const file = path.join(tmpDir, "nested", "deep", "x.json");
    config.ensureFile(file, "{}\n");
    expect(fs.readFileSync(file, "utf-8")).toBe("{}\n");
  });

  it("ensureFile is a no-op when the file exists", async () => {
    const config = await getConfig();
    const file = path.join(tmpDir, "x.json");
    fs.writeFileSync(file, "custom", "utf-8");
    config.ensureFile(file, "{}\n");
    expect(fs.readFileSync(file, "utf-8")).toBe("custom");
  });

  it("writeJson then readJson round-trips", async () => {
    const config = await getConfig();
    const file = path.join(tmpDir, "data.json");
    config.writeJson(file, { a: 1, b: ["x", "y"] });
    expect(config.readJson(file)).toEqual({ a: 1, b: ["x", "y"] });
  });

  it("writeJson honours file mode", async () => {
    const config = await getConfig();
    const file = path.join(tmpDir, "secret.json");
    config.writeJson(file, { token: "sk-x" }, 0o600);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("ensureProfilesFile creates default profiles data", async () => {
    const config = await getConfig();
    config.ensureProfilesFile();
    expect(config.readJson<Record<string, unknown>>(config.PROFILES_FILE)).toEqual({ profiles: {} });
  });
});

describe("readYaml / writeYaml", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("writeYaml then readYaml round-trips nested data", async () => {
    const config = await getConfig();
    const file = path.join(tmpDir, "config.yml");
    const data = { defaultModel: "m", modelThinkingLevels: { "p/m": "low" }, list: [1, 2] };
    config.writeYaml(file, data);
    expect(config.readYaml(file)).toEqual(data);
  });

  it("writeYaml honours file mode", async () => {
    const config = await getConfig();
    const file = path.join(tmpDir, "secret.yml");
    config.writeYaml(file, { token: "sk-x" }, 0o600);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
