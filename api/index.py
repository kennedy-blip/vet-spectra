"""
Vercel entry point for the VET-SPECTRA physics API.

`vet_physics.py` is a stdlib `BaseHTTPRequestHandler` server so it can be run
locally with `python api/vet_physics.py`. Vercel needs a callable instead, so this
module exposes a minimal WSGI `app` that forwards GET/POST to the same
`dispatch()` router — identical responses, identical CORS headers, no duplicated
business logic.

Local smoke test:
    python -c "from api.index import dispatch; print(dispatch({'action':'health'}))"
"""

from __future__ import annotations

import importlib.util
import json
import os
from typing import Any, Callable, Iterable

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in os.environ.get("PYTHONPATH", "").split(os.pathsep):
    import sys

    if _ROOT not in sys.path:
        sys.path.insert(0, _ROOT)


def _load_router() -> Callable[[dict[str, Any]], dict[str, Any]]:
    """Import the sibling router without requiring the api/ folder to be a package."""
    spec = importlib.util.spec_from_file_location("vet_physics", os.path.join(_HERE, "vet_physics.py"))
    if spec is None or spec.loader is None:  # pragma: no cover - packaging guard
        raise RuntimeError("api/vet_physics.py is missing from the deployment bundle")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.dispatch


dispatch = _load_router()

MAX_BODY_BYTES = 512 * 1024

CORS_HEADERS = [
    ("Access-Control-Allow-Origin", "*"),
    ("Access-Control-Allow-Methods", "GET, POST, OPTIONS"),
    ("Access-Control-Allow-Headers", "content-type"),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
]


def _json_body(environ: dict[str, Any]) -> bytes | None:
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except (TypeError, ValueError):
        return None
    if length <= 0:
        return None
    if length > MAX_BODY_BYTES:
        return b"__TOO_LARGE__"
    stream: Iterable[bytes] = environ["wsgi.input"]
    return stream.read(length)


def app(environ: dict[str, Any], start_response: Callable[..., Any]):
    method = (environ.get("REQUEST_METHOD") or "GET").upper()

    if method == "OPTIONS":
        start_response("204 No Content", CORS_HEADERS + [("Content-Length", "0")])
        return [b""]

    if method == "GET":
        payload = dispatch({"action": "health"})

        def respond(status: str, body: dict[str, Any]):
            raw = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            start_response(status, CORS_HEADERS + [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(raw)))])
            return [raw]

        return respond("200 OK", payload)

    raw = _json_body(environ)
    if raw is None:
        return _error(start_response, "400 Bad Request", "empty body")
    if raw == b"__TOO_LARGE__":
        return _error(start_response, "413 Payload Too Large", "payload too large")
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return _error(start_response, "400 Bad Request", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(start_response, "400 Bad Request", "body must be a JSON object")

    result = dispatch(body)
    status = "200 OK" if result.get("ok") else "400 Bad Request"
    encoded = json.dumps(result, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    start_response(
        status,
        CORS_HEADERS
        + [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(encoded)))],
    )
    return [encoded]


def _error(start_response: Callable[..., Any], status: str, message: str):
    encoded = json.dumps({"ok": False, "error": message}, separators=(",", ":")).encode("utf-8")
    start_response(
        status,
        CORS_HEADERS + [("Content-Type", "application/json; charset=utf-8"), ("Content-Length", str(len(encoded)))],
    )
    return [encoded]


# Some runtimes probe for `handler` rather than `app`.
handler = app
