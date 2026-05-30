"""
anthropic_endpoint_shim.py
==========================

A thin HTTP adapter that sits between a LiteLLM proxy (Anthropic provider)
and a non-standard Anthropic-compatible upstream. Typical use cases:

  * Corporate / institutional proxies that route to Bedrock, Vertex, or
    self-hosted Claude deployments and serve Anthropic Messages API
    responses — but with path, auth, or response-format quirks that
    LiteLLM's Anthropic parser does not tolerate.
  * Gateways that sit in front of AWS Bedrock and expose Claude over
    HTTP with Bedrock-style usage field names.

The shim exposes one endpoint, `POST /v1/messages`, that matches what
LiteLLM's Anthropic provider expects. It forwards the request body to
the configured upstream and normalises the response so LiteLLM can
consume it without errors.

What this shim addresses
------------------------

1. Path mismatch. LiteLLM's Anthropic provider appends "/v1/messages"
   to its configured `api_base`. If the upstream's real endpoint uses
   a different path (e.g. "/invoke", "/model-api/invoke"), the shim
   absorbs the "/v1/messages" segment and forwards to the real URL.

2. Auth header mismatch. LiteLLM may send its key in one header name;
   the upstream may expect another. The shim strips the incoming auth
   header and injects whatever the upstream expects (configurable).

3. Missing `stop_reason`. Some upstreams (observed on Bedrock-fronting
   gateways) omit `stop_reason` from the response. LiteLLM's Anthropic
   parser does a hard dict lookup and raises KeyError. The shim infers
   `stop_reason` from the response `content`:
     - any `tool_use` block      -> "tool_use"
     - output_tokens == max_tokens -> "max_tokens"
     - otherwise                   -> "end_turn"

4. camelCase `usage` fields. Some gateways return `inputTokens` and
   `outputTokens` (Bedrock Converse API style). LiteLLM's Anthropic
   parser reads snake_case. The shim renames them.

What this shim does not do
--------------------------

* Modify request bodies.
* Support streaming (add if your client needs it).
* Translate between API flavours (e.g. OpenAI <-> Anthropic). That is
  LiteLLM's job, not this shim's.

Configuration
-------------

All configuration is via environment variables:

  SHIM_UPSTREAM_URL       (required)
      Full URL of the upstream endpoint to forward requests to.
      Example: https://example.com/bedrock/claude/invoke

  SHIM_UPSTREAM_API_KEY   (required)
      The API key / credential value to forward to the upstream.

  SHIM_UPSTREAM_AUTH_HEADER  (default: "x-api-key")
      The header name under which SHIM_UPSTREAM_API_KEY is sent to the
      upstream. Set this to whatever header name your upstream expects.
      Common values: "x-api-key", "X-Api-Key", "Authorization".
      If your upstream expects "Authorization: Bearer <key>", set this
      to "Authorization" and set SHIM_UPSTREAM_API_KEY_PREFIX="Bearer ".

  SHIM_UPSTREAM_API_KEY_PREFIX  (default: "")
      Optional prefix added before SHIM_UPSTREAM_API_KEY in the auth
      header (useful for "Bearer " or "Token " styles).

  SHIM_UPSTREAM_TIMEOUT   (default: 60)
      Total request timeout in seconds.

Run
---

    export SHIM_UPSTREAM_URL=https://...
    export SHIM_UPSTREAM_API_KEY=...
    uvicorn anthropic_endpoint_shim:app --host 127.0.0.1 --port 4100

In your LiteLLM config:

    model_list:
      - model_name: my-claude
        litellm_params:
          model: anthropic/<upstream-model-id>
          api_base: http://127.0.0.1:4100

License: same as project. See LICENSE at the repository root.
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request, Response, HTTPException


# ---------------------------------------------------------------------------
# Configuration — read once at module import, with clear error messages.
# ---------------------------------------------------------------------------

class ShimConfig:
    """Configuration loaded from environment variables."""

    def __init__(self) -> None:
        self.upstream_url: str = self._require("SHIM_UPSTREAM_URL")
        self.upstream_api_key: str = self._require("SHIM_UPSTREAM_API_KEY")
        self.upstream_auth_header: str = os.environ.get(
            "SHIM_UPSTREAM_AUTH_HEADER", "x-api-key"
        )
        self.upstream_api_key_prefix: str = os.environ.get(
            "SHIM_UPSTREAM_API_KEY_PREFIX", ""
        )
        try:
            self.timeout_seconds: float = float(
                os.environ.get("SHIM_UPSTREAM_TIMEOUT", "60")
            )
        except ValueError as e:
            raise RuntimeError(
                f"SHIM_UPSTREAM_TIMEOUT must be a number: {e}"
            ) from e

    @staticmethod
    def _require(name: str) -> str:
        value = os.environ.get(name)
        if not value:
            raise RuntimeError(
                f"Required environment variable {name!r} is not set. "
                f"See module docstring for configuration."
            )
        return value

    @property
    def auth_header_value(self) -> str:
        return f"{self.upstream_api_key_prefix}{self.upstream_api_key}"


# Load configuration at import time. Failure here prevents uvicorn from
# starting a broken server. If you want lazy initialisation for testing,
# override by setting env vars before importing.
_config = ShimConfig()


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Anthropic Endpoint Shim",
    description="Adapter between LiteLLM and non-standard Anthropic-compatible upstreams.",
)

# Single async client for connection reuse across requests.
_client = httpx.AsyncClient(
    timeout=httpx.Timeout(_config.timeout_seconds, connect=10.0)
)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await _client.aclose()


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """Liveness probe. Does not verify upstream reachability."""
    return {
        "ok": True,
        "upstream_url": _config.upstream_url,
        "upstream_auth_header": _config.upstream_auth_header,
    }


# ---------------------------------------------------------------------------
# Response normalisation
# ---------------------------------------------------------------------------

def normalise_response(
    body: dict[str, Any],
    requested_max_tokens: Optional[int],
) -> dict[str, Any]:
    """
    Mutate an Anthropic-format response body so LiteLLM's parser accepts it.

    Changes applied only when necessary; fields already present are preserved.

    Args:
        body: the parsed JSON response from the upstream.
        requested_max_tokens: the client's requested max_tokens (used to
            detect truncation when stop_reason must be inferred).

    Returns:
        The same dict, mutated in place.
    """
    # Infer stop_reason from content when the upstream omits it.
    if "stop_reason" not in body:
        content = body.get("content", []) or []
        has_tool_use = any(
            isinstance(b, dict) and b.get("type") == "tool_use"
            for b in content
        )
        usage = body.get("usage") or {}
        output_tokens = (
            usage.get("output_tokens")
            or usage.get("outputTokens")
            or 0
        )

        if has_tool_use:
            body["stop_reason"] = "tool_use"
        elif requested_max_tokens and output_tokens >= requested_max_tokens:
            body["stop_reason"] = "max_tokens"
        else:
            body["stop_reason"] = "end_turn"

    body.setdefault("stop_sequence", None)

    # Rename camelCase usage fields to snake_case (Anthropic convention).
    usage = body.get("usage")
    if isinstance(usage, dict):
        if "inputTokens" in usage and "input_tokens" not in usage:
            usage["input_tokens"] = usage.pop("inputTokens")
        if "outputTokens" in usage and "output_tokens" not in usage:
            usage["output_tokens"] = usage.pop("outputTokens")

    # Ensure the canonical top-level Anthropic message fields are present.
    body.setdefault("role", "assistant")
    body.setdefault("type", "message")
    body.setdefault("id", body.get("id") or "msg_shim_placeholder")

    return body


# ---------------------------------------------------------------------------
# Main endpoint
# ---------------------------------------------------------------------------

@app.post("/v1/messages")
async def messages(request: Request) -> Response:
    """
    Mimics Anthropic's /v1/messages endpoint. Forwards to the configured
    upstream with proper auth, and normalises the response for LiteLLM.
    """
    raw_body = await request.body()

    # Peek at requested max_tokens for stop_reason inference.
    try:
        req_json = json.loads(raw_body)
        requested_max_tokens = req_json.get("max_tokens")
    except json.JSONDecodeError:
        requested_max_tokens = None

    try:
        upstream = await _client.post(
            _config.upstream_url,
            content=raw_body,
            headers={
                "Content-Type": "application/json",
                _config.upstream_auth_header: _config.auth_header_value,
            },
        )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"upstream request failed: {exc!r}",
        )

    # Pass errors through verbatim — the client / LiteLLM should see them.
    if upstream.status_code >= 400:
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
        )

    try:
        resp_json = upstream.json()
    except ValueError:
        # Non-JSON 2xx would be surprising; pass through verbatim.
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/octet-stream"),
        )

    normalised = normalise_response(resp_json, requested_max_tokens)

    return Response(
        content=json.dumps(normalised),
        status_code=200,
        media_type="application/json",
    )