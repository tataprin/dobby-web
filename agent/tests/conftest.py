# -*- coding: utf-8 -*-
"""Shared fakes for the agent tests. Everything is offline: a fake Supabase server and a fake Telegram are injected as
the HTTP transport, the EA's Common folder is a temp dir, and two guards make any write to the REAL Common folder or
any real HTTP transport fail the test."""
import calendar
import json
import os
import shutil
import sys

import pytest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
sys.path.insert(0, AGENT_DIR)

import dobby_agent as da  # noqa: E402

_REAL_COMMON = os.path.normcase(os.path.abspath(os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~"), "MetaQuotes", "Terminal", "Common", "Files", "Dobby")))

URL = "https://unit-test.supabase.co"
KEY = "sb_publishable_UNITTEST_0123456789abcdef"
BOT = "11111111-2222-3333-4444-555555555555"
EMAIL = "me@example.com"
PASSWORD = "Pw-very-secret-123"
OFFSET = 120


def utc(y, mo, d, h=0, mi=0, s=0):
    return float(calendar.timegm((y, mo, d, h, mi, s, 0, 0, 0)))


T0 = utc(2026, 11, 9, 8, 0, 0)  # Monday 08:00 UTC = 10:00 server time


@pytest.fixture(autouse=True)
def _guards(monkeypatch, tmp_path):
    """Never the real Common\\Files\\Dobby folder, never a real HTTP transport."""
    monkeypatch.setenv("APPDATA", str(tmp_path / "appdata"))
    monkeypatch.setenv("DOBBY_COMMON", str(tmp_path / "env-common-unused"))
    monkeypatch.delenv("DOBBY_AGENT_HOME", raising=False)
    real_atomic = da.atomic_write_bytes

    def guarded_atomic(path, data, *a, **k):
        assert not os.path.normcase(os.path.abspath(path)).startswith(_REAL_COMMON), "write to the REAL EA folder!"
        return real_atomic(path, data, *a, **k)

    monkeypatch.setattr(da, "atomic_write_bytes", guarded_atomic)

    def no_real_http(self, *a, **k):
        raise AssertionError("a real HTTP transport was created in a test")

    monkeypatch.setattr(da.HttpTransport, "__init__", no_real_http)
    try:
        import dobby_app_core as core
    except ImportError:  # pragma: no cover
        core = None
    if core is not None:
        def no_real_mt5(*a, **k):
            raise AssertionError("a test tried to really start MT5 (terminal64.exe)")

        def no_real_process_list(*a, **k):
            raise AssertionError("a test read the real process list: pass a fake `processes`")
        monkeypatch.setattr(core, "real_launch", no_real_mt5)
        monkeypatch.setattr(core, "windows_terminal_processes", no_real_process_list)
    yield


class Clock(object):
    def __init__(self, t=T0):
        self.t = float(t)

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += s

    def local(self):
        """Local wall clock for file headers: fixed UTC+7 (Thai time) so tests are deterministic."""
        return da.epoch_to_naive(self.t + 7 * 3600)


def default_desired():
    return {"live": False,
            "control": {"mode": "run", "lots": 0.03, "allow_long": True, "allow_short": True, "max_spread": None,
                        "note": ""},
            "blackouts": [], "params": None}


class FakeSupabase(object):
    """A tiny in-memory GoTrue + PostgREST with the contract of supabase/schema.sql."""

    def __init__(self, clock, desired=None, version=1):
        self.clock = clock
        self.calls = []
        self.down = False
        self.control = {"version": version, "desired": desired if desired is not None else default_desired(),
                        "updated_at": "2026-11-09T00:00:00Z"}
        self.journal = {}
        self.journal_posts = []
        self.status_rows = []
        self.bots_patches = []
        self.control_patches = []
        self.rpc_calls = []
        self.valid_refresh = {"rt-0"}
        self.valid_access = {}
        self.n = 0
        self.expires_in = 3600
        self.reject_access_once = False
        self.web_name = "คอมหลัก"

    # -- web side helpers
    def web_set(self, desired):
        self.control["desired"] = desired
        self.control["version"] += 1

    def rest_calls(self, method=None):
        return [c for c in self.calls if "/rest/v1/" in c["url"] and (method is None or c["method"] == method)]

    def token_calls(self):
        return [c for c in self.calls if c["url"].endswith("/auth/v1/token")]

    # -- transport
    def request(self, method, url, headers=None, params=None, json_body=None, timeout=None):
        headers, params = dict(headers or {}), dict(params or {})
        self.calls.append({"method": method, "url": url, "headers": headers, "params": params, "body": json_body})
        if self.down:
            raise da.NetworkError("ConnectionError: connection refused")
        assert url.startswith(URL), url
        path = url[len(URL):]
        if headers.get("apikey") != KEY:
            return da.HttpResponse(401, '{"message":"No API key found in request"}')
        if path == "/auth/v1/token":
            return self._token(params, json_body or {}, headers)
        assert path.startswith("/rest/v1/"), path
        auth = headers.get("Authorization", "")
        tok = auth[7:] if auth.startswith("Bearer ") else None
        if self.reject_access_once or tok not in self.valid_access or self.valid_access[tok] < self.clock():
            self.reject_access_once = False
            return da.HttpResponse(401, '{"code":"PGRST301","message":"JWT expired"}')
        return self._rest(method, path[len("/rest/v1/"):], params, json_body, headers)

    def _token(self, params, body, headers):
        # the publishable key is NOT a JWT: the auth endpoint must get only the apikey header
        assert "Authorization" not in headers, "Authorization header sent to the auth endpoint"
        grant = params.get("grant_type")
        if grant == "password":
            if body.get("email") != EMAIL or body.get("password") != PASSWORD:
                return da.HttpResponse(400, json.dumps({"code": 400, "error_code": "invalid_credentials",
                                                        "msg": "Invalid login credentials"}))
        elif grant == "refresh_token":
            rt = body.get("refresh_token")
            if rt not in self.valid_refresh:
                return da.HttpResponse(400, json.dumps({"code": 400, "error_code": "refresh_token_not_found",
                                                        "msg": "Invalid Refresh Token: Refresh Token Not Found"}))
            self.valid_refresh.discard(rt)
        else:
            return da.HttpResponse(400, '{"msg":"unsupported grant"}')
        self.n += 1
        access, refresh = "access-token-%d" % self.n, "rt-%d" % self.n
        self.valid_access[access] = self.clock() + self.expires_in
        self.valid_refresh.add(refresh)
        return da.HttpResponse(200, json.dumps({
            "access_token": access, "token_type": "bearer", "expires_in": self.expires_in,
            "expires_at": int(self.clock() + self.expires_in), "refresh_token": refresh, "user": {"id": "user-1"}}))

    def _rest(self, method, table, params, body, headers):
        prefer = headers.get("Prefer", "")
        if table == "bot_status" and method == "POST":
            assert params == {"on_conflict": "bot_id"} and "resolution=merge-duplicates" in prefer
            self.status_rows.append(body)
            return da.HttpResponse(201, "")
        if table == "journal" and method == "POST":
            assert params == {"on_conflict": "bot_id,line_hash"} and "resolution=ignore-duplicates" in prefer
            keys = set(body[0])
            for r in body:
                assert set(r) == keys, "all rows of a batch need the same keys"
                assert r["bot_id"] == BOT
                self.journal.setdefault(r["line_hash"], r)
            self.journal_posts.append(len(body))
            return da.HttpResponse(201, "")
        if table == "bot_control" and method == "GET":
            assert params["bot_id"] == "eq." + BOT and params["select"] == "version,desired,updated_at"
            return da.HttpResponse(200, json.dumps([dict(self.control)]))
        if table == "bot_control" and method == "POST":
            return da.HttpResponse(403, '{"code":"42501","message":"permission denied for table bot_control"}')
        if table == "bot_control" and method == "PATCH":
            assert params["bot_id"] == "eq." + BOT
            self.control_patches.append({"params": params, "body": body})
            if "version" in params and params["version"] != "eq.%d" % self.control["version"]:
                return da.HttpResponse(200, "[]")
            new = body["desired"]
            assert isinstance(new, dict) and (new.get("live") is None or isinstance(new.get("live"), bool))
            if self.control["desired"].get("live") is not True and new.get("live") is True:
                return da.HttpResponse(400, '{"code":"P0001","message":"reauth_required"}')
            self.control["desired"] = new
            self.control["version"] += 1
            return da.HttpResponse(200, json.dumps([dict(self.control, bot_id=BOT)]))
        if table == "bots" and method == "PATCH":
            assert params == {"id": "eq." + BOT}
            self.bots_patches.append(body)
            return da.HttpResponse(204, "")
        if table == "bots" and method == "GET":
            assert params == {"id": "eq." + BOT, "select": "name"}
            return da.HttpResponse(200, json.dumps([{"name": self.web_name}] if self.web_name else []))
        if table == "rpc/register_bot":
            self.rpc_calls.append(body)
            self.control = {"version": 1, "desired": body["p_desired"], "updated_at": "2026-11-09T00:00:00Z"}
            return da.HttpResponse(200, json.dumps(BOT))
        if table == "rpc/is_approved":
            return da.HttpResponse(200, "true")
        return da.HttpResponse(404, '{"message":"no route %s %s"}' % (method, table))


class FakeTelegramTransport(object):
    def __init__(self):
        self.sent = []
        self.fail = None        # None | "network" | 429 | 500

    def request(self, method, url, headers=None, params=None, json_body=None, timeout=None):
        assert url.startswith("https://api.telegram.org/bot") and url.endswith("/sendMessage")
        if self.fail == "network":
            raise da.NetworkError("ConnectionError: Max retries exceeded with url: %s" % url)
        if self.fail == 429:
            return da.HttpResponse(429, json.dumps({"ok": False, "description": "Too Many Requests",
                                                    "parameters": {"retry_after": 7}}))
        if self.fail:
            return da.HttpResponse(self.fail, '{"ok":false,"description":"oops"}')
        self.sent.append(json_body)
        return da.HttpResponse(200, '{"ok":true}')

    def texts(self):
        return [m["text"] for m in self.sent]


def load_fixture_status():
    with open(os.path.join(FIXTURES, "dobby2_status.json"), encoding="utf-8") as f:
        return json.load(f)


def server_time_str(t, offset_min=OFFSET):
    return da.epoch_to_naive(t + offset_min * 60).strftime("%Y.%m.%d %H:%M:%S")


class Env(object):
    """A registered agent folder + a temp EA Common folder + fakes."""

    def __init__(self, tmp_path, desired=None, version=1, limits=None, config_extra=None, telegram=True,
                 copy_journal=True):
        self.clock = Clock()
        self.agent_dir = str(tmp_path / "agent")
        self.common = str(tmp_path / "common")
        os.makedirs(self.agent_dir)
        os.makedirs(self.common)
        if copy_journal:
            shutil.copy(os.path.join(FIXTURES, "dobby2_journal.csv"), self.path("dobby2_journal.csv"))
        self.status = load_fixture_status()
        self.write_status()
        cfg = da.default_config()
        cfg.update({"supabase_url": URL, "anon_key": KEY, "email": EMAIL, "refresh_token": "rt-0", "bot_id": BOT,
                    "bot_name": "Main PC", "common_dir": self.common})
        if limits:
            cfg["limits"].update(limits)
        if telegram:
            cfg["telegram"].update({"token": "123456:TELEGRAM-SECRET-TOKEN", "chat_id": "42"})
        if config_extra:
            cfg.update(config_extra)
        da.save_config(self.cfg_path, cfg)
        self.fake = FakeSupabase(self.clock, desired=desired, version=version)
        self.tg_transport = FakeTelegramTransport()

    @property
    def cfg_path(self):
        return os.path.join(self.agent_dir, da.CONFIG_NAME)

    def path(self, name):
        return os.path.join(self.common, name)

    def write_status(self, fresh=True, **changes):
        """Status with heartbeat = now and server time = now + 120 min (a running market)."""
        if fresh:
            self.status["heartbeat_gmt_unix"] = int(self.clock())
            self.status["server_time"] = server_time_str(self.clock())
        for k, v in changes.items():
            self.status[k] = v
        with open(self.path("dobby2_status.json"), "w", encoding="utf-8") as f:
            json.dump(self.status, f)

    def tick(self, seconds=5, **changes):
        self.clock.advance(seconds)
        self.write_status(**changes)

    def client(self, refresh_token="rt-0"):
        return da.SupabaseClient(URL, KEY, self.fake, refresh_token=refresh_token, clock=self.clock)

    def agent(self, dry_run=False):
        cfg = da.load_config(self.cfg_path)
        tg = cfg["telegram"]
        telegram = da.Telegram(self.tg_transport, tg["token"], tg["chat_id"], tg["events"], clock=self.clock,
                               dry_run=dry_run)
        return da.Agent(self.agent_dir, self.common, self.client(cfg["refresh_token"]), telegram, clock=self.clock,
                        sleep=lambda s: None, local_now=self.clock.local, dry_run=dry_run)

    def read(self, name):
        p = self.path(name)
        if not os.path.exists(p):
            return None
        with open(p, "rb") as f:
            return f.read()

    def snapshot(self):
        out = {}
        for n in sorted(os.listdir(self.common)):
            p = self.path(n)
            with open(p, "rb") as f:
                out[n] = (f.read(), os.stat(p).st_mtime)
        return out

    def config(self):
        return da.load_config(self.cfg_path)

    def state(self):
        p = os.path.join(self.agent_dir, da.STATE_NAME)
        with open(p, encoding="utf-8") as f:
            return json.load(f)


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)
