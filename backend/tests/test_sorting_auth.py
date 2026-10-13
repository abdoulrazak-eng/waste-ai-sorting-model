import asyncio
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request
from sorting_auth import require_sorting_session, verify_browser_origin


def request(method="GET", headers=()):
    return Request({"type": "http", "method": method, "path": "/inference", "headers": list(headers),
                    "scheme": "http", "server": ("localhost", 8000), "query_string": b""})


class SortingAuthenticationTests(unittest.TestCase):
    def test_anonymous_requests_are_rejected_before_cloud_access(self):
        with patch("sorting_auth.cloud_request") as cloud:
            with self.assertRaises(HTTPException) as error:
                asyncio.run(require_sorting_session(request()))
            self.assertEqual(error.exception.status_code, 401)
            cloud.assert_not_called()

    def test_cookie_mutations_require_a_trusted_origin(self):
        with patch.dict(os.environ, {"SORTING_FRONTEND_ORIGINS": "https://sorting.example.com"}):
            with self.assertRaises(HTTPException) as error:
                verify_browser_origin(request("POST", [(b"origin", b"https://untrusted.example.com")]))
            self.assertEqual(error.exception.status_code, 403)
            verify_browser_origin(request("POST", [(b"origin", b"https://sorting.example.com")]))

    def test_business_identity_comes_from_validated_server_context(self):
        context = {"business": {"id": "business-a"}, "kiosk": {"kioskId": "kiosk-a"}}
        with patch("sorting_auth.cloud_request", return_value=context):
            result = asyncio.run(require_sorting_session(request(headers=[(b"authorization", b"Bearer sorting-session")])) )
            self.assertEqual(result["business"]["id"], "business-a")
            self.assertEqual(result["kiosk"]["kioskId"], "kiosk-a")

    def test_cloud_outage_does_not_allow_anonymous_fallback(self):
        with patch("sorting_auth.cloud_request", side_effect=HTTPException(503, "Unavailable")):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(require_sorting_session(request(headers=[(b"authorization", b"Bearer sorting-session")])))
            self.assertEqual(error.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
