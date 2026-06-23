"""
Cell A adapter — pre-v1 OpenAI Functions API → modern tool_calls.

Sits between MemGPT (Cell A: `f46cc3b` + F2, openai SDK v0.28) and LiteLLM
in the V1.3 protocol chain documented in `docs/v1-cells.md` §7:

    MemGPT (pre-v1 Functions API)
      → cell-a-adapter (this file)
      → LiteLLM:4000 (translates OpenAI tools → Anthropic Messages)
      → shim:4100 (transport-layer adapter for the Bedrock gateway)
      → institutional Bedrock gateway

Why it exists
-------------
LiteLLM's Anthropic translator mints independent `uuid.uuid4()` values for
the assistant `tool_use.id` and the matching `tool_result.tool_use_id`
when fed pre-v1 Functions API (`litellm/llms/anthropic/...` —
`factory.py:1877-1898` and `:1859-1868`), producing malformed Messages
that Anthropic rejects on multi-turn agent runs. The working branch is
`convert_to_anthropic_tool_invoke` (`factory.py:1901,1956`) — reached only
when the request already carries modern `tools` / `tool_calls` / role=tool
with matching ids. This adapter rewrites Cell A's outgoing Functions API
into that shape so the working branch fires, with a single minted
`tool_call_id` linking each assistant call to its result.

What it does
------------
1. Walks the message list in conversation order; mints one `call_<uuid>`
   per assistant `function_call`; rewrites the next role=function as
   role=tool with the same `tool_call_id`. FIFO matching is robust to
   well-formed input (queue size is always 0 or 1 at the matching
   role=function in MemGPT's loop).
2. Rewrites top-level `functions` → `tools` and `function_call` →
   `tool_choice`.
3. Forwards to the upstream (LiteLLM) and translates the response back:
   `tool_calls[0]` → singleton `function_call` (MemGPT consumes one per
   turn at `agent.py:512-547`), and `finish_reason: tool_calls` →
   `function_call` so the soft-error check at `agent.py:125` passes.

What it does NOT do
-------------------
* No memory logic, no buffer mutation, no prompt rewriting. Plumbing only.
* No API-flavour translation (OpenAI ↔ Anthropic). That's LiteLLM's job.
* No transport-layer adaptation. That's the shim's job (`sidecar/proxy_shim.py`).
* No request bodies modified beyond the documented Functions→tools shape change.

Configuration
-------------
  ADAPTER_UPSTREAM_URL  (default: http://127.0.0.1:4000/v1)
      Base URL of the LiteLLM proxy. `/chat/completions` is appended.
  ADAPTER_TIMEOUT       (default: 120)
      Total request timeout in seconds.

Run
---
    cd ~/Workspace/UCL/dissertation/openclaw-memgpt/cell-a-adapter
    uv sync
    uv run uvicorn adapter:app --host 127.0.0.1 --port 4200

Cell A terminal recipe is now four terminals: adapter (4200), shim (4100),
LiteLLM (4000), MemGPT CLI. `OPENAI_API_BASE=http://localhost:4200/v1`
points MemGPT at the adapter.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

UPSTREAM_URL = os.environ.get("ADAPTER_UPSTREAM_URL", "http://127.0.0.1:4000/v1")
TIMEOUT = float(os.environ.get("ADAPTER_TIMEOUT", "120"))
LOG_REQUESTS = os.environ.get("ADAPTER_LOG_REQUESTS", "1") not in ("0", "", "false", "False")

app = FastAPI(title="Cell A Adapter")
_client = httpx.AsyncClient(timeout=httpx.Timeout(TIMEOUT, connect=10.0))


@app.on_event("shutdown")
async def _shutdown() -> None:
    await _client.aclose()


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "upstream_url": UPSTREAM_URL}


def _new_tool_call_id() -> str:
    # OpenAI tool_call_id convention: "call_" + 24 alphanum chars.
    return f"call_{uuid.uuid4().hex[:24]}"


def translate_messages(messages: list[dict]) -> list[dict]:
    out: list[dict] = []
    pending: list[str] = []
    for msg in messages:
        role = msg.get("role")
        if role == "assistant" and msg.get("function_call"):
            tc_id = _new_tool_call_id()
            pending.append(tc_id)
            fc = msg["function_call"]
            out.append({
                "role": "assistant",
                "content": msg.get("content"),
                "tool_calls": [{
                    "id": tc_id,
                    "type": "function",
                    "function": {
                        "name": fc.get("name"),
                        "arguments": fc.get("arguments", ""),
                    },
                }],
            })
        elif role == "function":
            if not pending:
                raise HTTPException(
                    status_code=400,
                    detail="role=function message without a preceding assistant function_call",
                )
            tc_id = pending.pop(0)
            out.append({
                "role": "tool",
                "tool_call_id": tc_id,
                "content": msg.get("content", ""),
            })
        else:
            out.append({k: v for k, v in msg.items() if v is not None})
    return out


_PASSTHROUGH = (
    "temperature", "top_p", "n", "stream", "stop", "max_tokens",
    "presence_penalty", "frequency_penalty", "logit_bias", "user", "seed",
    "response_format",
)


def translate_request(body: dict) -> dict:
    out: dict[str, Any] = {
        "model": body.get("model"),
        "messages": translate_messages(body.get("messages", [])),
    }
    fns = body.get("functions")
    if fns:
        out["tools"] = [{"type": "function", "function": fn} for fn in fns]
    fc = body.get("function_call")
    if isinstance(fc, str):
        out["tool_choice"] = fc
    elif isinstance(fc, dict) and "name" in fc:
        out["tool_choice"] = {
            "type": "function",
            "function": {"name": fc["name"]},
        }
    for k in _PASSTHROUGH:
        if k in body:
            out[k] = body[k]
    return out


def translate_response(body: dict) -> dict:
    for choice in body.get("choices", []):
        msg = choice.get("message", {})
        tool_calls = msg.get("tool_calls")
        if tool_calls:
            first_fn = tool_calls[0].get("function", {})
            msg["function_call"] = {
                "name": first_fn.get("name"),
                "arguments": first_fn.get("arguments", ""),
            }
            msg.pop("tool_calls", None)
        if choice.get("finish_reason") == "tool_calls":
            choice["finish_reason"] = "function_call"
    return body


def _log_incoming(body: dict) -> None:
    """Diagnostic — dump the pre-translation body. Hypothesis under test:
    MemGPT primes `agent.step()` with an unpaired role=function message,
    producing an orphan `tool_call_id` downstream. The role summary makes
    pairing visible at a glance; the full JSON is for post-hoc analysis."""
    msgs = body.get("messages", [])
    summary = []
    for i, m in enumerate(msgs):
        tag = m.get("role", "?")
        if m.get("function_call"):
            tag += "+call"
        if m.get("role") == "function":
            tag += f"(name={m.get('name')!r})"
        summary.append(f"  [{i:2d}] {tag}")
    sys.stderr.write(
        "\n--- adapter request ---\n"
        f"model={body.get('model')!r}, msg_count={len(msgs)}\n"
        + "\n".join(summary)
        + "\nfull body:\n"
        + json.dumps(body, indent=2)
        + "\n--- end ---\n"
    )
    sys.stderr.flush()


@app.post("/v1/chat/completions")
async def chat_completions(req: Request) -> Response:
    body = await req.json()
    if LOG_REQUESTS:
        _log_incoming(body)
    translated_req = translate_request(body)

    headers = {"Content-Type": "application/json"}
    auth = req.headers.get("authorization")
    if auth:
        headers["Authorization"] = auth

    try:
        upstream = await _client.post(
            f"{UPSTREAM_URL}/chat/completions",
            json=translated_req,
            headers=headers,
        )
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"upstream unreachable: {e}")

    if upstream.status_code != 200:
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/json"),
        )

    return JSONResponse(translate_response(upstream.json()))
