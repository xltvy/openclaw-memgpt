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
    },
    { commands: ["memgpt"] },
  );
}
