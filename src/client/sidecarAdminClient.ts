/**
 * Management/status surface client — per API_DESIGN.md §3.5.
 *
 * The memory-behaviour SidecarClient is governed by the no-invented-endpoint
 * rule: every method must trace to a pymemgpt anchor. Operational plumbing —
 * residency tables, process PID/port, last-restart, future restart-self —
 * has no pymemgpt behaviour to anchor against and is therefore exempt by
 * design, not oversight. Keeping it on a separate class makes the boundary
 * structural rather than conventional, and means the §3.5 surface can be
 * developed (6d) without enlarging the memory-surface contract.
 *
 * 6c.1 — scaffold only. Every method throws `not yet implemented —
 * deferred to 6d`. The class compiles, satisfies the documentary contract,
 * and is importable by lifecycle code that wants to gate on its existence,
 * but cannot do real work until 6d binds the endpoints.
 */

import type { PluginConfig } from "../config.ts";
import type { SidecarStatus } from "./types.ts";

// ============================================================================
// Contract
// ============================================================================

export interface SidecarAdminClient {
  /**
   * Snapshot of the sidecar's operational state: residency table, PID, port,
   * and last-restart timestamp. Not anchored to any pymemgpt method (§3.5).
   */
  status(): Promise<SidecarStatus>;

  /**
   * Force-evict an agent from the sidecar's resident registry, simulating a
   * process restart for that namespace without disturbing the rest. Used by
   * the experiment harness's cold-start arm (§7.2). Disk state is untouched
   * — the next ensure() that targets this namespace will see the on-disk
   * branch and delegate to :load.
   */
  evict(namespace: string): Promise<{ namespace: string; evicted: boolean }>;

  /**
   * List every namespace currently resident in the sidecar's registry.
   * Diagnostic surface for the `openclaw memgpt sidecar status` CLI (6d).
   */
  listResident(): Promise<{ namespaces: string[] }>;
}

// ============================================================================
// Implementation — stubs only
// ============================================================================

const DEFERRED = (op: string): Error =>
  new Error(
    `SidecarAdminClient.${op}: admin endpoint not yet implemented — ` +
      `deferred to 6d (§3.5 management/status surface; lifecycle layer ` +
      `binds these once it owns the sidecar process)`,
  );

export class SidecarAdminClientImpl implements SidecarAdminClient {
  private readonly config: PluginConfig;
  private readonly resolveBaseUrl: () => Promise<string>;

  constructor(config: PluginConfig, resolveBaseUrl: () => Promise<string>) {
    this.config = config;
    this.resolveBaseUrl = resolveBaseUrl;
  }

  async status(): Promise<SidecarStatus> {
    // Reference these so the unused-private warnings don't fire while 6d is
    // pending; the constructor surface is the documentary contract.
    void this.config;
    void this.resolveBaseUrl;
    throw DEFERRED("status");
  }

  async evict(_namespace: string): Promise<{ namespace: string; evicted: boolean }> {
    throw DEFERRED("evict");
  }

  async listResident(): Promise<{ namespaces: string[] }> {
    throw DEFERRED("listResident");
  }
}
