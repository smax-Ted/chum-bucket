import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import {
  ATLASSIAN_ALLOWED_TOOLS,
  ATLASSIAN_TOOLSETS,
  resolveAtlassianConfig,
} from "../server/harness/tools/atlassian-policy";

const HOST = "127.0.0.1";
const PORT = "8000";
const PATH_NAME = "/mcp";
const VERSION = "0.23.1";
const STOP_TIMEOUT_MS = 5_000;
const RUNTIME_KEYS = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LC_ALL",
]);

export type LaunchSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function buildLaunchSpec(env: Record<string, string | undefined>): LaunchSpec {
  const config = resolveAtlassianConfig(env);

  if (!config) {
    throw new Error(
      "JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN are required to start Atlassian MCP.",
    );
  }

  const runtime = Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (RUNTIME_KEYS.has(entry[0].toUpperCase()) || entry[0].toUpperCase().startsWith("UV_")),
    ),
  );

  return {
    command: "uvx",
    args: [
      "--from",
      `mcp-atlassian==${VERSION}`,
      "mcp-atlassian",
      "--transport",
      "streamable-http",
      "--host",
      HOST,
      "--port",
      PORT,
      "--path",
      PATH_NAME,
      "--read-only",
      "--enabled-tools",
      ATLASSIAN_ALLOWED_TOOLS.join(","),
    ],
    env: {
      ...runtime,
      JIRA_URL: config.baseUrl,
      JIRA_USERNAME: config.email,
      JIRA_API_TOKEN: config.apiToken,
      CONFLUENCE_URL: `${config.baseUrl}/wiki`,
      CONFLUENCE_USERNAME: config.email,
      CONFLUENCE_API_TOKEN: config.apiToken,
      ALLOW_GLOBAL_CRED_FALLBACK: "true",
      TOOLSETS: ATLASSIAN_TOOLSETS.join(","),
      PYTHON_DOTENV_DISABLED: "1",
    },
  };
}

export function launch(spec: LaunchSpec) {
  const child = spawn(spec.command, spec.args, {
    env: spec.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  let finished = false;
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", (failure: NodeJS.ErrnoException) => {
      finished = true;
      reject(
        new Error(`Failed to start ${spec.command}${failure.code ? ` (${failure.code})` : ""}.`),
      );
    });
    child.once("exit", (code, signal) => {
      finished = true;
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  function kill(force: boolean) {
    if (child.pid === undefined) {
      return;
    }

    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });

      return;
    }

    child.kill(force ? "SIGKILL" : "SIGTERM");
  }

  async function stop() {
    if (finished) {
      return;
    }

    kill(false);
    const timer = setTimeout(() => kill(true), STOP_TIMEOUT_MS);

    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  return { exited, stop };
}

async function main() {
  dotenv.config({ quiet: true });
  const handle = launch(buildLaunchSpec(process.env));

  const shutdown = () => {
    handle.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.exitCode = await handle.exited;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((failure: unknown) => {
    console.error(failure instanceof Error ? failure.message : "Launch failed.");
    process.exitCode = 1;
  });
}
