"""Business authentication delegated to SmartEco; no credentials are stored locally."""
import asyncio
import json
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request as UrlRequest, urlopen

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

auth_router = APIRouter(prefix="/auth")
COOKIE_NAME = "smarteco_sorting_session"


def cloud_url():
    value = os.getenv("SMARTECO_API_URL", "").rstrip("/")
    if not value:
        raise HTTPException(503, "Sorting authentication is not configured")
    return value


def cloud_request(path, method="GET", payload=None, credential=None):
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if credential:
        headers["Authorization"] = f"Bearer {credential}"
    request = UrlRequest(f"{cloud_url()}{path}", data=json.dumps(payload).encode() if payload is not None else None,
                         headers=headers, method=method)
    try:
        with urlopen(request, timeout=10) as response:
            result = json.load(response)
    except HTTPError as error:
        if error.code in (401, 403):
            raise HTTPException(401, "Invalid credentials, expired session, or sorting access disabled") from None
        if error.code == 400:
            raise HTTPException(400, "The sorting request was rejected") from None
        raise HTTPException(503, "SmartEco is temporarily unavailable") from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise HTTPException(503, "Unable to connect to SmartEco. Please try again.") from None
    if not isinstance(result, dict) or result.get("success") is not True:
        raise HTTPException(503, "Unexpected SmartEco response")
    return result.get("data", {})


def verify_browser_origin(request: Request):
    # Cookie authentication requires an allowed Origin on state-changing requests.
    origin = request.headers.get("origin")
    configured = os.getenv("SORTING_FRONTEND_ORIGINS", "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173")
    allowed = {value.strip().rstrip("/") for value in configured.split(",") if value.strip()}
    if not origin or origin.rstrip("/") not in allowed:
        raise HTTPException(403, "This browser origin is not allowed")


async def require_sorting_session(request: Request):
    header = request.headers.get("authorization", "")
    if header:
        parts = header.split()
        if len(parts) != 2 or parts[0] != "Bearer":
            raise HTTPException(401, "A valid sorting credential is required")
        credential = parts[1]
    else:
        credential = request.cookies.get(COOKIE_NAME)
        if not credential:
            raise HTTPException(401, "Sign in to use sorting")
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            verify_browser_origin(request)
    context = await asyncio.to_thread(cloud_request, "/sorting/access/session", credential=credential)
    if not context.get("business", {}).get("id") or not context.get("kiosk", {}).get("kioskId"):
        raise HTTPException(401, "Sorting business identity is missing")
    return {**context, "credential": credential}


class LoginPayload(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)


class TokenPayload(BaseModel):
    token: str = Field(min_length=1, max_length=512)


def login_response(response: Response, result):
    credential = result.get("accessToken")
    if not credential:
        raise HTTPException(503, "SmartEco did not issue a session")
    response.set_cookie(COOKIE_NAME, credential, httponly=True, samesite="strict", path="/",
                        secure=os.getenv("SORTING_COOKIE_SECURE", "true").lower() == "true",
                        max_age=int(result["expiresIn"]))
    response.headers["Cache-Control"] = "no-store"
    return {"business": result["business"], "kiosk": result["kiosk"], "expiresIn": result["expiresIn"]}


@auth_router.post("/login")
async def login(payload: LoginPayload, request: Request, response: Response):
    verify_browser_origin(request)
    result = await asyncio.to_thread(cloud_request, "/sorting/access/login", "POST", {"email": payload.email, "password": payload.password})
    return login_response(response, result)


@auth_router.post("/token")
async def token_login(payload: TokenPayload, request: Request, response: Response):
    verify_browser_origin(request)
    result = await asyncio.to_thread(cloud_request, "/sorting/access/token", "POST", {"token": payload.token})
    return login_response(response, result)


@auth_router.get("/session")
async def session(response: Response, context=Depends(require_sorting_session)):
    response.headers["Cache-Control"] = "no-store"
    return {"business": context["business"], "kiosk": context["kiosk"]}


@auth_router.post("/logout")
async def logout(request: Request, response: Response):
    verify_browser_origin(request)
    credential = request.cookies.get(COOKIE_NAME)
    if credential:
        try:
            await asyncio.to_thread(cloud_request, "/sorting/access/logout", "POST", {}, credential)
        except HTTPException as error:
            if error.status_code != 401:
                raise
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="strict",
                           secure=os.getenv("SORTING_COOKIE_SECURE", "true").lower() == "true")
    return {"loggedOut": True}
