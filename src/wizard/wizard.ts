/**
 * Install-wizard orchestrator (6d.6).
 *
 * `runWizard` drives the interactive flow (from the `openclaw memgpt setup`
 * command) and persists the result: it writes the secret file first when a key
 * was pasted (so a failed write aborts before config is touched), then merges
 * the config block, then removes a now-orphaned secret file when switching
 * file→env (after config so the env ref is the source of truth — per the
 * operator's ordering decision).
 *
 * The register()-time detect-and-notify half lives in `detect.ts` (kept
 * dependency-light so the hot path doesn't load @clack). This module owns the
 * interactive flow, dynamic-imported by the `setup` CLI command.
 */

import { execFile } from "node:child_process";
import path from "node:path";

import {
  type ConfigIO,
  mergePluginConfig,
  readPluginConfigBlock,
  sdkConfigIO,
} from "./configStore.ts";
import {
  removeApiKeyFile,
  type SecretFileIO,
  sdkSecretFileIO,
  writeApiKeyFile,
} from "./credentialStore.ts";
import { PROVIDER_PRESETS } from "./providers.ts";
import {
  clackPrompter,
  collectAnswers,
  type Prompter,
  type WizardAnswers,
} from "./prompts.ts";

type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export interface RunWizardDeps {
  prompter?: Prompter;
  configIO?: ConfigIO;
  secretIO?: SecretFileIO;
  /** Resolved OpenClaw state dir (secret-file root). Defaults to the SDK resolver. */
  stateDir?: string;
  logger?: Logger;
  /**
   * Prerequisite probe: resolves true when `uv` is available (the plugin spawns
   * the sidecar via `uv run uvicorn`). Defaults to a real `uv --version` check.
   * Injected in tests. Only consulted in spawn mode (no `sidecarUrl`).
   */
  checkUv?: () => Promise<boolean>;
}

export interface RunWizardResult {
  status: "applied" | "cancelled";
  answers?: WizardAnswers;
}

/** Resolve the state dir via the SDK, with an env/home fallback for safety. */
export async function defaultStateDir(): Promise<string> {
  try {
    const mod = await import("openclaw/plugin-sdk/state-paths");
    return mod.resolveStateDir();
  } catch {
    const override = process.env.OPENCLAW_STATE_DIR?.trim();
    if (override) return override;
    return path.join(process.env.HOME ?? process.cwd(), ".openclaw");
  }
}

/**
 * Run the interactive wizard and persist its result. Returns `cancelled`
 * (writing nothing) if the user aborted at any prompt or declined the summary.
 */
export async function runWizard(
  deps: RunWizardDeps = {},
): Promise<RunWizardResult> {
  const prompter = deps.prompter ?? clackPrompter;
  const configIO = deps.configIO ?? sdkConfigIO;
  const secretIO = deps.secretIO ?? sdkSecretFileIO;
  const logger = deps.logger ?? console;
  const stateDir = deps.stateDir ?? (await defaultStateDir());

  const existing = await readPluginConfigBlock(configIO);
  const answers = await collectAnswers(prompter, existing);
  if (answers === null) return { status: "cancelled" };

  const preset = PROVIDER_PRESETS[answers.provider];
  // Store an explicit base URL so config is self-describing and the sidecar
  // env-injection just reads config.baseUrl: entered value for compatible,
  // preset default for the direct providers.
  const baseUrl = answers.baseUrl ?? preset.defaultBaseUrl;

  // 1. Secret file FIRST when a key was pasted — a failed write must not leave
  //    config pointing at a missing file.
  if (answers.pastedKey !== undefined) {
    await writeApiKeyFile(stateDir, answers.pastedKey, secretIO);
  }

  // 2. Config block.
  await mergePluginConfig(
    {
      provider: answers.provider,
      baseUrl,
      model: answers.model,
      credential: answers.credential,
      observability: answers.observability,
      sidecarUrl: answers.sidecarUrl,
    },
    configIO,
  );

  // 3. Remove the orphaned secret file AFTER config when switching file→env.
  if (answers.removeOldSecretFile) {
    try {
      await removeApiKeyFile(stateDir, secretIO);
    } catch (err) {
      logger.warn(
        `openclaw-memgpt: could not remove old secret file (harmless — config no longer references it): ${String(err)}`,
      );
    }
  }

  // Spawn-mode-only guidance (attach mode runs no sidecar of ours). Surfaces
  // the `uv` prerequisite and the embedder cold-start at setup time rather than
  // letting them bite at the first turn.
  if (answers.sidecarUrl === undefined) {
    const uvOk = await (deps.checkUv ?? defaultCheckUv)();
    if (!uvOk) {
      prompter.note(
        "`uv` was not found on your PATH. The plugin runs the memory sidecar via `uv run uvicorn`, so install uv before starting an agent:\n  https://docs.astral.sh/uv/  (e.g. `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`)\nThis wizard does not install it for you.",
        "Prerequisite missing",
      );
    }
    prompter.note(
      "The first agent turn downloads the embedding model (~60–90s) before memory is ready; subsequent runs are fast.",
      "Heads-up",
    );
  }

  prompter.outro("openclaw-memgpt configured. Run an agent to start using memory.");
  return { status: "applied", answers };
}

/** Real `uv` probe — resolves true iff `uv --version` exits 0. */
function defaultCheckUv(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("uv", ["--version"], { timeout: 5000 }, (err) => resolve(err == null));
  });
}
