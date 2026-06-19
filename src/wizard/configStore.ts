/**
 * Plugin-config read/write for the 6d.6 wizard.
 *
 * The plugin reads its config from `api.pluginConfig`, which OpenClaw populates
 * from the single top-level config file (`~/.openclaw/openclaw.json`, dev:
 * `~/.openclaw-dev/openclaw.json`) at `plugins.entries.openclaw-memgpt.config`.
 * There is no separate per-plugin config file in this SDK — so the wizard
 * writes into that same block, via the SDK's `updateConfig` helper which does a
 * read-snapshot → mutate-clone → write-back with hash-based conflict detection
 * (concurrency-safe; resolves the config path from env internally).
 *
 * As with credentialStore, the SDK calls go through a `ConfigIO` seam that
 * `dynamic import()`s the host module at call time — unit tests inject a fake.
 */

export const PLUGIN_ID = "openclaw-memgpt";

export interface ConfigIO {
  load(): Promise<Record<string, any>>;
  update(
    mutator: (cfg: Record<string, any>) => Record<string, any>,
  ): Promise<Record<string, any>>;
}

export const sdkConfigIO: ConfigIO = {
  async load() {
    const mod = await import("openclaw/plugin-sdk/config-runtime");
    return await mod.loadConfig();
  },
  async update(mutator) {
    const mod = await import("openclaw/plugin-sdk/config-runtime");
    return await mod.updateConfig(mutator);
  },
};

/**
 * Read the plugin's current config block from disk (empty object if the plugin
 * has no config entry yet). Used to prefill defaults on wizard re-entry.
 */
export async function readPluginConfigBlock(
  io: ConfigIO = sdkConfigIO,
): Promise<Record<string, unknown>> {
  const cfg = await io.load();
  const block = cfg?.plugins?.entries?.[PLUGIN_ID]?.config;
  return block && typeof block === "object" ? { ...block } : {};
}

/**
 * Merge `updates` into the plugin's config block. Keys with `undefined` values
 * are *deleted* from the block (so the wizard can clear e.g. `baseUrl` or
 * `sidecarUrl`); all other current keys (namespace/persona/human, which the
 * wizard does not collect) are preserved. Ensures the plugin entry exists and
 * is enabled.
 */
export async function mergePluginConfig(
  updates: Record<string, unknown>,
  io: ConfigIO = sdkConfigIO,
): Promise<void> {
  await io.update((cfg) => {
    cfg.plugins ??= {};
    cfg.plugins.entries ??= {};
    const entry = (cfg.plugins.entries[PLUGIN_ID] ??= { enabled: true });
    if (entry.enabled === undefined) entry.enabled = true;
    const current = (entry.config ??= {});
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete current[key];
      else current[key] = value;
    }
    return cfg;
  });
}
