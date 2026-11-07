# -*- coding: utf-8 -*-
"""Dobby App - everything that is not GUI (importable and testable without a window).

  * app data folder (%APPDATA%\\DobbyApp) and its config (same agent_config.json format as the CLI agent)
  * MT5 detection (%APPDATA%\\MetaQuotes\\Terminal\\<id>\\origin.txt) and the EA common folder
  * EA / preset install from the private Storage bucket `downloads` into <data>\\MQL5\\Experts\\Dobby and \\Presets
  * "start with Windows" launcher in the user's Startup folder
  * AppClient: one shared, thread-safe Supabase client (+ Storage, bots list)
  * AppAgent / AgentRunner: the CLI agent loop (dobby_agent.Agent) in a background thread, behind the EA-folder lock
  * checklist / status-card / Thai explanation helpers
  * demo backend (in-memory Supabase, fake MT5 folders, fake EA status) for --demo and --selftest
  * PNG / ICO writer (stdlib) for the app icon and the self-test screenshots

It never imports the MT5 Python package and never starts MT5: starting MT5 would start the user's live EA.
"""
import json
import logging
import math
import os
import random
import re
import struct
import sys
import threading
import time
import uuid
import zlib

try:
    from urllib.parse import quote
except ImportError:  # pragma: no cover - python 2
    from urllib import quote

import dobby_agent as da

APP_NAME = "Dobby App"
APP_VERSION = "1.0.0"
DEFAULT_URL = "https://rpzuzhefviydjmeggvvz.supabase.co"
DEFAULT_KEY = "sb_publishable_208tCs0INvDHYohhl5_DGQ_ezVQkJst"   # publishable key: public by design (RLS protects data)
WEB_URL = "https://tataprin.github.io/dobby-web/"
BUCKET = "downloads"
APP_DIR_NAME = "DobbyApp"
APP_LOCK_NAME = "app.lock"
LAUNCHER_NAME = "DobbyApp-autostart.cmd"
LAUNCHER_MARK = "Dobby App autostart"
EA_ONLINE_S = da.OFFLINE_AFTER_S          # heartbeat younger than this = the EA is running
EA_CHART_NAME = "Dobby3_v304"

LOG = da.LOG
APPLOG = logging.getLogger("dobby_agent.app")
CONFIG_LOCK = threading.RLock()            # the GUI and the agent thread both read-modify-write agent_config.json


# ---------------------------------------------------------------------------------------------------------------------
# App data folder + config
# ---------------------------------------------------------------------------------------------------------------------
def app_data_dir(environ=None):
    """%APPDATA%\\DobbyApp - config, state and logs of the app. Never next to the exe (Downloads, Program Files...)."""
    environ = os.environ if environ is None else environ
    base = environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(base, APP_DIR_NAME)


def config_path(data_dir):
    return os.path.join(data_dir, da.CONFIG_NAME)


def state_path(data_dir):
    return os.path.join(data_dir, da.STATE_NAME)


def default_app_section():
    return {"wizard_done": False, "auto_start": False, "start_with_windows": False, "mt5_data_dir": "",
            "pending_bot_name": ""}


def _fill_defaults(cfg):
    if not cfg.get("supabase_url"):
        cfg["supabase_url"] = DEFAULT_URL
    if not cfg.get("anon_key"):
        cfg["anon_key"] = DEFAULT_KEY
    app = default_app_section()
    if isinstance(cfg.get("app"), dict):
        app.update(cfg["app"])
    cfg["app"] = app
    return cfg


def load_app_config(data_dir):
    """agent_config.json of the app (the CLI format + an `app` section), with the website defaults filled in."""
    with CONFIG_LOCK:
        cfg = da.load_config(config_path(data_dir))
    return _fill_defaults(cfg)


def update_app_config(data_dir, mutate):
    """Read-modify-write under the config lock (the agent thread saves rotated refresh tokens meanwhile)."""
    with CONFIG_LOCK:
        os.makedirs(data_dir, exist_ok=True)

        def mut(c):
            _fill_defaults(c)
            mutate(c)
        return da.update_config(config_path(data_dir), mut)


def config_complete(cfg):
    """Everything Start needs: a login and a bot (or a bot to create when the EA first runs)."""
    return bool(cfg.get("supabase_url") and cfg.get("anon_key") and cfg.get("refresh_token") and
                (cfg.get("bot_id") or (cfg.get("app") or {}).get("pending_bot_name")))


# ---------------------------------------------------------------------------------------------------------------------
# MT5 folders (read only)
# ---------------------------------------------------------------------------------------------------------------------
_TERMINAL_ID = re.compile(r"^[0-9A-Fa-f]{32}$")
_NOT_SERVERS = {"default", "signals", "custom", "symbols", "history", "trades", "news"}


def terminals_root(appdata):
    return os.path.join(appdata, "MetaQuotes", "Terminal")


def default_common_dir(appdata):
    return os.path.join(terminals_root(appdata), "Common", "Files", "Dobby")


def read_origin(path):
    """origin.txt = the MT5 install folder (MT5 writes it in UTF-16LE with a BOM). '' when missing."""
    try:
        with open(path, "rb") as f:
            data = f.read(4096)
    except OSError:
        return ""
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = data.decode("utf-16", "replace")
    elif len(data) >= 2 and data[1:2] == b"\x00":
        text = data.decode("utf-16-le", "replace")
    else:
        text = data.decode("utf-8-sig", "replace")
    return text.replace("\x00", "").strip()


def terminal_servers(data_dir):
    """Broker servers this MT5 has used (sub folders of <data>\\bases), e.g. ['TMGM-Live']."""
    try:
        names = sorted(os.listdir(os.path.join(data_dir, "bases")))
    except OSError:
        return []
    return [n for n in names if n.lower() not in _NOT_SERVERS and os.path.isdir(os.path.join(data_dir, "bases", n))]


def ea_files_in(data_dir):
    """Dobby .ex5 files already in <data>\\MQL5\\Experts (top level and the Dobby sub folder)."""
    out = []
    for sub in ("", "Dobby"):
        folder = os.path.join(data_dir, "MQL5", "Experts", sub) if sub else os.path.join(data_dir, "MQL5", "Experts")
        try:
            names = sorted(os.listdir(folder))
        except OSError:
            continue
        for n in names:
            if n.lower().endswith(".ex5") and n.lower().startswith("dobby"):
                out.append((sub + "\\" + n) if sub else n)
    return out


def normalize_data_dir(path):
    """A folder picked by hand: the data folder itself, its MQL5 folder or a portable install folder."""
    path = os.path.abspath(path or "")
    if os.path.basename(path).lower() == "mql5":
        path = os.path.dirname(path)
    return path


def is_data_dir(path):
    return bool(path) and os.path.isdir(os.path.join(path, "MQL5"))


def describe_terminal(data_dir, terminal_id=""):
    origin = read_origin(os.path.join(data_dir, "origin.txt"))
    install = origin or data_dir
    name = os.path.basename(install.rstrip("\\/")) or "MetaTrader 5"
    last = 0.0
    for p in (os.path.join(data_dir, "logs"), os.path.join(data_dir, "MQL5", "Logs"), data_dir):
        try:
            last = max(last, os.path.getmtime(p))
        except OSError:
            pass
    return {"id": terminal_id, "data_dir": data_dir, "install_dir": origin, "name": name,
            "servers": terminal_servers(data_dir), "ea_files": ea_files_in(data_dir),
            "has_mql5": os.path.isdir(os.path.join(data_dir, "MQL5")), "last_used": last}


def detect_terminals(appdata):
    """MT5 data folders under %APPDATA%\\MetaQuotes\\Terminal\\<32 hex id>, most recently used first."""
    root = terminals_root(appdata)
    try:
        names = os.listdir(root)
    except OSError:
        return []
    out = []
    for n in names:
        p = os.path.join(root, n)
        if not _TERMINAL_ID.match(n) or not os.path.isdir(p):
            continue
        if not os.path.isdir(os.path.join(p, "MQL5")) and not os.path.isfile(os.path.join(p, "origin.txt")):
            continue
        out.append(describe_terminal(p, n))
    out.sort(key=lambda t: (-t["last_used"], t["name"].lower()))
    return out


def common_dir_info(common):
    """What the wizard says about the EA common folder."""
    status = da.read_status_file(os.path.join(common, da.STATUS_NAME), attempts=1)
    return {"path": common, "exists": os.path.isdir(common), "status": status,
            "age": heartbeat_age(status, time.time())}


# ---------------------------------------------------------------------------------------------------------------------
# EA / preset install (only the chosen files, only into their own folders)
# ---------------------------------------------------------------------------------------------------------------------
INSTALL_DIRS = {".ex5": ("MQL5", "Experts", "Dobby"), ".set": ("MQL5", "Presets")}
_BAD_NAME = re.compile(r'[<>:"|?*\x00-\x1f]')


def safe_file_name(name):
    base = str(name or "").replace("\\", "/").split("/")[-1].strip()
    if not base or base.startswith(".") or _BAD_NAME.search(base):
        return None
    return base


def install_kind(name):
    base = safe_file_name(name)
    ext = os.path.splitext(base or "")[1].lower()
    return {".ex5": "ea", ".set": "preset"}.get(ext)


def install_target(data_dir, name):
    """<data>\\MQL5\\Experts\\Dobby\\x.ex5 or <data>\\MQL5\\Presets\\x.set; None for any other file."""
    base = safe_file_name(name)
    sub = INSTALL_DIRS.get(os.path.splitext(base or "")[1].lower())
    if not base or not sub or not data_dir:
        return None
    return os.path.join(data_dir, *(sub + (base,)))


def storage_files(rows):
    """Storage list rows -> [{name, size, updated_at, kind}] (folders and placeholders skipped)."""
    out = []
    for r in rows or []:
        if not isinstance(r, dict) or not r.get("name") or r.get("id") is None:
            continue
        if r["name"].startswith("."):
            continue
        meta = r.get("metadata") if isinstance(r.get("metadata"), dict) else {}
        out.append({"name": r["name"], "size": da.to_num(meta.get("size")), "updated_at": r.get("updated_at"),
                    "kind": install_kind(r["name"])})
    return out


def file_state(target, data):
    """'new' | 'same' (identical file already there) | 'different' (a different file with this name exists)."""
    try:
        with open(target, "rb") as f:
            return "same" if f.read() == data else "different"
    except FileNotFoundError:
        return "new"
    except OSError:
        return "different"


def install_file(target, data, overwrite=False):
    """'installed' | 'same' | 'kept' (exists, not overwritten). Creates the folder; touches nothing else."""
    st = file_state(target, data)
    if st == "same":
        return "same"
    if st == "different" and not overwrite:
        return "kept"
    os.makedirs(os.path.dirname(target), exist_ok=True)
    da.atomic_write_bytes(target, data)
    return "installed"


def fmt_size(n):
    if n is None:
        return ""
    if n >= 1024 * 1024:
        return "%.1f MB" % (n / 1048576.0)
    if n >= 1024:
        return "%.0f KB" % (n / 1024.0)
    return "%d B" % n


# ---------------------------------------------------------------------------------------------------------------------
# "Start with Windows": one small .cmd in the user's Startup folder, nothing else
# ---------------------------------------------------------------------------------------------------------------------
def startup_dir(environ=None):
    environ = os.environ if environ is None else environ
    base = environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(base, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")


def app_command():
    """How to start this app again: the exe when frozen, else pythonw + this script."""
    if getattr(sys, "frozen", False):
        return [sys.executable]
    exe = sys.executable
    pyw = os.path.join(os.path.dirname(exe), "pythonw.exe")
    return [pyw if os.path.isfile(pyw) else exe, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                               "dobby_app.py")]


def launcher_path(folder):
    return os.path.join(folder, LAUNCHER_NAME)


def launcher_text(cmd):
    quoted = " ".join('"%s"' % c for c in cmd)
    return ("@echo off\r\n"
            "rem %s - created by Dobby App. Untick \"start with Windows\" in the app (or delete this file) to stop.\r\n"
            "chcp 65001 >nul\r\n"
            "start \"\" %s --autostart\r\n" % (LAUNCHER_MARK, quoted))


def create_launcher(folder, cmd):
    os.makedirs(folder, exist_ok=True)
    path = launcher_path(folder)
    da.atomic_write_bytes(path, launcher_text(cmd).encode("utf-8"))
    return path


def launcher_exists(folder):
    return os.path.isfile(launcher_path(folder))


def launcher_up_to_date(folder, cmd):
    try:
        with open(launcher_path(folder), "rb") as f:
            return f.read().decode("utf-8", "replace") == launcher_text(cmd)
    except OSError:
        return False


def remove_launcher(folder):
    """Remove our launcher (only a file that carries our mark). True when it was removed."""
    path = launcher_path(folder)
    try:
        with open(path, "rb") as f:
            if LAUNCHER_MARK.encode() not in f.read(400):
                return False
        os.remove(path)
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------------------------------------------------
# Supabase: one shared client for the GUI and the agent thread
# ---------------------------------------------------------------------------------------------------------------------
class AppClient(da.SupabaseClient):
    """Calls are serialised: Supabase rotates refresh tokens, and the same token used twice would end the session.
    Adds Storage (list / download of the `downloads` bucket) and the user's bots list."""

    def __init__(self, *a, **k):
        self._lock = threading.RLock()
        da.SupabaseClient.__init__(self, *a, **k)

    def _token_request(self, grant, body):
        with self._lock:
            return da.SupabaseClient._token_request(self, grant, body)

    def ensure_token(self):
        with self._lock:
            return da.SupabaseClient.ensure_token(self)

    def refresh(self):
        with self._lock:
            return da.SupabaseClient.refresh(self)

    def request(self, method, path, params=None, body=None, prefer=None, _retry=True):
        with self._lock:
            return da.SupabaseClient.request(self, method, path, params, body, prefer, _retry)

    # -- Storage REST (user's access token as Bearer, publishable key as apikey)
    def storage(self, method, path, body=None, _retry=True):
        with self._lock:
            self.ensure_token()
            headers = {"apikey": self.key, "Authorization": "Bearer " + self.access_token}
            if body is not None:
                headers["Content-Type"] = "application/json"
            r = self.transport.request(method, self.url + "/storage/v1/" + path, headers=headers, json_body=body,
                                       timeout=120)
            if r.status == 401 and _retry:
                self.access_token = None
                self.refresh()
                return self.storage(method, path, body, _retry=False)
            if r.status >= 500 or r.status in (408, 429):
                raise da.NetworkError("storage HTTP %d" % r.status)
            if r.status >= 400:
                msg, code = da._error_message(r)
                raise da.ApiError(r.status, msg, code)
            return r

    def list_files(self, bucket=BUCKET, prefix=""):
        r = self.storage("POST", "object/list/" + bucket,
                         {"prefix": prefix, "limit": 200, "offset": 0, "sortBy": {"column": "name", "order": "asc"}})
        data = r.json()
        return data if isinstance(data, list) else []

    def download_file(self, name, bucket=BUCKET):
        return self.storage("GET", "object/authenticated/%s/%s" % (bucket, quote(name, safe="/"))).content

    def is_approved(self):
        return self.rpc("is_approved", {}) is True

    def list_bots(self):
        """The signed-in user's own bots (an admin can read every bot: always filter by owner)."""
        self.ensure_token()
        params = {"select": "id,name,last_seen,ea_version,symbol,created_at", "order": "created_at.asc"}
        if self.user_id:
            params["owner"] = "eq." + self.user_id
        rows = self.select("bots", params)
        return rows if isinstance(rows, list) else []


def auth_problem(err):
    """AuthError text -> 'wrong_password' | 'email_not_confirmed' | 'session' | 'other'."""
    m = str(err).lower()
    if "invalid login credentials" in m or "invalid_credentials" in m or "invalid email or password" in m:
        return "wrong_password"
    if "not confirmed" in m:
        return "email_not_confirmed"
    if "refresh token" in m or "not logged in" in m:
        return "session"
    return "other"


AUTH_TH = {
    "wrong_password": "อีเมลหรือรหัสผ่านไม่ถูกต้อง ลองพิมพ์ใหม่ (ระวังแป้นภาษาไทย/อังกฤษ และตัวพิมพ์ใหญ่)",
    "email_not_confirmed": "ยังไม่ได้ยืนยันอีเมล เปิดอีเมลจาก Dobby แล้วกดลิงก์ยืนยันก่อน แล้วลองใหม่",
    "session": "การเข้าสู่ระบบหมดอายุ เข้าสู่ระบบใหม่อีกครั้ง",
    "other": "เข้าสู่ระบบไม่สำเร็จ",
}


def sign_in(client, email, password):
    """Password sign-in; only the refresh token is kept (saved by client.on_refresh_token). Returns approved."""
    client.sign_in_password(email, password)
    try:
        return client.is_approved()
    except da.ApiError:
        return False


# ---------------------------------------------------------------------------------------------------------------------
# Link this PC to a bot
# ---------------------------------------------------------------------------------------------------------------------
class NoEaStatus(Exception):
    """The EA status file is missing: the bot cannot be seeded from the EA's state yet."""


def register_new_bot(client, data_dir, common, name, cfg, clock=time.time, sleep=time.sleep, wait_s=6):
    """Same as `dobby_agent.py register`: desired seeded from the EA's files, RPC register_bot, fresh state."""
    seed = da.seed_from_ea(common, cfg, clock=clock, sleep=sleep, wait_s=wait_s)
    if seed is None:
        raise NoEaStatus()
    bot_id = client.rpc("register_bot", {"p_name": name, "p_desired": seed["desired"]})
    if not isinstance(bot_id, str) or not bot_id:
        raise da.ApiError(500, "no bot id in the answer")

    def mut(c):
        c["bot_id"], c["bot_name"] = bot_id, name
        c["app"]["pending_bot_name"] = ""
    update_app_config(data_dir, mut)
    st = da.first_state(common, seed["now"], applied_live=seed["desired"]["live"], status=seed["status"],
                        confirmed=seed["confirmed"])
    da.write_json_atomic(state_path(data_dir), st)
    APPLOG.info("bot \"%s\" created on the website (live=%s)", name, "on" if seed["desired"]["live"] else "off")
    return bot_id, seed


def link_existing_bot(data_dir, common, bot, clock=time.time):
    """Use an existing bot: its web state is applied to this MT5 at the first cycle after Start."""
    def mut(c):
        c["bot_id"], c["bot_name"] = bot["id"], bot.get("name") or "Dobby"
        c["app"]["pending_bot_name"] = ""
    update_app_config(data_dir, mut)
    da.write_json_atomic(state_path(data_dir), da.first_state(common, clock(), applied_version=0))
    APPLOG.info("this PC is now linked to the bot \"%s\"", bot.get("name"))


def set_pending_bot(data_dir, name):
    """The EA is not running yet: the bot is created when Start finds the EA (seeded from its state)."""
    def mut(c):
        c["bot_id"], c["bot_name"] = "", name
        c["app"]["pending_bot_name"] = name
    update_app_config(data_dir, mut)


def unlink_pc(data_dir):
    def mut(c):
        c["bot_id"], c["bot_name"] = "", ""
        c["app"]["pending_bot_name"] = ""
    update_app_config(data_dir, mut)
    try:
        os.remove(state_path(data_dir))
    except OSError:
        pass


def sign_out(data_dir, client=None):
    update_app_config(data_dir, lambda c: c.__setitem__("refresh_token", ""))
    if client is not None:
        client.set_refresh_token("")
        client.user_id = None


# ---------------------------------------------------------------------------------------------------------------------
# Status, checklist and Thai explanations
# ---------------------------------------------------------------------------------------------------------------------
def heartbeat_age(status, now):
    hb = (status or {}).get("heartbeat_gmt_unix") if isinstance(status, dict) else None
    if isinstance(hb, bool) or not isinstance(hb, (int, float)):
        return None
    return max(0.0, now - hb)


def ago_th(seconds):
    if seconds is None:
        return "-"
    s = int(seconds)
    if s < 60:
        return "%d วินาทีที่แล้ว" % s
    if s < 3600:
        return "%d นาทีที่แล้ว" % (s // 60)
    if s < 86400:
        return "%d ชั่วโมงที่แล้ว" % (s // 3600)
    return "%d วันที่แล้ว" % (s // 86400)


def duration_th(seconds):
    s = int(max(0, seconds or 0))
    if s < 60:
        return "%d วินาที" % s
    if s < 3600:
        return "%d นาที" % (s // 60)
    return "%d ชม. %d นาที" % (s // 3600, (s % 3600) // 60)


def money(x, signed=False):
    if x is None:
        return "-"
    return format(x, "+,.2f" if signed else ",.2f")


def summarize_status(status, now):
    """Numbers for the status cards (None when unknown)."""
    st = status if isinstance(status, dict) else {}
    acc = st.get("account") if isinstance(st.get("account"), dict) else {}
    v = st.get("virtual") if isinstance(st.get("virtual"), dict) else {}
    params = st.get("params") if isinstance(st.get("params"), dict) else {}
    num = da.to_num
    day_start, day_pnl = num(v.get("day_start")), num(v.get("day_pnl"))
    cap_pct = num(params.get("daily_cap_pct"))
    remote = st.get("remote") if isinstance(st.get("remote"), dict) else {}
    eff = remote.get("effective") if isinstance(remote.get("effective"), dict) else {}
    if num(eff.get("InpDailyCapPct")) is not None:
        cap_pct = num(eff.get("InpDailyCapPct"))
    cap_amount = day_start * cap_pct / 100.0 if day_start and cap_pct else None
    used = None
    if cap_amount and day_pnl is not None:
        used = max(0.0, min(1.0, -day_pnl / cap_amount)) if day_pnl < 0 else 0.0
    positions = [p for p in (st.get("positions") or []) if isinstance(p, dict) and p.get("open")]
    if not positions and isinstance(st.get("position"), dict) and st["position"].get("open"):
        positions = [st["position"]]
    return {
        "has_status": bool(st),
        "age": heartbeat_age(st, now) if st else None,
        "ea": "%s %s" % (st.get("ea") or "Dobby", st.get("ea_version") or "") if st else "",
        "symbol": st.get("symbol") or "",
        "currency": acc.get("currency") or "",
        "mode": acc.get("mode") or "",
        "balance": num(acc.get("balance")), "equity": num(acc.get("equity")),
        "v_balance": num(v.get("balance")), "v_start": num(v.get("start")),
        "day_pnl": day_pnl, "day_start": day_start, "cap_pct": cap_pct, "cap_amount": cap_amount, "cap_used": used,
        "cap_hit": bool(v.get("day_cap_hit")), "positions": positions,
        "last_event": str(st.get("last_event") or ""), "ea_error": str(st.get("last_error") or ""),
        "control_mode": str(((st.get("control") or {}) if isinstance(st.get("control"), dict) else {}).get("mode")
                            or ""),
    }


def build_checklist(cfg, status, snap, now, running):
    """The six readiness checks of the main screen: [{key, state ok|warn|bad|idle, title, detail}]."""
    cfg = cfg or {}
    snap = snap or {}
    app = cfg.get("app") or {}
    lim = da.get_limits(cfg)
    st = status if isinstance(status, dict) else None
    age = heartbeat_age(st, now) if st else None
    ea_on = age is not None and age < EA_ONLINE_S
    err = snap.get("last_error") or "" if running else ""
    items = []

    def add(key, state, title, detail=""):
        items.append({"key": key, "state": state, "title": title, "detail": detail})

    # 1 signed in
    if not cfg.get("refresh_token"):
        add("signin", "bad", "ยังไม่ได้เข้าสู่ระบบ", "ตั้งค่า > บัญชีและเครื่อง > เข้าสู่ระบบ")
    elif err.startswith("login:"):
        add("signin", "bad", "เข้าสู่ระบบไม่ได้", "ต้องเข้าสู่ระบบใหม่: ตั้งค่า > บัญชีและเครื่อง")
    else:
        add("signin", "ok", "เข้าสู่ระบบแล้ว", cfg.get("email") or "")
    # 2 linked
    if cfg.get("bot_id"):
        add("linked", "ok", "เชื่อมเครื่องนี้กับเว็บแล้ว", "บอท \"%s\"" % (cfg.get("bot_name") or "Dobby"))
    elif app.get("pending_bot_name"):
        add("linked", "warn", "รอสร้างบอทบนเว็บ", "สร้าง \"%s\" ให้เองเมื่อ EA เริ่มทำงาน (หลังกดเริ่ม)"
            % app["pending_bot_name"])
    else:
        add("linked", "bad", "ยังไม่ได้เชื่อมกับบอท", "เปิดตัวช่วยตั้งค่าในหน้าตั้งค่า")
    # 3 EA running
    if st is None:
        add("ea", "bad", "ยังไม่พบ EA ใน MT5", "ทำตามขั้นตอนเปิด EA ด้านล่าง (ครั้งเดียว)")
    elif not ea_on:
        add("ea", "bad", "EA ไม่ส่งสัญญาณ", "ล่าสุด %s: MT5 ปิดอยู่ หรือ EA ถูกเอาออกจากกราฟ" % ago_th(age))
    else:
        add("ea", "ok", "EA ทำงานอยู่ใน MT5", "%s %s, สัญญาณล่าสุด %s" % (
            (st.get("ea") or "Dobby"), st.get("ea_version") or "", ago_th(age)))
    # 4 Algo Trading
    acc = (st or {}).get("account") if isinstance((st or {}).get("account"), dict) else {}
    if not ea_on:
        add("algo", "idle", "Algo Trading", "รอข้อมูลจาก EA")
    elif acc.get("trade_permitted") is True:
        add("algo", "ok", "Algo Trading เปิดอยู่", "MT5 อนุญาตให้ EA ส่งคำสั่งซื้อขาย")
    else:
        add("algo", "bad", "Algo Trading ยังไม่เปิด",
            "ติ๊ก Allow Algo Trading ในหน้าต่าง EA และกดปุ่ม Algo Trading ให้เป็นสีเขียว")
    # 5 live trading
    flags = (st or {}).get("flags") if isinstance((st or {}).get("flags"), dict) else {}
    remote = (st or {}).get("remote") if isinstance((st or {}).get("remote"), dict) else {}
    mode = str(((st or {}).get("control") or {}).get("mode") or "run") if isinstance((st or {}).get("control"),
                                                                                    dict) else "run"
    if not ea_on:
        add("live", "idle", "เทรดจริง", "รอข้อมูลจาก EA")
    elif flags.get("live_locked"):
        if remote.get("live_enabled"):
            add("live", "warn", "เทรดจริงปิดอยู่", "เปิดได้จากเว็บ" + (
                "" if lim["allow_remote_live"] else " (ต้องติ๊ก \"ให้เว็บเปิดเทรดจริงได้\" ในตั้งค่าก่อน)"))
        else:
            add("live", "bad", "EA ล็อกเทรดจริงไว้",
                "บัญชีจริง: ตั้ง InpAllowLive = true ใน EA (หรือ InpRemoteLive = true แล้วเปิดจากเว็บ)")
    elif mode.lower() == "pause":
        add("live", "warn", "หยุดชั่วคราวอยู่", "บอทไม่เข้าออเดอร์ใหม่ สั่งทำงานต่อได้จากเว็บ")
    else:
        mode_th = {"REAL": "บัญชีจริง", "DEMO": "บัญชีทดลอง", "CONTEST": "บัญชีแข่งขัน"}
        add("live", "ok", "เทรดได้ (ไม่หยุดชั่วคราว)", mode_th.get(str(acc.get("mode") or "").upper(),
                                                                 "บัญชี %s" % (acc.get("mode") or "-")))
    # 6 web commands applied
    if not running:
        add("web", "idle", "รับคำสั่งจากเว็บ", "กดปุ่ม เริ่มทำงาน Dobby")
    elif not lim["allow_remote_control"]:
        add("web", "warn", "ปิดรับคำสั่งจากเว็บไว้", "เปิดได้ที่ ตั้งค่า > ความปลอดภัย")
    elif snap.get("phase") in ("waiting_ea", "registering"):
        add("web", "idle", "รับคำสั่งจากเว็บ", "รอ EA เริ่มทำงานเพื่อสร้างบอทบนเว็บ")
    elif snap.get("web_version") is None:
        add("web", "idle", "กำลังเชื่อมต่อเว็บ", err and explain_error(err)[0] or "รอสักครู่")
    elif snap.get("applied_version") == snap.get("web_version"):
        rej = [r for r in snap.get("rejected") or []]
        if rej:
            add("web", "warn", "รับคำสั่งเว็บ v%s แล้ว (บางข้อไม่ทำ)" % snap["web_version"],
                explain_reject(rej[0])[0])
        else:
            add("web", "ok", "รับคำสั่งจากเว็บแล้ว", "คำสั่งล่าสุด v%s" % snap["web_version"])
    else:
        add("web", "warn", "รอใช้คำสั่งจากเว็บ", "เว็บ v%s, เครื่องนี้ v%s" % (
            snap.get("web_version"), snap.get("applied_version")))
    return items


MT5_STEPS = [
    ("เปิดโปรแกรม MT5", "ล็อกอินบัญชีที่จะให้ Dobby เทรด"),
    ("Navigator > Refresh", "กด Ctrl+N แล้วคลิกขวาที่ Expert Advisors เลือก Refresh"),
    ("ลาก \"%s\" ใส่กราฟ" % EA_CHART_NAME, "ใช้กราฟ XAUUSD กรอบเวลา M15 กราฟเดียว"),
    ("โหลดพรีเซ็ต", "แท็บ Inputs กด Load แล้วเลือกไฟล์ .set"),
    ("ติ๊ก Allow Algo Trading", "แท็บ Common ในหน้าต่างเดียวกัน แล้วกด OK"),
    ("กดปุ่ม Algo Trading ให้เขียว", "ปุ่มบนแถบเครื่องมือด้านบนของ MT5"),
]

REJECT_TH = {
    "live_not_allowed_locally": ("เว็บขอเปิดเทรดจริง แต่เครื่องนี้ไม่อนุญาต",
                                 "ถ้าต้องการ: ตั้งค่า > ความปลอดภัย ติ๊ก \"ให้เว็บเปิดเทรดจริงได้\" แล้วกดเปิดบนเว็บอีกครั้ง"),
    "params_not_allowed_locally": ("เว็บส่งพรีเซ็ตมา แต่เครื่องนี้ไม่รับ",
                                   "ติ๊ก \"ให้เว็บส่งพรีเซ็ตได้\" ในตั้งค่า (ต้องใช้ EA v3.04 และ InpRemoteParams = true)"),
    "remote_control_disabled": ("ปิดรับคำสั่งจากเว็บไว้", "แอปไม่เขียนไฟล์ควบคุมให้ EA เลย เปิดได้ที่ ตั้งค่า > ความปลอดภัย"),
    "lots_clamped": ("lot จากเว็บเกินเพดานของเครื่อง จึงลดลงเท่าเพดาน", "เพดาน lot เปลี่ยนได้ที่ ตั้งค่า > ความปลอดภัย"),
    "params_lots_over_limit": ("lot ในพรีเซ็ตเกินเพดานของเครื่อง ทั้งชุดถูกปฏิเสธ", "ลด lot ในพรีเซ็ต หรือเพิ่มเพดานในตั้งค่า"),
    "params_cap_over_limit": ("จุดหยุดขาดทุนรายวันในพรีเซ็ตเกินเพดาน ทั้งชุดถูกปฏิเสธ",
                              "ลด InpDailyCapPct ในพรีเซ็ต หรือเพิ่มเพดานในตั้งค่า"),
    "params_unknown_key": ("พรีเซ็ตมีค่าที่ส่งจากเว็บไม่ได้ ทั้งชุดถูกปฏิเสธ", "ค่านั้นต้องโหลดไฟล์ .set ใน MT5 เอง"),
    "params_out_of_bounds": ("ค่าในพรีเซ็ตอยู่นอกช่วงที่ EA รับได้ ทั้งชุดถูกปฏิเสธ", "ตรวจค่าที่ขึ้นสีแดงในหน้าพรีเซ็ตบนเว็บ"),
    "params_invalid": ("พรีเซ็ตจากเว็บอ่านไม่ได้", "บันทึกพรีเซ็ตบนเว็บใหม่อีกครั้ง"),
    "offset_unknown": ("ยังไม่รู้เวลาเซิร์ฟเวอร์ของโบรก", "ช่วงงดเทรดข่าวจะเขียนได้เมื่อ EA ทำงาน"),
    "offset_unconfirmed": ("ยังยืนยันเวลาเซิร์ฟเวอร์ไม่ได้ (ตลาดปิด?)", "เวลางดเทรดข่าวอาจคลาดได้จนกว่าราคาจะขยับ"),
    "bad_blackout": ("มีช่วงงดเทรดที่อ่านไม่ได้ จึงถูกข้าม", "ลบแล้วเพิ่มช่วงนั้นใหม่บนเว็บ"),
}


def explain_reject(code):
    base = str(code or "").split(":")[0]
    return REJECT_TH.get(base) or ("เครื่องนี้ไม่ทำตามคำสั่งบางข้อ (%s)" % base, "ดูรายละเอียดในบันทึก")


def explain_error(err):
    """Agent last_error -> (Thai title, Thai detail)."""
    e = str(err or "")
    if e.startswith("network:"):
        return "เชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ต แอปจะลองใหม่เองทุกนาที (ไม่แตะไฟล์ของ EA ระหว่างนั้น)"
    if e.startswith("login:"):
        return "เข้าสู่ระบบไม่ได้", "เข้าสู่ระบบใหม่ที่ ตั้งค่า > บัญชีและเครื่อง"
    if "no bot_control row" in e:
        return "ไม่พบบอทนี้บนเว็บ (ถูกลบ?)", "ตั้งค่า > บัญชีและเครื่อง > ยกเลิกการเชื่อม แล้วเชื่อมใหม่"
    if "not_approved" in e:
        return "บัญชียังไม่ได้รับอนุมัติ", "ใส่รหัสเชิญบนเว็บ Dobby ก่อน"
    if "EA folder not found" in e:
        return "ไม่พบโฟลเดอร์ไฟล์ของ EA", "เปิด MT5 ให้ EA ทำงานหนึ่งครั้ง"
    if e.startswith("cannot write"):
        return "เขียนไฟล์ควบคุมให้ EA ไม่ได้", e
    if e.startswith("server:"):
        return "เว็บตอบกลับว่ามีปัญหา", e[len("server:"):].strip()
    return "มีข้อผิดพลาด", e


_FRIENDLY = [  # (pattern, Thai text, keep the original line after it)
    (re.compile(r"^wrote dobby2_control\.txt$"), "เขียนไฟล์ควบคุมให้ EA แล้ว", False),
    (re.compile(r"^wrote dobby3_remote\.txt$"), "เขียนไฟล์ค่าจากเว็บให้ EA v3.04 แล้ว", False),
    (re.compile(r"^journal: (\d+) new row"), "ส่งประวัติการเทรดขึ้นเว็บ \\1 รายการ", False),
    (re.compile(r"^decision: v(\d+) applied"), "ใช้คำสั่งจากเว็บ v\\1 แล้ว", False),
    (re.compile(r"^decision: v(\d+) NOT applied"), "ไม่ใช้คำสั่งจากเว็บ v\\1 (ปิดรับคำสั่งไว้)", False),
    (re.compile(r"^EA offline"), "EA ไม่ส่งสัญญาณ (ออฟไลน์)", False),
    (re.compile(r"^EA back online"), "EA กลับมาออนไลน์", False),
    (re.compile(r"^network: "), "เชื่อมต่อเว็บไม่ได้ จะลองใหม่", True),
    (re.compile(r"^login: "), "เข้าสู่ระบบไม่ได้", True),
    (re.compile(r"^server: "), "เว็บตอบกลับว่ามีปัญหา", True),
    (re.compile(r"^server UTC offset confirmed"), "ยืนยันเวลาเซิร์ฟเวอร์ของโบรกแล้ว", False),
    (re.compile(r"^Dobby App \S+ start: bot \"(.*?)\""), "เริ่มทำงาน: บอท \"\\1\"", False),
    (re.compile(r"^Dobby App \S+ opened"), "เปิดแอป Dobby", False),
    (re.compile(r"^EA install: (.+?) -> .*\((installed|same|kept)\)$"), "ติดตั้ง \\1 ใน MT5 (\\2)", False),
    (re.compile(r"^stop pressed"), "กดหยุดแล้ว: ไม่เขียนไฟล์ของ EA อีก", False),
    (re.compile(r"^start refused: EA folder lock held by (.*)$"), "เริ่มไม่ได้: มี Dobby อีกตัวทำงานอยู่ (\\1)", False),
    (re.compile(r"^start refused"), "เริ่มไม่ได้", True),
    (re.compile(r"^setup wizard finished"), "ตั้งค่าครั้งแรกเสร็จแล้ว", False),
    (re.compile(r"^settings saved"), "บันทึกการตั้งค่าแล้ว", False),
    (re.compile(r"^signed out"), "ออกจากระบบแล้ว", False),
    (re.compile(r"^this PC is now linked to the bot \"(.*)\""), "เชื่อมเครื่องนี้กับบอท \"\\1\" แล้ว", False),
    (re.compile(r"^this PC was unlinked"), "ยกเลิกการเชื่อมเครื่องนี้แล้ว", False),
    (re.compile(r"^message: (.*?) \|"), "แจ้งเตือน: \\1", False),
    (re.compile(r"^EA folder lock: a stale lock"), "พบไฟล์ล็อกเก่าของ agent ที่ปิดไปแล้ว ใช้ต่อได้", False),
    (re.compile(r"^Dobby agent stopped"), "หยุดทำงานแล้ว", False),
    (re.compile(r"^stopped: "), "หยุดแล้ว: ไม่เขียนไฟล์ของ EA", False),
    (re.compile(r"^waiting for the EA"), "รอ EA เริ่มทำงานใน MT5 เพื่อสร้างบอทบนเว็บ", False),
    (re.compile(r"^bot \"(.*)\" created on the website"), "สร้างบอท \"\\1\" บนเว็บแล้ว", False),
]


def friendly_log(msg):
    """Thai summary for the GUI log panel (agent.log keeps the original English line)."""
    for rx, th, keep in _FRIENDLY:
        m = rx.search(msg)
        if m:
            text = m.expand(th)
            return text + "  (" + msg[:160] + ")" if keep else text
    return msg


# ---------------------------------------------------------------------------------------------------------------------
# The agent in a background thread
# ---------------------------------------------------------------------------------------------------------------------
class AppAgent(da.Agent):
    """dobby_agent.Agent for the app: writes no EA file once Stop was pressed, records the web version it saw."""

    def __init__(self, agent_dir, common_dir, client, telegram, stop_event, **kw):
        self.stop_event = stop_event
        self.web_version = None
        self.last_ok_at = None
        da.Agent.__init__(self, agent_dir, common_dir, client, telegram, **kw)

    def reload_config(self):
        with CONFIG_LOCK:
            da.Agent.reload_config(self)

    def _save_refresh_token(self, token):
        with CONFIG_LOCK:
            da.Agent._save_refresh_token(self, token)

    def _write_file(self, path, text):
        if self.stop_event.is_set():
            LOG.info("stopped: %s not written", os.path.basename(path))
            return False
        return da.Agent._write_file(self, path, text)

    def _apply_control(self, row, now):
        self.web_version = int(row.get("version") or 0)
        if self.stop_event.is_set():
            return None
        return da.Agent._apply_control(self, row, now)

    def _adopt_local_change(self, row, now):
        if self.stop_event.is_set():
            return row
        return da.Agent._adopt_local_change(self, row, now)

    def _ok(self):
        da.Agent._ok(self)
        self.last_ok_at = self.clock()

    def snapshot(self):
        st = self.state
        return {"status": self.last_status, "applied_version": st["applied_version"], "applied_at": st["applied_at"],
                "web_version": self.web_version, "rejected": list(self.rejected),
                "reject_details": list(self.reject_details), "warnings": list(self.warnings),
                "last_error": self.last_error, "fail_count": self.fail_count, "backoff": self.backoff,
                "last_ok_at": self.last_ok_at, "time": self.clock(), "phase": "running"}


class AgentRunner(object):
    """Start / stop the agent loop. Start takes the EA-folder lock first (one agent per MT5) and nothing is written
    to the EA's files before Start; Stop sets an event that blocks every further EA-file write at once."""

    def __init__(self, ctx, client, post):
        self.ctx = ctx
        self.client = client
        self.post = post
        self.thread = None
        self.stop_event = threading.Event()
        self.lock = None
        self.agent = None
        self.started_at = None
        self.common = None

    @property
    def running(self):
        return self.thread is not None and self.thread.is_alive()

    @property
    def stopping(self):
        return self.running and self.stop_event.is_set()

    def start(self):
        """(True, None) or (False, {"holder": lock body | None, "error": text, "common": folder})."""
        if self.running:
            if not self.stop_event.is_set():
                return True, None
            return False, {"holder": None, "error": "still stopping", "common": self.common}
        cfg = load_app_config(self.ctx.data_dir)
        common = self.ctx.common_dir(cfg)
        lock = da.CommonLock(common, program="Dobby App %s" % APP_VERSION)
        if not lock.acquire():
            return False, {"holder": lock.holder, "error": lock.error, "common": common}
        self.lock, self.common = lock, common
        self.stop_event = threading.Event()
        self.started_at = time.time()
        self.agent = None
        self.thread = threading.Thread(target=self._run, args=(self.stop_event,), name="dobby-agent")
        self.thread.daemon = True
        self.thread.start()
        return True, None

    def stop(self):
        self.stop_event.set()

    def _run(self, stop):
        try:
            cfg = load_app_config(self.ctx.data_dir)
            if not cfg.get("bot_id") and not self._register_pending(cfg, stop):
                return
            cfg = load_app_config(self.ctx.data_dir)
            tgc = cfg.get("telegram") or {}
            tg = da.Telegram(self.client.transport, tgc.get("token"), tgc.get("chat_id"),
                             tgc.get("events", da.TELEGRAM_EVENTS))
            agent = AppAgent(self.ctx.data_dir, self.common, self.client, tg, stop)
            self.agent = agent
            lim = agent.limits()
            LOG.info("Dobby App %s start: bot \"%s\", EA folder %s | remote control %s, live %s, params %s, max lots "
                     "%.2f, max cap %g%%", APP_VERSION, agent.bot_name(), self.common,
                     "on" if lim["allow_remote_control"] else "OFF", "on" if lim["allow_remote_live"] else "off",
                     "on" if lim["allow_remote_params"] else "off", lim["max_lots"], lim["max_daily_cap_pct"])
            if self.lock is not None and self.lock.stale:
                LOG.info("a lock left by an agent that is no longer running (pid %s) was taken over",
                         self.lock.stale.get("pid"))
            while not stop.is_set():
                delay = agent.cycle()
                self.post(("agent", agent.snapshot()))
                stop.wait(delay)
        except Exception as e:  # never let the thread die silently
            LOG.exception("agent thread failed")
            self.post(("agent_error", "internal error: %s" % e))
        finally:
            if self.lock is not None:
                self.lock.release()
                self.lock = None
            self.client.on_refresh_token = self.ctx.save_refresh_token
            LOG.info("Dobby agent stopped")
            self.post(("agent_stopped", None))

    def _register_pending(self, cfg, stop):
        name = (cfg.get("app") or {}).get("pending_bot_name")
        if not name:
            self.post(("agent_error", "login: this PC is not linked to a bot"))
            return False
        self.post(("phase", "waiting_ea"))
        LOG.info("waiting for the EA (status file) to create the bot \"%s\" on the website", name)
        path = os.path.join(self.common, da.STATUS_NAME)
        while not stop.is_set():
            age = heartbeat_age(da.read_status_file(path, attempts=2, sleep=stop.wait), time.time())
            if age is not None and age < EA_ONLINE_S:
                break
            stop.wait(3)
        while not stop.is_set():
            self.post(("phase", "registering"))
            try:
                register_new_bot(self.client, self.ctx.data_dir, self.common, name, cfg, sleep=stop.wait,
                                 wait_s=self.ctx.register_wait_s)
                self.post(("registered", name))
                return not stop.is_set()
            except NoEaStatus:
                stop.wait(3)
            except da.NetworkError as e:
                LOG.warning("bot not created yet (network: %s), retry in 30 s", e)
                stop.wait(30)
            except (da.AuthError, da.ApiError) as e:
                LOG.error("bot not created: %s", e)
                self.post(("agent_error", ("login: %s" if isinstance(e, da.AuthError) else "server: %s") % e))
                return False
        return False


class StatusWatcher(object):
    """Reads the EA status file every few seconds (read only) so the checklist is live even before Start."""

    def __init__(self, get_common, post, every=3.0):
        self.get_common = get_common
        self.post = post
        self.every = every
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._run, name="dobby-status")
        self.thread.daemon = True
        self.thread.start()

    def stop(self):
        self.stop_event.set()

    def _run(self):
        while not self.stop_event.is_set():
            try:
                common = self.get_common()
                st = da.read_status_file(os.path.join(common, da.STATUS_NAME), attempts=2,
                                         sleep=self.stop_event.wait)
                self.post(("status", st, time.time()))
            except Exception as e:  # pragma: no cover - never crash the watcher
                APPLOG.debug("status watcher: %s", e)
            self.stop_event.wait(self.every)


class AppContext(object):
    """Everything outside the app (injectable for --demo / --selftest / tests)."""

    def __init__(self, data_dir, environ=None, transport=None, demo=False, external=True, startup_folder=None,
                 register_wait_s=6, auto_answer=None):
        self.data_dir = data_dir
        self.environ = os.environ if environ is None else environ
        self._transport = transport
        self.demo = demo
        self.external = external            # False: never open a browser / Explorer (self-test)
        self._startup = startup_folder
        self.register_wait_s = register_wait_s
        self.auto_answer = auto_answer      # self-test: answer every question with this value
        self.opened = []
        self.save_refresh_token = lambda tok: update_app_config(self.data_dir,
                                                                lambda c: c.__setitem__("refresh_token", tok))

    @property
    def appdata(self):
        return self.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")

    def transport(self):
        if self._transport is None:
            self._transport = da.HttpTransport()
        return self._transport

    def common_dir(self, cfg):
        return da.resolve_common_dir(cfg, self.environ)

    def startup_folder(self):
        return self._startup or startup_dir(self.environ)

    def open_url(self, url):
        self.opened.append(url)
        if self.external:
            import webbrowser
            webbrowser.open(url)

    def open_path(self, path):
        self.opened.append(path)
        if self.external and hasattr(os, "startfile"):
            try:
                os.startfile(path)
            except OSError as e:
                APPLOG.warning("cannot open %s: %s", path, e)


# ---------------------------------------------------------------------------------------------------------------------
# Demo backend (in-memory Supabase + Telegram) and fake MT5 / EA files - for --demo and --selftest, never the network
# ---------------------------------------------------------------------------------------------------------------------
def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


class DemoServer(object):
    """Stands in for Supabase (auth, PostgREST, RPC, Storage) and Telegram. Any password works except "wrong";
    an email containing "pending" is not approved."""

    def __init__(self, url=DEFAULT_URL, key=DEFAULT_KEY, latency=0.0, clock=time.time):
        self.url = url.rstrip("/")
        self.key = key
        self.latency = latency
        self.clock = clock
        self.lock = threading.Lock()
        now = clock()
        self.user_id = "demo-user-0001"
        self.email = ""
        self.approved = True
        self.n = 0
        self.refresh = set()
        self.access = {}
        self.bots = [
            {"id": "7d1f2c3a-0000-4000-8000-000000000001", "name": "คอมที่บ้าน", "last_seen": _iso(now - 3 * 86400),
             "ea_version": "3.03", "symbol": "XAUUSD", "created_at": "2026-11-02T03:00:00Z", "owner": self.user_id},
            {"id": "7d1f2c3a-0000-4000-8000-000000000002", "name": "โน้ตบุ๊กที่ทำงาน", "last_seen": None,
             "ea_version": None, "symbol": None, "created_at": "2026-11-05T09:30:00Z", "owner": self.user_id},
        ]
        self.control = {}
        for b in self.bots:
            self.control[b["id"]] = {"version": 3, "updated_at": _iso(now - 3600), "desired": {
                "live": True, "control": {"mode": "run", "lots": 0.03, "allow_long": True, "allow_short": True,
                                          "max_spread": None, "note": ""}, "blackouts": [], "params": None}}
        self.files = [("Dobby3_v304.ex5", 186368), ("Dobby3_usd280_0.03each.set", 9812),
                      ("Dobby3_cent_0.01each.set", 9790), ("DobbyApp.exe", 11534336)]
        self.status_posts = 0
        self.journal_rows = 0
        self.telegram = []

    def web_change(self, bot_id, **control):
        """The website changes the desired state (demo of a new version / a rejection)."""
        with self.lock:
            row = self.control[bot_id]
            row["desired"]["control"].update(control)
            row["version"] += 1
            row["updated_at"] = _iso(self.clock())

    def _resp(self, status, obj=None, raw=None):
        if raw is not None:
            return da.HttpResponse(status, None, {}, raw)
        return da.HttpResponse(status, "" if obj is None else json.dumps(obj))

    def request(self, method, url, headers=None, params=None, json_body=None, timeout=None):
        if self.latency:
            time.sleep(self.latency)
        headers, params, body = dict(headers or {}), dict(params or {}), json_body
        if url.startswith("https://api.telegram.org/"):
            self.telegram.append(body)
            return self._resp(200, {"ok": True})
        if not url.startswith(self.url):
            raise da.NetworkError("demo: unknown host %s" % url.split("/")[2])
        if headers.get("apikey") != self.key:
            return self._resp(401, {"message": "Invalid API key"})
        path = url[len(self.url):]
        with self.lock:
            if path == "/auth/v1/token":
                return self._token(params, body or {})
            tok = (headers.get("Authorization") or "")[7:]
            if tok not in self.access or self.access[tok] < self.clock():
                return self._resp(401, {"message": "JWT expired"})
            if path.startswith("/storage/v1/"):
                return self._storage(method, path[len("/storage/v1/"):], body)
            if path.startswith("/rest/v1/"):
                return self._rest(method, path[len("/rest/v1/"):], params, body)
        return self._resp(404, {"message": "no route"})

    def _token(self, params, body):
        grant = params.get("grant_type")
        if grant == "password":
            if not body.get("password") or body.get("password") == "wrong":
                return self._resp(400, {"error_code": "invalid_credentials", "msg": "Invalid login credentials"})
            self.email = body.get("email") or ""
            self.approved = "pending" not in self.email
        elif grant == "refresh_token":
            if body.get("refresh_token") not in self.refresh:
                return self._resp(400, {"error_code": "refresh_token_not_found", "msg": "Invalid Refresh Token"})
            self.refresh.discard(body.get("refresh_token"))
        else:
            return self._resp(400, {"msg": "unsupported grant"})
        self.n += 1
        access, refresh = "demo-access-%d-%s" % (self.n, uuid.uuid4().hex[:8]), "demo-refresh-%d-%s" % (
            self.n, uuid.uuid4().hex[:8])
        self.access[access] = self.clock() + 3600
        self.refresh.add(refresh)
        return self._resp(200, {"access_token": access, "expires_in": 3600, "expires_at": int(self.clock() + 3600),
                                "refresh_token": refresh, "user": {"id": self.user_id, "email": self.email}})

    def _storage(self, method, path, body):
        if not self.approved:
            return self._resp(400, {"statusCode": "403", "error": "Unauthorized", "message": "not approved"})
        if method == "POST" and path == "object/list/" + BUCKET:
            return self._resp(200, [{"name": n, "id": "f%d" % i, "updated_at": "2026-11-07T06:00:00Z",
                                     "metadata": {"size": s, "mimetype": "application/octet-stream"}}
                                    for i, (n, s) in enumerate(self.files)])
        prefix = "object/authenticated/%s/" % BUCKET
        if method == "GET" and path.startswith(prefix):
            name = path[len(prefix):]
            for n, s in self.files:
                if quote(n, safe="/") == name:
                    return self._resp(200, raw=("DEMO FILE %s\r\n" % n).encode("utf-8"))
            return self._resp(400, {"statusCode": "404", "error": "not_found", "message": "Object not found"})
        return self._resp(404, {"message": "no storage route"})

    def _bot(self, params, key):
        v = params.get(key) or ""
        return v[3:] if v.startswith("eq.") else v

    def _rest(self, method, table, params, body):
        now = self.clock()
        if table == "rpc/is_approved":
            return self._resp(200, self.approved)
        if not self.approved:
            return self._resp(400, {"code": "P0001", "message": "not_approved"})
        if table == "rpc/register_bot":
            bid = str(uuid.uuid4())
            self.bots.append({"id": bid, "name": body["p_name"], "last_seen": None, "ea_version": None, "symbol": None,
                              "created_at": _iso(now), "owner": self.user_id})
            self.control[bid] = {"version": 1, "desired": body["p_desired"], "updated_at": _iso(now)}
            return self._resp(200, bid)
        if table == "bots" and method == "GET":
            return self._resp(200, [dict((k, v) for k, v in b.items() if k != "owner") for b in self.bots])
        if table == "bots" and method == "PATCH":
            for b in self.bots:
                if b["id"] == self._bot(params, "id"):
                    b.update(dict((k, v) for k, v in (body or {}).items() if k != "agent_state"))
                    b["last_seen"] = _iso(now)
            return self._resp(204)
        if table == "bot_status" and method == "POST":
            self.status_posts += 1
            return self._resp(201)
        if table == "journal" and method == "POST":
            self.journal_rows += len(body or [])
            return self._resp(201)
        if table == "bot_control":
            row = self.control.get(self._bot(params, "bot_id"))
            if row is None:
                return self._resp(200, [])
            if method == "GET":
                return self._resp(200, [dict(row)])
            if method == "PATCH":
                if params.get("version") and params["version"] != "eq.%d" % row["version"]:
                    return self._resp(200, [])
                row["desired"] = body["desired"]
                row["version"] += 1
                return self._resp(200, [dict(row)])
        return self._resp(404, {"message": "no route %s %s" % (method, table)})


def build_demo_appdata(base, with_common=False):
    """A fake %APPDATA% with two MT5 data folders (and optionally the EA common folder)."""
    term = terminals_root(base)
    specs = [("D0E8209F77C8CF37AD8BF550E51FF075", r"C:\Program Files\TMGM MetaTrader 5", "TMGM-Live", True),
             ("2F5A1C0B9E7D4A3B8C6D5E4F3A2B1C0D", r"C:\Program Files\MetaTrader 5", "MetaQuotes-Demo", False)]
    for i, (tid, origin, server, utf16) in enumerate(specs):
        d = os.path.join(term, tid)
        for sub in (("MQL5", "Experts", "Advisors"), ("MQL5", "Presets"), ("bases", server), ("bases", "Default"),
                    ("logs",)):
            os.makedirs(os.path.join(d, *sub), exist_ok=True)
        with open(os.path.join(d, "origin.txt"), "wb") as f:
            f.write(b"\xff\xfe" + origin.encode("utf-16-le") if utf16 else origin.encode("utf-8"))
        t = time.time() - 3600 - i * 86400 * 5
        os.utime(os.path.join(d, "logs"), (t, t))
        os.utime(d, (t, t))
    os.makedirs(os.path.join(term, "Common", "Files"), exist_ok=True)
    if with_common:
        os.makedirs(default_common_dir(base), exist_ok=True)
    return base


class DemoEA(object):
    """Writes a fake dobby2_status.json (and a short journal) into a TEMP common folder, like a running EA."""

    def __init__(self, common, offset_min=120, clock=time.time):
        self.common = common
        self.offset_min = offset_min
        self.clock = clock
        self.thread = None
        self.stop_event = threading.Event()
        self.profit = 4.2
        self.trade_permitted = True
        self.live_locked = False
        self.position = True

    def status(self):
        now = self.clock()
        server = da.epoch_to_naive(now + self.offset_min * 60).strftime("%Y.%m.%d %H:%M:%S")
        day = server[:10]
        pos = {"open": True, "module": "C5G", "ticket": 4123, "side": "BUY", "lots": 0.03, "open_price": 2512.30,
               "sl": 2505.90, "tp": 2521.90, "profit": round(self.profit, 2), "swap": 0.0,
               "open_time": day + " 09:45:00"} if self.position else {"open": False, "module": "C5G"}
        return {
            "schema_version": 5, "ea": "Dobby3", "ea_version": "3.04", "tag": "A_new+NY+C5G", "symbol": "XAUUSD",
            "server_time": server, "heartbeat_gmt_unix": int(now),
            "account": {"mode": "REAL", "currency": "USD", "balance": 500.0, "equity": round(500.0 + self.profit, 2),
                        "connected": True, "trade_permitted": self.trade_permitted},
            "virtual": {"start": 280.0, "balance": 312.4, "day": day, "day_start": 300.0, "day_pnl": -8.6,
                        "day_cap_hit": False, "trades": 12, "wins": 7, "losses": 5},
            "positions": [{"open": False, "module": "A_new"}, {"open": False, "module": "NY"}, pos],
            "position": pos,
            "control": {"file_exists": True, "mode": "run", "lots": 0.03, "id": "W004"},
            "flags": {"live_locked": self.live_locked, "allow_live_input": True},
            "params": {"daily_cap_pct": 10.0, "lots_input": 0.03, "max_lots": 0.03},
            "remote": {"params_enabled": False, "live_enabled": False, "file_exists": False, "version": 0,
                       "applied_version": 0, "pending": False, "live": None},
            "last_event": "%s 09:45:00 OPEN C5G BUY 0.03 @ 2512.30 SL 2505.90 TP 2521.90" % day,
            "last_error": "",
        }

    def write(self):
        os.makedirs(self.common, exist_ok=True)
        da.write_json_atomic(os.path.join(self.common, da.STATUS_NAME), self.status())
        jp = os.path.join(self.common, da.JOURNAL_NAME)
        if not os.path.exists(jp):
            day = self.status()["server_time"][:10]
            with open(jp, "w", encoding="utf-8", newline="") as f:
                f.write(da.JOURNAL_HEADER + "\r\n")
                f.write("%s 00:05:00,START,ALL,NONE,0.00,,,,0.00,312.40,0,v3.04 demo\r\n" % day)
                f.write("%s 09:45:00,OPEN,C5G,BUY,0.03,2512.30,2505.90,2521.90,0.00,312.40,0,demo\r\n" % day)

    def start(self, every=4.0):
        def run():
            while not self.stop_event.is_set():
                self.profit += random.uniform(-0.8, 0.9)
                self.write()
                self.stop_event.wait(every)
        self.write()
        self.thread = threading.Thread(target=run, name="demo-ea")
        self.thread.daemon = True
        self.thread.start()

    def stop(self):
        self.stop_event.set()


# ---------------------------------------------------------------------------------------------------------------------
# PNG / ICO (stdlib only) - app icon and self-test screenshots
# ---------------------------------------------------------------------------------------------------------------------
def png_bytes(width, height, rgba):
    """RGBA bytes (row-major) -> PNG file bytes."""
    stride = width * 4
    raw = b"".join(b"\x00" + bytes(rgba[y * stride:(y + 1) * stride]) for y in range(height))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def _mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def icon_rgba(size):
    """The Dobby App icon: a blue rounded tile, a white "D" and a gold dot. 4x4 supersampled."""
    top, bottom = (42, 92, 214), (29, 67, 168)
    white, gold = (255, 255, 255), (236, 198, 94)
    out = bytearray(size * size * 4)
    n = 4
    r_tile = 0.22

    def tile_in(x, y):
        dx = max(abs(x - 0.5) - (0.5 - r_tile), 0.0)
        dy = max(abs(y - 0.5) - (0.5 - r_tile), 0.0)
        return dx * dx + dy * dy <= r_tile * r_tile

    def d_in(x, y):
        if 0.27 <= x <= 0.41 and 0.22 <= y <= 0.78:
            return True
        cx, cy = 0.41, 0.5
        dist = math.hypot(x - cx, (y - cy) * 1.0)
        return x >= cx and 0.145 <= dist <= 0.28

    def dot_in(x, y):
        return math.hypot(x - 0.74, y - 0.26) <= 0.075

    for py in range(size):
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(n):
                for sx in range(n):
                    x = (px + (sx + 0.5) / n) / size
                    y = (py + (sy + 0.5) / n) / size
                    if not tile_in(x, y):
                        continue
                    if dot_in(x, y):
                        c = gold
                    elif d_in(x, y):
                        c = white
                    else:
                        c = _mix(top, bottom, y)
                    acc[0] += c[0]
                    acc[1] += c[1]
                    acc[2] += c[2]
                    acc[3] += 1
            i = (py * size + px) * 4
            if acc[3]:
                out[i:i + 4] = bytes((int(acc[0] / acc[3]), int(acc[1] / acc[3]), int(acc[2] / acc[3]),
                                      int(255 * acc[3] / (n * n))))
    return out


def icon_png(size=64):
    return png_bytes(size, size, icon_rgba(size))


def _seg_dist(px_, py_, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px_ - ax) * dx + (py_ - ay) * dy) / float(dx * dx + dy * dy)))
    return math.hypot(px_ - (ax + t * dx), py_ - (ay + t * dy))


def indicator_png(size, kind="check", on=False, disabled=False, accent=(36, 80, 199)):
    """Check box (rounded square + tick) or radio (circle + dot) for the ttk indicators. 4x4 supersampled."""
    border = (178, 186, 199) if not disabled else (208, 213, 221)
    fill_off = (255, 255, 255) if not disabled else (238, 241, 245)
    acc = accent if not disabled else (169, 185, 230)
    n = 4
    out = bytearray(size * size * 4)
    bw = 1.6 / size + 0.02

    def sample(x, y):
        if kind == "radio":
            r = math.hypot(x - 0.5, y - 0.5)
            if r > 0.46:
                return None
            if on:
                return (255, 255, 255) if r <= 0.17 else acc
            return border if r > 0.46 - bw else fill_off
        dx = max(abs(x - 0.5) - (0.46 - 0.18), 0.0)
        dy = max(abs(y - 0.5) - (0.46 - 0.18), 0.0)
        d = math.hypot(dx, dy)
        if d > 0.18:
            return None
        if on:
            t = min(_seg_dist(x, y, 0.27, 0.52, 0.43, 0.68), _seg_dist(x, y, 0.43, 0.68, 0.74, 0.34))
            return (255, 255, 255) if t <= 0.065 else acc
        inner = max(abs(x - 0.5), abs(y - 0.5)) <= 0.46 - bw and d <= 0.18 - bw
        return fill_off if inner else border

    for py in range(size):
        for px_ in range(size):
            acc_c = [0, 0, 0, 0]
            for sy in range(n):
                for sx in range(n):
                    c = sample((px_ + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size)
                    if c is not None:
                        acc_c[0] += c[0]
                        acc_c[1] += c[1]
                        acc_c[2] += c[2]
                        acc_c[3] += 1
            if acc_c[3]:
                i = (py * size + px_) * 4
                out[i:i + 4] = bytes((acc_c[0] // acc_c[3], acc_c[1] // acc_c[3], acc_c[2] // acc_c[3],
                                      255 * acc_c[3] // (n * n)))
    return png_bytes(size, size, out)


def _dib(size, rgba):
    """32-bit BGRA DIB (bottom-up) + an empty AND mask, for small ICO entries."""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    rows = []
    for y in range(size - 1, -1, -1):
        row = bytearray()
        for x in range(size):
            i = (y * size + x) * 4
            row += bytes((rgba[i + 2], rgba[i + 1], rgba[i], rgba[i + 3]))
        rows.append(bytes(row))
    mask_row = b"\x00" * (((size + 31) // 32) * 4)
    return header + b"".join(rows) + mask_row * size


def ico_bytes(sizes=(16, 24, 32, 48, 64, 128, 256)):
    images = []
    for s in sizes:
        rgba = icon_rgba(s)
        images.append((s, png_bytes(s, s, rgba) if s >= 128 else _dib(s, rgba)))
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, blobs = b"", b""
    for s, data in images:
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        blobs += data
    return head + entries + blobs


def write_icon(path):
    with open(path, "wb") as f:
        f.write(ico_bytes())
    return path


# ---------------------------------------------------------------------------------------------------------------------
# Window screenshots (self-test): Pillow ImageGrab when available, else Windows GDI (PrintWindow) + our PNG writer
# ---------------------------------------------------------------------------------------------------------------------
def window_rect(hwnd):
    import ctypes
    from ctypes import wintypes
    rect = wintypes.RECT()
    try:
        ok = ctypes.windll.dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), 9, ctypes.byref(rect),
                                                        ctypes.sizeof(rect)) == 0
    except Exception:
        ok = False
    if not ok:
        ctypes.windll.user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
    return rect.left, rect.top, rect.right, rect.bottom


def capture_hwnd(hwnd, path):
    """Save the window as PNG. Returns the method used ('pillow' | 'gdi')."""
    left, top, right, bottom = window_rect(hwnd)
    try:
        from PIL import ImageGrab
    except ImportError:
        ImageGrab = None
    if ImageGrab is not None:
        img = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        img.save(path)
        return "pillow"
    _gdi_capture(hwnd, path, (left, top, right, bottom))
    return "gdi"


def _gdi_capture(hwnd, path, visible):
    import ctypes
    from ctypes import wintypes
    user32, gdi32 = ctypes.WinDLL("user32"), ctypes.WinDLL("gdi32")
    H, D, I, U = wintypes.HWND, wintypes.HDC, ctypes.c_int, wintypes.UINT
    user32.GetWindowDC.restype, user32.GetWindowDC.argtypes = D, [H]
    user32.ReleaseDC.argtypes = [H, D]
    user32.GetWindowRect.argtypes = [H, ctypes.POINTER(wintypes.RECT)]
    user32.PrintWindow.argtypes = [H, D, U]
    gdi32.CreateCompatibleDC.restype, gdi32.CreateCompatibleDC.argtypes = D, [D]
    gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    gdi32.CreateCompatibleBitmap.argtypes = [D, I, I]
    gdi32.SelectObject.restype, gdi32.SelectObject.argtypes = wintypes.HGDIOBJ, [D, wintypes.HGDIOBJ]
    gdi32.BitBlt.argtypes = [D, I, I, I, I, D, I, I, wintypes.DWORD]
    gdi32.GetDIBits.argtypes = [D, wintypes.HBITMAP, U, U, ctypes.c_void_p, ctypes.c_void_p, U]
    gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
    gdi32.DeleteDC.argtypes = [D]
    full = wintypes.RECT()
    user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(full))
    w, h = full.right - full.left, full.bottom - full.top
    hdc = user32.GetWindowDC(wintypes.HWND(hwnd))
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    old = gdi32.SelectObject(mem, bmp)
    if not user32.PrintWindow(wintypes.HWND(hwnd), mem, 2):
        gdi32.BitBlt(mem, 0, 0, w, h, hdc, 0, 0, 0x00CC0020)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                    ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD)]
    bi = BITMAPINFOHEADER()
    bi.biSize, bi.biWidth, bi.biHeight, bi.biPlanes, bi.biBitCount = ctypes.sizeof(bi), w, -h, 1, 32
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(mem, bmp, 0, h, ctypes.addressof(buf), ctypes.addressof(bi), 0)
    gdi32.SelectObject(mem, old)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(wintypes.HWND(hwnd), hdc)
    data = buf.raw
    x0, y0 = max(0, visible[0] - full.left), max(0, visible[1] - full.top)
    vw, vh = min(w - x0, visible[2] - visible[0]), min(h - y0, visible[3] - visible[1])
    rgba = bytearray(vw * vh * 4)
    for y in range(vh):
        src = data[((y + y0) * w + x0) * 4:((y + y0) * w + x0 + vw) * 4]
        row = bytearray(src)
        row[0::4], row[2::4] = src[2::4], src[0::4]
        row[3::4] = b"\xff" * vw
        rgba[y * vw * 4:(y + 1) * vw * 4] = row
    with open(path, "wb") as f:
        f.write(png_bytes(vw, vh, rgba))


def contact_sheet(paths, out, columns=3, thumb_w=600):
    """One overview PNG of all screenshots (Pillow only). Returns True when written."""
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return False
    thumbs = []
    for p in paths:
        try:
            im = Image.open(p).convert("RGB")
        except OSError:
            continue
        r = thumb_w / float(im.width)
        thumbs.append((os.path.basename(p), im.resize((thumb_w, int(im.height * r)))))
    if not thumbs:
        return False
    th = max(t[1].height for t in thumbs) + 28
    rows = (len(thumbs) + columns - 1) // columns
    sheet = Image.new("RGB", (columns * (thumb_w + 16) + 16, rows * (th + 16) + 16), (230, 233, 238))
    draw = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(thumbs):
        x = 16 + (i % columns) * (thumb_w + 16)
        y = 16 + (i // columns) * (th + 16)
        draw.text((x, y), name, fill=(40, 40, 40))
        sheet.paste(im, (x, y + 22))
    sheet.save(out)
    return True
