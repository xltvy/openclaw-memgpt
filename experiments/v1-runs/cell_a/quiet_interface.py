"""Quiet interface for Cell A wrapper.

Async no-op surface matching the methods `AgentAsync.step()` calls on
`self.interface` (per `memgpt/agent.py` greps:
`internal_monologue`, `function_message`, `assistant_message`,
`user_message`). The interface layer is display-only — no architectural
state flows through it — so substituting no-ops produces a pickle
byte-identical to one produced under `memgpt.interface` (modulo timestamps).

Print methods (`important_message`, `warning_message`) are also no-op'd to
keep wrapper runs headless.
"""


async def internal_monologue(msg):  # noqa: ARG001
    return None


async def function_message(msg):  # noqa: ARG001
    return None


async def assistant_message(msg):  # noqa: ARG001
    return None


async def user_message(msg):  # noqa: ARG001
    return None


async def memory_message(msg):  # noqa: ARG001
    return None


async def print_messages(messages, dump=False):  # noqa: ARG001
    return None


async def print_messages_raw(messages):  # noqa: ARG001
    return None


def important_message(msg):  # noqa: ARG001
    return None


def warning_message(msg):  # noqa: ARG001
    return None
