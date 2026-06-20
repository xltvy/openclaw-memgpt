/**
 * `openclaw memgpt uninstall` — one-command teardown (6d.6).
 *
 * Generic `openclaw plugins uninstall` removes the registry entry but leaves
 * this plugin's *data* behind (the mode-0600 secret file, the MemGPT data dir,
 * the observability log). This command removes those AND de-registers the
 * plugin from `openclaw.json`, so a public user gets a clean removal in one go.
 *
 * De-registration mirrors exactly what `plugins uninstall` writes (verified
 * against its computed output): drop `plugins.entries[id]`, `plugins.installs
 * [id]`, our `plugins.load.paths` entry, and reset `plugins.slots.memory` to
 * the default `memory-core`. It goes through the SDK `updateConfig` first; if
 * that throws (notably OpenClaw's size-drop guard on a minimal config, which
 * blocks the normal `plugins uninstall` too), it falls back to a direct atomic
 * write of the resolved config path — justified for an explicit, user-initiated
 * uninstall with no concurrent writer.
 *
 * The linked *source* repo (for a `--link` dev install) is never touched — that
 * is the user's code, not plugin state.
 */

import { rm, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";

import { PLUGIN_ID, type ConfigIO, sdkConfigIO } from "./configStore.ts";
import { clackPrompter, type Prompter } from "./prompts.ts";
import { defaultStateDir } from "./wizard.ts";

type Logger = { info(m: string): void; warn(m: string): void; error(m: string): void };

export interface UninstallOptions {
  force?: boolean;
  keepData?: boolean;
  dryRun?: boolean;
}

export interface UninstallDeps extends UninstallOptions {
  prompter?: Prompter;
  configIO?: ConfigIO;
  stateDir?: string;
  configPath?: string;
  logger?: Logger;
  /** Filesystem seam (tests inject a fake). */
  fs?: UninstallFs;
  /** TTY check seam for the confirm gate. */
  isInteractive?: boolean;
}

export interface UninstallFs {
  remove(target: string): Promise<void>;
  atomicWriteJson(target: string, value: unknown): Promise<void>;
}

const defaultFs: UninstallFs = {
  async remove(target) {
    await rm(target, { recursive: true, force: true });
  },
  async atomicWriteJson(target, value) {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, target);
  },
};

/** Absolute paths of this plugin's on-disk artifacts under `stateDir`. */
export function artifactPaths(
  stateDir: string,
  opts: { keepData?: boolean } = {},
): string[] {
  const paths = [
    path.join(stateDir, "plugins", "openclaw-memgpt"), // secret dir (api-key)
    path.join(stateDir, "memgpt-observability.jsonl"), // observability log
  ];
  if (!opts.keepData) {
    paths.push(path.join(stateDir, "memgpt-data")); // MemGPT agent state / pickles
  }
  return paths;
}

/**
 * Config mutator matching `plugins uninstall`'s output for this plugin. Pure +
 * exported for testing. Operates on (and returns) the passed object.
 */
export function applyUninstallMutation(
  cfg: Record<string, any>,
): Record<string, any> {
  const p = cfg?.plugins;
  if (!p || typeof p !== "object") return cfg;

  const sourcePath: string | undefined = p.installs?.[PLUGIN_ID]?.sourcePath;
  if (p.entries) delete p.entries[PLUGIN_ID];
  if (p.installs) delete p.installs[PLUGIN_ID];

  if (Array.isArray(p.load?.paths)) {
    p.load.paths = p.load.paths.filter(
      (entry: unknown) => entry !== sourcePath,
    );
    if (p.load.paths.length === 0) delete p.load.paths;
  }

  // Only reset the memory slot if *we* hold it; mirror OpenClaw's fallback.
  if (p.slots && p.slots.memory === PLUGIN_ID) {
    p.slots.memory = "memory-core";
  }
  return cfg;
}

function resolveConfigPath(stateDir: string): string {
  const override = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) return override;
  return path.join(stateDir, "openclaw.json");
}

export interface UninstallResult {
  status: "removed" | "cancelled" | "dry-run";
  artifactsRemoved: string[];
}

/**
 * Run the uninstall. Removes artifacts, then de-registers from config (SDK
 * update → direct-write fallback). `--dry-run` reports without changing
 * anything; `--keep-data` preserves the MemGPT data dir.
 */
export async function runUninstall(
  deps: UninstallDeps = {},
): Promise<UninstallResult> {
  const prompter = deps.prompter ?? clackPrompter;
  const configIO = deps.configIO ?? sdkConfigIO;
  const fs = deps.fs ?? defaultFs;
  const logger = deps.logger ?? console;
  const stateDir = deps.stateDir ?? (await defaultStateDir());
  const configPath = deps.configPath ?? resolveConfigPath(stateDir);
  const interactive =
    deps.isInteractive ?? Boolean(process.stdout?.isTTY && process.stdin?.isTTY);

  const artifacts = artifactPaths(stateDir, { keepData: deps.keepData });

  if (deps.dryRun) {
    prompter.note(
      [
        "Would remove these artifacts:",
        ...artifacts.map((a) => `  - ${a}`),
        deps.keepData ? "  (memgpt-data kept: --keep-data)" : "",
        `And de-register the plugin from ${configPath}.`,
      ]
        .filter(Boolean)
        .join("\n"),
      "Dry run — no changes made",
    );
    return { status: "dry-run", artifactsRemoved: [] };
  }

  // Destructive: confirm unless --force. Non-interactive requires --force.
  if (!deps.force) {
    if (!interactive) {
      throw new Error(
        "openclaw-memgpt: uninstall needs confirmation — re-run with --force in a non-interactive shell.",
      );
    }
    const ok = await prompter.confirm({
      message: deps.keepData
        ? "Remove openclaw-memgpt's credentials + config and unregister it (keeping memory data)?"
        : "Remove openclaw-memgpt's credentials, memory data, and config, and unregister it?",
      initialValue: false,
    });
    if (prompter.isCancel(ok) || ok === false) {
      prompter.cancel("Uninstall cancelled — nothing was removed.");
      return { status: "cancelled", artifactsRemoved: [] };
    }
  }

  // 1. Remove on-disk artifacts (idempotent; missing paths are fine).
  const removed: string[] = [];
  for (const target of artifacts) {
    try {
      await fs.remove(target);
      removed.push(target);
    } catch (err) {
      logger.warn(
        `openclaw-memgpt: could not remove ${target}: ${String(err)}`,
      );
    }
  }

  // 2. De-register from config: SDK update → direct atomic-write fallback.
  try {
    await configIO.update(applyUninstallMutation);
  } catch (err) {
    logger.warn(
      `openclaw-memgpt: SDK config update rejected (${String(err)}); writing config directly.`,
    );
    const current = await configIO.load();
    const next = applyUninstallMutation(structuredClone(current));
    await fs.atomicWriteJson(configPath, next);
  }

  prompter.outro?.(
    "openclaw-memgpt uninstalled. Restart OpenClaw (or the gateway) if it's running.",
  );
  return { status: "removed", artifactsRemoved: removed };
}
