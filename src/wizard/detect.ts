/**
 * register()-time configuration detection (6d.6). Deliberately tiny and
 * dependency-light (config only — no @clack, no SDK) so it can run on the hot
 * path of *every* plugin registration without pulling the prompt library in.
 *
 * register() is synchronous and not awaited by the SDK, so a blocking
 * interactive prompt cannot be launched here without racing the agent loop /
 * gateway / the `setup` command itself. We therefore *detect and notify* — one
 * prominent log pointing at `openclaw memgpt setup` — and keep the interactive
 * flow in the async CLI command.
 */

import { isConfigComplete, type PluginConfig } from "../config.ts";

type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

/**
 * If the plugin is unconfigured, emit a single pointer to `openclaw memgpt
 * setup` (warn on an interactive TTY, info otherwise so log-only operators
 * still discover it). Returns whether a notice was emitted. Silent when the
 * required wizard fields (provider + credential) are present.
 */
export function notifyIfUnconfigured(
  logger: Logger,
  config: PluginConfig,
  isInteractive: boolean = Boolean(process.stdout?.isTTY && process.stdin?.isTTY),
): boolean {
  if (isConfigComplete(config)) return false;
  const msg =
    "openclaw-memgpt is not configured yet — run `openclaw memgpt setup` to choose an LLM provider and supply an API key. Memory features stay inactive until setup completes.";
  if (isInteractive) logger.warn(msg);
  else logger.info(msg);
  return true;
}
