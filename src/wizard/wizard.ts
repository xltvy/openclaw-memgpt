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
import { fileURLToPath } from "node:url";

import { findSidecarDir } from "../lifecycle/lifecycleManager.ts";
import { isEndpointReachable, isLocalUrl } from "../reachability.ts";
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
  /**
   * Connection-level reachability probe for the configured LLM endpoint.
   * Defaults to a real fetch (`isEndpointReachable`). Injected in tests.
   */
  reachable?: (url: string) => Promise<boolean>;
  /**
   * Pre-warm the embedder cache by running the sidecar's `--prewarm` mode
   * (downloads + caches the model, then exits). Resolves true on success.
   * Defaults to a real `uv run python main.py --prewarm`. Injected in tests so
   * the wizard suite never spawns a subprocess.
   */
  prewarmEmbedder?: (stateDir: string) => Promise<boolean>;
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

  // Conversation-access grant note (surfaced before the write that sets it).
  // OpenClaw blocks a non-bundled plugin's conversation-reading hooks unless the
  // user opts in; a memory plugin can't store what it can't read, so setup grants
  // it. Make the grant visible + revocable.
  prompter.note(
    "openclaw-memgpt reads your conversation to store memories, so setup grants it conversation access (sets hooks.allowConversationAccess=true on the plugin entry in your config). Without it, gateway mode silently skips saving/recalling. Remove that flag any time to revoke.",
    "Conversation access",
  );

  // 2. Config block (also sets hooks.allowConversationAccess — see mergePluginConfig).
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

  // Reachability of the LLM endpoint (all modes — the sidecar always uses
  // config.baseUrl). Warn at setup if it's not answering now, so an unstarted
  // local server (LiteLLM/Ollama/…) or a typo'd URL surfaces here rather than
  // only when summarisation later fails. Connection-level only (any HTTP
  // response = reachable), so an auth-gated endpoint doesn't false-warn.
  if (baseUrl !== undefined) {
    const reachable = deps.reachable ?? ((u: string) => isEndpointReachable(u));
    if (!(await reachable(baseUrl))) {
      prompter.note(
        `Couldn't reach the LLM endpoint ${baseUrl} right now.${
          isLocalUrl(baseUrl)
            ? " If this is a local server (LiteLLM, Ollama, LM Studio, …), start it before running an agent — the plugin does not launch it for you."
            : " Double-check the URL; the sidecar uses it for the LLM."
        }`,
        "Endpoint not reachable",
      );
    }
  }

  // Spawn-mode-only guidance (attach mode runs no sidecar of ours). Surfaces
  // the `uv` prerequisite and the embedder cold-start at setup time rather than
  // letting them bite at the first turn.
  if (answers.sidecarUrl === undefined) {
    const uvOk = await (deps.checkUv ?? defaultCheckUv)();
    if (!uvOk) {
      // Without uv we can't run the sidecar (or pre-warm); just flag the
      // prerequisite and the cold-start cost the first turn will pay.
      prompter.note(
        "`uv` was not found on your PATH. The plugin runs the memory sidecar via `uv run uvicorn`, so install uv before starting an agent:\n  https://docs.astral.sh/uv/  (e.g. `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`)\nThis wizard does not install it for you.",
        "Prerequisite missing",
      );
      prompter.note(
        "The first agent turn downloads the embedding model (~60–90s) before memory is ready; subsequent runs are fast.",
        "Heads-up",
      );
    } else {
      // Offer to pre-warm the embedder cache now. A cold (uncached) load is a
      // ~60s online download that overruns OpenClaw's 15s before_prompt_build
      // hook on the first `--local` turn; pre-warming downloads it once here so
      // the first turn finds a warm cache (offline load ~3-4s). Declining is
      // fine — the first turn just pays the download instead.
      const wantPrewarm = await prompter.confirm({
        message:
          "Pre-download the embedding model now (~60s)? Makes the first agent turn fast; otherwise the first turn pays the download.",
        initialValue: true,
      });
      if (wantPrewarm === true) {
        prompter.note(
          "Downloading the embedding model — runs once, may take up to ~60s …",
          "Pre-warming",
        );
        const ok = await (deps.prewarmEmbedder ?? defaultPrewarmEmbedder)(stateDir);
        prompter.note(
          ok
            ? "Embedder cached — the first agent turn will be fast."
            : "Pre-warm didn't finish; the first agent turn will download the embedding model (~60s) instead. Harmless — subsequent turns are still fast.",
          ok ? "Ready" : "Heads-up",
        );
      } else {
        // Cancel or decline → skip; note the deferred cost.
        prompter.note(
          "Skipped pre-warm. The first agent turn downloads the embedding model (~60s); subsequent runs are fast.",
          "Heads-up",
        );
      }
    }
  }

  prompter.outro("openclaw-memgpt configured. Run an agent to start using memory.");
  return { status: "applied", answers };
}

export interface RunPrewarmDeps {
  logger?: Logger;
  stateDir?: string;
  checkUv?: () => Promise<boolean>;
  prewarmEmbedder?: (stateDir: string) => Promise<boolean>;
}

/**
 * Standalone embedder pre-warm (the `openclaw memgpt prewarm` command). Same
 * `--prewarm` sidecar mode the wizard offers, exposed separately for recovery
 * (e.g. after the HF cache is evicted and the runtime sidecar reports the cache
 * unavailable). Downloads + caches the model and writes the warm-marker so
 * subsequent cold-starts are offline-fast. Returns true on success.
 */
export async function runPrewarm(deps: RunPrewarmDeps = {}): Promise<boolean> {
  const logger = deps.logger ?? console;
  const stateDir = deps.stateDir ?? (await defaultStateDir());

  const uvOk = await (deps.checkUv ?? defaultCheckUv)();
  if (!uvOk) {
    logger.error(
      "openclaw-memgpt: `uv` not found on PATH — cannot pre-warm. Install uv (https://docs.astral.sh/uv/) and retry.",
    );
    return false;
  }

  logger.info(
    "openclaw-memgpt: pre-warming the embedder — downloads once, up to ~60s …",
  );
  const ok = await (deps.prewarmEmbedder ?? defaultPrewarmEmbedder)(stateDir);
  if (ok) {
    logger.info(
      "openclaw-memgpt: embedder cached — agent turns will be offline-fast.",
    );
  } else {
    logger.error(
      "openclaw-memgpt: pre-warm did not complete. The first agent turn will download the model instead (harmless, just slower).",
    );
  }
  return ok;
}

/** Real `uv` probe — resolves true iff `uv --version` exits 0. */
function defaultCheckUv(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("uv", ["--version"], { timeout: 5000 }, (err) => resolve(err == null));
  });
}

/**
 * Real embedder pre-warm — runs the sidecar's `--prewarm` mode (`uv run python
 * main.py --prewarm`), which downloads + caches the model then exits. Resolves
 * true iff it exits 0. The sidecar dir is resolved the same way the lifecycle
 * manager resolves it (walk up to `sidecar/main.py`); the data/venv dirs mirror
 * the spawn env so the warmed cache is the one the runtime sidecar uses.
 */
function defaultPrewarmEmbedder(stateDir: string): Promise<boolean> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sidecarDir = findSidecarDir(here);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_MEMGPT_DATA_DIR: path.join(stateDir, "memgpt-data"),
    UV_PROJECT_ENVIRONMENT: path.join(stateDir, "memgpt-sidecar-venv"),
  };
  return new Promise((resolve) => {
    execFile(
      "uv",
      ["run", "python", "main.py", "--prewarm"],
      { cwd: sidecarDir, env, timeout: 180_000 },
      (err) => resolve(err == null),
    );
  });
}
