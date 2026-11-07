# -*- coding: utf-8 -*-
"""Dobby App helpers (no window): app data folder + config, MT5 detection, Storage request shapes, EA install,
the one-agent-per-MT5 lock (incl. stale locks), the Startup launcher, the app's agent and registration flows."""
import json
import os
import subprocess
import sys
import threading
import time

import pytest

import dobby_agent as da
import dobby_app_core as core
from conftest import BOT, KEY, URL, Env
from test_cli import run

HEX1 = "D0E8209F77C8CF37AD8BF550E51FF075"
HEX2 = "2f5a1c0b9e7d4a3b8c6d5e4f3a2b1c0d"


# ---------------------------------------------------------------------------------------------------------------------
# app data folder + config
# ---------------------------------------------------------------------------------------------------------------------
def test_app_data_dir_is_in_appdata_not_next_to_the_exe(tmp_path):
    d = core.app_data_dir({"APPDATA": str(tmp_path / "roaming")})
    assert d == os.path.join(str(tmp_path / "roaming"), "DobbyApp")
    assert not d.startswith(os.path.dirname(sys.executable))
    assert core.app_data_dir({}).endswith(os.path.join("AppData", "Roaming", "DobbyApp"))


def test_app_config_defaults_and_cli_compatible(tmp_path):
    data = str(tmp_path / "DobbyApp")
    cfg = core.load_app_config(data)                       # nothing on disk yet: defaults, nothing written
    assert cfg["supabase_url"] == core.DEFAULT_URL and cfg["anon_key"] == core.DEFAULT_KEY
    assert cfg["app"] == core.default_app_section() and not os.path.exists(data)
    assert not core.config_complete(cfg)
    core.update_app_config(data, lambda c: (c.update(refresh_token="rt-x", email="a@b.c"),
                                            c["limits"].update(max_lots=0.05), c["app"].update(auto_start=True)))
    path = os.path.join(data, da.CONFIG_NAME)
    assert os.path.isfile(path)
    cli = da.load_config(path)                             # the CLI agent reads the very same file
    assert cli["refresh_token"] == "rt-x" and da.get_limits(cli)["max_lots"] == 0.05
    assert cli["supabase_url"] == core.DEFAULT_URL and cli["app"]["auto_start"] is True
    assert not core.config_complete(core.load_app_config(data))   # no bot yet
    core.set_pending_bot(data, "คอมที่บ้าน")
    cfg = core.load_app_config(data)
    assert core.config_complete(cfg) and cfg["app"]["pending_bot_name"] == "คอมที่บ้าน" and cfg["bot_id"] == ""
    core.update_app_config(data, lambda c: c.update(bot_id=BOT))
    assert core.load_app_config(data)["app"]["auto_start"] is True     # other keys survive


# ---------------------------------------------------------------------------------------------------------------------
# MT5 detection (fake %APPDATA% tree)
# ---------------------------------------------------------------------------------------------------------------------
def _terminal(root, tid, origin, utf16=True, servers=(), ex5=(), age=0):
    d = os.path.join(root, "MetaQuotes", "Terminal", tid)
    os.makedirs(os.path.join(d, "MQL5", "Experts", "Dobby"))
    os.makedirs(os.path.join(d, "logs"))
    for s in servers:
        os.makedirs(os.path.join(d, "bases", s))
    for n in ex5:
        open(os.path.join(d, "MQL5", "Experts", n), "wb").close()
    if origin is not None:
        with open(os.path.join(d, "origin.txt"), "wb") as f:
            f.write(b"\xff\xfe" + origin.encode("utf-16-le") if utf16 else origin.encode("utf-8"))
    t = time.time() - age
    for p in (os.path.join(d, "logs"), d):
        os.utime(p, (t, t))
    return d


def test_detect_terminals_fake_tree(tmp_path):
    root = str(tmp_path / "appdata")
    d1 = _terminal(root, HEX1, r"C:\Program Files\TMGM MetaTrader 5", servers=("TMGM-Live", "Default"),
                   ex5=("Dobby3_v303.ex5", "Other.ex5"), age=10)
    d2 = _terminal(root, HEX2, r"C:\Program Files\MetaTrader 5", utf16=False, servers=("MetaQuotes-Demo",),
                   age=86400)
    os.makedirs(os.path.join(root, "MetaQuotes", "Terminal", "Common", "Files"))          # not a terminal
    os.makedirs(os.path.join(root, "MetaQuotes", "Terminal", "Community"))                # not a terminal
    os.makedirs(os.path.join(root, "MetaQuotes", "Terminal", "A" * 32))                    # no MQL5, no origin
    found = core.detect_terminals(root)
    assert [t["data_dir"] for t in found] == [d1, d2]                                      # most recent first
    t1, t2 = found
    assert t1["name"] == "TMGM MetaTrader 5" and t1["install_dir"] == r"C:\Program Files\TMGM MetaTrader 5"
    assert t1["servers"] == ["TMGM-Live"] and t1["ea_files"] == ["Dobby3_v303.ex5"] and t1["id"] == HEX1
    assert t2["name"] == "MetaTrader 5" and t2["servers"] == ["MetaQuotes-Demo"] and t2["ea_files"] == []
    open(os.path.join(d2, "MQL5", "Experts", "Dobby", "Dobby3_v304.ex5"), "wb").close()
    assert core.describe_terminal(d2)["ea_files"] == ["Dobby\\Dobby3_v304.ex5"]
    assert core.detect_terminals(str(tmp_path / "nothing")) == []
    assert core.default_common_dir(root) == os.path.join(root, "MetaQuotes", "Terminal", "Common", "Files", "Dobby")


def test_read_origin_and_manual_folder(tmp_path):
    p = str(tmp_path / "origin.txt")
    with open(p, "wb") as f:
        f.write("C:\\MT5 ทดลอง".encode("utf-16-le"))                                       # UTF-16 without BOM
    assert core.read_origin(p) == "C:\\MT5 ทดลอง"
    assert core.read_origin(str(tmp_path / "missing.txt")) == ""
    portable = tmp_path / "portable"
    (portable / "MQL5").mkdir(parents=True)
    assert core.normalize_data_dir(str(portable / "MQL5")) == str(portable)
    assert core.is_data_dir(str(portable)) and not core.is_data_dir(str(tmp_path))
    t = core.describe_terminal(str(portable))
    assert t["name"] == "portable" and t["install_dir"] == "" and t["has_mql5"]


# ---------------------------------------------------------------------------------------------------------------------
# Storage request shapes (fake transport)
# ---------------------------------------------------------------------------------------------------------------------
class Recorder(object):
    """Minimal Supabase stand-in that records every request."""

    def __init__(self):
        self.calls = []
        self.n = 0
        self.fail_next = None
        self.files = [{"name": "Dobby3 v304.ex5", "id": "1", "updated_at": "2026-11-07T06:00:00Z",
                       "metadata": {"size": 186368}},
                      {"name": "Dobby3_usd280_0.03each.set", "id": "2", "metadata": {"size": 9812}},
                      {"name": "DobbyApp.exe", "id": "3", "metadata": {"size": 11534336}},
                      {"name": "old", "id": None, "metadata": None},                       # a folder
                      {"name": ".emptyFolderPlaceholder", "id": "4", "metadata": {"size": 0}}]

    def request(self, method, url, headers=None, params=None, json_body=None, timeout=None):
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {}), "params": params,
                           "body": json_body})
        if url.endswith("/auth/v1/token"):
            assert "Authorization" not in (headers or {})
            self.n += 1
            return da.HttpResponse(200, json.dumps({"access_token": "acc-%d" % self.n, "expires_in": 3600,
                                                    "refresh_token": "rt-%d" % self.n, "user": {"id": "user-9"}}))
        if self.fail_next:
            status, self.fail_next = self.fail_next, None
            return da.HttpResponse(status, '{"statusCode":"%d","error":"x","message":"boom %d"}' % (status, status))
        if "/storage/v1/object/list/" in url:
            return da.HttpResponse(200, json.dumps(self.files))
        if "/storage/v1/object/authenticated/" in url:
            return da.HttpResponse(200, None, {}, b"\x00\x01EX5\xff\xfe binary")
        if url.endswith("/rest/v1/bots"):
            return da.HttpResponse(200, json.dumps([{"id": BOT, "name": "Main PC"}]))
        return da.HttpResponse(404, '{"message":"no route"}')


def test_storage_list_and_download_request_shapes():
    rec = Recorder()
    c = core.AppClient(URL, KEY, rec, refresh_token="rt-0")
    rows = c.list_files()
    tok, lst = rec.calls[0], rec.calls[1]
    assert tok["params"] == {"grant_type": "refresh_token"} and tok["body"] == {"refresh_token": "rt-0"}
    assert lst["method"] == "POST" and lst["url"] == URL + "/storage/v1/object/list/downloads"
    assert lst["headers"]["apikey"] == KEY and lst["headers"]["Authorization"] == "Bearer acc-1"
    assert lst["body"] == {"prefix": "", "limit": 200, "offset": 0, "sortBy": {"column": "name", "order": "asc"}}
    files = core.storage_files(rows)
    assert [(f["name"], f["kind"], f["size"]) for f in files] == [
        ("Dobby3 v304.ex5", "ea", 186368), ("Dobby3_usd280_0.03each.set", "preset", 9812),
        ("DobbyApp.exe", None, 11534336)]
    data = c.download_file("Dobby3 v304.ex5")
    dl = rec.calls[-1]
    assert dl["method"] == "GET" and dl["url"] == URL + "/storage/v1/object/authenticated/downloads/Dobby3%20v304.ex5"
    assert dl["headers"]["Authorization"] == "Bearer acc-1" and dl["body"] is None
    assert data == b"\x00\x01EX5\xff\xfe binary"                                           # bytes, not decoded
    rec.fail_next = 401                                                                    # expired: refresh, retry
    assert c.download_file("Dobby3 v304.ex5") == data and rec.calls[-1]["headers"]["Authorization"] == "Bearer acc-2"
    rec.fail_next = 400
    with pytest.raises(da.ApiError):
        c.download_file("missing.ex5")
    rec.fail_next = 503
    with pytest.raises(da.NetworkError):
        c.list_files()


def test_list_bots_is_filtered_by_owner():
    rec = Recorder()
    c = core.AppClient(URL, KEY, rec, refresh_token="rt-0")
    assert c.list_bots() == [{"id": BOT, "name": "Main PC"}]
    q = rec.calls[-1]
    assert q["method"] == "GET" and q["url"] == URL + "/rest/v1/bots"
    assert q["params"]["owner"] == "eq.user-9" and "id,name" in q["params"]["select"]


# ---------------------------------------------------------------------------------------------------------------------
# EA install
# ---------------------------------------------------------------------------------------------------------------------
def test_install_targets_and_files(tmp_path):
    d = str(tmp_path / "mt5")
    os.makedirs(os.path.join(d, "MQL5", "Experts"))
    other = os.path.join(d, "MQL5", "Experts", "Mine.ex5")
    open(other, "wb").write(b"mine")
    assert core.install_target(d, "Dobby3_v304.ex5") == os.path.join(d, "MQL5", "Experts", "Dobby", "Dobby3_v304.ex5")
    assert core.install_target(d, "x/Dobby.SET") == os.path.join(d, "MQL5", "Presets", "Dobby.SET")
    assert core.install_target(d, "../../evil.ex5") == os.path.join(d, "MQL5", "Experts", "Dobby", "evil.ex5")
    for bad in ("DobbyApp.exe", "notes.txt", ".hidden.ex5", "a:b.ex5", "", None):
        assert core.install_target(d, bad) is None
    t = core.install_target(d, "Dobby3_v304.ex5")
    assert core.install_file(t, b"v1") == "installed" and open(t, "rb").read() == b"v1"   # folder created
    assert core.install_file(t, b"v1") == "same"
    assert core.install_file(t, b"v2") == "kept" and open(t, "rb").read() == b"v1"        # asked: no
    assert core.install_file(t, b"v2", overwrite=True) == "installed" and open(t, "rb").read() == b"v2"
    assert open(other, "rb").read() == b"mine"                                             # never touched
    assert sorted(os.listdir(os.path.join(d, "MQL5", "Experts", "Dobby"))) == ["Dobby3_v304.ex5"]
    assert core.fmt_size(186368) == "182 KB" and core.fmt_size(11534336) == "11.0 MB"


# ---------------------------------------------------------------------------------------------------------------------
# One agent per MT5: the EA-folder lock
# ---------------------------------------------------------------------------------------------------------------------
_CHILD = ("import sys; sys.path.insert(0, %r); import dobby_agent as da; "
          "l = da.CommonLock(sys.argv[1], program='child agent'); print(l.acquire(), flush=True); sys.stdin.read()")


def _child(common):
    p = subprocess.Popen([sys.executable, "-c", _CHILD % os.path.dirname(os.path.abspath(da.__file__)), common],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, universal_newlines=True)
    assert p.stdout.readline().strip() == "True"
    return p


def test_common_lock_basic(tmp_path):
    common = str(tmp_path / "Common" / "Files" / "Dobby")                                  # created if missing
    a = da.CommonLock(common, program="Dobby App 1.0.0")
    assert a.acquire() and a.stale is None
    body = a.read()
    assert body["pid"] == os.getpid() and body["program"] == "Dobby App 1.0.0" and body["started"]
    assert isinstance(body["started_unix"], int)
    b = da.CommonLock(common, program="dobby_agent.py run")
    assert not b.acquire() and b.holder["program"] == "Dobby App 1.0.0"                     # second agent refused
    assert "Dobby App 1.0.0" in da.lock_holder_text(b.holder) and "PID %d" % os.getpid() in da.lock_holder_text(
        b.holder)
    a.release()
    assert not os.path.exists(a.path) or not a.read()
    assert b.acquire() and b.stale is None                                                 # a clean release
    b.release()
    assert da.lock_holder_text(None) == "โปรแกรม Dobby อีกตัว"


def test_common_lock_other_process_and_stale_lock(tmp_path):
    common = str(tmp_path / "common")
    p = _child(common)
    try:
        mine = da.CommonLock(common, program="Dobby App")
        assert not mine.acquire() and mine.holder["pid"] == p.pid and mine.holder["program"] == "child agent"
    finally:
        p.kill()                                    # crash: no clean release, the body stays behind
        p.wait()
    assert da.CommonLock(common).read()["pid"] == p.pid
    assert mine.acquire()                           # the OS dropped the dead process's lock: stale, taken over
    assert mine.stale["pid"] == p.pid and mine.read()["pid"] == os.getpid()
    mine.release()


def test_common_lock_without_os_locking_uses_pid_and_start_time(tmp_path, monkeypatch):
    common = str(tmp_path / "common")
    os.makedirs(common)
    monkeypatch.setattr(da.CommonLock, "_os_lock", lambda self, fh: None)      # e.g. a network drive
    path = os.path.join(common, da.COMMON_LOCK_NAME)
    host = __import__("socket").gethostname()

    def body(**kw):
        b = {"pid": 0, "host": host, "program": "old agent", "started": "2026-11-07 10:00:00", "started_unix": 0}
        b.update(kw)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(b, f)

    dead = subprocess.Popen([sys.executable, "-c", "pass"])
    dead.wait()
    body(pid=dead.pid)
    lk = da.CommonLock(common)
    assert lk.acquire() and lk.stale["pid"] == dead.pid                       # dead pid: stale
    lk.release()
    live = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        created = da.process_started_at(live.pid) or time.time()
        body(pid=live.pid, started_unix=int(created) + 1)
        assert not da.CommonLock(common).acquire()                             # running agent: refused
        body(pid=live.pid, host="OTHER-PC", started_unix=int(created) + 1)
        assert not da.CommonLock(common).acquire()                             # another PC: assume running
        if os.name == "nt":
            body(pid=live.pid, started_unix=int(created) - 3600)                # the pid was reused later
            lk = da.CommonLock(common)
            assert lk.acquire() and lk.stale["pid"] == live.pid
            lk.release()
    finally:
        live.kill()
        live.wait()
    assert da.pid_alive(os.getpid()) and not da.pid_alive(dead.pid) and not da.pid_alive(-5)


def test_cli_run_refuses_while_the_app_holds_the_ea_folder(tmp_path):
    e = Env(tmp_path)
    app = da.CommonLock(e.common, program="Dobby App 1.0.0")
    assert app.acquire()
    try:
        code, out, _ = run(e, ["run", "--once"])
        assert code == da.EXIT_RUNNING and "Dobby App 1.0.0" in out.text and "PID" in out.text
        assert e.read(da.CONTROL_NAME) is None                                 # nothing written
    finally:
        app.release()
    code, out, _ = run(e, ["run", "--once"])
    assert code == 0 and b"id=W001" in e.read(da.CONTROL_NAME)
    assert not os.path.exists(os.path.join(e.common, da.COMMON_LOCK_NAME)) or not da.CommonLock(e.common).read()
    lock = da.CommonLock(e.common)                                             # released by run: free again
    assert lock.acquire()
    lock.release()


# ---------------------------------------------------------------------------------------------------------------------
# "Start with Windows" launcher
# ---------------------------------------------------------------------------------------------------------------------
def test_startup_launcher_create_and_remove(tmp_path):
    folder = str(tmp_path / "Startup")
    cmd = [r"C:\Users\เพื่อน\Downloads\DobbyApp.exe"]
    assert not core.launcher_exists(folder) and not core.remove_launcher(folder)
    path = core.create_launcher(folder, cmd)
    assert path == os.path.join(folder, core.LAUNCHER_NAME) and core.launcher_exists(folder)
    text = open(path, "rb").read().decode("utf-8")
    assert text.startswith("@echo off\r\n") and "chcp 65001" in text and core.LAUNCHER_MARK in text
    assert '"%s" --autostart' % cmd[0] in text
    assert core.launcher_up_to_date(folder, cmd) and not core.launcher_up_to_date(folder, [r"D:\moved\DobbyApp.exe"])
    other = os.path.join(folder, "someone-else.cmd")
    open(other, "w").write("@echo off\r\n")
    assert core.remove_launcher(folder) and not core.launcher_exists(folder)
    assert os.listdir(folder) == ["someone-else.cmd"]                          # nothing else touched
    with open(core.launcher_path(folder), "w") as f:                           # a foreign file with our name
        f.write("@echo off\r\nrem not ours\r\n")
    assert not core.remove_launcher(folder) and core.launcher_exists(folder)
    sd = core.startup_dir({"APPDATA": r"C:\Users\x\AppData\Roaming"})
    assert sd.endswith(os.path.join("Microsoft", "Windows", "Start Menu", "Programs", "Startup"))
    assert core.app_command()[-1].endswith("dobby_app.py")


# ---------------------------------------------------------------------------------------------------------------------
# The app's agent, registration and linking
# ---------------------------------------------------------------------------------------------------------------------
def _app_agent(e, stop):
    cfg = da.load_config(e.cfg_path)
    tg = da.Telegram(e.tg_transport, cfg["telegram"]["token"], cfg["telegram"]["chat_id"], clock=e.clock)
    return core.AppAgent(e.agent_dir, e.common, e.client(), tg, stop, clock=e.clock, sleep=lambda s: None,
                         local_now=e.clock.local)


def test_app_agent_writes_nothing_after_stop(tmp_path):
    e = Env(tmp_path)
    stop = threading.Event()
    stop.set()
    a = _app_agent(e, stop)
    a.cycle()
    assert e.read(da.CONTROL_NAME) is None and a.web_version == 1               # read the web, wrote nothing
    stop.clear()
    a.cycle()
    assert b"id=W001" in e.read(da.CONTROL_NAME)
    snap = a.snapshot()
    assert snap["applied_version"] == 1 and snap["web_version"] == 1 and snap["last_ok_at"] == e.clock()
    before = e.read(da.CONTROL_NAME)
    e.fake.web_set(dict(e.fake.control["desired"], control=dict(e.fake.control["desired"]["control"], lots=0.02)))
    e.tick()
    stop.set()                                                                  # Stop pressed
    a.cycle()
    assert e.read(da.CONTROL_NAME) == before and a.state["applied_version"] == 1


def test_register_new_bot_and_link_existing(tmp_path):
    e = Env(tmp_path)
    data = e.agent_dir
    core.update_app_config(data, lambda c: c.update(bot_id="", bot_name=""))

    def sleep(s):
        e.clock.advance(s)
        e.write_status()
    cfg = core.load_app_config(data)
    bot_id, seed = core.register_new_bot(e.client(), data, e.common, "คอมที่บ้าน", cfg, clock=e.clock, sleep=sleep)
    assert bot_id == BOT and e.fake.rpc_calls[0]["p_name"] == "คอมที่บ้าน"
    assert e.fake.rpc_calls[0]["p_desired"] == seed["desired"] and seed["desired"]["live"] is True
    cfg = core.load_app_config(data)
    assert cfg["bot_id"] == BOT and cfg["bot_name"] == "คอมที่บ้าน" and cfg["app"]["pending_bot_name"] == ""
    st = da.load_state(core.state_path(data))
    assert st["applied_version"] == 1 and st["applied_live"] is True and st["offset"]["confirmed"] is True
    os.remove(e.path(da.STATUS_NAME))                                           # no EA: cannot seed
    with pytest.raises(core.NoEaStatus):
        core.register_new_bot(e.client(), data, e.common, "x", cfg, clock=e.clock, sleep=sleep)
    with open(e.path(da.CONTROL_NAME), "w") as f:
        f.write("mode=pause\r\nid=C001\r\n")
    core.link_existing_bot(data, e.common, {"id": "bot-2", "name": "โน้ตบุ๊ก"}, clock=e.clock)
    cfg = core.load_app_config(data)
    st = da.load_state(core.state_path(data))
    assert cfg["bot_id"] == "bot-2" and cfg["bot_name"] == "โน้ตบุ๊ก"
    assert st["applied_version"] == 0 and st["applied_live"] is None            # the web state applies at Start
    assert st["control"]["adopted_mtime"] == os.stat(e.path(da.CONTROL_NAME)).st_mtime   # local file not adopted
    core.unlink_pc(data)
    cfg = core.load_app_config(data)
    assert cfg["bot_id"] == "" and not os.path.exists(core.state_path(data)) and cfg["refresh_token"] == "rt-0"
    c = e.client()
    core.sign_out(data, c)
    assert core.load_app_config(data)["refresh_token"] == "" and c.refresh_token == ""


def test_demo_server_end_to_end_without_network():
    srv = core.DemoServer()
    c = core.AppClient(core.DEFAULT_URL, core.DEFAULT_KEY, srv)
    with pytest.raises(da.AuthError):
        core.sign_in(c, "a@b.c", "wrong")
    assert core.sign_in(c, "friend@example.com", "pw") is True
    assert core.sign_in(c, "pending@example.com", "pw") is False
    assert core.sign_in(c, "friend@example.com", "pw") is True
    names = [f["name"] for f in core.storage_files(c.list_files())]
    assert "Dobby3_v304.ex5" in names and c.download_file("Dobby3_v304.ex5").startswith(b"DEMO FILE")
    assert len(c.list_bots()) == 2
    assert c.rpc("register_bot", {"p_name": "x", "p_desired": {"live": False}})


# ---------------------------------------------------------------------------------------------------------------------
# Checklist, status cards, Thai explanations
# ---------------------------------------------------------------------------------------------------------------------
def _status(now, **over):
    with open(os.path.join(os.path.dirname(__file__), "fixtures", "dobby2_status.json"), encoding="utf-8") as f:
        st = json.load(f)
    st["heartbeat_gmt_unix"] = int(now) - 3
    for k, v in over.items():
        st[k] = v
    return st


def test_checklist_states():
    now = 1794002099.0
    cfg = {"refresh_token": "rt", "email": "me@x.y", "bot_id": BOT, "bot_name": "Main PC", "limits": {}}
    st = _status(now)
    snap = {"web_version": 4, "applied_version": 4, "rejected": [], "last_error": ""}
    items = core.build_checklist(cfg, st, snap, now, running=True)
    assert [i["key"] for i in items] == ["signin", "linked", "ea", "algo", "live", "web"]
    assert all(i["state"] == "ok" for i in items), items
    assert core.build_checklist(cfg, st, snap, now, running=False)[5]["state"] == "idle"
    snap2 = dict(snap, rejected=["lots_clamped"])
    assert core.build_checklist(cfg, st, snap2, now, True)[5]["state"] == "warn"
    snap3 = dict(snap, web_version=5)
    assert core.build_checklist(cfg, st, snap3, now, True)[5]["state"] == "warn"
    no_algo = _status(now, account=dict(st["account"], trade_permitted=False))
    assert core.build_checklist(cfg, no_algo, snap, now, True)[3]["state"] == "bad"
    locked = _status(now, flags={"live_locked": True})
    assert core.build_checklist(cfg, locked, snap, now, True)[4]["state"] == "bad"
    remote = _status(now, flags={"live_locked": True}, remote={"live_enabled": True})
    it = core.build_checklist(cfg, remote, snap, now, True)[4]
    assert it["state"] == "warn" and "ให้เว็บเปิดเทรดจริงได้" in it["detail"]
    paused = _status(now, control=dict(st["control"], mode="pause"))
    assert core.build_checklist(cfg, paused, snap, now, True)[4]["state"] == "warn"
    old = _status(now)
    old["heartbeat_gmt_unix"] = int(now) - 600
    items = core.build_checklist(cfg, old, snap, now, True)
    assert items[2]["state"] == "bad" and items[3]["state"] == "idle" and "10 นาที" in items[2]["detail"]
    items = core.build_checklist(dict(cfg, refresh_token="", bot_id="", app={"pending_bot_name": "PC"}), None,
                                 None, now, False)
    assert [i["state"] for i in items[:3]] == ["bad", "warn", "bad"]
    bad_login = dict(snap, last_error="login: Invalid Refresh Token")
    assert core.build_checklist(cfg, st, bad_login, now, True)[0]["state"] == "bad"


def test_status_summary():
    now = 1794002099.0
    s = core.summarize_status(_status(now, virtual={"start": 280.0, "balance": 312.4, "day_start": 300.0,
                                                    "day_pnl": -12.0, "day_cap_hit": False},
                                      positions=[{"open": False}, {"open": True, "side": "BUY", "lots": 0.03,
                                                                   "open_price": 2512.3, "sl": 2506.3,
                                                                   "tp": 2521.3, "profit": 4.2}]), now)
    assert s["balance"] == 500.0 and s["equity"] == 503.25 and s["currency"] == "USD"
    assert s["cap_amount"] == 30.0 and abs(s["cap_used"] - 0.4) < 1e-9 and not s["cap_hit"]
    assert len(s["positions"]) == 1 and s["positions"][0]["side"] == "BUY" and s["age"] == 3
    assert core.summarize_status(None, now)["has_status"] is False
    assert core.money(1234.5) == "1,234.50" and core.money(-8.6, True) == "-8.60" and core.money(None) == "-"
    assert core.ago_th(5) == "5 วินาทีที่แล้ว" and core.ago_th(130) == "2 นาทีที่แล้ว"


def test_thai_explanations():
    for code in ("live_not_allowed_locally", "params_not_allowed_locally", "remote_control_disabled", "lots_clamped",
                 "params_lots_over_limit", "params_cap_over_limit", "params_unknown_key", "params_out_of_bounds",
                 "offset_unknown", "bad_blackout"):
        title, how = core.explain_reject(code)
        assert title and how and code not in title
    assert "something_new" in core.explain_reject("something_new")[0]
    assert core.explain_error("network: ConnectionError")[0] == "เชื่อมต่อเว็บไม่ได้"
    assert core.explain_error("login: Invalid Refresh Token")[0] == "เข้าสู่ระบบไม่ได้"
    assert "ถูกลบ" in core.explain_error("server: HTTP 404: no bot_control row for this bot")[0]
    assert core.friendly_log("wrote dobby2_control.txt") == "เขียนไฟล์ควบคุมให้ EA แล้ว"
    assert core.friendly_log("journal: 3 new row(s)") == "ส่งประวัติการเทรดขึ้นเว็บ 3 รายการ"
    assert core.friendly_log("decision: v7 applied | live=on") == "ใช้คำสั่งจากเว็บ v7 แล้ว"
    assert core.friendly_log("something else") == "something else"
    assert core.auth_problem(da.AuthError("Invalid login credentials")) == "wrong_password"
    assert core.auth_problem(da.AuthError("Email not confirmed")) == "email_not_confirmed"


# ---------------------------------------------------------------------------------------------------------------------
# GUI helpers that need no window, icon/PNG writer, source rules
# ---------------------------------------------------------------------------------------------------------------------
def test_thai_safe_wrapping():
    import dobby_app as app
    text = ("ใช้ได้กับ EA v3.04 เท่านั้น และต้องตั้ง InpRemoteParams = true ใน EA ด้วย พรีเซ็ตที่เกินเพดานด้านล่างจะ"
            "ถูกปฏิเสธทั้งชุด " * 3) + "บัญชีที่จะให้" * 30
    lines = app.wrap_text(text, lambda s: 7 * len(s), 2000).split("\n")
    assert all(len(ln.encode("utf-8")) <= app.MAX_RUN_BYTES for ln in lines)
    assert all(ln and ln[0] not in app.THAI_MARKS for ln in lines)
    assert "".join(lines).replace(" ", "") == text.replace(" ", "").rstrip()
    narrow = app.wrap_text("abc def ghi", lambda s: 10 * len(s), 75)
    assert narrow == "abc def\nghi"
    assert app.wrap_text("a\nb", None) == "a\nb"


def test_png_and_icon_writer(tmp_path):
    png = core.png_bytes(2, 1, bytes([255, 0, 0, 255, 0, 0, 255, 128]))
    assert png.startswith(b"\x89PNG\r\n\x1a\n") and b"IHDR" in png and png.endswith(b"IEND\xaeB`\x82")
    ico = core.ico_bytes(sizes=(16, 32))
    assert ico[:6] == b"\x00\x00\x01\x00\x02\x00" and ico[6] == 16 and ico[22] == 32
    assert core.indicator_png(18, "check", True).startswith(b"\x89PNG")
    p = core.write_icon(str(tmp_path / "dobby.ico"))
    assert open(p, "rb").read(4) == b"\x00\x00\x01\x00"


def test_app_never_talks_to_mt5_and_starts_it_in_one_place_only():
    """No MetaTrader5 package; the only process start is core.real_launch (the confirmed "open MT5 with Dobby")."""
    import ast
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for name in ("dobby_app.py", "dobby_app_core.py", "dobby_app_ui.py", "dobby_app_gfx.py"):
        src = open(os.path.join(here, name), encoding="utf-8").read()
        assert "MetaTrader5" not in src.replace("never imports the MT5 Python package", "")
        assert "os.system" not in src and "os.popen" not in src
        if name != "dobby_app_core.py":            # core: os.startfile only opens a folder / the log in Explorer
            assert "startfile" not in src
        tree = ast.parse(src)
        users = set()
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.ClassDef)):
                for node in ast.walk(fn):
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module]
                        if "subprocess" in mods:
                            users.add(fn.name)
        top = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom)) and "subprocess" in (
            [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module])]
        assert not top, "%s imports subprocess at module level" % name
        assert users == ({"real_launch"} if name == "dobby_app_core.py" else set()), (name, users)
        if name != "dobby_app_core.py":
            assert "Popen" not in src and "real_launch" not in src     # the UI only goes through ctx.launch
        if name in ("dobby_app_ui.py", "dobby_app_gfx.py"):
            assert "terminal64" not in src.lower()
    core_src = open(os.path.join(here, "dobby_app_core.py"), encoding="utf-8").read()
    assert core_src.count("Popen(") == 1 and core_src.count('TERMINAL_EXE = "terminal64.exe"') == 1


# ---------------------------------------------------------------------------------------------------------------------
# SPEC 9 in the app: the AppAgent gets the batch features, demo feed, main-screen sentence, activity feed
# ---------------------------------------------------------------------------------------------------------------------
def test_app_agent_writes_auto_blackouts_and_snapshots_them(tmp_path):
    from conftest import FakeNewsTransport
    from test_batch import FF_WEEK, auto_desired
    e = Env(tmp_path, desired=auto_desired(), config_extra={"server_utc_offset_min": 120})
    cfg = da.load_config(e.cfg_path)
    tg = da.Telegram(e.tg_transport, cfg["telegram"]["token"], cfg["telegram"]["chat_id"], clock=e.clock)
    stop = threading.Event()
    a = core.AppAgent(e.agent_dir, e.common, e.client(), tg, stop, clock=e.clock, sleep=lambda s: None,
                      local_now=e.clock.local, news_transport=FakeNewsTransport(FF_WEEK))
    a.cycle()
    snap = a.snapshot()
    assert [w["reason"] for w in snap["auto_blackouts"]][0] == "CPI m/m" and snap["news_error"] is None
    assert b"blackout=2026.11.10 15:00-16:30\r\n" in e.read(da.CONTROL_NAME)
    assert core.next_blackout_th(snap["auto_blackouts"], e.clock()) == \
        "งดเข้าไม้อัตโนมัติครั้งถัดไป พรุ่งนี้ 20:00–21:30 (CPI m/m)"


def test_demo_server_serves_a_synthetic_forexfactory_week():
    now = time.time()
    srv = core.DemoServer()
    r = srv.request("GET", da.NEWS_URL, headers={"User-Agent": da.NEWS_USER_AGENT})
    ev = da.normalize_ff_events(r.json())
    usd = da.matching_news(ev, da.AUTO_NEWS_DEFAULTS)
    assert srv.news_calls == 1 and [e["title"] for e in usd] == ["CPI m/m", "Unemployment Claims"]
    assert all(da.parse_utc(e["ts_utc"]) > now for e in usd)


def test_next_blackout_sentence_in_thai_time():
    now = da.naive_to_epoch(da.parse_server_dt("2026.11.13 10:00:00"))          # Friday 17:00 Thai
    fri = [{"from_utc": "2026-11-13T14:00:00Z", "to_utc": "2026-11-13T17:00:00Z", "reason": "ตารางเวลา"}]
    assert core.next_blackout_th(fri, now) == "งดเข้าไม้อัตโนมัติครั้งถัดไป วันนี้ 21:00–24:00 (ตารางเวลา)"
    assert core.next_blackout_th(fri, now + 5 * 3600) == "ตอนนี้งดเข้าไม้อัตโนมัติถึง เที่ยงคืน (ตารางเวลา)"
    assert core.next_blackout_th(fri, now + 8 * 3600) == ""
    hol = [{"from_utc": "2026-11-26T05:00:00Z", "to_utc": "2026-11-27T05:00:00Z", "reason": "Thanksgiving Day"}]
    assert core.next_blackout_th(hol, now) == \
        "งดเข้าไม้อัตโนมัติครั้งถัดไป วันพฤหัสบดี 12:00–วันศุกร์ 12:00 (Thanksgiving Day)"
    assert core.next_blackout_th(None, now) == "" and core.next_blackout_th([{"x": 1}], now) == ""


def test_activity_feed_lines_for_the_batch():
    t, text = core.app_activity("auto blackouts: 3 window(s) in the next 7 days, next 2026-11-10T13:00:00Z - "
                                "2026-11-10T14:30:00Z (CPI m/m)")
    assert t == "info" and text.startswith("งดเข้าไม้อัตโนมัติ 3 ช่วงใน 7 วัน ครั้งถัดไป") and text.endswith("(CPI m/m)")
    assert core.app_activity("cash flow suggested on the website: +200.00 (balance 700.00 not explained by Dobby "
                             "trades)") == ("info", "พบเงินเข้า-ออกบัญชี +200.00 ที่ไม่ใช่ผลเทรดของ Dobby: ยืนยันได้บนเว็บ")
    assert core.friendly_log("news calendar fetched: 42 event(s) this week") == "โหลดปฏิทินข่าวสัปดาห์นี้แล้ว (42 ข่าว)"
    assert core.app_activity("bars: 4 bar(s) uploaded") is None                  # not worth the main screen
