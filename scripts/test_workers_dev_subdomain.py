"""Offline tests for Cloudflare workers.dev onboarding."""

import unittest
from ensure_workers_dev_subdomain import SubdomainSetupError, ensure_subdomain

ACCOUNT = "0123456789abcdef0123456789abcdef"
TOKEN = "fake-test-token"


class WorkerSubdomainTest(unittest.TestCase):
    def test_existing_subdomain_is_untouched(self):
        calls = []

        def request(method, url, token, payload=None):
            calls.append(method)
            return 200, {"success": True, "result": {"subdomain": "existing"}}

        self.assertEqual(ensure_subdomain(ACCOUNT, TOKEN, request_fn=request), "existing")
        self.assertEqual(calls, ["GET"])

    def test_missing_subdomain_without_optin_fails_before_write(self):
        calls = []

        def request(method, url, token, payload=None):
            calls.append(method)
            return 404, {"success": False, "errors": []}

        with self.assertRaisesRegex(SubdomainSetupError, "WORKERS_DEV_SUBDOMAIN"):
            ensure_subdomain(ACCOUNT, TOKEN, request_fn=request)
        self.assertEqual(calls, ["GET"])

    def test_explicit_subdomain_is_registered_only_if_missing(self):
        calls = []

        def request(method, url, token, payload=None):
            calls.append((method, payload))
            if method == "GET":
                return 404, {"success": False}
            return 200, {"success": True, "result": {"subdomain": payload["subdomain"]}}

        self.assertEqual(
            ensure_subdomain(ACCOUNT, TOKEN, "pulipuli-facebook", request), "pulipuli-facebook"
        )
        self.assertEqual(calls, [("GET", None), ("PUT", {"subdomain": "pulipuli-facebook"})])

    def test_existing_account_subdomain_cannot_be_renamed(self):
        def request(method, url, token, payload=None):
            self.assertEqual(method, "GET")
            return 200, {"success": True, "result": {"subdomain": "existing"}}

        with self.assertRaisesRegex(SubdomainSetupError, "already uses"):
            ensure_subdomain(ACCOUNT, TOKEN, "different", request)

    def test_invalid_subdomain_rejected_without_api_call(self):
        def request(*args):
            self.fail("Invalid subdomain must not trigger API call")

        for value in ["-wrong", "Wrong", "wrong_underscore", "a" * 64]:
            with self.subTest(value=value), self.assertRaisesRegex(SubdomainSetupError, "WORKERS_DEV_SUBDOMAIN"):
                ensure_subdomain(ACCOUNT, TOKEN, value, request)

    def test_permission_failure_is_actionable(self):
        def request(method, url, token, payload=None):
            return 403, {"success": False, "errors": [{"code": 9109, "message": "Permission denied"}]}

        with self.assertRaisesRegex(SubdomainSetupError, "Workers Scripts Read/Write"):
            ensure_subdomain(ACCOUNT, TOKEN, request_fn=request)


if __name__ == "__main__":
    unittest.main()
