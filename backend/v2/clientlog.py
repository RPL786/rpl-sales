"""Front-end crashes are printed to the server log (visible in Portainer), so a
"white screen" report can be traced to the exact error and screen."""
from __future__ import annotations

import time
from collections import deque

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/v2", tags=["v2-client-log"])

_recent: deque = deque(maxlen=200)  # timestamps, simple flood guard


class ClientError(BaseModel):
    kind: str = ""
    message: str = ""
    stack: str = ""
    where: str = ""
    url: str = ""
    user: str = ""
    agent: str = ""


@router.post("/client-error")
def client_error(payload: ClientError, request: Request):
    now = time.time()
    while _recent and now - _recent[0] > 60:
        _recent.popleft()
    if len(_recent) >= 60:  # max 60 reports a minute
        return {"status": "skipped"}
    _recent.append(now)
    ip = request.client.host if request.client else "-"
    print(
        f"CLIENT ERROR [{payload.kind[:20]}] user={payload.user[:40] or '-'} ip={ip} screen={payload.where[:40] or '-'}"
        f" url={payload.url[:100]} :: {payload.message[:500]}",
        flush=True,
    )
    if payload.stack:
        print("CLIENT STACK:", payload.stack[:1500].replace("\n", " | "), flush=True)
    if payload.agent:
        print("CLIENT AGENT:", payload.agent[:200], flush=True)
    return {"status": "logged"}
