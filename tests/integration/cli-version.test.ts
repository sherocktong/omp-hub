import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("cli", () => {
  let version = "";

  beforeAll(() => {
    execSync("npm run build", { cwd: rootDir, stdio: "pipe" });
    version = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8")).version;
  }, 120_000);

  it("dist/index.js --version prints the package version", () => {
    const out = execSync("node dist/index.js --version", { cwd: rootDir }).toString().trim();
    expect(out).toBe(version);
  });

  it("dist/index.js --help lists the core commands", () => {
    const out = execSync("node dist/index.js --help", { cwd: rootDir }).toString();
    expect(out).toContain("profile");
    expect(out).toContain("use");
    expect(out).toContain("run");
  });
});
