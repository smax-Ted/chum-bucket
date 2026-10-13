import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

const selected = process.argv.slice(2);
const files = selected.length
  ? selected
  : readdirSync(testsDir, { recursive: true })
      .filter((file) => TEST_FILE.test(file) && !file.includes("node_modules"))
      .map((file) => join("tests", file))
      .sort();

if (files.length === 0) {
  throw new Error("No tests found");
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
  cwd: projectRoot,
  env: { ...process.env, TSX_TSCONFIG_PATH: join(testsDir, "tsconfig.json") },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
