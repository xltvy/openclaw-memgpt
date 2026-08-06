/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with:  node scripts/generate-sdk-types.mjs
 * Source: openclaw@2026.6.10 (dist/plugin-sdk/hook-types-Dik-Ur77.d.ts)
 *
 * Ambient types for the host-provided `openclaw` package. The hook layer is
 * generated from the installed SDK so every hook's event/context payload is
 * fully typed (ctx.contextTokenBudget, event.messages, usage, ...); the plugin
 * API surface and wizard subpath modules are hand-maintained templates inside
 * the generator script, verified against the same bundle.
 */

declare module "openclaw/plugin-sdk" {

  // ── Plugin API surface (hand-maintained template in the generator) ──

  export interface MemoryArtifact {
    id: string;
    type: "memory" | "dream" | "digest" | "entity";
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }

  export interface PublicArtifactsProvider {
    listArtifacts(options?: {
      userId?: string;
      types?: string[];
      limit?: number;
    }): Promise<MemoryArtifact[]>;
  }

  export interface MemoryCapabilityConfig {
    promptBuilder?: (ctx: any) => Promise<string | null>;
    flushPlanResolver?: (ctx: any) => Promise<any>;
    runtime?: Record<string, unknown>;
    publicArtifacts?: PublicArtifactsProvider;
  }

  export interface OpenClawPluginApi {
    pluginConfig: Record<string, unknown>;
    logger: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
      debug(msg: string): void;
    };
    resolvePath(p: string): string;
    registerTool(
      definition: {
        name: string;
        description: string;
        parameters: unknown;
        execute: (
          toolCallId: string,
          params: Record<string, unknown>,
        ) => Promise<{ content: Array<{ type: string; text: string }>; [key: string]: unknown }>;
        [key: string]: unknown;
      },
      metadata?: { optional?: boolean; [key: string]: unknown },
    ): void;
    /**
     * Typed hook registration — the SDK's real signature (types-*.d.ts
     * `OpenClawPluginApi.on`). Handlers get the per-hook event/context types
     * from PluginHookHandlerMap instead of `any`.
     */
    on<K extends PluginHookName>(
      hookName: K,
      handler: PluginHookHandlerMap[K],
      opts?: { priority?: number; timeoutMs?: number },
    ): void;
    registerCli(
      handler: (context: { program: any }) => void,
      options?: Record<string, unknown>,
    ): void;
    registerCommand?(definition: Record<string, unknown>): void;
    registerService(service: {
      id: string;
      start?: (ctx: Record<string, unknown>) => void | Promise<void>;
      stop?: (ctx: Record<string, unknown>) => void | Promise<void>;
    }): void;
    registerContextEngine?(id: string, factory: unknown): void;
    registerMemoryCapability?(config: MemoryCapabilityConfig): void;
    [key: string]: unknown;
  }

  // ── Hook types (generated from hook-types-Dik-Ur77.d.ts) ──

  // Opaque aliases for chunk-internal types the hook payloads reference.
  type AgentMessage = { role: string; content?: unknown; [key: string]: unknown };
  type ChatType = string;
  type SourceReplyDeliveryMode = string;
  type ReplyPayload = { [key: string]: unknown };
  type FinalizedMsgContext = { [key: string]: unknown };
  type OpenClawConfig = { [key: string]: unknown };
  type TtsAutoMode = string;
  type DiagnosticTraceContext = { [key: string]: unknown };
  type PluginConversationBinding = { [key: string]: unknown };


  //#region src/auto-reply/reply/reply-dispatcher.types.d.ts
  export type ReplyDispatchKind = "tool" | "block" | "final";
  export type ReplyFollowupAdmissionBarrierTimeoutPolicy = {
    /** Absolute failsafe for owner activity that never settles. */maxTimeoutMs: number; /** Extend by another default settle interval while bounded owner work remains active. */
    shouldExtend: () => boolean;
  };
  export type ReplyDispatchRuntimeInfo = {
    kind: ReplyDispatchKind;
    assistantMessageIndex?: number;
  };
  export type ReplyDispatchBeforeDeliver = (payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) => Promise<ReplyPayload | null> | ReplyPayload | null;
  export type ReplyDispatcher = {
    sendToolResult: (payload: ReplyPayload) => boolean;
    sendBlockReply: (payload: ReplyPayload) => boolean;
    sendFinalReply: (payload: ReplyPayload) => boolean;
    appendBeforeDeliver?: (hook: ReplyDispatchBeforeDeliver) => void;
    waitForIdle: () => Promise<void>;
    getQueuedCounts: () => Record<ReplyDispatchKind, number>;
    getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
    getFailedCounts: () => Record<ReplyDispatchKind, number>;
    markComplete: () => void; /** Owner-declared deadline for holding queued follow-ups behind all queued deliveries. */
    resolveFollowupAdmissionBarrierTimeoutPolicy?: () => ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined;
  };
  //#endregion
  //#region src/plugins/hook-before-agent-start.types.d.ts
  export type PluginHookBeforeModelResolveAttachment = {
    kind: "image" | "video" | "audio" | "document" | "other";
    mimeType?: string;
  };
  export type PluginHookBeforeModelResolveEvent = {
    /** User prompt for this run. No session messages are available yet in this phase. */prompt: string; /** Attachment metadata for file-aware model routing. */
    attachments?: PluginHookBeforeModelResolveAttachment[];
  };
  export type PluginHookBeforeModelResolveResult = {
    /** Override the model for this agent run. E.g. "llama3.3:8b" */modelOverride?: string; /** Override the provider for this agent run. E.g. "local-provider" */
    providerOverride?: string;
  };
  export type PluginHookBeforePromptBuildEvent = {
    prompt: string; /** Session messages prepared for this run. */
    messages: unknown[];
  };
  export type PluginHookBeforePromptBuildResult = {
    systemPrompt?: string;
    prependContext?: string;
    appendContext?: string;
    /**
     * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
     * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
     */
    prependSystemContext?: string;
    /**
     * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
     * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
     */
    appendSystemContext?: string;
  };
  export const PLUGIN_PROMPT_MUTATION_RESULT_FIELDS: readonly ["systemPrompt", "prependContext", "appendContext", "prependSystemContext", "appendSystemContext"];
  /**
   * @deprecated Use before_model_resolve and before_prompt_build.
   *
   * Legacy compatibility hook that combines both phases.
   */
  export type PluginHookBeforeAgentStartEvent = {
    prompt: string;
    runId?: string; /** Optional because legacy hook can run in pre-session phase. */
    messages?: unknown[];
  };
  /** @deprecated Use before_model_resolve and before_prompt_build result types. */
  export type PluginHookBeforeAgentStartResult = PluginHookBeforePromptBuildResult & PluginHookBeforeModelResolveResult;
  /** @deprecated Use before_model_resolve override result types. */
  export type PluginHookBeforeAgentStartOverrideResult = Omit<PluginHookBeforeAgentStartResult, keyof PluginHookBeforePromptBuildResult>;
  export const stripPromptMutationFieldsFromLegacyHookResult: (result: PluginHookBeforeAgentStartResult | void) => PluginHookBeforeAgentStartOverrideResult | void;
  //#endregion
  //#region src/plugins/hook-before-tool-call-result.d.ts
  export const PluginApprovalResolutions: {
    readonly ALLOW_ONCE: "allow-once";
    readonly ALLOW_ALWAYS: "allow-always";
    readonly DENY: "deny";
    readonly TIMEOUT: "timeout";
    readonly CANCELLED: "cancelled";
  };
  export type PluginApprovalResolution = (typeof PluginApprovalResolutions)[keyof typeof PluginApprovalResolutions];
  export type PluginHookBeforeToolCallResult = {
    params?: Record<string, unknown>;
    block?: boolean;
    blockReason?: string;
    requireApproval?: {
      title: string;
      description: string;
      severity?: "info" | "warning" | "critical";
      timeoutMs?: number;
      timeoutBehavior?: "allow" | "deny";
      allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
      pluginId?: string;
      onResolution?: (decision: PluginApprovalResolution) => Promise<void> | void;
    };
  };
  //#endregion
  //#region src/plugins/hook-decision-types.d.ts
  /**
   * Structured decision returned by gate/policy hooks.
   * Core is outcome-agnostic — it handles the mechanics of each outcome
   * without knowing *why* the decision was made.
   */
  export type HookDecision = HookDecisionPass | HookDecisionBlock;
  /** Content is fine. Proceed normally. */
  export type HookDecisionPass = {
    outcome: "pass";
  };
  /**
   * Content is blocked. `reason` is internal plugin-local detail; core must not log,
   * persist, broadcast, or expose it verbatim. `message` is user-facing detail.
   */
  export type HookDecisionBlock = {
    outcome: "block"; /** Internal plugin-local reason. Do not log, persist, broadcast, or expose verbatim. */
    reason: string; /** Optional user-facing detail included in the block response envelope. */
    message?: string; /** Plugin-defined category for analytics (e.g. "violence", "pii", "cost_limit"). */
    category?: string; /** Opaque metadata for the plugin's own use. Core does not interpret it. */
    metadata?: Record<string, unknown>;
  };
  /** Outcomes valid for input gates (before_agent_run). */
  export type InputGateDecision = HookDecisionPass | HookDecisionBlock;
  /**
   * A gate hook decision paired with the pluginId that produced it.
   * Returned by gate hook runners so callers can
   * attribute blocked entries and audit events to the originating plugin.
   */
  export type GateHookResult<TDecision extends HookDecision = HookDecision> = {
    decision: TDecision;
    pluginId: string;
  };
  //#endregion
  //#region src/plugins/hook-message.types.d.ts
  export type PluginHookMessageContext = {
    channelId: string;
    accountId?: string;
    conversationId?: string;
    /**
     * Canonical session key for this conversation — the same value the agent
     * runtime sees as `params.sessionKey` for the run that produced the
     * outbound payload, and the same value `agent_end`/`llm_input`/`llm_output`
     * fire with. Plugins correlating per-turn state across `agent_end` and
     * `message_sending` rely on this equality.
     *
     * For inbound message hooks (`inbound_claim` etc.), this is the canonical
     * session for the inbound conversation as resolved by `resolveSessionKey`
     * / `deriveInboundMessageHookContext`.
     *
     * For outbound delivery hooks (`message_sending` and `message_sent`),
     * this mirrors `OutboundSessionContext.key` from the dispatch path when
     * delivery has a session attached. When the outbound path has no
     * resolvable session (e.g. internal smoke runs without
     * `OutboundSessionContext`), this field is omitted; plugins must treat
     * it as optional.
     */
    sessionKey?: string;
    /**
     * Per-turn run identifier (UUID), unique to one end-to-end agent turn:
     * stable across all LLM-call iterations, retry attempts (compaction,
     * empty-response, planning-only, etc.), and multi-payload reply chunks
     * within that turn; distinct for each new inbound user message and for
     * each cron/heartbeat/followup-triggered run.
     *
     * Generated once in `agent-runner-execution.ts`/`followup-runner.ts` via
     * `crypto.randomUUID()`. Currently populated for inbound message hooks
     * (`inbound_claim`, `message_received`) and for agent-runtime hooks that
     * already receive the run id (e.g. `agent_end`, `llm_input`, `llm_output`).
     * It is **not yet** plumbed through the outbound delivery path, so
     * plugins observing `message_sending` / `message_sent` should not rely
     * on `runId` to correlate against `agent_end`; use `sessionKey` for
     * outbound→inbound correlation today (with the caveat that it cannot
     * disambiguate concurrent turns in the same session).
     */
    runId?: string;
    messageId?: string;
    senderId?: string;
    replyToId?: string;
    replyToIdFull?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    trace?: DiagnosticTraceContext;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    callDepth?: number;
  };
  export type PluginHookInboundClaimContext = PluginHookMessageContext & {
    parentConversationId?: string;
    senderId?: string;
    messageId?: string;
    pluginBinding?: PluginConversationBinding;
  };
  export type PluginHookInboundClaimEvent = {
    content: string;
    body?: string;
    bodyForAgent?: string;
    transcript?: string;
    timestamp?: number;
    channel: string;
    accountId?: string;
    conversationId?: string;
    parentConversationId?: string;
    senderId?: string;
    senderName?: string;
    senderUsername?: string;
    replyToId?: string;
    replyToIdFull?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    threadId?: string | number;
    messageId?: string;
    sessionKey?: string;
    runId?: string;
    trace?: DiagnosticTraceContext;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    isGroup: boolean;
    commandAuthorized?: boolean;
    wasMentioned?: boolean;
    metadata?: Record<string, unknown>;
  };
  export type PluginHookMessageReceivedEvent = {
    from: string;
    content: string;
    timestamp?: number;
    threadId?: string | number;
    messageId?: string;
    senderId?: string;
    replyToId?: string;
    replyToIdFull?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    sessionKey?: string;
    runId?: string;
    trace?: DiagnosticTraceContext;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    metadata?: Record<string, unknown>;
  };
  export type PluginHookMessageSendingEvent = {
    to: string;
    content: string;
    replyToId?: string | number;
    threadId?: string | number;
    metadata?: Record<string, unknown>;
  };
  export type PluginHookMessageSendingResult = {
    content?: string;
    cancel?: boolean;
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
  export type PluginHookMessageSentEvent = {
    to: string;
    content: string;
    success: boolean;
    messageId?: string;
    sessionKey?: string;
    runId?: string;
    trace?: DiagnosticTraceContext;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    error?: string;
  };
  //#endregion
  //#region src/plugins/host-hook-json.d.ts
  /** JSON primitive values accepted across plugin host-hook boundaries. */
  export type PluginJsonPrimitive = string | number | boolean | null;
  /** Bounded JSON value shape accepted from plugin hooks. */
  export type PluginJsonValue = PluginJsonPrimitive | PluginJsonValue[] | {
    [key: string]: PluginJsonValue;
  };
  //#endregion
  //#region src/plugins/host-hook-turn-types.d.ts
  /** Placement for context injected into the next agent turn. */
  export type PluginNextTurnInjectionPlacement = "prepend_context" | "append_context";
  /** Plugin request to inject text into the next turn for a session. */
  export type PluginNextTurnInjection = {
    sessionKey: string;
    text: string;
    idempotencyKey?: string;
    placement?: PluginNextTurnInjectionPlacement;
    ttlMs?: number;
    metadata?: PluginJsonValue;
  };
  /** Stored next-turn injection after session/plugin metadata is attached. */
  export type PluginNextTurnInjectionRecord = Omit<PluginNextTurnInjection, "sessionKey"> & {
    id: string;
    pluginId: string;
    pluginName?: string;
    createdAt: number;
    placement: PluginNextTurnInjectionPlacement;
  };
  /** Result returned after enqueueing a next-turn injection. */
  export type PluginNextTurnInjectionEnqueueResult = {
    enqueued: boolean;
    id: string;
    sessionKey: string;
  };
  /** Event passed to plugins before an agent turn is prepared. */
  export type PluginAgentTurnPrepareEvent = {
    prompt: string;
    messages: unknown[];
    queuedInjections: PluginNextTurnInjectionRecord[];
  };
  /** Plugin contribution to prepend or append context for a prepared agent turn. */
  export type PluginAgentTurnPrepareResult = {
    prependContext?: string;
    appendContext?: string;
  };
  /** Event passed to plugins that contribute heartbeat prompt context. */
  export type PluginHeartbeatPromptContributionEvent = {
    sessionKey?: string;
    agentId?: string;
    heartbeatName?: string;
  };
  /** Plugin contribution to heartbeat prompt context. */
  export type PluginHeartbeatPromptContributionResult = {
    prependContext?: string;
    appendContext?: string;
  };
  //#endregion
  //#region src/plugins/hook-types.d.ts
  export type PluginHookName = "before_model_resolve" | "agent_turn_prepare" | "before_prompt_build" | "before_agent_start" | "before_agent_reply" | "model_call_started" | "model_call_ended" | "llm_input" | "llm_output" | "before_agent_finalize" | "agent_end" | "before_compaction" | "after_compaction" | "before_reset" | "inbound_claim" | "message_received" | "message_sending" | "reply_payload_sending" | "message_sent" | "before_tool_call" | "after_tool_call" | "tool_result_persist" | "before_message_write" | "session_start" | "session_end"
  /**
   * @deprecated Core prepares thread-bound subagent bindings through channel
   * session-binding adapters before `subagent_spawned` fires. Use
   * `subagent_spawned` for post-launch observation in new plugins.
   */
  | "subagent_spawning" | "subagent_delivery_target" | "subagent_spawned" | "subagent_ended" /** @deprecated Use gateway_stop. */ | "deactivate" | "gateway_start" | "gateway_stop" | "heartbeat_prompt_contribution" | "cron_changed" | "before_dispatch" | "reply_dispatch" | "before_install" | "before_agent_run" | "resolve_exec_env";
  export const PLUGIN_HOOK_NAMES: readonly ["before_model_resolve", "agent_turn_prepare", "before_prompt_build", "before_agent_start", "before_agent_reply", "model_call_started", "model_call_ended", "llm_input", "llm_output", "before_agent_finalize", "agent_end", "before_compaction", "after_compaction", "before_reset", "inbound_claim", "message_received", "message_sending", "reply_payload_sending", "message_sent", "before_tool_call", "after_tool_call", "tool_result_persist", "before_message_write", "session_start", "session_end", "subagent_spawning", "subagent_delivery_target", "subagent_spawned", "subagent_ended", "deactivate", "gateway_start", "gateway_stop", "heartbeat_prompt_contribution", "cron_changed", "before_dispatch", "reply_dispatch", "before_install", "before_agent_run", "resolve_exec_env"];
  export type DeprecatedPluginHookName = "subagent_spawning" | "deactivate";
  export type PluginHookDeprecation = {
    replacement: string;
    reason: string;
    removeAfter?: string;
  };
  export const DEPRECATED_PLUGIN_HOOKS: {
    readonly subagent_spawning: {
      readonly replacement: "`subagent_spawned` for observation; core session bindings for routing";
      readonly reason: "Core prepares thread-bound subagent bindings through channel session-binding adapters before `subagent_spawned` fires.";
      readonly removeAfter: "2026-08-30";
    };
    readonly deactivate: {
      readonly replacement: "`gateway_stop`";
      readonly reason: "`deactivate` is a legacy cleanup hook alias for `gateway_stop`.";
      readonly removeAfter: "2026-08-16";
    };
  };
  export const DEPRECATED_PLUGIN_HOOK_NAMES: DeprecatedPluginHookName[];
  export const isDeprecatedPluginHookName: (hookName: PluginHookName) => hookName is DeprecatedPluginHookName;
  export const isPluginHookName: (hookName: unknown) => hookName is PluginHookName;
  export const PROMPT_INJECTION_HOOK_NAMES: readonly ["agent_turn_prepare", "before_prompt_build", "before_agent_start", "heartbeat_prompt_contribution"];
  export type PromptInjectionHookName = (typeof PROMPT_INJECTION_HOOK_NAMES)[number];
  export const isPromptInjectionHookName: (hookName: PluginHookName) => boolean;
  export const CONVERSATION_HOOK_NAMES: readonly ["before_model_resolve", "before_agent_reply", "llm_input", "llm_output", "before_agent_finalize", "agent_end", "before_agent_run"];
  export type ConversationHookName = (typeof CONVERSATION_HOOK_NAMES)[number];
  export const isConversationHookName: (hookName: PluginHookName) => boolean;
  export type PluginHookAgentContext = {
    runId?: string;
    jobId?: string;
    trace?: DiagnosticTraceContext;
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    modelProviderId?: string;
    modelId?: string;
    messageProvider?: string; /** Channel/plugin id for channel-originated runs, e.g. `discord`. */
    channel?: string; /** Conversation target id for channel-originated runs. Mirrors `channelId` for compatibility. */
    chatId?: string; /** Sender identity for channel-originated runs when available. */
    senderId?: string;
    trigger?: string;
    channelId?: string; /** Resolved effective context-token budget after model/config/agent caps. */
    contextTokenBudget?: number; /** Source that supplied the resolved context-token budget. */
    contextWindowSource?: PluginHookContextWindowSource; /** Native/configured reference window when a lower cap wins. */
    contextWindowReferenceTokens?: number;
  };
  export type PluginHookContextWindowSource = "model" | "modelsConfig" | "agentContextTokens" | "default";
  export type PluginHookBeforeAgentReplyEvent = {
    cleanedBody: string;
  };
  export type PluginHookBeforeAgentReplyResult = {
    handled: boolean;
    reply?: ReplyPayload;
    reason?: string;
  };
  export type PluginHookLlmInputEvent = {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    systemPrompt?: string;
    prompt: string;
    historyMessages: unknown[];
    imagesCount: number;
    tools?: unknown[];
  };
  export type PluginHookModelCallBaseEvent = {
    runId: string;
    callId: string;
    sessionKey?: string;
    sessionId?: string;
    provider: string;
    model: string;
    api?: string;
    transport?: string; /** Resolved effective context-token budget after model/config/agent caps. */
    contextTokenBudget?: number; /** Source that supplied the resolved context-token budget. */
    contextWindowSource?: PluginHookContextWindowSource; /** Native/configured reference window when a lower cap wins. */
    contextWindowReferenceTokens?: number;
  };
  export type PluginHookModelCallStartedEvent = PluginHookModelCallBaseEvent;
  export type PluginHookModelCallEndedEvent = PluginHookModelCallBaseEvent & {
    durationMs: number;
    outcome: "completed" | "error";
    errorCategory?: string;
    failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
    requestPayloadBytes?: number;
    responseStreamBytes?: number;
    timeToFirstByteMs?: number;
    upstreamRequestIdHash?: string;
  };
  export type PluginHookLlmOutputEvent = {
    runId: string;
    sessionId: string;
    provider: string;
    model: string; /** Resolved effective context-token budget after model/config/agent caps. */
    contextTokenBudget?: number; /** Source that supplied the resolved context-token budget. */
    contextWindowSource?: PluginHookContextWindowSource; /** Native/configured reference window when a lower cap wins. */
    contextWindowReferenceTokens?: number;
    /**
     * Fully resolved provider/model ref used for the call.
     *
     * This intentionally keeps the provider prefix so operator tooling can
     * distinguish e.g. openai/gpt-5.4 from codex/gpt-5.4 even when display
     * names collapse to just the model id.
     */
    resolvedRef?: string;
    /**
     * Harness/backend responsible for the model loop. Kept separate from
     * `resolvedRef` so provider/model consumers keep a stable parse contract.
     */
    harnessId?: string; /** The original user prompt that produced this output. */
    prompt?: string;
    assistantTexts: string[];
    lastAssistant?: unknown;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    /**
     * Requested reasoning/think effort for this call (provider think level, e.g.
     * "off" | "low" | "medium" | "high"). Lets a passive footer show the mode the
     * user is actually running without re-deriving it.
     */
    reasoningEffort?: string; /** Whether fast mode was active for this call. */
    fastMode?: boolean;
  };
  export type PluginHookAgentEndEvent = {
    runId?: string;
    messages: unknown[];
    success: boolean;
    error?: string;
    durationMs?: number;
  };
  export type PluginHookBeforeAgentFinalizeEvent = {
    runId?: string;
    sessionId: string;
    sessionKey?: string;
    turnId?: string;
    provider?: string;
    model?: string;
    cwd?: string;
    transcriptPath?: string;
    stopHookActive: boolean;
    lastAssistantMessage?: string;
    messages?: unknown[];
  };
  export type PluginHookBeforeAgentFinalizeResult = {
    /**
     * continue: accept normal finalization.
     * revise: block finalization and ask the harness for another model pass.
     * finalize: force finalization even if another hook requested revision.
     */
    action?: "continue" | "revise" | "finalize";
    reason?: string;
    retry?: {
      instruction: string;
      idempotencyKey?: string;
      maxAttempts?: number;
    };
  };
  export type PluginHookBeforeCompactionEvent = {
    messageCount: number;
    compactingCount?: number;
    tokenCount?: number;
    messages?: unknown[];
    sessionFile?: string;
  };
  export type PluginHookBeforeResetEvent = {
    sessionFile?: string;
    messages?: unknown[];
    reason?: string;
  };
  export type PluginHookAfterCompactionEvent = {
    messageCount: number;
    tokenCount?: number;
    compactedCount: number;
    sessionFile?: string;
  };
  export type PluginHookInboundClaimResult = {
    handled: boolean;
    reply?: ReplyPayload;
  };
  export type PluginHookBeforeDispatchEvent = {
    content: string;
    body?: string;
    channel?: string;
    sessionKey?: string;
    senderId?: string;
    replyToId?: string;
    replyToIdFull?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
    isGroup?: boolean;
    timestamp?: number;
  };
  export type PluginHookBeforeDispatchContext = {
    channelId?: string;
    accountId?: string;
    conversationId?: string;
    sessionKey?: string;
    senderId?: string;
    replyToId?: string;
    replyToIdFull?: string;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
  };
  export type PluginHookBeforeDispatchResult = {
    handled: boolean;
    text?: string;
  };
  export type PluginHookReplyDispatchEvent = {
    ctx: FinalizedMsgContext;
    runId?: string;
    sessionKey?: string;
    toolsAllow?: string[];
    images?: Array<{
      data: string;
      mimeType: string;
    }>;
    inboundAudio: boolean;
    sessionTtsAuto?: TtsAutoMode;
    ttsChannel?: string;
    suppressUserDelivery?: boolean;
    suppressReplyLifecycle?: boolean;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
    shouldRouteToOriginating: boolean;
    originatingChannel?: string;
    originatingTo?: string;
    originatingAccountId?: string;
    originatingThreadId?: string | number;
    originatingChatType?: ChatType;
    shouldSendToolSummaries: boolean;
    sendPolicy: "allow" | "deny";
    isTailDispatch?: boolean;
  };
  export type PluginHookReplyDispatchContext = {
    cfg: OpenClawConfig;
    dispatcher: ReplyDispatcher;
    abortSignal?: AbortSignal;
    onReplyStart?: () => Promise<void> | void;
    recordProcessed: (outcome: "completed" | "skipped" | "error", opts?: {
      reason?: string;
      error?: string;
    }) => void;
    markIdle: (reason: string) => void;
  };
  export type PluginHookReplyDispatchResult = {
    handled: boolean;
    queuedFinal: boolean;
    counts: Record<ReplyDispatchKind, number>;
  };
  /**
   * Per-turn execution state for the outbound reply, available to every harness
   * (embedded, CLI, Codex app-server) — sourced from the unified `runResult.meta`
   * at dispatch, not from the harness-specific `llm_output` hook. Lets a plugin
   * render a passive per-response footer without re-deriving run state.
   */
  export type PluginHookReplyUsageState = {
    provider?: string;
    model?: string; /** Resolved provider/model ref actually used (keeps the provider prefix). */
    resolvedRef?: string; /** Requested reasoning/think effort (e.g. "off" | "low" | "medium" | "high"). */
    reasoningEffort?: string;
    fastMode?: boolean; /** True when a model fallback was used for this turn. */
    fallbackUsed?: boolean; /** Owning agent + session for this reply. */
    agentId?: string;
    sessionId?: string; /** Chat surface kind (e.g. "direct" | "group"). */
    chatType?: string; /** Credential mode the turn ran under (e.g. "oauth" | "api_key"). */
    authMode?: string; /** Session model-override source, when a non-default model was pinned. */
    overrideSource?: string; /** Provider/model ref requested for the turn (vs resolvedRef actually used). */
    requested?: string; /** Estimated cost of this turn in USD, when a cost table is configured. */
    turnUsd?: number; /** Wall-clock duration of the turn in milliseconds. */
    durationMs?: number; /** Owning agent's configured identity (name/emoji/avatar), when set. */
    identity?: {
      name?: string;
      emoji?: string;
      avatar?: string;
    };
    compactionCount?: number; /** Effective context-token budget after model/config/agent caps. */
    contextTokenBudget?: number;
    /**
     * Actual context-window occupancy at the END of the turn — the final model
     * call's prompt tokens, NOT the per-turn aggregate. This is the value
     * `context.used_tokens` / `context.pct_used` must use: the aggregate prompt
     * total over a multi-call tool loop overstates occupancy (often beyond the
     * window). Absent on harnesses that don't report it (the contract then falls
     * back to the aggregate prompt total, which is correct for single-call turns).
     */
    contextUsedTokens?: number;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    /**
     * Usage from the FINAL model call of the turn only — vs `usage`, which is the
     * turn aggregate summed across every tool-loop call. Lets a footer render the
     * last exchange's i/o + cache instead of the whole turn. Absent on harnesses
     * that don't report per-call usage.
     */
    lastUsage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
  export type PluginHookReplyPayloadSendingEvent = {
    payload: PluginHookReplyPayload;
    kind: ReplyDispatchKind;
    channel?: string;
    sessionKey?: string;
    runId?: string;
    /**
     * Per-turn usage snapshot for live dispatcher delivery. Absent on durable
     * delivery/replay paths, and whenever no exact run correlation is available.
     */
    usageState?: PluginHookReplyUsageState;
  };
  export type PluginHookReplyPayload = Omit<ReplyPayload, "trustedLocalMedia">;
  export type PluginHookReplyPayloadSendingContext = PluginHookMessageContext;
  export type PluginHookReplyPayloadSendingResult = {
    payload?: PluginHookReplyPayload;
    cancel?: boolean;
    reason?: string;
  };
  export type PluginHookToolKind = "code_mode_exec";
  export type PluginHookToolInputKind = "javascript" | "typescript";
  export type PluginHookToolContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    trace?: DiagnosticTraceContext;
    toolName: string; /** Host-authoritative discriminator for tools that intentionally share names. */
    toolKind?: PluginHookToolKind; /** Host-authoritative input/runtime family for tools whose payloads need policy distinction. */
    toolInputKind?: PluginHookToolInputKind;
    toolCallId?: string;
    getSessionExtension?: (namespace: string) => PluginJsonValue | undefined;
    channelId?: string;
  };
  export type PluginHookBeforeToolCallEvent = {
    toolName: string;
    params: Record<string, unknown>; /** Host-authoritative discriminator for tools that intentionally share names. */
    toolKind?: PluginHookToolKind; /** Host-authoritative input/runtime family for tools whose payloads need policy distinction. */
    toolInputKind?: PluginHookToolInputKind;
    runId?: string;
    toolCallId?: string;
    /**
     * Optional best-effort destination path hints the host derived from `params`
     * for well-known tool envelopes (e.g. `apply_patch`).
     *
     * This is a convenience hint, not an authoritative parse result: the host's
     * extractor may be intentionally lenient and can return paths for malformed
     * or partial envelopes. Plugins may use `derivedPaths` as a fast path, but
     * should parse and validate `params` themselves when correctness or policy
     * decisions depend on the exact set of affected paths. Absent for tools the
     * host does not know how to derive paths for.
     */
    derivedPaths?: readonly string[];
  };
  export type PluginHookAfterToolCallEvent = {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  };
  export type PluginHookToolResultPersistContext = {
    agentId?: string;
    sessionKey?: string;
    toolName?: string;
    toolCallId?: string;
  };
  export type PluginHookToolResultPersistEvent = {
    toolName?: string;
    toolCallId?: string;
    message: AgentMessage;
    isSynthetic?: boolean;
  };
  export type PluginHookToolResultPersistResult = {
    message?: AgentMessage;
  };
  export type PluginHookBeforeMessageWriteEvent = {
    message: AgentMessage;
    sessionKey?: string;
    agentId?: string;
  };
  export type PluginHookBeforeMessageWriteResult = {
    block?: boolean;
    message?: AgentMessage;
  };
  export type PluginHookSessionContext = {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
  };
  export type PluginHookSessionStartEvent = {
    sessionId: string;
    sessionKey?: string;
    resumedFrom?: string;
  };
  export type PluginHookSessionEndReason = "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "shutdown" | "restart" | "unknown";
  export type PluginHookSessionEndEvent = {
    sessionId: string;
    sessionKey?: string;
    messageCount: number;
    durationMs?: number;
    reason?: PluginHookSessionEndReason;
    sessionFile?: string;
    transcriptArchived?: boolean;
    nextSessionId?: string;
    nextSessionKey?: string;
  };
  export type PluginHookSubagentContext = {
    runId?: string;
    childSessionKey?: string;
    requesterSessionKey?: string;
  };
  export type PluginHookSubagentTargetKind = "subagent" | "acp";
  export type PluginHookSubagentSpawnBase = {
    childSessionKey: string;
    agentId: string;
    label?: string;
    mode: "run" | "session";
    requester?: {
      channel?: string;
      accountId?: string;
      to?: string;
      threadId?: string | number;
    };
    threadRequested: boolean;
  };
  /**
   * @deprecated Core prepares thread-bound subagent bindings through channel
   * session-binding adapters before `subagent_spawned` fires. Use
   * `subagent_spawned` for post-launch observation in new plugins.
   */
  export type PluginHookSubagentSpawningEvent = PluginHookSubagentSpawnBase;
  /**
   * @deprecated Core prepares thread-bound subagent bindings through channel
   * session-binding adapters before `subagent_spawned` fires. Returning routing
   * data from `subagent_spawning` is retained only for older runtimes.
   */
  export type PluginHookSubagentSpawningResult = {
    status: "ok";
    /**
     * @deprecated Core now resolves thread-bound spawn routing from session
     * bindings and channel route projection. Keep returning this only for
     * compatibility with older OpenClaw runtimes.
     */
    threadBindingReady?: boolean;
    /**
     * @deprecated Use channel `resolveDeliveryTarget` plus core
     * `SessionBindingRecord` projection instead of returning an ad hoc
     * delivery route from this hook.
     */
    deliveryOrigin?: {
      channel?: string;
      accountId?: string;
      to?: string;
      threadId?: string | number;
    };
  } | {
    status: "error";
    error: string;
  };
  export type PluginHookSubagentDeliveryTargetEvent = {
    childSessionKey: string;
    requesterSessionKey: string;
    requesterOrigin?: {
      channel?: string;
      accountId?: string;
      to?: string;
      threadId?: string | number;
    };
    childRunId?: string;
    spawnMode?: "run" | "session";
    expectsCompletionMessage: boolean;
  };
  /**
   * @deprecated Core route projection resolves subagent delivery targets from
   * `SessionBindingRecord` and channel `resolveDeliveryTarget`. This hook result
   * remains for plugin compatibility during the transition.
   */
  export type PluginHookSubagentDeliveryTargetResult = {
    origin?: {
      channel?: string;
      accountId?: string;
      to?: string;
      threadId?: string | number;
    };
  };
  export type PluginHookSubagentSpawnedEvent = PluginHookSubagentSpawnBase & {
    runId: string; /** Fully resolved provider/model ref applied to the spawned child session. */
    resolvedModel?: string; /** Provider prefix parsed from resolvedModel when the ref includes one. */
    resolvedProvider?: string;
  };
  export type PluginHookSubagentEndedEvent = {
    targetSessionKey: string;
    targetKind: PluginHookSubagentTargetKind;
    reason: string;
    sendFarewell?: boolean;
    accountId?: string;
    runId?: string;
    endedAt?: number;
    outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
    error?: string;
  };
  export type PluginHookGatewayContext = {
    port?: number;
    config?: OpenClawConfig;
    workspaceDir?: string;
    getCron?: () => PluginHookGatewayCronService | undefined;
  };
  export type PluginHookGatewayStartEvent = {
    port: number;
  };
  export type PluginHookGatewayStopEvent = {
    reason?: string;
  };
  export type PluginHookGatewayCronRunStatus = "ok" | "error" | "skipped";
  export type PluginHookGatewayCronDeliveryStatus = "not-requested" | "delivered" | "not-delivered" | "unknown";
  export type PluginHookGatewayCronJobState = {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: PluginHookGatewayCronRunStatus;
    lastError?: string;
    lastDurationMs?: number;
    lastDelivered?: boolean;
    lastDeliveryStatus?: PluginHookGatewayCronDeliveryStatus;
    lastDeliveryError?: string;
    lastFailureNotificationDelivered?: boolean;
    lastFailureNotificationDeliveryStatus?: PluginHookGatewayCronDeliveryStatus;
    lastFailureNotificationDeliveryError?: string;
  };
  export type PluginHookGatewayCronJob = {
    id: string; /** Agent id that owns this cron job. */
    agentId?: string;
    name?: string;
    description?: string;
    enabled?: boolean;
    schedule?: {
      kind: "cron";
      expr?: string;
      tz?: string;
      staggerMs?: number;
    } | {
      kind: "at";
      at?: string;
    } | {
      kind: "every";
      everyMs?: number;
      anchorMs?: number;
    };
    sessionTarget?: string;
    wakeMode?: string;
    payload?: {
      kind?: string;
      text?: string;
    };
    state?: PluginHookGatewayCronJobState;
    createdAtMs?: number;
    updatedAtMs?: number;
  };
  export type PluginHookCronChangedEvent = {
    action: "added" | "updated" | "removed" | "started" | "finished";
    jobId: string;
    job?: PluginHookGatewayCronJob; /** Top-level session target for downstream routing (mirrors job.sessionTarget). */
    sessionTarget?: string; /** Agent id that owns this cron job (mirrors job.agentId). */
    agentId?: string;
    runAtMs?: number;
    durationMs?: number;
    status?: PluginHookGatewayCronRunStatus;
    error?: string;
    summary?: string;
    delivered?: boolean;
    deliveryStatus?: PluginHookGatewayCronDeliveryStatus;
    deliveryError?: string;
    sessionId?: string;
    sessionKey?: string;
    runId?: string;
    nextRunAtMs?: number;
    model?: string;
    provider?: string;
  };
  export type PluginHookGatewayCronCreateInput = {
    name: string;
    description: string;
    enabled: boolean;
    schedule: {
      kind: string;
      expr: string;
      tz?: string;
    };
    sessionTarget: string;
    wakeMode: string;
    payload: {
      kind: string;
      text?: string;
    };
  };
  export type PluginHookGatewayCronUpdateInput = Partial<PluginHookGatewayCronCreateInput>;
  export type PluginHookGatewayCronRemoveResult = {
    removed?: boolean;
  };
  export type PluginHookGatewayCronService = {
    list: (opts?: {
      includeDisabled?: boolean;
    }) => Promise<PluginHookGatewayCronJob[]>;
    add: (input: PluginHookGatewayCronCreateInput) => Promise<unknown>;
    update: (id: string, patch: PluginHookGatewayCronUpdateInput) => Promise<unknown>;
    remove: (id: string) => Promise<PluginHookGatewayCronRemoveResult>;
  };
  export type PluginInstallTargetType = "skill" | "plugin";
  export type PluginInstallRequestKind = "skill-install" | "plugin-dir" | "plugin-archive" | "plugin-file" | "plugin-npm" | "plugin-git";
  export type PluginInstallSourcePathKind = "file" | "directory";
  export type PluginInstallFinding = {
    ruleId: string;
    severity: "info" | "warn" | "critical";
    file: string;
    line: number;
    message: string;
  };
  export type PluginHookBeforeInstallRequest = {
    kind: PluginInstallRequestKind;
    mode: "install" | "update";
    requestedSpecifier?: string;
  };
  export type PluginHookBeforeInstallBuiltinScan = {
    status: "ok" | "error";
    scannedFiles: number;
    critical: number;
    warn: number;
    info: number;
    findings: PluginInstallFinding[];
    error?: string;
  };
  export type PluginHookBeforeInstallSkillInstallSpec = {
    id?: string;
    kind: "brew" | "node" | "go" | "uv" | "download";
    label?: string;
    bins?: string[];
    os?: string[];
    formula?: string;
    package?: string;
    module?: string;
    url?: string;
    archive?: string;
    extract?: boolean;
    stripComponents?: number;
    targetDir?: string;
  };
  export type PluginHookBeforeInstallSkill = {
    installId: string;
    installSpec?: PluginHookBeforeInstallSkillInstallSpec;
  };
  export type PluginHookBeforeInstallPlugin = {
    pluginId: string;
    contentType: "bundle" | "package" | "file";
    packageName?: string;
    manifestId?: string;
    version?: string;
    extensions?: string[];
  };
  export type PluginHookBeforeInstallContext = {
    targetType: PluginInstallTargetType;
    requestKind: PluginInstallRequestKind;
    origin?: string;
  };
  export type PluginHookBeforeInstallEvent = {
    targetType: PluginInstallTargetType;
    targetName: string;
    sourcePath: string;
    sourcePathKind: PluginInstallSourcePathKind;
    origin?: string;
    request: PluginHookBeforeInstallRequest;
    builtinScan: PluginHookBeforeInstallBuiltinScan;
    skill?: PluginHookBeforeInstallSkill;
    plugin?: PluginHookBeforeInstallPlugin;
  };
  export type PluginHookBeforeInstallResult = {
    findings?: PluginInstallFinding[];
    block?: boolean;
    blockReason?: string;
  };
  /** Event payload for the before_agent_run gate hook. */
  export type PluginHookBeforeAgentRunEvent = {
    /** The user's message that triggered this run. */prompt: string; /** Loaded session history before the current prompt is submitted. */
    messages: unknown[]; /** Active system prompt prepared for this run. */
    systemPrompt?: string; /** Account identity when available. */
    accountId?: string; /** Channel the message came from. */
    channelId?: string; /** Sender identity when available. */
    senderId?: string; /** Trusted sender identity bit when available. */
    senderIsOwner?: boolean;
  };
  /** Result type for before_agent_run. Returns pass/block or void (= pass). */
  export type PluginHookBeforeAgentRunResult = InputGateDecision | void;
  export type PluginHookResolveExecEnvEvent = {
    sessionKey?: string;
    toolName: "exec";
    host: "gateway" | "sandbox" | "node";
  };
  export type PluginHookResolveExecEnvContext = PluginHookAgentContext;
  export type PluginHookHandlerMap = {
    agent_turn_prepare: (event: PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => Promise<PluginAgentTurnPrepareResult | void> | PluginAgentTurnPrepareResult | void;
    before_model_resolve: (event: PluginHookBeforeModelResolveEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeModelResolveResult | void> | PluginHookBeforeModelResolveResult | void;
    before_prompt_build: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | void> | PluginHookBeforePromptBuildResult | void; /** @deprecated Use before_model_resolve and before_prompt_build. */
    before_agent_start: (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentStartResult | void> | PluginHookBeforeAgentStartResult | void;
    before_agent_reply: (event: PluginHookBeforeAgentReplyEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentReplyResult | void> | PluginHookBeforeAgentReplyResult | void;
    model_call_started: (event: PluginHookModelCallStartedEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    model_call_ended: (event: PluginHookModelCallEndedEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    llm_input: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    llm_output: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    before_agent_finalize: (event: PluginHookBeforeAgentFinalizeEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentFinalizeResult | void> | PluginHookBeforeAgentFinalizeResult | void;
    agent_end: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    before_compaction: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    after_compaction: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    before_reset: (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => Promise<void> | void;
    inbound_claim: (event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginHookInboundClaimResult | void> | PluginHookInboundClaimResult | void;
    before_dispatch: (event: PluginHookBeforeDispatchEvent, ctx: PluginHookBeforeDispatchContext) => Promise<PluginHookBeforeDispatchResult | void> | PluginHookBeforeDispatchResult | void;
    reply_dispatch: (event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext) => Promise<PluginHookReplyDispatchResult | void> | PluginHookReplyDispatchResult | void;
    reply_payload_sending: (event: PluginHookReplyPayloadSendingEvent, ctx: PluginHookReplyPayloadSendingContext) => Promise<PluginHookReplyPayloadSendingResult | void> | PluginHookReplyPayloadSendingResult | void;
    message_received: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => Promise<void> | void;
    message_sending: (event: PluginHookMessageSendingEvent, ctx: PluginHookMessageContext) => Promise<PluginHookMessageSendingResult | void> | PluginHookMessageSendingResult | void;
    message_sent: (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => Promise<void> | void;
    before_tool_call: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => Promise<PluginHookBeforeToolCallResult | void> | PluginHookBeforeToolCallResult | void;
    after_tool_call: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void> | void;
    tool_result_persist: (event: PluginHookToolResultPersistEvent, ctx: PluginHookToolResultPersistContext) => PluginHookToolResultPersistResult | void;
    before_message_write: (event: PluginHookBeforeMessageWriteEvent, ctx: {
      agentId?: string;
      sessionKey?: string;
    }) => PluginHookBeforeMessageWriteResult | void;
    session_start: (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => Promise<void> | void;
    session_end: (event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext) => Promise<void> | void;
    /**
     * @deprecated Core prepares thread-bound subagent bindings through channel
     * session-binding adapters before `subagent_spawned` fires. Use
     * `subagent_spawned` for post-launch observation in new plugins.
     */
    subagent_spawning: (event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentSpawningResult | void> | PluginHookSubagentSpawningResult | void;
    subagent_delivery_target: (event: PluginHookSubagentDeliveryTargetEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentDeliveryTargetResult | void> | PluginHookSubagentDeliveryTargetResult | void;
    subagent_spawned: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void;
    subagent_ended: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void;
    /**
     * Deprecated compatibility alias for gateway_stop.
     *
     * New plugins should register gateway_stop directly; the loader normalizes
     * deactivate registrations onto gateway_stop so cleanup handlers still run
     * during Gateway shutdown.
     *
     * @deprecated Use gateway_stop.
     */
    deactivate: (event: PluginHookGatewayStopEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
    gateway_start: (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
    gateway_stop: (event: PluginHookGatewayStopEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
    heartbeat_prompt_contribution: (event: PluginHeartbeatPromptContributionEvent, ctx: PluginHookAgentContext) => Promise<PluginHeartbeatPromptContributionResult | void> | PluginHeartbeatPromptContributionResult | void;
    cron_changed: (event: PluginHookCronChangedEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
    before_install: (event: PluginHookBeforeInstallEvent, ctx: PluginHookBeforeInstallContext) => Promise<PluginHookBeforeInstallResult | void> | PluginHookBeforeInstallResult | void;
    before_agent_run: (event: PluginHookBeforeAgentRunEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentRunResult> | PluginHookBeforeAgentRunResult;
    resolve_exec_env: (event: PluginHookResolveExecEnvEvent, ctx: PluginHookResolveExecEnvContext) => Promise<Record<string, string> | void> | Record<string, string> | void;
  };
  export type PluginHookRegistration<K extends PluginHookName = PluginHookName> = {
    pluginId: string;
    hookName: K;
    handler: PluginHookHandlerMap[K];
    priority?: number;
    timeoutMs?: number;
    source: string;
  };
  //#endregion
}

declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

  export interface PluginEntry {
    id: string;
    name: string;
    description?: string;
    register(api: OpenClawPluginApi): void;
  }

  export function definePluginEntry<T extends PluginEntry>(entry: T): T;
}

declare module "openclaw/plugin-sdk/core" {
  export * from "openclaw/plugin-sdk";
}

// ---------------------------------------------------------------------------
// SDK subpaths consumed at runtime via `await import(...)` — `openclaw` is
// resolved by the OpenClaw host process, never by `node --test` (where the
// host is absent), so every value import of these subpaths must stay dynamic.
// Signatures verified against the installed bundle.
// ---------------------------------------------------------------------------

declare module "openclaw/plugin-sdk/agent-core" {
  /**
   * OpenClaw's own provider-independent per-message token estimator (a
   * conservative visible-content chars/4 heuristic; `proxy-*.js
   * estimateTokens`). Sum it over a message buffer for a context estimate
   * that owes nothing to provider-reported `usage`.
   *
   * Do NOT reach for `estimateContextTokens` when provider independence
   * matters: it anchors on the last assistant message's provider usage and
   * only estimates the tail after it.
   */
  export function estimateTokens(message: unknown): number;
  /** Anchors on provider-reported usage; see estimateTokens caveat. */
  export function estimateContextTokens(messages: unknown[]): {
    tokens: number;
    [key: string]: unknown;
  };
}

declare module "openclaw/plugin-sdk/config-runtime" {
  /** Read config snapshot, apply mutator to a clone, write back with hash-based
   *  conflict detection. Resolves the config path from env internally. */
  export function updateConfig(
    mutator: (cfg: Record<string, any>) => Record<string, any>,
  ): Promise<Record<string, any>>;
  /** Load the current resolved config object. */
  export function loadConfig(): Promise<Record<string, any>> | Record<string, any>;
}

declare module "openclaw/plugin-sdk/secret-file-runtime" {
  /** Atomic, mode-0600, symlink-rejecting private secret file writer. */
  export function writePrivateSecretFileAtomic(params: {
    rootDir: string;
    filePath: string;
    content: string;
  }): Promise<void>;
  /** Read a secret file's contents (throws on failure). */
  export function readSecretFileSync(
    filePath: string,
    label: string,
    options?: Record<string, unknown>,
  ): string;
  /** Read a secret file's contents, returning undefined on any failure. */
  export function tryReadSecretFileSync(
    filePath: string,
    label: string,
    options?: Record<string, unknown>,
  ): string | undefined;
  export const PRIVATE_SECRET_FILE_MODE: number;
  export const PRIVATE_SECRET_DIR_MODE: number;
}

declare module "openclaw/plugin-sdk/state-paths" {
  /** Resolve the OpenClaw state dir (config-file parent). Honours
   *  OPENCLAW_STATE_DIR / OPENCLAW_CONFIG_PATH; defaults to ~/.openclaw. */
  export function resolveStateDir(env?: NodeJS.ProcessEnv): string;
  export const STATE_DIR: string;
}
