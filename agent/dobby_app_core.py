# -*- coding: utf-8 -*-
"""Dobby App - everything that is not GUI (importable and testable without a window).

  * app data folder (%APPDATA%\\DobbyApp) and its config (same agent_config.json format as the CLI agent)
  * MT5 detection (%APPDATA%\\MetaQuotes\\Terminal\\<id>\\origin.txt) and the EA common folder
  * EA install from the private Storage bucket `downloads` into <data>\\MQL5\\Experts\\Dobby, and the generic preset
    Dobby3_v305_web.set written by the app (SPEC 7.4) into <data>\\MQL5\\Presets
  * bot catalog and the simple settings model (SPEC 7.1-7.3): auto from balance, Thai summary, risk estimate (5.1)
  * "open MT5 with Dobby": a startup ini (/config:) - only after the user confirms, only when that MT5 is closed
    and no chart of it already runs a Dobby EA
  * "start with Windows" launcher in the user's Startup folder
  * AppClient: one shared, thread-safe Supabase client (+ Storage, bots list)
  * AppAgent / AgentRunner: the CLI agent loop (dobby_agent.Agent) in a background thread, behind the EA-folder lock
  * hero state / checklist / activity / Thai explanation helpers
  * demo backend (in-memory Supabase, fake MT5 folders, fake EA status) for --demo and --selftest
  * PNG / ICO writer (stdlib) for the app icon and the self-test screenshots

It never imports the MT5 Python package. The only program it can start is the user's own MT5 (real_launch), when
the user presses "เปิด MT5 พร้อม Dobby" and confirms; tests, --demo and --selftest use a fake launcher.
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
import unicodedata
import uuid
import zlib

try:
    from urllib.parse import quote
except ImportError:  # pragma: no cover - python 2
    from urllib import quote

import dobby_agent as da

APP_NAME = "Dobby App"
APP_VERSION = "1.3.0"
DEFAULT_URL = "https://rpzuzhefviydjmeggvvz.supabase.co"
DEFAULT_KEY = "sb_publishable_208tCs0INvDHYohhl5_DGQ_ezVQkJst"   # publishable key: public by design (RLS protects data)
WEB_URL = "https://tataprin.github.io/dobby-web/"
GUIDE_URL = WEB_URL + "#/guide"
BUCKET = "downloads"
APP_DIR_NAME = "DobbyApp"
APP_LOCK_NAME = "app.lock"
LAUNCHER_NAME = "DobbyApp-autostart.cmd"
LAUNCHER_MARK = "Dobby App autostart"
EA_ONLINE_S = da.OFFLINE_AFTER_S          # heartbeat younger than this = the EA is running
EA_CHART_NAME = "Dobby3_v305"
WEB_PRESET_NAME = "Dobby3_v305_web.set"     # SPEC 7.4: the generic preset every friend loads (written by the app)
STARTUP_INI_NAME = "mt5_startup.ini"        # in the app data folder: MT5 /config: file for "open MT5 with Dobby"
TERMINAL_EXE = "terminal64.exe"

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
            "pending_bot_name": "", "bot_kind": "", "ea_file": "", "symbol": "XAUUSD"}


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

    def bot_controls(self, ids):
        """{bot_id: {version, desired}} of the given bots (read only; the wizard shows each bot's settings)."""
        ids = [i for i in ids or [] if i]
        if not ids:
            return {}
        rows = self.select("bot_control", {"select": "bot_id,version,desired", "bot_id": "in.(%s)" % ",".join(ids)})
        return dict((r.get("bot_id"), r) for r in rows if isinstance(r, dict)) if isinstance(rows, list) else {}

    def bots_with_controls(self):
        """list_bots() + each bot's desired state under "control" (None when it cannot be read)."""
        bots = self.list_bots()
        try:
            ctl = self.bot_controls([b.get("id") for b in bots])
        except da.ApiError:
            ctl = {}
        for b in bots:
            b["control"] = ctl.get(b.get("id"))
        return bots


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
    old = da.load_state(state_path(data_dir))
    seed = da.seed_from_ea(common, cfg, clock=clock, sleep=sleep, wait_s=wait_s,
                           exclude_blackouts=old["control"].get("auto_lines"))
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


THAI_DOW = ["จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์", "อาทิตย์"]


def thai_when(t_utc, now):
    """'วันนี้ 20:00' / 'พรุ่งนี้ 20:00' / 'วันศุกร์ 21:00' in Thai time (UTC+7)."""
    d = da.epoch_to_naive(t_utc + da.THAI_OFFSET_S)
    diff = (d.date() - da.epoch_to_naive(now + da.THAI_OFFSET_S).date()).days
    day = "วันนี้" if diff == 0 else "พรุ่งนี้" if diff == 1 else "วัน" + THAI_DOW[d.weekday()]
    return "%s %s" % (day, d.strftime("%H:%M"))


def next_blackout_th(windows, now):
    """SPEC 9.3, main screen: the running or next automatic blackout in one Thai sentence, or ''."""
    for w in windows or []:
        f, t = da.parse_utc((w or {}).get("from_utc")), da.parse_utc((w or {}).get("to_utc"))
        if f is None or t is None or t <= now:
            continue
        reason = da.clean_note(w.get("reason"), 70)
        ts = da.epoch_to_naive(t + da.THAI_OFFSET_S)
        fs = da.epoch_to_naive(f + da.THAI_OFFSET_S)
        if ts.strftime("%H:%M") == "00:00" and (ts.date() - fs.date()).days == 1:
            end = "24:00"                                      # "to 24:00" of the start day
        elif ts.date() == fs.date():
            end = ts.strftime("%H:%M")
        else:
            end = thai_when(t, now)
        why = " (%s)" % reason if reason else ""
        if f <= now:
            return "ตอนนี้งดเข้าไม้อัตโนมัติถึง %s%s" % (end if end != "24:00" else "เที่ยงคืน", why)
        return "งดเข้าไม้อัตโนมัติครั้งถัดไป %s–%s%s" % (thai_when(f, now), end, why)
    return ""


def _auto_activity(m):
    f = da.parse_utc(m.group(2))
    when = thai_when(f, time.time()) if f is not None else m.group(2)
    return "งดเข้าไม้อัตโนมัติ %s ช่วงใน 7 วัน ครั้งถัดไป %s (%s)" % (m.group(1), when, da.clean_note(m.group(4), 60))


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
        "trades": num(v.get("trades")), "wins": num(v.get("wins")),
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
        add("ea", "bad", "ยังไม่พบ Dobby ใน MT5", "กด เชื่อม MT5 เพื่อเปิด MT5 พร้อม Dobby (ครั้งเดียว)")
    elif not ea_on:
        add("ea", "bad", "Dobby ใน MT5 ไม่ส่งสัญญาณ", "ล่าสุด %s: MT5 ปิดอยู่ หรือ Dobby ถูกเอาออกจากกราฟ" % ago_th(age))
    else:
        add("ea", "ok", "Dobby ทำงานอยู่ใน MT5", "%s %s ส่งสัญญาณล่าสุด %s" % (
            (st.get("ea") or "Dobby"), st.get("ea_version") or "", ago_th(age)))
    # 4 Algo Trading
    acc = (st or {}).get("account") if isinstance((st or {}).get("account"), dict) else {}
    if not ea_on:
        add("algo", "idle", "Algo Trading", "รอข้อมูลจาก Dobby")
    elif acc.get("trade_permitted") is True:
        add("algo", "ok", "Algo Trading เปิดอยู่", "MT5 อนุญาตให้ Dobby ส่งคำสั่งซื้อขาย")
    else:
        add("algo", "bad", "Algo Trading ยังไม่เปิด",
            "ติ๊ก Allow Algo Trading ในหน้าต่างของ Dobby และกดปุ่ม Algo Trading ให้เป็นสีเขียว")
    # 5 live trading
    flags = (st or {}).get("flags") if isinstance((st or {}).get("flags"), dict) else {}
    remote = (st or {}).get("remote") if isinstance((st or {}).get("remote"), dict) else {}
    mode = str(((st or {}).get("control") or {}).get("mode") or "run") if isinstance((st or {}).get("control"),
                                                                                    dict) else "run"
    if not ea_on:
        add("live", "idle", "เทรดจริง", "รอข้อมูลจาก Dobby")
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
        add("web", "idle", "รับคำสั่งจากเว็บ", "รอ Dobby เริ่มทำงานเพื่อสร้างบอทบนเว็บ")
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


def mt5_steps(ea_name=EA_CHART_NAME, symbol="XAUUSD"):
    """The manual way (ทำเองใน MT5): (picture key, title, detail)."""
    ea = os.path.splitext(ea_name or EA_CHART_NAME)[0]
    return [
        ("open", "เปิด MT5 และล็อกอิน", "ใช้บัญชีเทรดที่จะให้ Dobby เทรด"),
        ("navigator", "รีเฟรชรายชื่อใน Navigator", "กด Ctrl+N คลิกขวาที่ Expert Advisors แล้วเลือก Refresh"),
        ("drag", "ลาก %s ใส่กราฟ %s M15" % (ea, symbol),
         "เปิดกราฟ %s กรอบเวลา M15 (กราฟเดียว) แล้วลาก %s จากโฟลเดอร์ Dobby ไปวางบนกราฟ" % (symbol, ea)),
        ("load", "โหลดพรีเซ็ต %s" % WEB_PRESET_NAME, "แท็บ Inputs กด Load แล้วเลือกไฟล์นี้"),
        ("allow", "ติ๊ก Allow Algo Trading", "แท็บ Common ในหน้าต่างเดียวกัน แล้วกด OK"),
        ("algo", "ปุ่ม Algo Trading เป็นสีเขียว", "กดปุ่ม Algo Trading บนแถบเครื่องมือด้านบนของ MT5"),
    ]


MT5_STEPS = [(t, d) for _, t, d in mt5_steps()]

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
    (re.compile(r"^EA install: (.+?) -> .*\(installed\)$"), "ติดตั้ง \\1 ใน MT5 แล้ว", False),
    (re.compile(r"^EA install: (.+?) -> .*\(same\)$"), "\\1 มีอยู่แล้วใน MT5 (ไฟล์เดียวกัน)", False),
    (re.compile(r"^EA install: (.+?) -> .*\(kept\)$"), "เก็บ \\1 ไฟล์เดิมใน MT5 ไว้", False),
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
    (re.compile(r"^MT5 started with Dobby"), "เปิด MT5 พร้อม Dobby แล้ว", False),
    (re.compile(r"^preset written: (.+?) "), "สร้างพรีเซ็ต \\1 ใน MT5 แล้ว", False),
    (re.compile(r"^auto blackouts: (\d+) window"), "งดเข้าไม้อัตโนมัติ \\1 ช่วงใน 7 วันข้างหน้า", True),
    (re.compile(r"^auto blackouts: none"), "ไม่มีช่วงงดเข้าไม้อัตโนมัติใน 7 วันข้างหน้า", False),
    (re.compile(r"^auto blackouts: off"), "ปิดการงดเข้าไม้อัตโนมัติแล้ว", False),
    (re.compile(r"^news calendar fetched: (\d+)"), "โหลดปฏิทินข่าวสัปดาห์นี้แล้ว (\\1 ข่าว)", False),
    (re.compile(r"^news calendar not fetched"), "โหลดปฏิทินข่าวไม่ได้ ใช้ข้อมูลเดิมไปก่อน", True),
    (re.compile(r"^cash flow suggested on the website: (\S+)"),
     "พบเงินเข้า-ออกบัญชี \\1 ที่ไม่ใช่ผลเทรดของ Dobby: ยืนยันได้บนเว็บ", False),
    (re.compile(r"^bars: (\d+) bar"), "ส่งราคา \\1 แท่งขึ้นเว็บ", False),
    (re.compile(r"^(bars not uploaded|cash flow suggestion not stored)"), "ส่งข้อมูลเสริมขึ้นเว็บไม่ได้ จะลองใหม่", True),
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
        self.web_desired = None
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
        self.web_desired = row.get("desired") if isinstance(row.get("desired"), dict) else None
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
                "web_version": self.web_version, "web_desired": self.web_desired, "rejected": list(self.rejected),
                "reject_details": list(self.reject_details), "warnings": list(self.warnings),
                "last_error": self.last_error, "fail_count": self.fail_count, "backoff": self.backoff,
                "last_ok_at": self.last_ok_at, "time": self.clock(), "phase": "running",
                "offset": self.effective_offset(), "auto_blackouts": [dict(w) for w in self.auto_windows],
                "news_error": self.news.error if self.news_cfg else None}


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
        jkey = bkey = None
        while not self.stop_event.is_set():
            try:
                common = self.get_common()
                st = da.read_status_file(os.path.join(common, da.STATUS_NAME), attempts=2,
                                         sleep=self.stop_event.wait)
                self.post(("status", st, time.time()))
                jp = os.path.join(common, da.JOURNAL_NAME)
                try:
                    s = os.stat(jp)
                    key = (jp, s.st_size, s.st_mtime)
                except OSError:
                    key = None
                if key and key != jkey:
                    self.post(("journal", journal_tail(jp, 8)))
                jkey = key
                bp = os.path.join(common, da.BARS_NAME)
                try:
                    s = os.stat(bp)
                    key = (bp, s.st_size, s.st_mtime)
                except OSError:
                    key = None
                if key != bkey:
                    self.post(("bars", read_bars_tail(bp) if key else None))
                bkey = key
            except Exception as e:  # pragma: no cover - never crash the watcher
                APPLOG.debug("status watcher: %s", e)
            self.stop_event.wait(self.every)


def read_bars_tail(path, max_bytes=64 * 1024):
    """The end of the EA's dobby2_bars.csv (read only; enough for 24 h of M15 bars). The first line of the result
    is a header or a partial row: dobby_agent.parse_bars_text skips it."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8-sig", "replace")
    except OSError:
        return None


def bars_for_chart(text, offset_min):
    """(bars, offset) for the price line: with the agent's server offset the times are real (UTC); without it the
    bars are parsed with offset 0 and the chart shows no time axis (offset None)."""
    bars = da.parse_bars_text(text, offset_min if offset_min is not None else 0)
    return bars, (offset_min if bars and offset_min is not None else None)


class AppContext(object):
    """Everything outside the app (injectable for --demo / --selftest / tests)."""

    def __init__(self, data_dir, environ=None, transport=None, demo=False, external=True, startup_folder=None,
                 register_wait_s=6, auto_answer=None, launcher=None, processes=None):
        self.data_dir = data_dir
        self.environ = os.environ if environ is None else environ
        self._transport = transport
        self.demo = demo
        self.external = external            # False: never open a browser / Explorer (self-test)
        self._startup = startup_folder
        self.register_wait_s = register_wait_s
        self.auto_answer = auto_answer      # self-test: answer every question with this value
        self._launcher = launcher           # fake MT5 launcher (demo / self-test / tests)
        self._processes = processes         # fake running-MT5 list (list or callable)
        self.opened = []
        self.launched = []
        self.save_refresh_token = lambda tok: update_app_config(self.data_dir,
                                                                lambda c: c.__setitem__("refresh_token", tok))

    def launch(self, cmdline, cwd):
        """Start MT5 (the user confirmed). --demo / --selftest / tests never reach real_launch."""
        self.launched.append((cmdline, cwd))
        if self._launcher is not None:
            return self._launcher(cmdline, cwd)
        if self.demo:
            return None
        return real_launch(cmdline, cwd)

    def terminal_processes(self):
        """Running terminal64.exe processes [{pid, path}] or None when they cannot be listed."""
        if self._processes is not None:
            return list(self._processes() if callable(self._processes) else self._processes)
        if self.demo:
            return []
        try:
            return windows_terminal_processes()
        except Exception as e:  # never guess "closed" when Windows does not answer
            APPLOG.warning("cannot list running programs: %s", e)
            return None

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
# Bot catalog (SPEC 7.1)
# ---------------------------------------------------------------------------------------------------------------------
BOT_CATALOG = [{
    "kind": "dobby", "name": "Dobby",
    "desc": "บอททอง XAUUSD กราฟ 15 นาที 3 สูตร (A_new, NY, C5G) + ASIA16 เสริม",
    "facts": ["ทองคำ XAUUSD", "กราฟ 15 นาที", "3 สูตร + เอเชียเสริม"],
    "why": "เปิด-ปิดออเดอร์ ตั้ง SL/TP และล็อกกำไรให้เองทุกไม้ หยุดเองเมื่อขาดทุนถึงเพดานรายวัน",
}]


def catalog_entry(kind="dobby"):
    return next((b for b in BOT_CATALOG if b["kind"] == kind), BOT_CATALOG[0])


# ---------------------------------------------------------------------------------------------------------------------
# Simple bot settings (SPEC 7.2 / 7.3): what a friend sees instead of EA input names
# ---------------------------------------------------------------------------------------------------------------------
LOT_MIN, LOT_MAX = 0.01, 0.50
PRESET_MAX_LOTS = 0.50       # InpRemoteMaxLots of Dobby3_v305_web.set: the EA ceiling for every remote lot
PRESET_MAX_CAP = 10.0        # InpRemoteMaxCapPct of Dobby3_v305_web.set
WEB_PRESET_BALANCE = 300.0   # the generic preset carries the 7.3 values for a 300 USD account
# (simple key, name shown, EA use key, EA lot key)
MODULES = [("a", "A_new", "InpUseA", "InpLotsA"), ("ny", "NY", "InpUseNY", "InpLotsNY"),
           ("c5g", "C5G", "InpUseC5G", "InpLotsC5G"), ("asia", "ASIA16", "InpUseAsia", "InpLotsAsia")]
STRATEGY_TH = {
    "a": ("A_new", "สูตรหลัก: เข้าตอนราคาส่งสัญญาณกลับตัว (RSI divergence)"),
    "ny": ("NY", "เบรกกรอบราคาตอนตลาดนิวยอร์กเปิด"),
    "c5g": ("C5G", "เข้าตามแรงเด้งจากเส้นราคาเฉลี่ย VWAP"),
    "asia": ("ASIA16", "สูตรเสริม: ถือฝั่งซื้อช่วงเอเชียถึงบ่าย (ปกติปิดไว้)"),
}
SETTING_DEFAULTS = {
    "use_a": True, "use_ny": True, "use_c5g": True, "use_asia": False, "lot_mode": "same", "lot_asia": 0.01,
    "lock_stages": 2, "lock_at": 95.0, "lock_to": 93.0, "lock1_at": 85.0, "lock1_to": 83.0, "daily_cap": 10.0,
    "recovery": 1.5, "attempts": 4, "conf_mult": 1.5, "conf_min": 60, "max_spread": 1.0, "vol_gate": False,
    "vol_gate_pct": 1.75,
}


def _num(v, default=None):
    x = da.to_num(v)
    return default if x is None else x


def lot2(x):
    """Lots on the 0.01 grid (like the EA's NormLots)."""
    return round(math.floor(float(x) * 100 + 0.5 + 1e-9) / 100.0, 2)


def pct_text(x):
    x = round(float(x), 1)
    return ("%d" % x) if x == int(x) else ("%.1f" % x)


def auto_lot(balance):
    """SPEC 7.3: L = max(0.01, floor(B / 100) / 100), capped at 0.50 (300 -> 0.03, 1000 -> 0.10, 150 -> 0.01)."""
    b = da.to_num(balance)
    if b is None or b <= 0:
        return LOT_MIN
    lot = math.floor(b / 100.0 + 1e-9) / 100.0
    return round(min(LOT_MAX, max(LOT_MIN, lot)), 2)


def auto_settings(balance):
    """SPEC 7.3 "ตั้งให้อัตโนมัติจากทุน": everything from the balance alone."""
    b = da.to_num(balance)
    lot = auto_lot(b)
    s = dict(SETTING_DEFAULTS)
    s.update(balance=round(b, 2) if b is not None and b > 0 else None, lot=lot, lot_a=lot, lot_ny=lot, lot_c5g=lot)
    return s


def default_local_max_lots(lot):
    """SPEC 7.3: the PC's local max lots = min(0.50, max(0.02, 2 x L))."""
    return round(min(0.50, max(0.02, 2 * float(lot))), 2)


def recommended_limits(max_lot):
    """The safety screen's recommended default: the website may control everything, within local ceilings."""
    return {"allow_remote_control": True, "allow_remote_live": True, "allow_remote_params": True,
            "max_lots": default_local_max_lots(max_lot), "max_daily_cap_pct": 10.0}


def settings_lots(s):
    """{a, ny, c5g, asia} -> lot of each module (one lot for the three in "same" mode)."""
    if s.get("lot_mode") == "each":
        a, ny, c5 = s.get("lot_a"), s.get("lot_ny"), s.get("lot_c5g")
    else:
        a = ny = c5 = s.get("lot")
    return {"a": lot2(_num(a, LOT_MIN)), "ny": lot2(_num(ny, LOT_MIN)), "c5g": lot2(_num(c5, LOT_MIN)),
            "asia": lot2(_num(s.get("lot_asia"), LOT_MIN))}


def settings_max_lot(s):
    """InpMaxLots: the largest module lot (the EA caps every module's base lot, ASIA16's too, at InpMaxLots)."""
    return max(settings_lots(s).values())


def _between(x, lo, hi):
    return x is not None and lo - 1e-9 <= x <= hi + 1e-9


def validate_settings(s):
    """{field: Thai message} for the fields the user can see (empty = OK)."""
    err = {}
    b = da.to_num(s.get("balance"))
    if b is None or b <= 0 or b > 1e8:
        err["balance"] = "ใส่ยอดเงินเป็นตัวเลขมากกว่า 0 เช่น 300"
    if not any(s.get("use_" + k) for k, _, _, _ in MODULES):
        err["strategies"] = "เปิดอย่างน้อย 1 สูตร"
    lot_fields = ["lot_a", "lot_ny", "lot_c5g"] if s.get("lot_mode") == "each" else ["lot"]
    if s.get("use_asia"):
        lot_fields.append("lot_asia")
    for k in lot_fields:
        x = da.to_num(s.get(k))
        if x is None or x < LOT_MIN - 1e-9:
            err[k] = "ล็อตอย่างน้อย 0.01"
        elif x > LOT_MAX + 1e-9:
            err[k] = "ล็อตไม่เกิน %.2f" % LOT_MAX
    stages = int(_num(s.get("lock_stages"), 0))
    at, to = da.to_num(s.get("lock_at")), da.to_num(s.get("lock_to"))
    a1, t1 = da.to_num(s.get("lock1_at")), da.to_num(s.get("lock1_to"))
    if stages >= 1:
        if not _between(at, 50, 99.5):
            err["lock_at"] = "ใส่ 50 ถึง 99.5%"
        elif not _between(to, 1, at - 0.5):
            err["lock_to"] = "ต้องต่ำกว่า %s%% (จุดเริ่มล็อก) อย่างน้อย 0.5" % pct_text(at)
    if stages >= 2 and "lock_at" not in err:
        if not _between(a1, 10, at - 0.5):
            err["lock1_at"] = "ชั้นแรกต้องอยู่ระหว่าง 10 ถึง %s%% (ต่ำกว่าชั้นใกล้ TP)" % pct_text(at - 0.5)
        elif to is not None and not _between(t1, 1, min(a1, to) - 0.5):
            err["lock1_to"] = "ต้องไม่เกิน %s%% (ต่ำกว่าทั้งจุดเริ่มชั้นแรกและ SL ชั้นใกล้ TP)" % pct_text(
                min(a1, to) - 0.5)
    for k, lo, hi, msg in (("daily_cap", 1, PRESET_MAX_CAP, "1 ถึง 10%"), ("recovery", 1.0, 2.0, "1.0 ถึง 2.0"),
                           ("conf_mult", 1.0, 2.0, "1.0 ถึง 2.0"), ("max_spread", 0.05, 2.0, "0.05 ถึง 2.00")):
        if not _between(da.to_num(s.get(k)), lo, hi):
            err[k] = "ใส่ " + msg
    for k, lo, hi, msg in (("attempts", 1, 4, "1 ถึง 4 ครั้ง"), ("conf_min", 0, 240, "0 ถึง 240 นาที")):
        x = da.to_num(s.get(k))
        if not _between(x, lo, hi) or abs(x - round(x)) > 1e-9:
            err[k] = "ใส่จำนวนเต็ม " + msg
    if s.get("vol_gate") and not _between(da.to_num(s.get("vol_gate_pct")), 0.5, 5.0):
        err["vol_gate_pct"] = "ใส่ 0.5 ถึง 5.0"
    return err


def _sane_locks(s):
    """The lock values sent even for a stage that is off must still pass the EA's cross-checks (SPEC 4.2)."""
    stages = int(_num(s.get("lock_stages"), 0))
    at, to = _num(s.get("lock_at"), 95.0), _num(s.get("lock_to"), 93.0)
    a1, t1 = _num(s.get("lock1_at"), 85.0), _num(s.get("lock1_to"), 83.0)
    if not (_between(at, 50, 99.5) and _between(to, 1, at - 0.5)):
        at, to = 95.0, 93.0
    if stages < 2 and not (_between(a1, 10, at - 0.5) and _between(t1, 1, min(a1, to) - 0.5)):
        a1 = max(10.0, min(a1, at - 0.5))
        t1 = max(1.0, min(t1, min(a1, to) - 0.5))
    return round(at, 1), round(to, 1), round(a1, 1), round(t1, 1)


def settings_to_params(s):
    """Simple settings -> the full v3.04 remote key set (SPEC 4.2 allow-list, in its order) for desired.params.
    The v3.05 runner keys and the cap_reset command are the website's (SPEC 11): the app never sends them."""
    lots = settings_lots(s)
    at, to, a1, t1 = _sane_locks(s)
    stages = int(_num(s.get("lock_stages"), 0))
    v = {
        "InpUseA": bool(s.get("use_a")), "InpUseNY": bool(s.get("use_ny")), "InpUseC5G": bool(s.get("use_c5g")),
        "InpUseAsia": bool(s.get("use_asia")),
        "InpLotsA": lots["a"], "InpLotsNY": lots["ny"], "InpLotsC5G": lots["c5g"], "InpMaxLots": max(lots.values()),
        "InpLotsAsia": lots["asia"],
        "InpRecoveryMult": round(_num(s.get("recovery"), 1.5), 2),
        "InpMaxAttempts": int(round(_num(s.get("attempts"), 4))),
        "InpConfluenceMult": round(_num(s.get("conf_mult"), 1.5), 2),
        "InpConfluenceMin": int(round(_num(s.get("conf_min"), 60))),
        "InpDailyCapPct": round(_num(s.get("daily_cap"), 10.0), 1),
        "InpKillBalance": 0.0,
        "InpVirtualStart": round(_num(s.get("balance"), WEB_PRESET_BALANCE), 2),
        "InpMaxSpread": round(_num(s.get("max_spread"), 1.0), 2),
        "InpVolGate": bool(s.get("vol_gate")),
        "InpVolGatePct": round(_num(s.get("vol_gate_pct"), 1.75), 2),
        "InpLockEnable": stages >= 1, "InpLock_A": True, "InpLock_NY": True, "InpLock_C5G": True,
        "InpLockShadow": True, "InpLock1Enable": stages >= 2,
        "InpLockAtPct": at, "InpLockToPct": to, "InpLock1AtPct": a1, "InpLock1ToPct": t1,
    }
    return dict((k, v[k]) for k in da.REMOTE_KEYS if k not in da.V305_KEYS)


def params_to_settings(p):
    """EA keys (desired.params or status.remote.effective) -> simple settings (missing keys: the 7.3 values)."""
    p = p if isinstance(p, dict) else {}
    s = auto_settings(_num(p.get("InpVirtualStart"), WEB_PRESET_BALANCE))

    def b(key, cur):
        v = da.to_bool(p.get(key), None) if not isinstance(p.get(key), bool) else p.get(key)
        return cur if v is None else bool(v)

    def n(key, cur):
        return _num(p.get(key), cur)
    for key, _, use_k, lot_k in MODULES:
        s["use_" + key] = b(use_k, s["use_" + key])
    la, lny, lc = (lot2(n(k, s["lot"])) for k in ("InpLotsA", "InpLotsNY", "InpLotsC5G"))
    s.update(lot_a=la, lot_ny=lny, lot_c5g=lc, lot_asia=lot2(n("InpLotsAsia", s["lot_asia"])))
    s["lot_mode"] = "same" if la == lny == lc else "each"
    s["lot"] = la if s["lot_mode"] == "same" else max(la, lny, lc)
    lock_on, lock1_on = b("InpLockEnable", True), b("InpLock1Enable", True)
    s["lock_stages"] = 2 if (lock_on and lock1_on) else 1 if (lock_on or lock1_on) else 0
    s["lock_at"], s["lock_to"] = n("InpLockAtPct", 95.0), n("InpLockToPct", 93.0)
    s["lock1_at"], s["lock1_to"] = n("InpLock1AtPct", 85.0), n("InpLock1ToPct", 83.0)
    if lock1_on and not lock_on:       # only the first stage on: show it as the one stage
        s["lock_at"], s["lock_to"] = s["lock1_at"], s["lock1_to"]
    s.update(daily_cap=n("InpDailyCapPct", 10.0), recovery=n("InpRecoveryMult", 1.5),
             attempts=int(n("InpMaxAttempts", 4)), conf_mult=n("InpConfluenceMult", 1.5),
             conf_min=int(n("InpConfluenceMin", 60)), max_spread=n("InpMaxSpread", 1.0),
             vol_gate=b("InpVolGate", False), vol_gate_pct=n("InpVolGatePct", 1.75))
    return s


def status_to_settings(status):
    """(settings, source) from the EA status: "ea" = status.remote.effective (v3.04), "ea_v303" = read from the
    v3.03 fields (read only), (None, None) when the status says nothing about the settings."""
    st = status if isinstance(status, dict) else {}
    rem = st.get("remote") if isinstance(st.get("remote"), dict) else {}
    eff = rem.get("effective") if isinstance(rem.get("effective"), dict) else None
    if eff:
        return params_to_settings(eff), "ea"
    mods = dict((m.get("module"), m) for m in st.get("modules") or [] if isinstance(m, dict))
    prm = st.get("params") if isinstance(st.get("params"), dict) else {}
    opt = st.get("options") if isinstance(st.get("options"), dict) else {}
    if not mods and not prm:
        return None, None
    p = {}
    for _, name, use_k, lot_k in MODULES:
        m = mods.get(name)
        if m:
            p[use_k], p[lot_k] = bool(m.get("enabled")), m.get("lots")
    for k, src in (("InpLotsA", "lots_input"), ("InpLotsNY", "lots_ny"), ("InpLotsC5G", "lots_c5g"),
                   ("InpMaxLots", "max_lots"), ("InpRecoveryMult", "recovery_mult"),
                   ("InpDailyCapPct", "daily_cap_pct"), ("InpMaxSpread", "max_spread_input")):
        if k not in p and prm.get(src) is not None:
            p[k] = prm.get(src)
    asia = opt.get("asia") if isinstance(opt.get("asia"), dict) else {}
    if "InpUseAsia" not in p and "enabled" in asia:
        p["InpUseAsia"] = bool(asia.get("enabled"))
    if asia.get("lots") is not None:
        p["InpLotsAsia"] = asia.get("lots")
    for k, src in (("InpMaxAttempts", "max_attempts"), ("InpConfluenceMult", "confluence_mult"),
                   ("InpConfluenceMin", "confluence_min")):
        if opt.get(src) is not None:
            p[k] = opt.get(src)
    vg = opt.get("vol_gate") if isinstance(opt.get("vol_gate"), dict) else {}
    if vg:
        p["InpVolGate"], p["InpVolGatePct"] = bool(vg.get("enabled")), vg.get("pct")
    for blk, en, at, to in (("lock", "InpLockEnable", "InpLockAtPct", "InpLockToPct"),
                            ("lock1", "InpLock1Enable", "InpLock1AtPct", "InpLock1ToPct")):
        lk = opt.get(blk) if isinstance(opt.get(blk), dict) else {}
        if lk:
            p[en], p[at], p[to] = bool(lk.get("enabled")), lk.get("at_pct"), lk.get("to_pct")
    p.setdefault("InpLockEnable", False)
    p.setdefault("InpLock1Enable", False)
    v = st.get("virtual") if isinstance(st.get("virtual"), dict) else {}
    if v.get("start") is not None:
        p["InpVirtualStart"] = v.get("start")
    return params_to_settings(dict((k, x) for k, x in p.items() if x is not None)), "ea_v303"


SETTINGS_SOURCE_TH = {
    "ea": "ค่าที่ Dobby ใน MT5 ใช้อยู่ตอนนี้",
    "ea_v303": "อ่านอย่างเดียว — บอทนี้เป็น v3.03 (แก้ค่าได้ด้วยไฟล์ .set ใน MT5)",
    "web": "ค่าที่ตั้งไว้บนเว็บ (Dobby จะใช้เมื่อไม่มีไม้ค้าง)",
    "ea_last": "ค่าล่าสุดที่ Dobby ส่งมา (ตอนนี้ไม่ได้ทำงาน)",
}


def current_settings(status, desired, ea_online):
    """What the main screen shows as "การตั้งค่าที่ใช้อยู่": the EA's values when it runs, else the web's wish."""
    if ea_online:
        s, src = status_to_settings(status)
        if s:
            return s, src
    params = (desired or {}).get("params") if isinstance(desired, dict) else None
    if isinstance(params, dict) and params:
        return params_to_settings(params), "web"
    s, src = status_to_settings(status)
    if s:
        return s, "ea_last"
    return None, None


def settings_summary(s):
    """Friendly cards: [{key, title, sub}] e.g. 3 สูตรเปิด / ล็อต 0.03 / ล็อก 2 ชั้น / เอเชียปิด / หยุดเมื่อขาดทุน 10%/วัน."""
    on = [name for key, name, _, _ in MODULES[:3] if s.get("use_" + key)]
    out = [{"key": "strategies", "title": ("%d สูตรเปิด" % len(on)) if on else "ปิดสูตรหลักทั้งหมด",
            "sub": " · ".join(on) if on else "ไม่เปิดไม้ใหม่ (ยกเว้นเอเชีย)"}]
    lots = settings_lots(s)
    main = [lots[k] for k, _, _, _ in MODULES[:3] if s.get("use_" + k)] or [lots["a"]]
    if len(set(main)) <= 1:
        out.append({"key": "lot", "title": "ล็อต %.2f" % main[0], "sub": "ทุกสูตร" if len(on) > 1 else "ต่อไม้"})
    else:
        out.append({"key": "lot", "title": "ล็อตแยกสูตร", "sub": " · ".join(
            "%s %.2f" % (name.replace("_new", ""), lots[k]) for k, name, _, _ in MODULES[:3] if s.get("use_" + k))})
    stages = int(_num(s.get("lock_stages"), 0))
    if stages >= 2:
        out.append({"key": "lock", "title": "ล็อก 2 ชั้น", "sub": "%s→%s / %s→%s" % (
            pct_text(s["lock1_at"]), pct_text(s["lock1_to"]), pct_text(s["lock_at"]), pct_text(s["lock_to"]))})
    elif stages == 1:
        out.append({"key": "lock", "title": "ล็อก 1 ชั้น", "sub": "%s→%s" % (pct_text(s["lock_at"]),
                                                                           pct_text(s["lock_to"]))})
    else:
        out.append({"key": "lock", "title": "ไม่ล็อกกำไร", "sub": "ปล่อยถึง TP หรือ SL"})
    if s.get("use_asia"):
        out.append({"key": "asia", "title": "เอเชียเปิด", "sub": "ASIA16 ล็อต %.2f" % lots["asia"]})
    else:
        out.append({"key": "asia", "title": "เอเชียปิด", "sub": "ASIA16"})
    cap = _num(s.get("daily_cap"), 10.0)
    b = da.to_num(s.get("balance"))
    out.append({"key": "cap", "title": "หยุดเมื่อขาดทุน %s%%/วัน" % pct_text(cap),
                "sub": ("≈ %s USD ต่อวัน" % money(b * cap / 100.0)) if b else "ของทุนต้นวัน"})
    return out


def settings_line(s):
    """One line: 3 สูตรเปิด · ล็อต 0.03 · ล็อก 2 ชั้น 85→83 / 95→93 · เอเชียปิด · หยุดเมื่อขาดทุน 10%/วัน"""
    parts = []
    for it in settings_summary(s):
        if it["key"] == "lock" and it["title"] != "ไม่ล็อกกำไร":
            parts.append("%s %s" % (it["title"], it["sub"]))
        elif it["key"] == "lot" and it["title"] == "ล็อตแยกสูตร":
            parts.append("ล็อต %s" % it["sub"])
        else:
            parts.append(it["title"])
    return " · ".join(parts)


def settings_sentence(s):
    """The settings as one plain Thai sentence (shown instead of an "A · B · C" string)."""
    lots = settings_lots(s)
    on = [name for key, name, _, _ in MODULES[:3] if s.get("use_" + key)]
    main = [lots[k] for k, _, _, _ in MODULES[:3] if s.get("use_" + k)] or [lots["a"]]
    parts = []
    if not on:
        parts.append("ปิดสูตรหลักทั้งหมด")
    elif len(set(main)) <= 1:
        parts.append("เปิด %d สูตร (%s) ล็อต %.2f%s" % (len(on), ", ".join(on), main[0],
                                                     " ทุกสูตร" if len(on) > 1 else ""))
    else:
        parts.append("เปิด %d สูตร ล็อต %s" % (len(on), ", ".join(
            "%s %.2f" % (name.replace("_new", ""), lots[k]) for k, name, _, _ in MODULES[:3] if s.get("use_" + k))))
    b = da.to_num(s.get("balance"))
    if b:
        parts.append("จากทุน %s USD" % format(b, ",.0f"))
    stages = int(_num(s.get("lock_stages"), 0))
    if stages >= 2:
        parts.append("ล็อกกำไร 2 ชั้น (%s→%s และ %s→%s)" % (pct_text(s["lock1_at"]), pct_text(s["lock1_to"]),
                                                          pct_text(s["lock_at"]), pct_text(s["lock_to"])))
    elif stages == 1:
        parts.append("ล็อกกำไร 1 ชั้น (%s→%s)" % (pct_text(s["lock_at"]), pct_text(s["lock_to"])))
    else:
        parts.append("ไม่ล็อกกำไร")
    parts.append("เปิดสูตรเอเชีย ล็อต %.2f" % lots["asia"] if s.get("use_asia") else "ปิดสูตรเอเชีย")
    cap = _num(s.get("daily_cap"), 10.0)
    return " ".join(parts) + " และหยุดเปิดไม้เมื่อขาดทุนถึง %s%% ต่อวัน" % pct_text(cap)


def settings_chips(s):
    """A few short chips for the same settings: [(text, tone)]."""
    out = []
    for it in settings_summary(s):
        if it["key"] == "strategies":
            out.append((it["title"].replace("สูตรเปิด", "สูตร"), None))
        elif it["key"] == "lot":
            out.append((it["title"] if it["title"] != "ล็อตแยกสูตร" else "ล็อต " + it["sub"].replace(" · ", ", "), None))
        elif it["key"] == "lock":
            out.append((it["title"], "gold" if it["title"] != "ไม่ล็อกกำไร" else None))
        elif it["key"] == "asia":
            out.append((it["title"], None))
        else:
            out.append(("หยุดที่ %s%%/วัน" % pct_text(_num(s.get("daily_cap"), 10.0)), None))
    return out


# -- lot calculator (SPEC 5.1, research r37: 0.03 lot on a 280 balance, 2025-01 .. 2026-10) ---------------------------
CALC_BASE_BALANCE, CALC_BASE_LOT = 280.0, 0.03
HORIZON30 = [(0.03, 151.79, -151.36, 487.86, 28.7), (0.04, 135.40, -229.53, 663.16, 40.2),
             (0.05, 132.42, -292.65, 776.21, 41.4), (0.06, 90.37, -299.85, 899.49, 50.6),
             (0.08, 31.98, -301.55, 1012.44, 60.9)]
DAILY_BASE = {"losing_pct": 41, "mean": -30.6, "median": -26.2, "p10": -56.4, "p5": -65.3, "worst": -96.9}
RISK_DISCLAIMER = "ตัวเลขนี้เป็นผลจำลองย้อนหลัง ไม่ใช่การคาดการณ์ และตลาดแบบปี 2025 แย่กว่าปี 2026 มาก"


def _interp_row(eq):
    if eq < HORIZON30[0][0] - 1e-9 or eq > HORIZON30[-1][0] + 1e-9:
        return None
    for a, b in zip(HORIZON30, HORIZON30[1:]):
        if eq <= b[0] + 1e-9:
            t = max(0.0, min(1.0, (eq - a[0]) / (b[0] - a[0])))
            return tuple(a[i] + (b[i] - a[i]) * t for i in range(1, 5))
    return HORIZON30[-1][1:]


def usd(x, signed=True):
    if x is None:
        return "-"
    v = abs(x)
    txt = ("{:,.0f}" if v >= 100 else "{:,.2f}").format(v)
    return ("+" if x >= 0 else "−") + txt + " USD" if signed else txt + " USD"


def risk_estimate(balance, lot, cap_pct=10.0):
    """SPEC 5.1 scaling: equivalent lot at 280 = lot x 280 / B, money x B / 280, interpolated on the table.
    Returns {eq_lot, kind (in | near | below | above), median, p10, p90, half_pct, daily_mean, text, details}."""
    b, lot = da.to_num(balance), da.to_num(lot)
    if b is None or b <= 0 or lot is None or lot <= 0:
        return None
    eq = lot * CALC_BASE_BALANCE / b
    scale = b / CALC_BASE_BALANCE
    row = _interp_row(eq)
    kind = "in"
    if row is None and eq < HORIZON30[0][0]:
        kind = "near" if eq >= 0.025 - 1e-9 else "below"
        row = HORIZON30[0][1:]
    elif row is None:
        kind = "above"
    out = {"eq_lot": eq, "kind": kind, "balance": b, "lot": lot}
    dscale = (eq / CALC_BASE_LOT) * scale
    out["daily_mean"] = DAILY_BASE["mean"] * dscale
    out["daily_worst"] = DAILY_BASE["worst"] * dscale
    if row is not None:
        med, p10, p90, half = row
        out.update(median=med * scale, p10=p10 * scale, p90=p90 * scale, half_pct=half)
    if kind in ("in", "near"):
        out["text"] = "ผลจำลอง 30 วัน%s: กลาง ๆ %s กรณีแย่ (1 ใน 10) %s และโอกาสทุนลดเหลือครึ่ง %s%.0f%%" % (
            " (โดยประมาณ)" if kind == "near" else "", usd(out["median"]), usd(out["p10"]),
            "~" if kind == "near" else "", out["half_pct"])
    elif kind == "below":
        out["text"] = "ล็อตนี้เล็กกว่าระดับที่ทดสอบ (เสี่ยงน้อยกว่า) วันที่ขาดทุนเฉลี่ยราว %s" % usd(out["daily_mean"])
    else:
        out["text"] = "ล็อตนี้เสี่ยงกว่าที่ทดสอบ (เกินล็อต 0.08 ต่อทุน 280) ขาดทุนแรงได้ แนะนำลดล็อต"
    det = ["เทียบเท่าล็อต %.3f ที่ทุน 280 (ช่วงที่ทดสอบ 0.03 ถึง 0.08)" % eq]
    if row is not None and kind != "below":
        det.append("ใน 30 วัน กรณีดี (1 ใน 10) %s กลาง ๆ %s และกรณีแย่ (1 ใน 10) %s" % (
            usd(out["p90"]), usd(out["median"]), usd(out["p10"])))
    det.append("วันที่ขาดทุนมีราว %d%% ของวัน เฉลี่ย %s และแย่สุดที่เคยเจอ %s" % (
        DAILY_BASE["losing_pct"], usd(out["daily_mean"]), usd(out["daily_worst"])))
    if cap_pct:
        det.append("Dobby หยุดเองเมื่อขาดทุนถึง %s%% ของทุนต้นวัน (≈ %s)" % (pct_text(cap_pct),
                                                                         usd(b * cap_pct / 100.0, False)))
    det.append(RISK_DISCLAIMER)
    out["details"] = det
    return out


# ---------------------------------------------------------------------------------------------------------------------
# EA inputs (Dobby3_v305.mq5 input block, in order) and the generic preset Dobby3_v305_web.set (SPEC 7.4)
# ---------------------------------------------------------------------------------------------------------------------
EA_INPUTS = [
    ("InpUseA", "bool", True), ("InpUseNY", "bool", True), ("InpUseC5G", "bool", True),
    ("InpLotsA", "double", 0.02), ("InpLotsNY", "double", 0.02), ("InpLotsC5G", "double", 0.02),
    ("InpMaxLots", "double", 0.02), ("InpRecoveryMult", "double", 1.0),
    ("InpA_SLCap", "double", 6.0), ("InpA_TPRatio", "double", 1.5), ("InpA_ATRMult", "double", 1.5),
    ("InpA_PivotM", "int", 3), ("InpA_PivotN", "int", 40), ("InpA_TimeStop", "int", 48),
    ("InpA_Rollover", "bool", True),
    ("InpNY_Cap", "double", 8.0), ("InpNY_Floor", "double", 3.0), ("InpNY_ATRMult", "double", 2.0),
    ("InpNY_TPRatio", "double", 1.0), ("InpNY_Buffer", "double", 0.20), ("InpNY_RangeMin", "int", 990),
    ("InpNY_LastMin", "int", 1245), ("InpNY_FlatMin", "int", 1380),
    ("InpC5_Cap", "double", 10.0), ("InpC5_Floor", "double", 4.0), ("InpC5_ATRMult", "double", 1.0),
    ("InpC5_TPRatio", "double", 1.5), ("InpC5_TimeStop", "int", 48), ("InpC5_MinBars", "int", 4),
    ("InpC5_Touch", "int", 3),
    ("InpVirtualStart", "double", 200.0), ("InpKillBalance", "double", 0.0), ("InpDailyCapPct", "double", 10.0),
    ("InpStartDate", "datetime", 0),
    ("InpMagicA", "long", 26102402), ("InpMagicNY", "long", 26102403), ("InpMagicC5G", "long", 26102404),
    ("InpMaxSpread", "double", 1.00), ("InpUseControl", "bool", True), ("InpAllowLive", "bool", False),
    ("InpControlInTester", "bool", False),
    ("InpVolGate", "bool", False), ("InpVolGatePct", "double", 1.75), ("InpMaxAttempts", "int", 2),
    ("InpConfluenceMult", "double", 1.0), ("InpConfluenceMin", "int", 60), ("InpUseAsia", "bool", False),
    ("InpLotsAsia", "double", 0.01), ("InpMagicAsia", "long", 26102405), ("InpAsia_EntryMin", "int", 75),
    ("InpAsia_LastMin", "int", 120), ("InpAsia_ExitMin", "int", 975), ("InpAsia_ATRMult", "double", 2.0),
    ("InpAsia_SLFloor", "double", 8.0), ("InpAsia_SLCap", "double", 20.0), ("InpAsia_MaxSpread", "double", 0.40),
    ("InpLockEnable", "bool", False), ("InpLockAtPct", "double", 95.0), ("InpLockToPct", "double", 93.0),
    ("InpLock_A", "bool", True), ("InpLock_NY", "bool", True), ("InpLock_C5G", "bool", True),
    ("InpLockShadow", "bool", True),
    ("InpLock1Enable", "bool", False), ("InpLock1AtPct", "double", 82.0), ("InpLock1ToPct", "double", 80.0),
    ("InpRemoteParams", "bool", False), ("InpRemoteLive", "bool", False), ("InpRemoteMaxLots", "double", 0.10),
    ("InpRemoteMaxCapPct", "double", 10.0), ("InpRemoteFile", "string", "Dobby\\dobby3_remote.txt"),
    ("InpRemoteTesterFrom", "datetime", 0),
    # group "v3.05 runner (web)" (contract 2026-11-10 §1): OFF by default = v3.04 behaviour trade for trade
    ("InpRunnerEnable", "bool", False), ("InpRunner_A", "bool", True), ("InpRunner_NY", "bool", True),
    ("InpRunner_C5G", "bool", True), ("InpRunnerKeepPct", "double", 75.0), ("InpRunnerStep", "double", 0.5),
    ("InpRunnerMaxSteps", "int", 0), ("InpRunnerSafetyTP", "double", 4.0),
]
EA_INPUT_KIND = dict((k, t) for k, t, _ in EA_INPUTS)
RUNNER_DEFAULTS = dict((k, d) for k, _, d in EA_INPUTS if k in da.V305_KEYS)   # the eight runner inputs
WEB_PRESET_COMMENTS = [
    "Dobby3 v3.05 web preset (Dobby3_v305_web.set), written by Dobby App: the same file for every friend.",
    "= EA defaults + the auto settings for a 300 USD account (0.03 lot each, locks 85->83 / 95->93, ASIA16 off).",
    "Remote ON: the Dobby website sets lots, balance, locks and the runner (InpRemoteParams=true, ceilings 0.50 lot /",
    "10% cap) and switches live trading (InpRemoteLive=true). InpAllowLive=false: no live trade until live=1 arrives.",
    "Runner mode OFF (InpRunnerEnable=false) = v3.04 behaviour; the website switches it on per bot.",
]


def ea_defaults():
    return dict((k, d) for k, _, d in EA_INPUTS)


def web_preset_values(balance=WEB_PRESET_BALANCE):
    """SPEC 7.4: EA defaults + 7.3 values for B = 300 + remote on (ceilings 0.50 / 10) + InpAllowLive=false."""
    v = ea_defaults()
    v.update(settings_to_params(auto_settings(balance)))
    v.update(InpRemoteParams=True, InpRemoteLive=True, InpRemoteMaxLots=PRESET_MAX_LOTS,
             InpRemoteMaxCapPct=PRESET_MAX_CAP, InpAllowLive=False)
    return v


def set_value_text(kind, value):
    if kind == "bool":
        return "true" if value else "false"
    if kind == "string":
        return str(value)
    if kind == "double":
        r = round(float(value), 8)
        return ("%.1f" % r) if r == int(r) else repr(r)
    return str(int(round(float(value))))


def set_line(key, kind, value):
    """MT5 .set line: `key=value||start||step||stop||N` (bools: `key=v||false||0||true||N`, strings: `key=value`)."""
    t = set_value_text(kind, value)
    if kind == "bool":
        return "%s=%s||false||0||true||N" % (key, t)
    if kind == "string":
        return "%s=%s" % (key, t)
    return "%s=%s||%s||0||%s||N" % (key, t, t, t)


def render_set(values, comments=()):
    lines = ["; " + c for c in comments] + [set_line(k, t, values.get(k, d)) for k, t, d in EA_INPUTS]
    return "\r\n".join(lines) + "\r\n"


def set_bytes(values, comments=()):
    """UTF-16LE with a BOM, CRLF (what MT5 writes and reads)."""
    return b"\xff\xfe" + render_set(values, comments).encode("utf-16-le")


def web_preset_bytes():
    return set_bytes(web_preset_values(), WEB_PRESET_COMMENTS)


def parse_set(data):
    """.set bytes or text -> [(key, value text)] in file order (comments skipped)."""
    if isinstance(data, bytes):
        if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
            data = data.decode("utf-16")
        else:
            data = data.decode("utf-8-sig")
    out = []
    for ln in data.splitlines():
        ln = ln.strip()
        if not ln or ln.startswith(";") or "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        out.append((k.strip(), v.split("||")[0].strip()))
    return out


def preset_target(data_dir):
    return os.path.join(data_dir, "MQL5", "Presets", WEB_PRESET_NAME)


def install_web_preset(data_dir):
    """Write Dobby3_v305_web.set into <data>\\MQL5\\Presets (our own file: replaced when different)."""
    target = preset_target(data_dir)
    res = install_file(target, web_preset_bytes(), overwrite=True)
    LOG.info("preset written: %s (%s)", WEB_PRESET_NAME, res)
    return target, res


_EA_VER = re.compile(r"^dobby3_v(\d+)", re.I)


def pick_ea_file(files):
    """The newest Dobby3_v3*.ex5 of the `downloads` bucket (highest version, then newest upload)."""
    eas = [f for f in files or [] if f.get("kind") == "ea" and f.get("name", "").lower().startswith("dobby")]
    if not eas:
        return None

    def key(f):
        m = _EA_VER.match(f["name"])
        return (1 if m else 0, int(m.group(1)) if m else 0, f.get("updated_at") or "", f["name"])
    return max(eas, key=key)


def ea_target(data_dir, name):
    return install_target(data_dir, name)


def ea_installed(data_dir, name):
    t = ea_target(data_dir, name) if data_dir and name else None
    return bool(t and os.path.isfile(t))


def installed_ea_name(data_dir):
    """The newest Dobby3 .ex5 already in <data>\\MQL5\\Experts\\Dobby ('' when none)."""
    names = [n.split("\\")[-1] for n in ea_files_in(data_dir) if n.lower().startswith("dobby\\")]
    picked = pick_ea_file([{"name": n, "kind": "ea"} for n in names])
    return picked["name"] if picked else ""


# ---------------------------------------------------------------------------------------------------------------------
# "เปิด MT5 พร้อม Dobby": checks, the startup ini, the launch (only after the user confirms)
# ---------------------------------------------------------------------------------------------------------------------
def mt5_install_dir(data_dir):
    """Where terminal64.exe lives: origin.txt, or the data folder itself for a portable install."""
    if not data_dir:
        return ""
    origin = read_origin(os.path.join(data_dir, "origin.txt"))
    if origin:
        return origin
    if os.path.isfile(os.path.join(data_dir, TERMINAL_EXE)):
        return data_dir
    return ""


def terminal_exe(install_dir):
    p = os.path.join(install_dir, TERMINAL_EXE) if install_dir else ""
    return p if p and os.path.isfile(p) else None


def read_text_any(path, limit=8 * 1024 * 1024):
    """A text file MT5 wrote (UTF-16LE with BOM, or UTF-8/ANSI). None when unreadable."""
    try:
        with open(path, "rb") as f:
            data = f.read(limit)
    except OSError:
        return None
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", "replace")
    if len(data) >= 4 and data[1:2] == b"\x00" and data[3:4] == b"\x00":
        return data.decode("utf-16-le", "replace")
    return data.decode("utf-8", "replace")


_EXPERT_START = re.compile(r"<expert>", re.I)
_EXPERT_END = re.compile(r"</expert>", re.I)


def chart_experts(data_dir):
    """Every EA attached to a chart in any profile: <data>\\MQL5\\Profiles\\Charts\\<profile>\\*.chr <expert> blocks.
    [{profile, file, symbol, name, path}]"""
    root = os.path.join(data_dir or "", "MQL5", "Profiles", "Charts")
    out = []
    try:
        profiles = sorted(os.listdir(root))
    except OSError:
        return out
    for prof in profiles:
        pdir = os.path.join(root, prof)
        try:
            names = sorted(n for n in os.listdir(pdir) if n.lower().endswith(".chr"))
        except OSError:
            continue
        for n in names:
            text = read_text_any(os.path.join(pdir, n))
            if not text:
                continue
            msym = re.search(r"^\s*symbol=(.+?)\s*$", text, re.M)
            pos = 0
            while True:
                m = _EXPERT_START.search(text, pos)
                if not m:
                    break
                e = _EXPERT_END.search(text, m.end())
                block = text[m.end():e.start() if e else len(text)]
                pos = e.end() if e else len(text)
                head = block.split("<inputs>")[0]
                mn = re.search(r"^\s*name=(.*?)\s*$", head, re.M)
                mp = re.search(r"^\s*path=(.*?)\s*$", head, re.M)
                out.append({"profile": prof, "file": n, "symbol": msym.group(1) if msym else "",
                            "name": mn.group(1) if mn else "", "path": mp.group(1) if mp else ""})
    return out


def dobby_charts(data_dir):
    """Charts that already run a Dobby EA (two Dobby EAs on one account would double-trade)."""
    return [c for c in chart_experts(data_dir) if "dobby" in ("%s %s" % (c["name"], c["path"])).lower()]


def broker_symbols(data_dir, prefix="XAU"):
    """Gold symbols this MT5 has data for (<data>\\bases\\<server>\\history|ticks\\<SYMBOL>), XAUUSD first."""
    found = set()
    servers = terminal_servers(data_dir) or []
    for srv in servers:
        for sub in ("history", "ticks"):
            try:
                names = os.listdir(os.path.join(data_dir, "bases", srv, sub))
            except OSError:
                continue
            for n in names:
                if n.upper().startswith(prefix) and valid_symbol(n):
                    found.add(n)
    return sorted(found, key=lambda s: (s.upper() != "XAUUSD", len(s), s.upper()))


_SYMBOL = re.compile(r"^[A-Za-z0-9._#+\-]{3,32}$")


def valid_symbol(sym):
    return bool(_SYMBOL.match(sym or ""))


def windows_terminal_processes():
    """Running terminal64.exe processes [{pid, path}] (read only; path '' when Windows does not tell)."""
    if os.name != "nt":
        return []
    import ctypes
    from ctypes import wintypes

    class PE32(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PE32)]
    k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PE32)]
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                               ctypes.POINTER(wintypes.DWORD)]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snap in (None, 0, ctypes.c_void_p(-1).value):
        raise OSError("CreateToolhelp32Snapshot failed (%d)" % ctypes.get_last_error())
    out = []
    try:
        e = PE32()
        e.dwSize = ctypes.sizeof(PE32)
        ok = k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            if e.szExeFile.lower() == TERMINAL_EXE:
                path = ""
                h = k32.OpenProcess(0x1000, False, e.th32ProcessID)      # PROCESS_QUERY_LIMITED_INFORMATION
                if h:
                    buf = ctypes.create_unicode_buffer(1024)
                    size = wintypes.DWORD(1024)
                    if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                        path = buf.value
                    k32.CloseHandle(h)
                out.append({"pid": int(e.th32ProcessID), "path": path})
            ok = k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        k32.CloseHandle(snap)
    return out


def terminal_running(install_dir, procs):
    """True when this MT5 runs (or a terminal64.exe whose path Windows hides), None when unknown."""
    if procs is None:
        return None
    exe = os.path.normcase(os.path.abspath(os.path.join(install_dir or "", TERMINAL_EXE)))
    for p in procs:
        path = (p or {}).get("path") or ""
        if not path or os.path.normcase(os.path.abspath(path)) == exe:
            return True
    return False


def startup_ini_text(expert, preset, symbol, period="M15"):
    """MT5 /config: file: a new <symbol> <period> chart with the EA + its preset, Algo Trading on."""
    return "\r\n".join([
        "[StartUp]", "Expert=%s" % expert, "ExpertParameters=%s" % preset, "Symbol=%s" % symbol,
        "Period=%s" % period, "[Experts]", "Enabled=1", "AllowLiveTrading=1"]) + "\r\n"


def startup_ini_bytes(text):
    return b"\xff\xfe" + text.encode("utf-16-le")       # UTF-16LE with a BOM, like MT5's own ini files


AUTOSTART_TH = {
    "no_mt5": ("ยังไม่ได้เลือก MT5", "เลือก MT5 ที่จะใช้กับ Dobby ก่อน"),
    "no_terminal": ("ไม่พบโปรแกรม MT5 (terminal64.exe)", "ใช้วิธี \"ทำเองใน MT5\" ด้านล่างแทน"),
    "no_ea": ("ยังไม่ได้ติดตั้ง Dobby ใน MT5 นี้", "รอให้ติดตั้งเสร็จ หรือกด ติดตั้งอีกครั้ง"),
    "no_preset": ("ยังไม่มีพรีเซ็ต %s" % WEB_PRESET_NAME, "รอให้ติดตั้งเสร็จ หรือกด ติดตั้งอีกครั้ง"),
    "bad_symbol": ("ชื่อสัญลักษณ์ทองไม่ถูกต้อง", "ใช้ชื่อตามโบรกของคุณ เช่น XAUUSD"),
    "mt5_unknown": ("ตรวจไม่ได้ว่า MT5 ปิดอยู่หรือไม่", "ใช้วิธี \"ทำเองใน MT5\" ด้านล่างแทน"),
    "mt5_running": ("ปิด MT5 ก่อน", "แอปเปิดกราฟใหม่ให้ได้เฉพาะตอนเริ่ม MT5: ใน MT5 กด File > Exit แล้วกด ตรวจอีกครั้ง"),
    "dobby_attached": ("Dobby ติดกราฟอยู่แล้วใน MT5 นี้", "ไม่ต้องเปิดเพิ่ม: Dobby สองตัวในบัญชีเดียวจะเทรดซ้ำกัน"),
    "dobby_running": ("มี Dobby ทำงานอยู่แล้วในเครื่องนี้", "Dobby ใน MT5 อีกตัวกำลังส่งสัญญาณ: ไม่ต้องเปิดเพิ่ม"),
}
_AUTOSTART_ORDER = ["dobby_attached", "dobby_running", "no_mt5", "no_terminal", "mt5_unknown", "mt5_running",
                    "no_ea", "no_preset", "bad_symbol"]


def autostart_check(data_dir, ex5_name, common, symbol, procs, now=None):
    """Can the app start this MT5 with Dobby? {ok, problems: [{code, title, text}], exe, install_dir, expert,
    symbol, charts, ini}. Refuses when MT5 runs, when a chart already has Dobby, or when a Dobby EA runs elsewhere."""
    now = time.time() if now is None else now
    codes = []
    install = mt5_install_dir(data_dir) if data_dir else ""
    exe = terminal_exe(install)
    charts = dobby_charts(data_dir) if data_dir else []
    if not data_dir or not is_data_dir(data_dir):
        codes.append("no_mt5")
    else:
        if exe is None:
            codes.append("no_terminal")
        if not ea_installed(data_dir, ex5_name):
            codes.append("no_ea")
        if not os.path.isfile(preset_target(data_dir)):
            codes.append("no_preset")
    if not valid_symbol(symbol):
        codes.append("bad_symbol")
    if exe is not None:
        running = terminal_running(install, procs)
        if running is None:
            codes.append("mt5_unknown")
        elif running:
            codes.append("mt5_running")
    if charts:
        codes.append("dobby_attached")
    else:
        age = heartbeat_age(da.read_status_file(os.path.join(common, da.STATUS_NAME), attempts=1), now) \
            if common else None
        if age is not None and age < EA_ONLINE_S:
            codes.append("dobby_running")
    codes.sort(key=_AUTOSTART_ORDER.index)
    probs = []
    for c in codes:
        title, text = AUTOSTART_TH[c]
        if c == "dobby_attached":
            ch = charts[0]
            text = "พบบนกราฟ %s (โปรไฟล์ %s, %s): %s" % (ch["symbol"] or "-", ch["profile"], ch["file"], text)
        probs.append({"code": c, "title": title, "text": text})
    expert = ("Dobby\\" + os.path.splitext(ex5_name)[0]) if ex5_name else ""
    return {"ok": not probs, "problems": probs, "exe": exe, "install_dir": install, "expert": expert,
            "symbol": symbol, "charts": charts,
            "ini": startup_ini_text(expert, WEB_PRESET_NAME, symbol) if expert and valid_symbol(symbol) else ""}


def remote_live_now(common):
    """True when an existing dobby3_remote.txt already says live=1 (a newly started Dobby would trade at once)."""
    text = da.read_text(os.path.join(common or "", da.REMOTE_NAME), attempts=1) if common else None
    return any(ln.replace(" ", "").lower() == "live=1" for ln in da.file_body(text or ""))


def launch_command(exe, ini):
    return '"%s" /config:"%s"' % (exe, ini)


def real_launch(cmdline, cwd):
    """The ONLY place that starts another program: the user's MT5, after "เปิด MT5 พร้อม Dobby" was confirmed."""
    import subprocess
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(cmdline, cwd=cwd or None, close_fds=True, creationflags=flags).pid


def start_mt5(ctx, check):
    """Write the startup ini into the app data folder and start terminal64.exe /config:<ini>.
    (False, problems) when the check refused; (True, {cmd, ini, pid}) otherwise."""
    if not check.get("ok") or not check.get("ini") or not check.get("exe"):
        return False, check.get("problems") or []
    os.makedirs(ctx.data_dir, exist_ok=True)
    ini = os.path.join(ctx.data_dir, STARTUP_INI_NAME)
    da.atomic_write_bytes(ini, startup_ini_bytes(check["ini"]))
    cmd = launch_command(check["exe"], ini)
    pid = ctx.launch(cmd, check["install_dir"])
    LOG.info("MT5 started with Dobby: %s (%s M15)", cmd, check["symbol"])
    return True, {"cmd": cmd, "ini": ini, "pid": pid}


# ---------------------------------------------------------------------------------------------------------------------
# Bots: choose / link / create (the wizard)
# ---------------------------------------------------------------------------------------------------------------------
def clean_bot_name(name):
    return " ".join(unicodedata.normalize("NFC", str(name or "")).split())[:100]


def default_bot_name(bots):
    names = set(clean_bot_name(b.get("name")).lower() for b in bots or [])
    if "dobby" not in names:
        return "Dobby"
    n = 2
    while ("dobby %d" % n) in names:
        n += 1
    return "Dobby %d" % n


def bot_seen_age(bot, now):
    t = da.parse_utc((bot or {}).get("last_seen"))
    return None if t is None else max(0.0, now - t)


def bot_online(bot, now):
    age = bot_seen_age(bot, now)
    return age is not None and age < EA_ONLINE_S


def bot_max_lot(desired):
    """The largest lot an existing bot's web state asks for (params lots, control lots), None when none."""
    d = desired if isinstance(desired, dict) else {}
    lots = []
    p = d.get("params") if isinstance(d.get("params"), dict) else {}
    for k in ("InpLotsA", "InpLotsNY", "InpLotsC5G", "InpMaxLots", "InpLotsAsia"):
        x = da.to_num(p.get(k))
        if x:
            lots.append(x)
    c = d.get("control") if isinstance(d.get("control"), dict) else {}
    x = da.to_num(c.get("lots"))
    if x:
        lots.append(x)
    return max(lots) if lots else None


def new_bot_desired(params):
    """SPEC 7.4: a new bot starts live, running both directions, no blackouts, the chosen settings."""
    return {"live": True, "control": {"mode": "run", "allow_long": True, "allow_short": True},
            "blackouts": [], "params": dict(params)}


def create_bot(client, data_dir, common, name, params, limits, kind="dobby", clock=time.time):
    """register_bot with the chosen settings; the agent applies v1 at its first cycle after Start."""
    name = clean_bot_name(name)
    if not name:
        raise ValueError("bot name is empty")
    bot_id = client.rpc("register_bot", {"p_name": name, "p_desired": new_bot_desired(params)})
    if not isinstance(bot_id, str) or not bot_id:
        raise da.ApiError(500, "no bot id in the answer")

    def mut(c):
        c["bot_id"], c["bot_name"] = bot_id, name
        c["limits"] = dict(limits)
        c["app"].update(pending_bot_name="", wizard_done=True, bot_kind=kind)
    update_app_config(data_dir, mut)
    da.write_json_atomic(state_path(data_dir), da.first_state(common, clock(), applied_version=0))
    APPLOG.info("bot \"%s\" created on the website (live on, %d settings)", name, len(params))
    return bot_id


def link_bot(data_dir, common, bot, limits, clock=time.time):
    """Use an existing bot on this PC: no new bot, its web settings are kept as they are."""
    link_existing_bot(data_dir, common, bot, clock=clock)

    def mut(c):
        c["limits"] = dict(limits)
        c["app"].update(wizard_done=True, bot_kind=c["app"].get("bot_kind") or "dobby")
    update_app_config(data_dir, mut)


# ---------------------------------------------------------------------------------------------------------------------
# Activity in plain Thai (main screen), hero state
# ---------------------------------------------------------------------------------------------------------------------
SIDE_TH = {"BUY": "ซื้อ", "SELL": "ขาย"}


def journal_tail(path, n=12, max_bytes=65536):
    """The last n journal rows (read only)."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            f.seek(max(0, size - max_bytes))
            data = f.read()
    except OSError:
        return []
    lines = data.split(b"\n")
    if size > max_bytes:
        lines = lines[1:]
    rows = []
    for raw in lines:
        raw = raw.rstrip(b"\r")
        if raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        if not raw.strip() or raw.startswith(b"time_server,"):
            continue
        row = da.parse_journal_line(raw.decode("utf-8", "replace"))
        if row:
            rows.append(row)
    return rows[-n:]


def journal_activity(row):
    """(tone, Thai text) for an EA journal row worth showing, else None."""
    ev = (row.get("event") or "").upper()
    tag = row.get("tag") or ""
    side = SIDE_TH.get((row.get("side") or "").upper(), row.get("side") or "")
    det = row.get("detail") or ""
    if ev == "OPEN":
        return "info", "เปิดไม้ %s %s %s ล็อต ที่ราคา %s" % (tag, side, da._f2(row.get("lots")), da._f2(row.get("price")))
    if ev == "CLOSE":
        pnl = row.get("pnl") or 0.0
        return ("good" if pnl >= 0 else "bad"), "ปิดไม้ %s %s %s" % (tag, "กำไร" if pnl >= 0 else "ขาดทุน",
                                                                   money(pnl, True))
    if ev in ("LOCK", "LOCK1"):
        return "good", "ล็อกกำไร %s%s: เลื่อน SL ไป %s" % (tag, " (ชั้นแรก)" if ev == "LOCK1" else "",
                                                          da._f2(row.get("sl")))
    if ev == "ERROR":
        return "bad", "Dobby แจ้งปัญหา (%s): %s" % (tag or "-", det[:90])
    if ev == "START":
        return "info", "Dobby เริ่มทำงานใน MT5"
    if ev == "STOP":
        return "idle", "Dobby หยุดใน MT5"
    if ev == "REMOTE":
        d = det.upper()
        if d.startswith("APPLY"):
            return "good", "Dobby ใช้การตั้งค่าใหม่จากเว็บแล้ว"
        if d.startswith("WAIT"):
            return "warn", "Dobby รอให้ไม่มีไม้ค้างก่อนใช้การตั้งค่าใหม่"
        if d.startswith("REJECT"):
            return "bad", "Dobby ไม่รับการตั้งค่าจากเว็บ (ค่าเกินเพดาน)"
        if d.startswith("LIVE ON") or "LIVE=1" in d:
            return "good", "เปิดเทรดจริงแล้ว (คำสั่งจากเว็บ)"
        if d.startswith("LIVE OFF") or "LIVE=0" in d:
            return "warn", "ปิดเทรดจริงแล้ว (คำสั่งจากเว็บ)"
    return None


_APP_ACTIVITY = [
    (re.compile(r"^Dobby App \S+ start: bot \"(.*?)\""), "info", "เริ่มทำงาน: เชื่อม MT5 กับเว็บแล้ว"),
    (re.compile(r"^stop pressed"), "idle", "กดหยุดทำงานแล้ว"),
    (re.compile(r"^decision: v(\d+) applied \| live=on"), "good", "รับคำสั่งจากเว็บแล้ว (เทรดจริงเปิด)"),
    (re.compile(r"^decision: v(\d+) applied \| live=off"), "warn", "รับคำสั่งจากเว็บแล้ว (เทรดจริงปิด)"),
    (re.compile(r"^decision: v(\d+) NOT applied"), "warn", "ไม่ใช้คำสั่งจากเว็บ (ปิดรับคำสั่งไว้)"),
    (re.compile(r"^EA offline"), "bad", "Dobby ใน MT5 ไม่ส่งสัญญาณ"),
    (re.compile(r"^EA back online"), "good", "Dobby ใน MT5 กลับมาทำงาน"),
    (re.compile(r"^network: "), "warn", "เชื่อมต่อเว็บไม่ได้ จะลองใหม่เอง"),
    (re.compile(r"^login: "), "bad", "เข้าสู่ระบบไม่ได้ ต้องเข้าสู่ระบบใหม่"),
    (re.compile(r"^bot \"(.*)\" created on the website"), "good", "สร้างบอท \"\\1\" บนเว็บแล้ว"),
    (re.compile(r"^this PC is now linked to the bot \"(.*)\""), "good", "เชื่อมเครื่องนี้กับบอท \"\\1\" แล้ว"),
    (re.compile(r"^MT5 started with Dobby"), "info", "เปิด MT5 พร้อม Dobby แล้ว"),
    (re.compile(r"^start refused"), "bad", "เริ่มทำงานไม่ได้"),
    (re.compile(r"^auto blackouts: (\d+) window\(s\) in the next 7 days, next (\S+) - (\S+) \((.*)\)$"), "info",
     _auto_activity),
    (re.compile(r"^cash flow suggested on the website: (\S+)"), "info",
     "พบเงินเข้า-ออกบัญชี \\1 ที่ไม่ใช่ผลเทรดของ Dobby: ยืนยันได้บนเว็บ"),
]


def app_activity(msg):
    """(tone, Thai text) for the agent/app log lines worth showing on the main screen, else None."""
    for rx, tone, th in _APP_ACTIVITY:
        m = rx.search(msg or "")
        if m:
            return tone, (th(m) if callable(th) else m.expand(th))
    return None


def hero_state(cfg, status, snap, now, running, stopping=False, phase=None, lock_problem=None, agent_error=None,
               started_at=None):
    """The main screen's big status: {tone good|warn|bad|idle|info, title, text, action, action_label}.
    action: start | wizard | signin | mt5 | algo_help | web | safety | None."""
    cfg = cfg or {}
    st = status if isinstance(status, dict) else None
    age = heartbeat_age(st, now) if st else None
    ea_on = age is not None and age < EA_ONLINE_S
    acc = (st or {}).get("account") if isinstance((st or {}).get("account"), dict) else {}
    flags = (st or {}).get("flags") if isinstance((st or {}).get("flags"), dict) else {}
    ctl = (st or {}).get("control") if isinstance((st or {}).get("control"), dict) else {}
    virt = (st or {}).get("virtual") if isinstance((st or {}).get("virtual"), dict) else {}
    remote = (st or {}).get("remote") if isinstance((st or {}).get("remote"), dict) else {}
    snap = snap or {}
    err = (snap.get("last_error") or "") if running else (agent_error or "")

    def out(tone, title, text, action=None, label=None, stamp=None):
        """stamp: the hallmark (tone gold | slate | cinnabar, state word); by default from the tone."""
        if stamp is None:
            stamp = {"good": ("gold", "เทรดจริง"), "bad": ("cinnabar", "ต้องแก้"), "warn": ("cinnabar", "รอ MT5"),
                     "info": ("slate", "ตั้งค่า"), "idle": ("slate", "หยุดอยู่")}[tone]
        return {"tone": tone, "title": title, "text": text, "action": action, "action_label": label,
                "stamp": stamp}
    if stopping:
        return out("idle", "กำลังหยุด…", "รอให้รอบสุดท้ายจบ แอปไม่เขียนไฟล์ของ Dobby แล้ว", stamp=("slate", "กำลังหยุด"))
    if not config_complete(cfg):
        if not cfg.get("refresh_token"):
            return out("info", "ยังไม่ได้เข้าสู่ระบบ", "เข้าสู่ระบบด้วยบัญชีเว็บ Dobby แล้วเลือกบอท", "wizard",
                       "ตั้งค่าต่อ")
        return out("info", "ยังตั้งค่าไม่เสร็จ", "เลือกบอทและตั้งค่าให้เสร็จก่อน ใช้เวลาไม่กี่นาที", "wizard", "ตั้งค่าต่อ")
    if not running:
        if lock_problem:
            if lock_problem.get("holder") is not None:
                return out("bad", "มี Dobby อีกตัวทำงานอยู่แล้ว",
                           "%s ทำงานกับ MT5 นี้อยู่: ปิดตัวนั้นก่อน แล้วกดเริ่มอีกครั้ง" % da.lock_holder_text(
                               lock_problem["holder"]), "start", "ลองอีกครั้ง")
            return out("bad", "เริ่มทำงานไม่ได้", "สร้างไฟล์ล็อกในโฟลเดอร์ของ Dobby ไม่ได้: %s"
                       % (lock_problem.get("error") or "-"), "start", "ลองอีกครั้ง")
        if err.startswith("login:"):
            return out("bad", "ต้องเข้าสู่ระบบใหม่", "การเข้าสู่ระบบหมดอายุ: เข้าสู่ระบบอีกครั้งแล้วกดเริ่ม", "signin",
                       "เข้าสู่ระบบ")
        if not ea_on:
            return out("idle", "Dobby หยุดอยู่", "ยังไม่พบ Dobby ทำงานใน MT5 เชื่อม MT5 ก่อน แล้วกด เริ่มทำงาน Dobby "
                       "เพื่อเชื่อมกับเว็บ", "mt5", "เชื่อม MT5")
        return out("idle", "Dobby หยุดอยู่", "กด เริ่มทำงาน Dobby เพื่อให้บอทรับคำสั่งจากเว็บและส่งข้อมูลขึ้นเว็บ")
    if err.startswith("login:"):
        return out("bad", "ต้องเข้าสู่ระบบใหม่", "แอปเข้าสู่ระบบเว็บไม่ได้ จึงรับคำสั่งจากเว็บไม่ได้", "signin",
                   "เข้าสู่ระบบ")
    if phase in ("waiting_ea", "registering"):
        return out("warn", "รอ MT5", "รอ Dobby เริ่มทำงานใน MT5 เพื่อสร้างบอทบนเว็บ", "mt5", "เชื่อม MT5")
    if not ea_on:
        if st is None:
            text = "ยังไม่พบ Dobby ทำงานใน MT5: เปิด MT5 ที่มี Dobby ติดกราฟ XAUUSD M15"
        else:
            text = "Dobby ใน MT5 ไม่ส่งสัญญาณมา %s: MT5 ปิดอยู่ หรือ Dobby ถูกเอาออกจากกราฟ" % ago_th(age).replace(
                "ที่แล้ว", "")
        return out("warn", "รอ MT5", text, "mt5", "เชื่อม MT5")
    if acc.get("trade_permitted") is not True:
        return out("warn", "รอ MT5", "ปุ่ม Algo Trading ใน MT5 ยังไม่เปิด: กดให้เป็นสีเขียว", "algo_help", "ดูวิธีเปิด")
    if err.startswith("network:"):
        return out("warn", "เชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ต แอปจะลองใหม่เอง (Dobby ใน MT5 ทำงานต่อตามคำสั่งล่าสุด)",
                   stamp=("cinnabar", "ออฟไลน์"))
    if err:
        t, d = explain_error(err)
        return out("bad", t, d)
    if "live_not_allowed_locally" in (snap.get("rejected") or []):
        return out("warn", "เว็บสั่งเปิดเทรดจริง แต่เครื่องนี้ไม่อนุญาต", "เปิดได้ที่ ตั้งค่า > ความปลอดภัย", "safety",
                   "เปิดความปลอดภัย", stamp=("slate", "ไม่เทรดจริง"))
    if flags.get("live_locked"):
        how = "เปิดได้จากเว็บ (สวิตช์ เทรดจริง)" if remote.get("live_enabled") else \
            "ตั้ง InpAllowLive = true ใน Dobby หรือใช้พรีเซ็ต %s" % WEB_PRESET_NAME
        return out("warn", "Dobby ยังไม่เปิดเทรดจริง", how, "web", "เปิดเว็บ", stamp=("slate", "ไม่เทรดจริง"))
    if str(ctl.get("mode") or "run").lower() == "pause":
        return out("warn", "Dobby หยุดชั่วคราว", "เว็บสั่งหยุดไว้: บอทไม่เปิดไม้ใหม่ สั่งทำงานต่อได้บนเว็บ", "web", "เปิดเว็บ",
                   stamp=("slate", "พักอยู่"))
    if virt.get("day_cap_hit"):
        return out("warn", "วันนี้หยุดเทรดแล้ว", "ขาดทุนถึงเพดานรายวัน Dobby จะเริ่มเทรดใหม่เองวันพรุ่งนี้",
                   stamp=("slate", "พักวันนี้"))
    mode = str(acc.get("mode") or "").upper()
    title = "Dobby กำลังเทรดจริง" if mode == "REAL" else "Dobby กำลังเทรด (บัญชีทดลอง)" if mode == "DEMO" else \
        "Dobby กำลังเทรด"
    bits = []
    if started_at:
        bits.append("ทำงานมาแล้ว %s" % duration_th(now - started_at))
    if snap.get("last_ok_at"):
        bits.append("ส่งข้อมูลขึ้นเว็บล่าสุด %s" % ago_th(now - snap["last_ok_at"]))
    elif not snap:
        bits.append("กำลังเชื่อมต่อเว็บ…")
    word = "เทรดจริง" if mode == "REAL" else "ทดลอง" if mode == "DEMO" else "ทำงาน"
    return out("good", title, " และ".join(bits) or "ทุกอย่างพร้อม", stamp=("gold", word))


# ---------------------------------------------------------------------------------------------------------------------
# Demo backend (in-memory Supabase + Telegram) and fake MT5 / EA files - for --demo and --selftest, never the network
# ---------------------------------------------------------------------------------------------------------------------
def _iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def demo_ff_week(now):
    """A synthetic ForexFactory week (SPEC 9.3) for --demo / --selftest: USD high-impact news 3 h and 27 h ahead and
    one EUR medium item (filtered out by the default settings)."""
    base = (int(now) // 3600 + 3) * 3600

    def ny(t):
        return da.epoch_to_naive(t - 5 * 3600).strftime("%Y-%m-%dT%H:%M:%S") + "-05:00"
    return [{"title": "CPI m/m", "country": "USD", "date": ny(base), "impact": "High", "forecast": "0.3%",
             "previous": "0.4%"},
            {"title": "German ZEW Economic Sentiment", "country": "EUR", "date": ny(base + 3600), "impact": "Medium",
             "forecast": "", "previous": "39.3"},
            {"title": "Unemployment Claims", "country": "USD", "date": ny(base + 24 * 3600), "impact": "High",
             "forecast": "221K", "previous": "219K"}]


class DemoServer(object):
    """Stands in for Supabase (auth, PostgREST, RPC, Storage) and Telegram. Any password works except "wrong".
    An email containing "pending" is not approved; one containing "new" is a new user without bots; every other
    email is the demo owner with the bots "คอมหลัก" (online, v3.03) and "DESKTOP-NPNL85P" (never seen)."""

    OWNER = "demo-user-0001"

    def __init__(self, url=DEFAULT_URL, key=DEFAULT_KEY, latency=0.0, clock=time.time):
        self.url = url.rstrip("/")
        self.key = key
        self.latency = latency
        self.clock = clock
        self.lock = threading.Lock()
        now = clock()
        self.user_id = None
        self.email = ""
        self.approved = True
        self.n = 0
        self.refresh = {}           # refresh token -> (user id, email, approved)
        self.access = {}            # access token -> (expires, user id, approved)
        self.bots = [
            {"id": "7d1f2c3a-0000-4000-8000-000000000001", "name": "คอมหลัก", "last_seen": _iso(now - 25),
             "ea_version": "3.03", "symbol": "XAUUSD", "created_at": "2026-11-02T03:00:00Z", "owner": self.OWNER},
            {"id": "7d1f2c3a-0000-4000-8000-000000000002", "name": "DESKTOP-NPNL85P", "last_seen": None,
             "ea_version": None, "symbol": None, "created_at": "2026-11-07T08:12:00Z", "owner": self.OWNER},
        ]
        self.control = {
            self.bots[0]["id"]: {"version": 12, "updated_at": _iso(now - 3600), "desired": {
                "live": True, "control": {"mode": "run", "lots": 0.10, "allow_long": True, "allow_short": True,
                                          "max_spread": None, "note": ""}, "blackouts": [], "params": None}},
            self.bots[1]["id"]: {"version": 1, "updated_at": _iso(now - 7200), "desired": {
                "live": False, "control": {"mode": "run", "lots": None, "allow_long": True, "allow_short": True,
                                           "max_spread": None, "note": "registered by Dobby App"},
                "blackouts": [], "params": None}},
        }
        self.files = [("Dobby3_v303.ex5", 181248, "2026-11-03T06:00:00Z"),
                      ("Dobby3_v304.ex5", 186368, "2026-11-07T06:00:00Z"),
                      ("Dobby3_v305.ex5", 191488, "2026-11-10T06:00:00Z"),
                      ("Dobby3_usd280_0.03each.set", 9812, "2026-11-05T06:00:00Z"),
                      ("DobbyApp.exe", 11534336, "2026-11-07T09:00:00Z")]
        self.registered = []        # register_bot bodies
        self.downloads = []
        self.status_posts = 0
        self.journal_rows = 0
        self.bars_rows = 0          # SPEC 9.1
        self.cash_rows = []         # SPEC 9.2
        self.news_calls = 0         # SPEC 9.3 (the ForexFactory week, synthetic)
        self.telegram = []

    def web_change(self, bot_id, **control):
        """The website changes the desired state (demo of a new version / a rejection)."""
        with self.lock:
            row = self.control[bot_id]
            row["desired"]["control"].update(control)
            row["version"] += 1
            row["updated_at"] = _iso(self.clock())

    def web_auto(self, bot_id, news=True, schedule=True):
        """The website turns on automatic blackouts (SPEC 9.3): USD high-impact news and Friday night."""
        with self.lock:
            row = self.control[bot_id]
            d = row["desired"]
            if news:
                d["auto_news"] = {"enabled": True, "before_min": 30, "after_min": 60, "currencies": ["USD"],
                                  "impact": ["High"]}
            if schedule:
                d["schedule"] = {"enabled": True, "us_holidays": True,
                                 "weekly": [{"dow": 5, "from": "21:00", "to": "24:00"}]}
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
        if url == da.NEWS_URL:
            self.news_calls += 1
            return self._resp(200, demo_ff_week(self.clock()))
        if not url.startswith(self.url):
            raise da.NetworkError("demo: unknown host %s" % url.split("/")[2])
        if headers.get("apikey") != self.key:
            return self._resp(401, {"message": "Invalid API key"})
        path = url[len(self.url):]
        with self.lock:
            if path == "/auth/v1/token":
                return self._token(params, body or {})
            tok = (headers.get("Authorization") or "")[7:]
            sess = self.access.get(tok)
            if sess is None or sess[0] < self.clock():
                return self._resp(401, {"message": "JWT expired"})
            uid, approved = sess[1], sess[2]
            if path.startswith("/storage/v1/"):
                return self._storage(method, path[len("/storage/v1/"):], body, approved)
            if path.startswith("/rest/v1/"):
                return self._rest(method, path[len("/rest/v1/"):], params, body, uid, approved)
        return self._resp(404, {"message": "no route"})

    def _token(self, params, body):
        grant = params.get("grant_type")
        if grant == "password":
            if not body.get("password") or body.get("password") == "wrong":
                return self._resp(400, {"error_code": "invalid_credentials", "msg": "Invalid login credentials"})
            email = body.get("email") or ""
            uid = ("demo-user-new-%08x" % (zlib.crc32(email.encode("utf-8")) & 0xffffffff)) if "new" in email \
                else self.OWNER
            sess = (uid, email, "pending" not in email)
        elif grant == "refresh_token":
            sess = self.refresh.pop(body.get("refresh_token"), None)
            if sess is None:
                return self._resp(400, {"error_code": "refresh_token_not_found", "msg": "Invalid Refresh Token"})
        else:
            return self._resp(400, {"msg": "unsupported grant"})
        self.user_id, self.email, self.approved = sess
        self.n += 1
        access, refresh = "demo-access-%d-%s" % (self.n, uuid.uuid4().hex[:8]), "demo-refresh-%d-%s" % (
            self.n, uuid.uuid4().hex[:8])
        self.access[access] = (self.clock() + 3600, sess[0], sess[2])
        self.refresh[refresh] = sess
        return self._resp(200, {"access_token": access, "expires_in": 3600, "expires_at": int(self.clock() + 3600),
                                "refresh_token": refresh, "user": {"id": sess[0], "email": sess[1]}})

    def _storage(self, method, path, body, approved):
        if not approved:
            return self._resp(400, {"statusCode": "403", "error": "Unauthorized", "message": "not approved"})
        if method == "POST" and path == "object/list/" + BUCKET:
            return self._resp(200, [{"name": n, "id": "f%d" % i, "updated_at": u,
                                     "metadata": {"size": s, "mimetype": "application/octet-stream"}}
                                    for i, (n, s, u) in enumerate(self.files)])
        prefix = "object/authenticated/%s/" % BUCKET
        if method == "GET" and path.startswith(prefix):
            name = path[len(prefix):]
            for n, s, u in self.files:
                if quote(n, safe="/") == name:
                    self.downloads.append(n)
                    return self._resp(200, raw=("DEMO FILE %s\r\n" % n).encode("utf-8"))
            return self._resp(400, {"statusCode": "404", "error": "not_found", "message": "Object not found"})
        return self._resp(404, {"message": "no storage route"})

    @staticmethod
    def _ids(params, key):
        v = params.get(key) or ""
        if v.startswith("eq."):
            return [v[3:]]
        if v.startswith("in.(") and v.endswith(")"):
            return [x for x in v[4:-1].split(",") if x]
        return [v] if v else []

    def _rest(self, method, table, params, body, uid, approved):
        now = self.clock()
        if table == "rpc/is_approved":
            return self._resp(200, approved)
        if not approved:
            return self._resp(400, {"code": "P0001", "message": "not_approved"})
        mine = [b for b in self.bots if b["owner"] == uid]
        if table == "rpc/register_bot":
            bid = str(uuid.uuid4())
            self.registered.append(dict(body))
            self.bots.append({"id": bid, "name": body["p_name"], "last_seen": None, "ea_version": None,
                              "symbol": None, "created_at": _iso(now), "owner": uid})
            self.control[bid] = {"version": 1, "desired": body["p_desired"], "updated_at": _iso(now)}
            return self._resp(200, bid)
        if table == "bots" and method == "GET":
            owner = self._ids(params, "owner")
            rows = [b for b in mine if not owner or b["owner"] in owner]
            return self._resp(200, [dict((k, v) for k, v in b.items() if k != "owner") for b in rows])
        if table == "bots" and method == "PATCH":
            for b in mine:
                if b["id"] in self._ids(params, "id"):
                    b.update(dict((k, v) for k, v in (body or {}).items() if k != "agent_state"))
                    b["last_seen"] = _iso(now)
            return self._resp(204)
        if table == "bot_status" and method == "POST":
            self.status_posts += 1
            return self._resp(201)
        if table == "journal" and method == "POST":
            self.journal_rows += len(body or [])
            return self._resp(201)
        if table == "bars" and method == "POST":
            self.bars_rows += len(body or [])
            return self._resp(201)
        if table == "cash_flows" and method == "POST":
            self.cash_rows += list(body or [])
            return self._resp(201)
        if table == "bot_control":
            ids = [i for i in self._ids(params, "bot_id") if any(b["id"] == i for b in mine)]
            if method == "GET":
                return self._resp(200, [dict(self.control[i], bot_id=i) for i in ids if i in self.control])
            if method == "PATCH" and ids:
                row = self.control[ids[0]]
                if params.get("version") and params["version"] != "eq.%d" % row["version"]:
                    return self._resp(200, [])
                row["desired"] = body["desired"]
                row["version"] += 1
                return self._resp(200, [dict(row, bot_id=ids[0])])
            return self._resp(200, [])
        return self._resp(404, {"message": "no route %s %s" % (method, table)})


def _chr_text(symbol, experts=(), indicator=None):
    """A minimal MT5 chart file (.chr) with optional <expert> blocks and an indicator."""
    lines = ["<chart>", "id=133000000000000001", "symbol=%s" % symbol, "description=", "period_type=0",
             "period_size=15", "digits=2", "<window>", "height=100.000000"]
    if indicator:
        lines += ["<indicator>", "name=Custom Indicator", "path=Indicators\\%s.ex5" % indicator, "</indicator>"]
    lines.append("</window>")
    for name, path in experts:
        lines += ["<expert>", "name=%s" % name, "path=%s" % path, "expertmode=1", "<inputs>", "InpUseA=true",
                  "</inputs>", "</expert>"]
    lines.append("</chart>")
    return "\r\n".join(lines) + "\r\n"


def write_chart(data_dir, profile, file_name, symbol, experts=(), indicator=None):
    d = os.path.join(data_dir, "MQL5", "Profiles", "Charts", profile)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, file_name)
    with open(p, "wb") as f:
        f.write(b"\xff\xfe" + _chr_text(symbol, experts, indicator).encode("utf-16-le"))
    return p


DEMO_TERMINALS = [("D0E8209F77C8CF37AD8BF550E51FF075", "TMGM MetaTrader 5", "TMGM-Live", True),
                  ("2F5A1C0B9E7D4A3B8C6D5E4F3A2B1C0D", "MetaTrader 5", "MetaQuotes-Demo", False)]


def build_demo_appdata(base, with_common=False):
    """A fake %APPDATA% with two MT5 data folders. Their install folders (with a dummy terminal64.exe that is never
    started) are under <base>\\Programs. MT5 #1 has a EURUSD chart (an indicator, no EA); MT5 #2 already runs
    Dobby3_v303 on a chart (the "Dobby already attached" case)."""
    term = terminals_root(base)
    for i, (tid, inst, server, utf16) in enumerate(DEMO_TERMINALS):
        install = os.path.join(base, "Programs", inst)
        os.makedirs(install, exist_ok=True)
        with open(os.path.join(install, TERMINAL_EXE), "wb") as f:
            f.write(b"DEMO terminal64.exe - a placeholder, never started\r\n")
        d = os.path.join(term, tid)
        for sub in (("MQL5", "Experts", "Advisors"), ("MQL5", "Presets"), ("bases", server, "history", "XAUUSD"),
                    ("bases", server, "history", "EURUSD"), ("bases", "Default", "history", "XAUUSD"), ("logs",)):
            os.makedirs(os.path.join(d, *sub), exist_ok=True)
        if i == 0:
            os.makedirs(os.path.join(d, "bases", server, "ticks", "XAUUSD.s"), exist_ok=True)
        with open(os.path.join(d, "origin.txt"), "wb") as f:
            f.write(b"\xff\xfe" + install.encode("utf-16-le") if utf16 else install.encode("utf-8"))
        if i == 0:
            write_chart(d, "Default", "chart01.chr", "EURUSD", experts=[("MACD Sample", "Experts\\MACD Sample.ex5")],
                        indicator="Dobby3_View")
        else:
            write_chart(d, "Default", "chart01.chr", "XAUUSD",
                        experts=[("Dobby3_v303", "Experts\\Dobby\\Dobby3_v303.ex5")])
        t = time.time() - 3600 - i * 86400 * 5
        os.utime(os.path.join(d, "logs"), (t, t))
        os.utime(d, (t, t))
    os.makedirs(os.path.join(term, "Common", "Files"), exist_ok=True)
    if with_common:
        os.makedirs(default_common_dir(base), exist_ok=True)
    return base


class DemoEA(object):
    """A fake Dobby3 v3.05 in a TEMP common folder: writes dobby2_status.json (schema 6) + a short journal like a
    running EA, and reads dobby3_remote.txt like the real one (InpRemoteParams / InpRemoteLive on: live, the web
    settings incl. the runner keys, and the one-shot `cap_reset` token)."""

    def __init__(self, common, offset_min=120, clock=time.time, balance=1000.0):
        self.common = common
        self.offset_min = offset_min
        self.clock = clock
        self.thread = None
        self.stop_event = threading.Event()
        self.profit = 11.0
        self._bars_at = None
        self.balance = balance
        self.trade_permitted = True
        self.live_locked = None             # None: follow the remote file (live=1 -> unlocked)
        self.position = True
        self.paused = None
        self.effective = settings_to_params(auto_settings(WEB_PRESET_BALANCE))
        self.effective.update(RUNNER_DEFAULTS)
        self.live = False
        self.remote_version = 0
        self._remote_mtime = None
        self._journal_add = []
        self.day_cap_hit = False            # contract §3: a cap_reset token is applied only while the cap is hit
        self.cap_reset_seen = 0             # last token seen (applied or ignored), like Dobby3_capreset_<magic>
        self.cap_reset_applied = 0
        self.cap_resets_today = 0

    def _read_remote(self):
        p = os.path.join(self.common, da.REMOTE_NAME)
        try:
            mt = os.stat(p).st_mtime
        except OSError:
            return
        if mt == self._remote_mtime:
            return
        self._remote_mtime = mt
        text = da.read_text(p) or ""
        ver, changes = 0, []
        for ln in da.file_body(text):
            if "=" not in ln:
                continue
            k, v = [x.strip() for x in ln.split("=", 1)]
            if k == "version":
                ver = int(da.to_num(v) or 0)
            elif k == "live":
                if self.live != (v == "1"):
                    self._journal_add.append(("REMOTE", "LIVE %s v%d" % ("on" if v == "1" else "off", ver)))
                self.live = v == "1"
            elif k == "cap_reset":
                tok = int(da.to_num(v) or 0)
                if tok > self.cap_reset_seen:
                    self.cap_reset_seen = tok
                    if self.day_cap_hit:
                        self.day_cap_hit = False
                        self.cap_reset_applied = tok
                        self.cap_resets_today += 1
                        self._journal_add.append(("DAYCAP_RESET", "day P&L -> 0.00, token %d" % tok))
                    else:
                        self._journal_add.append(("DAYCAP_RESET", "IGNORED: cap not hit, token %d" % tok))
            elif k in self.effective:
                kind = da.REMOTE_SPEC[k][0]
                val = (v == "true") if kind == "bool" else (int(float(v)) if kind == "int" else float(v))
                if self.effective[k] != val:
                    changes.append("%s %s->%s" % (k, self.effective[k], v))
                    self.effective[k] = val
        if changes:
            self._journal_add.append(("REMOTE", "APPLY v%d: %s" % (ver, ", ".join(changes[:4]))))
        self.remote_version = ver

    def status(self):
        self._read_remote()
        now = self.clock()
        server = da.epoch_to_naive(now + self.offset_min * 60).strftime("%Y.%m.%d %H:%M:%S")
        day = server[:10]
        e = self.effective
        lots = e["InpLotsC5G"]
        opened = da.epoch_to_naive((int(now + self.offset_min * 60) // 900) * 900 - 9 * 900)
        runner = {"on": bool(e["InpRunnerEnable"] and e["InpRunner_C5G"]), "converted": False, "k": 0,
                  "sl_floor": None, "target": None}
        pos = {"open": True, "module": "C5G", "ticket": 4123, "side": "BUY", "lots": lots, "open_price": 4012.30,
               "sl": 4005.90, "tp": 4021.90, "profit": round(self.profit, 2), "swap": 0.0,
               "open_time": opened.strftime("%Y.%m.%d %H:%M:%S"), "runner": runner} if self.position else {
            "open": False, "module": "C5G"}
        locked = (not self.live) if self.live_locked is None else self.live_locked
        mods = [{"module": name, "enabled": bool(e[use_k]), "lots": e[lot_k]} for _, name, use_k, lot_k in MODULES]
        return {
            "schema_version": 6, "ea": "Dobby3", "ea_version": "3.05", "tag": "A_new+NY+C5G", "symbol": "XAUUSD",
            "server_time": server, "heartbeat_gmt_unix": int(now),
            "account": {"mode": "REAL", "currency": "USD", "balance": self.balance,
                        "equity": round(self.balance + self.profit, 2), "connected": True,
                        "trade_permitted": self.trade_permitted},
            "virtual": {"start": e["InpVirtualStart"], "balance": round(e["InpVirtualStart"] + 32.4, 2), "day": day,
                        "day_start": e["InpVirtualStart"], "day_pnl": 12.4, "day_cap_hit": self.day_cap_hit,
                        "trades": 12, "wins": 7, "losses": 5, "cap_reset_applied": self.cap_reset_applied,
                        "cap_resets_today": self.cap_resets_today},
            "modules": mods,
            "positions": [{"open": False, "module": "A_new"}, {"open": False, "module": "NY"}, pos],
            "position": pos,
            "control": {"file_exists": True, "mode": self.paused or "run", "lots": lots, "id": "W001"},
            "flags": {"live_locked": locked, "allow_live_input": False},
            "params": {"daily_cap_pct": e["InpDailyCapPct"], "lots_input": e["InpLotsA"], "max_lots": e["InpMaxLots"],
                       "runner": {"enable": bool(e["InpRunnerEnable"]), "a": bool(e["InpRunner_A"]),
                                  "ny": bool(e["InpRunner_NY"]), "c5g": bool(e["InpRunner_C5G"]),
                                  "keep_pct": e["InpRunnerKeepPct"], "step": e["InpRunnerStep"],
                                  "max_steps": e["InpRunnerMaxSteps"], "safety_tp": e["InpRunnerSafetyTP"]}},
            "remote": {"params_enabled": True, "live_enabled": True,
                       "file_exists": os.path.exists(os.path.join(self.common, da.REMOTE_NAME)),
                       "version": self.remote_version, "applied_version": self.remote_version, "pending": False,
                       "waiting": "", "live": self.live, "rejects": "",
                       "ceilings": {"max_lots": PRESET_MAX_LOTS, "max_cap_pct": PRESET_MAX_CAP},
                       "effective": dict(e)},
            "last_event": "%s 09:45:00 OPEN C5G BUY %.2f @ 4012.30 SL 4005.90 TP 4021.90" % (day, lots),
            "last_error": "",
        }

    def write(self):
        os.makedirs(self.common, exist_ok=True)
        st = self.status()
        da.write_json_atomic(os.path.join(self.common, da.STATUS_NAME), st)
        jp = os.path.join(self.common, da.JOURNAL_NAME)
        day = st["server_time"][:10]
        if not os.path.exists(jp):
            with open(jp, "w", encoding="utf-8", newline="") as f:
                f.write(da.JOURNAL_HEADER + "\r\n")
                f.write("%s 00:05:00,START,ALL,NONE,0.00,,,,0.00,1032.40,0,v3.05 demo\r\n" % day)
                f.write("%s 08:15:00,OPEN,A_new,SELL,0.03,4019.10,4025.10,4010.10,0.00,1032.40,0,demo\r\n" % day)
                f.write("%s 08:58:00,LOCK1,A_new,SELL,0.03,4011.40,4011.45,4010.10,0.00,1032.40,0,stage-1 85->83\r\n"
                        % day)
                f.write("%s 09:02:00,CLOSE,A_new,SELL,0.03,4010.10,,,13.50,1045.90,0,reason=tp\r\n" % day)
                f.write("%s 09:45:00,OPEN,C5G,BUY,0.03,4012.30,4005.90,4021.90,0.00,1045.90,0,demo\r\n" % day)
        if self._journal_add:
            with open(jp, "a", encoding="utf-8", newline="") as f:
                for ev, det in self._journal_add:
                    f.write("%s,%s,ALL,NONE,0.00,,,,0.00,1045.90,0,%s\r\n" % (st["server_time"], ev, det))
            self._journal_add = []

        self._write_bars(self.clock())

    def _write_bars(self, now):
        """dobby2_bars.csv like the EA's: the last 24 h of M15 bars (server time), close and VWAP, rewritten when a
        new bar starts. The shape is the same every run (fixed seed), ending near 4,016."""
        bar = (int(now + self.offset_min * 60) // 900) * 900          # server-time epoch of the current bar
        if bar == self._bars_at:
            return
        self._bars_at = bar
        rnd = random.Random(20261107)
        closes, p = [], 3962.0
        for i in range(96):
            p += rnd.gauss(0.55, 3.6) + (6.0 if i in (21, 22) else 0.0) - (5.0 if i in (47, 48) else 0.0)
            closes.append(p)
        shift = 4015.98 - closes[-1]
        lines = ["bar_time,decision_time,close,rsi,atr,sl_dist,h4_close,h4_ema,h4_ema_prev,trend,bull,bear,signal,"
                 "note,vwap,vwap_touch,decision"]
        tot = cnt = 0.0
        day = None
        for i, c in enumerate(closes):
            t = da.epoch_to_naive(bar - (95 - i) * 900).strftime("%Y.%m.%d %H:%M:%S")
            if t[:10] != day:
                day, tot, cnt = t[:10], 0.0, 0.0
            c += shift
            tot, cnt = tot + c, cnt + 1
            lines.append("%s,%s,%.2f,51.0,6.5,6.0,%.2f,%.2f,%.2f,1,0,0,0,,%.3f,0,demo" % (
                t, t, c, c, c - 20, c - 21, tot / cnt))
        os.makedirs(self.common, exist_ok=True)
        tmp = os.path.join(self.common, da.BARS_NAME + ".tmp")
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write("\r\n".join(lines) + "\r\n")
        os.replace(tmp, os.path.join(self.common, da.BARS_NAME))

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


def _octagon_d(x, y, a, r):
    """Signed distance to a flat-sided regular octagon centred on 0 (apothem a, corners rounded by r)."""
    kx, ky, kz = -0.9238795325, 0.3826834323, 0.4142135623
    a -= r
    px_, py_ = abs(x), abs(y)
    d = min(kx * px_ + ky * py_, 0.0)
    px_, py_ = px_ - 2.0 * d * kx, py_ - 2.0 * d * ky
    d = min(-kx * px_ + ky * py_, 0.0)
    px_, py_ = px_ + 2.0 * d * kx, py_ - 2.0 * d * ky
    qx, qy = px_ - max(-kz * a, min(kz * a, px_)), py_ - a
    return math.hypot(qx, qy) * (1.0 if qy >= 0 else -1.0) - r


def icon_rgba(size):
    """The Dobby App icon: the hallmark brand mark - a struck gold octagon plate with one engraved ring and an
    engraved "D" (DESIGN.md: fine gold #D4AE52, engrave #6B4E10). 4x4 supersampled."""
    hi, mid, lo = (237, 213, 143), (212, 174, 82), (168, 130, 44)
    engrave = (107, 78, 16)
    out = bytearray(size * size * 4)
    n = 4

    def plate(x, y):
        t = max(0.0, min(1.0, (x + y) / 2.0))
        return _mix(hi, mid, t / 0.48) if t < 0.48 else _mix(mid, lo, (t - 0.48) / 0.52)

    def d_in(x, y):                       # the "D": a stem and a bowl, as strokes
        w = 0.085
        if 0.33 <= x <= 0.33 + w and 0.28 <= y <= 0.72:
            return True
        if 0.33 <= x <= 0.52 and (0.28 <= y <= 0.28 + w or 0.72 - w <= y <= 0.72):
            return True
        if x >= 0.52:
            dist = math.hypot(x - 0.52, y - 0.5)
            return 0.22 - w <= dist <= 0.22
        return False

    for py in range(size):
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(n):
                for sx in range(n):
                    x = (px + (sx + 0.5) / n) / size
                    y = (py + (sy + 0.5) / n) / size
                    d = _octagon_d(x - 0.5, y - 0.5, 0.47, 0.11)
                    if d > 0:
                        continue
                    ring = abs(_octagon_d(x - 0.5, y - 0.5, 0.395, 0.08)) <= max(0.012, 0.6 / size)
                    if d_in(x, y):
                        c = engrave
                    elif ring:
                        c = _mix(plate(x, y), engrave, 0.7)
                    else:
                        c = plate(x, y)
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
    """Save the window as PNG. Returns the method used ('gdi' | 'pillow').
    PrintWindow first: it renders the window's own content even when another window (a full-screen game, a
    browser) covers it, so the self-test never captures - or needs - whatever else is on the screen."""
    left, top, right, bottom = window_rect(hwnd)
    try:
        _gdi_capture(hwnd, path, (left, top, right, bottom))
        return "gdi"
    except Exception:
        try:
            from PIL import ImageGrab
        except ImportError:
            raise
        img = ImageGrab.grab(bbox=(left, top, right, bottom), all_screens=True)
        img.save(path)
        return "pillow"


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
