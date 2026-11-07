# -*- coding: utf-8 -*-
"""The commands: setup, login, register, limits, status, run, test-telegram (all offline)."""
import json
import os

import dobby_agent as da
from conftest import BOT, EMAIL, KEY, PASSWORD, URL, Env


class Out(object):
    def __init__(self):
        self.lines = []

    def __call__(self, s=""):
        self.lines.append(str(s))

    @property
    def text(self):
        return "\n".join(self.lines)


class Router(object):
    """Supabase fake + Telegram fake behind one transport."""

    def __init__(self, fake, tg):
        self.fake, self.tg = fake, tg

    def request(self, method, url, **kw):
        if url.startswith("https://api.telegram.org/"):
            return self.tg.request(method, url, **kw)
        return self.fake.request(method, url, **kw)


def run(e, argv, inputs=(), password=PASSWORD, sleep=None):
    out = Out()
    prompts = []
    answers = list(inputs)

    def inp(prompt):
        prompts.append(prompt)
        return answers.pop(0) if answers else ""

    def gp(prompt):
        prompts.append(prompt)
        return password

    rt = da.Runtime(agent_dir=e.agent_dir, transport=Router(e.fake, e.tg_transport), input_fn=inp, getpass_fn=gp,
                    out=out, clock=e.clock, sleep=sleep or (lambda s: None), local_now=e.clock.local,
                    environ={"APPDATA": os.path.dirname(e.common)}, setup_logs=False)
    code = da.main(argv, rt)
    return code, out, prompts


def fresh(tmp_path):
    """An agent folder without config (first install)."""
    e = Env(tmp_path)
    os.remove(e.cfg_path)
    return e


def test_setup_non_interactive(tmp_path):
    e = fresh(tmp_path)
    code, out, _ = run(e, ["setup", "--url", URL + "/", "--anon-key", KEY, "--common-dir", e.common,
                           "--telegram-token", "123456:TG-TOKEN-xyz", "--telegram-chat-id", "42", "--non-interactive"])
    assert code == 0
    cfg = e.config()
    assert cfg["supabase_url"] == URL and cfg["anon_key"] == KEY and cfg["common_dir"] == e.common
    assert cfg["telegram"]["token"] == "123456:TG-TOKEN-xyz" and cfg["limits"] == da.DEFAULT_LIMITS
    assert "พบไฟล์สถานะ: EA 3.03 XAUUSD" in out.text and KEY not in out.text


def test_setup_interactive_prompts(tmp_path):
    e = fresh(tmp_path)
    code, out, prompts = run(e, ["setup"], inputs=[URL, KEY, e.common, "n"])
    assert code == 0 and e.config()["anon_key"] == KEY and e.config()["common_dir"] == e.common
    assert any("Publishable key (sb_publishable_...) or anon key" in p for p in prompts)
    assert run(e, ["setup", "--url", "http://evil.example", "--non-interactive"])[0] == da.EXIT_CONFIG


def test_login_stores_only_the_refresh_token(tmp_path):
    e = fresh(tmp_path)
    run(e, ["setup", "--url", URL, "--anon-key", KEY, "--common-dir", e.common, "--non-interactive"])
    e.fake.valid_refresh.clear()
    code, out, prompts = run(e, ["login", "--email", EMAIL])
    assert code == 0
    cfg_text = open(e.cfg_path, encoding="utf-8").read()
    assert PASSWORD not in cfg_text and PASSWORD not in out.text and "access-token" not in cfg_text
    assert json.loads(cfg_text)["refresh_token"] == "rt-1" and json.loads(cfg_text)["email"] == EMAIL
    assert "rt-1" not in out.text
    auth = e.fake.token_calls()[0]
    assert auth["params"] == {"grant_type": "password"} and auth["headers"]["apikey"] == KEY
    assert "Authorization" not in auth["headers"]                 # the publishable key is never a Bearer token
    assert auth["body"] == {"email": EMAIL, "password": PASSWORD}
    assert e.fake.rest_calls()[0]["url"].endswith("/rest/v1/rpc/is_approved")
    assert "register" in out.text


def test_login_wrong_password(tmp_path):
    e = fresh(tmp_path)
    run(e, ["setup", "--url", URL, "--anon-key", KEY, "--non-interactive"])
    code, out, _ = run(e, ["login", "--email", EMAIL], password="nope-nope")
    assert code == da.EXIT_CONFIG and "Invalid login credentials" in out.text and "nope-nope" not in out.text
    assert e.config()["refresh_token"] == ""


def test_register_builds_desired_from_the_ea_state(tmp_path):
    e = Env(tmp_path)
    da.update_config(e.cfg_path, lambda c: (c.__setitem__("bot_id", ""), c.__setitem__("bot_name", "")))
    with open(e.path(da.CONTROL_NAME), "w", encoding="utf-8", newline="") as f:
        f.write("# Dobby2 control file\r\nmode=run\r\nlots=0.02\r\nallow_long=1\r\nallow_short=0\r\n"
                "max_spread=0.60\r\nblackout=2026.11.10 15:00-16:30\r\nblackout=2026.11.01 10:00-11:00\r\n"
                "id=C004\r\nnote=x\r\n")

    def sleep(s):                                                # the second status sample: the market is running
        e.clock.advance(s)
        e.write_status()
    code, out, _ = run(e, ["register", "--name", "Main PC"], sleep=sleep)
    assert code == 0, out.text
    p = e.fake.rpc_calls[0]
    assert p["p_name"] == "Main PC"
    assert p["p_desired"] == {
        "live": True,
        "control": {"mode": "run", "lots": 0.02, "allow_long": True, "allow_short": False, "max_spread": 0.6,
                    "note": "registered by dobby_agent"},
        "blackouts": [{"from_utc": "2026-11-10T13:00:00Z", "to_utc": "2026-11-10T14:30:00Z", "label": "local"}],
        "params": None}
    cfg = e.config()
    assert cfg["bot_id"] == BOT and cfg["bot_name"] == "Main PC"
    st = e.state()
    assert st["applied_version"] == 1 and st["applied_live"] is True and st["offset"]["confirmed"] is True
    assert st["control"]["adopted_mtime"] == os.stat(e.path(da.CONTROL_NAME)).st_mtime
    # already registered -> refused without --force
    code, out, _ = run(e, ["register", "--name", "Other"], sleep=sleep)
    assert code == da.EXIT_CONFIG and "--force" in out.text and len(e.fake.rpc_calls) == 1
    assert run(e, ["register", "--name", "Other", "--force"], sleep=sleep)[0] == 0
    # first run after register: same state, not adopted back, file rewritten in the web format
    a = e.agent()
    a.cycle()
    assert e.fake.control_patches == [] and b"id=W001\r\n" in e.read(da.CONTROL_NAME)
    assert b"lots=0.02\r\n" in e.read(da.CONTROL_NAME)


def test_register_live_locked_bot_starts_with_live_off(tmp_path):
    e = Env(tmp_path)
    da.update_config(e.cfg_path, lambda c: c.__setitem__("bot_id", ""))
    e.write_status(flags={"live_locked": True, "allow_live_input": False})
    code, out, _ = run(e, ["register", "--name", "PC2"])
    assert code == 0
    d = e.fake.rpc_calls[0]["p_desired"]
    assert d["live"] is False and d["control"]["mode"] == "run" and d["control"]["lots"] is None
    assert "ยังไม่ยืนยัน" in out.text                             # status did not move: offset unconfirmed


def test_register_needs_login_and_status(tmp_path):
    e = Env(tmp_path)
    da.update_config(e.cfg_path, lambda c: (c.__setitem__("bot_id", ""), c.__setitem__("refresh_token", "")))
    code, out, _ = run(e, ["register"])
    assert code == da.EXIT_CONFIG and "login" in out.text
    da.update_config(e.cfg_path, lambda c: c.__setitem__("refresh_token", "rt-0"))
    os.remove(e.path(da.STATUS_NAME))
    code, out, _ = run(e, ["register"])
    assert code == da.EXIT_CONFIG and da.STATUS_NAME in out.text


def test_limits_command(tmp_path):
    e = Env(tmp_path)
    code, out, _ = run(e, ["limits", "--allow-live", "on", "--allow-params", "on", "--max-lots", "0.05",
                           "--max-cap", "8"])
    assert code == 0
    lim = e.config()["limits"]
    assert lim == {"allow_remote_control": True, "allow_remote_live": True, "allow_remote_params": True,
                   "max_lots": 0.05, "max_daily_cap_pct": 8.0}
    code, out, _ = run(e, ["limits", "--allow-control", "off"])
    assert e.config()["limits"]["allow_remote_control"] is False and "allow_remote_control): off" in out.text
    assert e.config()["refresh_token"] == "rt-0" and e.config()["bot_id"] == BOT    # nothing else touched
    assert run(e, ["limits", "--max-lots", "-1"])[0] == da.EXIT_CONFIG
    code, out, _ = run(e, ["limits"])                             # no flags: just show
    assert code == 0 and "max_lots): 0.05" in out.text


def test_status_command_hides_secrets(tmp_path):
    e = Env(tmp_path)
    code, out, _ = run(e, ["status"])
    assert code == 0
    for secret in ("rt-0", KEY, "TELEGRAM-SECRET-TOKEN"):
        assert secret not in out.text
    assert "refresh token saved" in out.text and "EA heartbeat age: 0 s" in out.text
    assert "remote control on | remote live off | remote params off | max lots 0.10" in out.text


def test_run_once_dry_run_and_run_once(tmp_path):
    e = Env(tmp_path)
    before = e.snapshot()
    code, out, _ = run(e, ["run", "--once", "--dry-run"])
    assert code == 0 and e.snapshot() == before
    assert not os.path.exists(os.path.join(e.agent_dir, da.STATE_NAME))
    code, out, _ = run(e, ["run", "--once"])
    assert code == 0 and b"id=W001" in e.read(da.CONTROL_NAME)
    assert os.path.exists(os.path.join(e.agent_dir, da.STATE_NAME))


def test_run_refuses_without_registration_and_when_already_running(tmp_path):
    e = Env(tmp_path)
    da.update_config(e.cfg_path, lambda c: c.__setitem__("bot_id", ""))
    code, out, _ = run(e, ["run", "--once"])
    assert code == da.EXIT_CONFIG and "register" in out.text
    da.update_config(e.cfg_path, lambda c: c.__setitem__("bot_id", BOT))
    lock = da.InstanceLock(os.path.join(e.agent_dir, da.LOCK_NAME))
    assert lock.acquire()
    try:
        assert run(e, ["run", "--once"])[0] == da.EXIT_RUNNING
    finally:
        lock.release()
    assert run(e, ["run", "--once"])[0] == 0


def test_test_telegram(tmp_path):
    e = Env(tmp_path)
    code, out, _ = run(e, ["test-telegram"])
    assert code == 0 and e.tg_transport.texts() == ["[Main PC] ทดสอบการแจ้งเตือนจาก Dobby agent %s สำเร็จ"
                                                    % da.AGENT_VERSION]
    da.update_config(e.cfg_path, lambda c: c["telegram"].update({"token": ""}))
    assert run(e, ["test-telegram"])[0] == da.EXIT_CONFIG


def test_no_metatrader_import_and_version():
    src = open(da.__file__, encoding="utf-8").read()
    assert "MetaTrader5" not in src.replace("never imports MetaTrader5", "").replace("Never import MetaTrader5", "")
    assert da.AGENT_VERSION == "1.0.0"
