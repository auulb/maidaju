"""Minimal MCP (JSON-RPC) client for McDonald's China MCP.

The same server is normally exposed to the agent as the `mcd` MCP server.
This module exists so the planner can run end-to-end from a shell
(and so a plan can be reproduced / regression-tested).

Token: env MCD_MCP_TOKEN, else the token baked in below.
"""

from __future__ import annotations

import json
import os
import re
import ssl
import time
import urllib.error
import urllib.request

MCP_URL = os.environ.get("MCD_MCP_URL", "https://mcp.mcd.cn")
DEFAULT_TOKEN = "LxNvvLKjE8CkNm5S2reKKBs9diZMgkJa"


class McpError(RuntimeError):
    pass


def _token() -> str:
    return os.environ.get("MCD_MCP_TOKEN", DEFAULT_TOKEN)


def _ssl_context():
    """Some python.org builds ship without CA certs; fall back rather than fail."""
    try:
        return ssl.create_default_context()
    except Exception:  # pragma: no cover
        return ssl._create_unverified_context()


def _urlopen(req, timeout):
    try:
        return urllib.request.urlopen(req, timeout=timeout, context=_ssl_context())
    except urllib.error.URLError as e:
        if isinstance(getattr(e, "reason", None), ssl.SSLCertVerificationError):
            return urllib.request.urlopen(req, timeout=timeout,
                                          context=ssl._create_unverified_context())
        raise


def _post(payload: dict, timeout: int = 60) -> dict:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        MCP_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {_token()}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        with _urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            ctype = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:  # pragma: no cover - network
        raise McpError(f"HTTP {e.code} calling MCP: {e.read()[:300]!r}") from e
    except urllib.error.URLError as e:  # pragma: no cover - network
        raise McpError(f"network error calling MCP: {e}") from e

    if "text/event-stream" in ctype:
        chunks = [ln[5:].strip() for ln in raw.splitlines() if ln.startswith("data:")]
        raw = chunks[-1] if chunks else raw
    return json.loads(raw)


def extract_payload(text: str) -> dict:
    """MCP tools answer with a markdown preamble + `## Original Response` + JSON.

    A few tools put the JSON in the middle of their explanation and some emit a
    markdown table containing literal ``{data[].field}`` placeholders *before*
    the payload, so a plain ``find("{")`` is not enough. Scan every ``{`` from
    the end and decode the first value that looks like a tool result.
    """
    marker = "## Original Response"
    body = text[text.index(marker) + len(marker) :] if marker in text else text
    decoder = json.JSONDecoder()
    fallback: dict | None = None
    for start in range(len(body) - 1, -1, -1):
        if body[start] != "{":
            continue
        try:
            value, _ = decoder.raw_decode(body[start:])
        except ValueError:
            continue
        if not isinstance(value, dict):
            continue
        if "data" in value or "success" in value:
            return value
        if fallback is None:
            fallback = value
    if fallback is not None:
        return fallback
    raise McpError(f"no JSON payload in tool text: {text[:200]!r}")


def call_tool(name: str, arguments: dict | None = None, timeout: int = 90) -> dict:
    payload = _post(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
        timeout=timeout,
    )
    if "error" in payload:
        raise McpError(f"{name}: {payload['error']}")
    result = payload.get("result", {})
    if result.get("isError"):
        raise McpError(f"{name}: {result}")
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    text = "\n".join(texts)
    try:
        return extract_payload(text)
    except Exception:  # tools without JSON payload (rare)
        return {"raw_text": text}


# ---------------------------------------------------------------- cache layer


def _cache_dir() -> str:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(here, "data", "cache")
    os.makedirs(path, exist_ok=True)
    return path


def cached(key: str, ttl_seconds: int, producer):
    """Tiny file cache. key must be filesystem safe."""
    path = os.path.join(_cache_dir(), re.sub(r"[^A-Za-z0-9_.-]", "_", key) + ".json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < ttl_seconds:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    value = producer()
    with open(path, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False)
    return value


# ------------------------------------------------------------- tool wrappers


def nearby_stores(city: str, keyword: str, be_type: int = 1, search_type: int = 2) -> list[dict]:
    data = call_tool(
        "query-nearby-stores",
        {"beType": be_type, "searchType": search_type, "city": city, "keyword": keyword},
    )
    return data.get("data") or []


def delivery_stores(address_id: str, be_type: int = 2) -> list[dict]:
    data = call_tool("delivery-query-stores", {"addressId": address_id, "beType": be_type})
    d = data.get("data") or []
    return d if isinstance(d, list) else d.get("stores", [])


def menu(store_code: str, order_type: int = 1, be_type: int = 1, be_code: str | None = None,
         reservation: str | None = None, ttl: int = 1800) -> dict:
    args = {"storeCode": store_code, "orderType": order_type, "beType": be_type}
    if be_code:
        args["beCode"] = be_code
    if reservation:
        args["reservationDate"] = reservation
    key = f"menu_{store_code}_{order_type}_{be_type}_{be_code or ''}_{reservation or ''}"
    return cached(key, ttl, lambda: call_tool("query-meals", args))


def meal_detail(store_code: str, code: str, order_type: int = 1, be_type: int = 1,
                be_code: str | None = None, reservation: str | None = None, ttl: int = 86400) -> dict:
    args = {"storeCode": store_code, "orderType": order_type, "beType": be_type, "code": code}
    if be_code:
        args["beCode"] = be_code
    if reservation:
        args["reservationDate"] = reservation
    key = f"detail_{store_code}_{order_type}_{be_type}_{code}"
    return cached(key, ttl, lambda: call_tool("query-meal-detail", args))


def nutrition_foods(ttl: int = 7 * 86400) -> str:
    data = cached("nutrition_foods", ttl, lambda: call_tool("list-nutrition-foods"))
    return data.get("data") or ""


def now_time() -> dict:
    return call_tool("now-time-info").get("data") or {}


def calculate_price(store_code: str, items: list[dict], order_type: int = 1, be_type: int = 1,
                    be_code: str | None = None, reservation: str | None = None,
                    gm_service_code: str | None = None) -> dict:
    args = {"storeCode": store_code, "orderType": order_type, "beType": be_type, "items": items}
    if be_code:
        args["beCode"] = be_code
    if reservation:
        args["reservationDate"] = reservation
    if gm_service_code:
        args["gmServiceCode"] = gm_service_code
    return call_tool("calculate-price", args)


def delivery_addresses() -> list[dict]:
    data = call_tool("delivery-query-addresses").get("data") or {}
    if isinstance(data, list):
        return data
    return data.get("addresses") or []


def promotions(store_code: str, order_type: int = 2, be_type: int = 6,
               be_code: str | None = None, reservation: str | None = None,
               ttl: int = 1800) -> list[dict]:
    """Active 团餐 promotion rules for a store (满折/满减). Empty for other modes."""
    if be_type != 6:
        return []
    args = {"storeCode": store_code, "orderType": order_type, "beType": be_type}
    if be_code:
        args["beCode"] = be_code
    if reservation:
        args["reservationDate"] = reservation
    key = f"promotions_{store_code}_{order_type}_{be_type}_{be_code or ''}_{reservation or ''}"
    data = cached(key, ttl, lambda: call_tool("query-promotions", args))
    return data.get("data") or []


def meal_assistance(store_code: str, order_type: int = 2, be_type: int = 6,
                    be_code: str | None = None, reservation: str | None = None,
                    ttl: int = 1800) -> list[dict]:
    """助餐服务 (GMS001 保鲜速达 / GMS002 专人分餐 / GMS003 专人摆台)."""
    if be_type != 6:
        return []
    args = {"storeCode": store_code, "orderType": order_type, "beType": be_type}
    if be_code:
        args["beCode"] = be_code
    if reservation:
        args["reservationDate"] = reservation
    key = f"assistance_{store_code}_{order_type}_{be_type}_{be_code or ''}_{reservation or ''}"
    data = cached(key, ttl, lambda: call_tool("query-meal-assistance", args))
    items = (data.get("data") or {}).get("mealAssistanceItems") or []
    return items
