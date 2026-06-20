/**
 * `openclaw memgpt setup` command registration (6d.6).
 *
 * Uses `api.registerCli(({ program }) => …, { commands: ["memgpt"] })` — the
 * same pattern OpenClaw's own browser plugin uses to add a top-level command
 * group (`registerCli(({ program }) => registerBrowserCli(program), { commands:
 * ["browser"] })`). `program` is the host's commander instance.
 *
 * The wizard module (and @clack/prompts) is dynamic-imported inside the action
 * so it loads only when the user actually runs setup — plugin registration
 * (which happens on every OpenClaw invocation) stays light.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export function registerWizardCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }: { program: any }) => {
      const memgpt = program
        .command("memgpt")
        .description("openclaw-memgpt memory plugin");

      memgpt
        .command("setup")
        .description(
          "Configure the openclaw-memgpt LLM provider, credentials, and options",
        )
        .action(async () => {
          try {
            const { runWizard } = await import("./wizard.ts");
            const result = await runWizard({ logger: api.logger });
            if (result.status === "cancelled") {
              api.logger.info("openclaw-memgpt: setup cancelled — no changes made.");
            } else {
              api.logger.info(
                "openclaw-memgpt: setup complete — configuration saved.",
              );
            }
          } catch (err) {
            // Never echo credential bytes; surface only the error class/message,
            // which (by construction) carries file paths or validation text, not
            // the key itself.
            api.logger.error(
              `openclaw-memgpt: setup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exitCode = 1;
          }
        });

      memgpt
        .command("uninstall")
        .description(
          "Remove openclaw-memgpt: its credentials, memory data, config, and registration",
        )
        .option("--force", "Skip the confirmation prompt", false)
        .option("--keep-data", "Keep the MemGPT memory data dir", false)
        .option("--dry-run", "Show what would be removed without changing anything", false)
        .action(async (opts: { force?: boolean; keepData?: boolean; dryRun?: boolean }) => {
          try {
            const { runUninstall } = await import("./uninstall.ts");
            const result = await runUninstall({
              force: opts.force,
              keepData: opts.keepData,
              dryRun: opts.dryRun,
              logger: api.logger,
            });
            if (result.status === "cancelled") {
              api.logger.info("openclaw-memgpt: uninstall cancelled.");
            } else if (result.status === "removed") {
              api.logger.info(
                "openclaw-memgpt: uninstalled — artifacts removed and plugin unregistered.",
              );
            }
          } catch (err) {
            api.logger.error(
              `openclaw-memgpt: uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            process.exitCode = 1;
          }
        });
    },
    { commands: ["memgpt"] },
  );
}
