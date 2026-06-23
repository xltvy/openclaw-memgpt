/**
 * Startup-banner dedupe (polish).
 *
 * OpenClaw calls a plugin's `register()` several times per process (discovery /
 * runtime / context-engine / CLI contexts), each with the same config. Without
 * a guard the human-facing banner — the "… registered" line and the "not
 * configured" notice — prints N times. `takeFirstAnnounce` returns true only the
 * first time per namespace per process, so the banner logs once while the actual
 * tool/hook/service registration still runs on every `register()`.
 *
 * Kept in its own SDK-free module so it's unit-testable: `src/index.ts` imports
 * the host SDK (`definePluginEntry`), which the test runner can't resolve.
 */

const announced = new Set<string>();

/**
 * True the first time it's called for `namespace` this process (and records it);
 * false on every subsequent call for the same namespace. A different namespace
 * announces once of its own.
 */
export function takeFirstAnnounce(namespace: string): boolean {
  if (announced.has(namespace)) return false;
  announced.add(namespace);
  return true;
}

/** Test-only: clear the guard between cases. */
export function _resetAnnouncedNamespaces(): void {
  announced.clear();
}
