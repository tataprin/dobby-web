#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Dobby Web PC agent.

The only program on a PC that talks to Supabase for Dobby Web (contract: SPEC.md section 3, tables in section 2,
remote allow-list in 4.2, feature batch in 9). It reads the EA's files in Common\\Files\\Dobby (dobby2_status.json,
dobby2_journal.csv, dobby2_bars.csv), uploads them, and writes ONLY dobby2_control.txt and dobby3_remote.txt from the
website's desired state after checking the local limits in agent_config.json. Since 1.2.0 it also suggests deposits /
withdrawals (cash_flows) and adds automatic blackouts (ForexFactory news, a weekly schedule, NYSE holidays) to the
control file. It never trades, never imports MetaTrader5 and never touches MT5 settings.

  python dobby_agent.py setup                       Supabase URL + publishable key, EA folder check, Telegram
  python dobby_agent.py login                       email + password (typed by you; only a refresh token is stored)
  python dobby_agent.py register --name "Main PC"   create this bot on the website from the EA's current state
  python dobby_agent.py limits --allow-control on --allow-live off --allow-params off --max-lots 0.10 --max-cap 10
  python dobby_agent.py run [--once] [--dry-run]    the loop (Ctrl+C stops it)
  python dobby_agent.py status                      config (secrets hidden), limits, applied version, EA heartbeat
  python dobby_agent.py test-telegram               send a test message
  python dobby_agent.py rename --name "คอมหลัก"      fix the bot name stored on this PC (also --name-file, --from-web)

Quick stop of remote control:  python dobby_agent.py limits --allow-control off
One agent per MT5: `run` and the Dobby App (dobby_app.py) both hold Common\\Files\\Dobby\\dobby_agent.lock.
Python >= 3.8, standard library + requests.
"""
import argparse
import calendar
import copy
import csv
import errno
import getpass
import hashlib
import json
import logging
import logging.handlers
import math
import os
import re
import socket
import sys
import threading
import time
from datetime import datetime, timedelta

try:
    import requests
except ImportError:  # only the real HTTP transport needs it; the tests inject a fake transport
    requests = None

AGENT_VERSION = "1.3.0"

LOG = logging.getLogger("dobby_agent")
LOG.addHandler(logging.NullHandler())

# ---------------------------------------------------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------------------------------------------------
STATUS_NAME = "dobby2_status.json"
JOURNAL_NAME = "dobby2_journal.csv"
CONTROL_NAME = "dobby2_control.txt"
BARS_NAME = "dobby2_bars.csv"
BARS_KEEP = 96                 # 24 h of M15 bars for the website chart (SPEC 8)
REMOTE_NAME = "dobby3_remote.txt"
CONFIG_NAME = "agent_config.json"
STATE_NAME = "agent_state.json"
LOG_NAME = "agent.log"
DECISIONS_NAME = "agent_decisions.log"
LOCK_NAME = "agent.lock"
COMMON_LOCK_NAME = "dobby_agent.lock"   # in the EA folder: one agent (CLI or Dobby App) per MT5

JOURNAL_HEADER = "time_server,event,tag,side,lots,price,sl,tp,pnl,v_balance,step,detail"
JOURNAL_FIELDS = JOURNAL_HEADER.split(",")
JOURNAL_BATCH = 500
SEEN_HASHES_MAX = 5000

OFFLINE_AFTER_S = 120          # EA heartbeat older than this -> offline alert
STATUS_MIN_INTERVAL_S = 10     # bot_status upsert at most every 10 s
BOTS_MIN_INTERVAL_S = 30       # bots update at most every 30 s (forced right after a control apply)
TOKEN_MARGIN_S = 60            # refresh the access token when less than 60 s are left
MAX_BACKOFF_S = 60
OFFSET_TOLERANCE_S = 450       # half of the 15-minute offset grid
MAX_BLACKOUT_LINES = 100

EXIT_OK, EXIT_CRASH, EXIT_CONFIG, EXIT_RUNNING = 0, 1, 2, 3

# Feature batch 2026-11-07 (SPEC 9)
BARS_BATCH = 500                    # 9.1 bars upload: rows per POST
BARS_BACKFILL_S = 45 * 86400        # 9.1 first upload: at most the last 45 days
API_RETRY_S = 600                   # a refused optional upload (e.g. schema.sql not re-run yet) is retried after 10 min
CASH_MIN_ABS = 10.0                 # 9.2 a balance change is a deposit / withdrawal suggestion from max(10, 0.5 % of old)
CASH_MIN_PCT = 0.5
CASH_CONFIRM_S = 15                 # ... and only when it is still unexplained one cycle (and >= 15 s) later
CASH_NOTE = "balance change not explained by Dobby trades"
NEWS_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
NEWS_CACHE_NAME = "news_cache.json"
NEWS_USER_AGENT = "DobbyAgent/1.2"
NEWS_REFRESH_S = 4 * 3600           # 9.3 fetch the ForexFactory week at most every 4 h
NEWS_RETRY_S = 30 * 60              # after a failed fetch (the last good copy stays in use)
NEWS_WEEK_OVER_REFRESH_S = 2 * 3600 # the cached week is over: look for the new week every 2 h
NEWS_TIMEOUT_S = 15
NEWS_MAX_BYTES = 2 * 1024 * 1024
NEWS_REPORT_MAX = 60
# SPEC 10.6 shadow AI: while a Dobby trade is open, ask the Edge Function `shadow` what Claude would do (log only)
SHADOW_PATH = "/functions/v1/shadow"
SHADOW_LOG_NAME = "shadow_decisions.jsonl"
SHADOW_INTERVAL_S = 300             # until the function answers with its own next_after_s
SHADOW_TIMEOUT_S = 75
SHADOW_TOKEN_LEFT_S = 150           # the call uses the current access token only when it has this long left
SHADOW_BARS = 32                    # 8 h of M15 bars in the snapshot
SHADOW_JOURNAL_ROWS = 12
SHADOW_PAUSE_S = {"shadow_disabled": 1800, "ai_not_configured": 1800, "shadow_budget": 3600, "not_approved": 3600,
                  "bot_not_found": 3600}
SHADOW_RETRY_S = 120                # network error / 5xx
AUTO_HORIZON_S = 7 * 86400          # automatic blackouts: the next 7 days
THAI_OFFSET_S = 7 * 3600            # schedule windows are Thai time (UTC+7, no DST)
AUTO_NEWS_DEFAULTS = {"before_min": 30, "after_min": 60, "currencies": ["USD"], "impact": ["High"]}
NEWS_IMPACTS = ("High", "Medium", "Low", "Holiday")
SCHEDULE_REASON = "ตารางเวลา"
WEEKLY_MAX = 14
# NYSE full-day closures 2026-2027 (New York dates; Saturday holidays observed on Friday, Sunday ones on Monday;
# New Year 2028 falls on a Saturday and is not observed on 2027-12-31)
NYSE_HOLIDAYS = [
    ("2026-01-01", "New Year's Day"), ("2026-01-19", "Martin Luther King Jr. Day"),
    ("2026-02-16", "Washington's Birthday"), ("2026-04-03", "Good Friday"), ("2026-05-25", "Memorial Day"),
    ("2026-06-19", "Juneteenth"), ("2026-07-03", "Independence Day (observed)"), ("2026-09-07", "Labor Day"),
    ("2026-11-26", "Thanksgiving Day"), ("2026-12-25", "Christmas Day"),
    ("2027-01-01", "New Year's Day"), ("2027-01-18", "Martin Luther King Jr. Day"),
    ("2027-02-15", "Washington's Birthday"), ("2027-03-26", "Good Friday"), ("2027-05-31", "Memorial Day"),
    ("2027-06-18", "Juneteenth (observed)"), ("2027-07-05", "Independence Day (observed)"),
    ("2027-09-06", "Labor Day"), ("2027-11-25", "Thanksgiving Day"), ("2027-12-24", "Christmas Day (observed)"),
]

TELEGRAM_EVENTS = ["open", "close", "lock", "cap", "offline", "live", "error", "daily"]
DEFAULT_LIMITS = {
    "allow_remote_control": True,
    "allow_remote_live": False,
    "allow_remote_params": False,
    "max_lots": 0.10,
    "max_daily_cap_pct": 10.0,
}

# SPEC 4.2 remote allow-list, in file order: key -> (kind, min, max)
#   bool | lots (0.01 .. min(max_lots, EA ceiling)) | cap (1 .. min(max_daily_cap_pct, EA ceiling)) | int | float |
#   pos (> 0) | lock1at (0 or >= 10, cross-checked) | token (integer unix seconds within TOKEN_WINDOW_S of now)
REMOTE_PARAMS = [
    ("InpUseA", "bool", None, None), ("InpUseNY", "bool", None, None), ("InpUseC5G", "bool", None, None),
    ("InpUseAsia", "bool", None, None),
    ("InpLotsA", "lots", None, None), ("InpLotsNY", "lots", None, None), ("InpLotsC5G", "lots", None, None),
    ("InpMaxLots", "lots", None, None), ("InpLotsAsia", "lots", None, None),
    ("InpRecoveryMult", "float", 1.0, 2.0),
    ("InpMaxAttempts", "int", 1, 4),
    ("InpConfluenceMult", "float", 1.0, 2.0),
    ("InpConfluenceMin", "int", 0, 240),
    ("InpDailyCapPct", "cap", 1.0, None),
    ("InpKillBalance", "float", 0.0, None),
    ("InpVirtualStart", "pos", None, None),
    ("InpMaxSpread", "float", 0.05, 2.0),
    ("InpVolGate", "bool", None, None),
    ("InpVolGatePct", "float", 0.5, 5.0),
    ("InpLockEnable", "bool", None, None), ("InpLock_A", "bool", None, None), ("InpLock_NY", "bool", None, None),
    ("InpLock_C5G", "bool", None, None), ("InpLockShadow", "bool", None, None), ("InpLock1Enable", "bool", None, None),
    ("InpLockAtPct", "float", 50.0, 99.5),
    ("InpLockToPct", "float", 1.0, None),
    ("InpLock1AtPct", "lock1at", None, None),
    ("InpLock1ToPct", "float", 1.0, None),
    # v3.05 (contract 2026-11-10, SPEC 11): runner mode inputs + the daily-cap reset command `cap_reset`, which is
    # always the LAST line. An EA below 3.05 rejects a file with an unknown key, so these leave the file for it
    # (drop_v305_keys) instead of the whole desired set being refused.
    ("InpRunnerEnable", "bool", None, None), ("InpRunner_A", "bool", None, None), ("InpRunner_NY", "bool", None, None),
    ("InpRunner_C5G", "bool", None, None),
    ("InpRunnerKeepPct", "float", 50.0, 99.0),
    ("InpRunnerStep", "float", 0.1, 2.0),
    ("InpRunnerMaxSteps", "int", 0, 50),
    ("InpRunnerSafetyTP", "float", 0.0, 10.0),
    ("cap_reset", "token", None, None),
]
REMOTE_SPEC = dict((k, (kind, lo, hi)) for k, kind, lo, hi in REMOTE_PARAMS)
REMOTE_KEYS = [k for k, _, _, _ in REMOTE_PARAMS]
V305_KEYS = ("InpRunnerEnable", "InpRunner_A", "InpRunner_NY", "InpRunner_C5G", "InpRunnerKeepPct", "InpRunnerStep",
             "InpRunnerMaxSteps", "InpRunnerSafetyTP", "cap_reset")
V305_MIN_EA = (3, 5)                # the first EA that knows the keys above
TOKEN_WINDOW_S = 48 * 3600          # a cap_reset token must be within 48 h of the agent's UTC clock


# ---------------------------------------------------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------------------------------------------------
class NetworkError(Exception):
    """Connection problem, timeout, HTTP 5xx / 408 / 429: retry later with back-off."""


class AuthError(Exception):
    """No usable login (refresh token missing / revoked, wrong password): run `login`."""


class ApiError(Exception):
    """A 4xx answer from Supabase (RLS, validation, unknown bot ...)."""

    def __init__(self, status, message, code=None):
        Exception.__init__(self, "HTTP %s: %s" % (status, message))
        self.status = status
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------------------------------------------------
# Secrets never reach the log or the console
# ---------------------------------------------------------------------------------------------------------------------
_SECRETS = set()


def add_secret(value):
    if isinstance(value, str) and len(value) >= 6:
        _SECRETS.add(value)


def redact(text):
    if not isinstance(text, str):
        text = str(text)
    for s in sorted(_SECRETS, key=len, reverse=True):
        if s in text:
            text = text.replace(s, "***")
    return text


class RedactFilter(logging.Filter):
    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        record.msg = redact(msg)
        record.args = None
        if record.exc_info:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = redact(record.exc_text)
        return True


_OUR_HANDLERS = []


def setup_logging(agent_dir, console=False, verbose=False):
    """agent.log (rotating, 1 MB x 3) in the agent folder; optional console output. Idempotent."""
    for h in _OUR_HANDLERS:
        LOG.removeHandler(h)
        try:
            h.close()
        except Exception:
            pass
    del _OUR_HANDLERS[:]
    LOG.setLevel(logging.DEBUG if verbose else logging.INFO)
    LOG.propagate = False
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    try:
        fh = logging.handlers.RotatingFileHandler(os.path.join(agent_dir, LOG_NAME), maxBytes=1000000, backupCount=3,
                                                  encoding="utf-8")
        fh.setFormatter(fmt)
        fh.addFilter(RedactFilter())
        LOG.addHandler(fh)
        _OUR_HANDLERS.append(fh)
    except OSError as e:  # pragma: no cover - read-only folder
        sys.stderr.write("cannot open %s: %s\n" % (LOG_NAME, e))
    if console:
        ch = logging.StreamHandler()
        ch.setFormatter(logging.Formatter("%(asctime)s %(message)s", "%H:%M:%S"))
        ch.addFilter(RedactFilter())
        LOG.addHandler(ch)
        _OUR_HANDLERS.append(ch)


# ---------------------------------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------------------------------
def script_dir():
    return os.path.dirname(os.path.abspath(__file__))


def to_num(v):
    """float or None (bools, NaN, inf and garbage -> None)."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        x = float(v)
    else:
        try:
            x = float(str(v).strip())
        except ValueError:
            return None
    return x if math.isfinite(x) else None


def to_bool(v, default=None):
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    if isinstance(v, (int, float)):
        return v != 0
    s = str(v).strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return default


def ea_bool(v):
    """The EA's ParseBool: only 1/true/yes/on are true."""
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def floor2(x):
    return math.floor(x * 100 + 1e-6) / 100.0


def clean_note(s, limit=120):
    s = " ".join(str(s or "").replace("\r", " ").replace("\n", " ").split())
    return s[:limit]


def _merge(base, over):
    for k, v in (over or {}).items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            _merge(base[k], v)
        else:
            base[k] = v
    return base


# ---------------------------------------------------------------------------------------------------------------------
# Files: atomic writes, retrying reads
# ---------------------------------------------------------------------------------------------------------------------
def atomic_write_bytes(path, data, sleep=time.sleep, retries=5):
    """Write <path>.tmp then os.replace (retried: on Windows the EA may hold the target open for a moment)."""
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    for i in range(retries):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == retries - 1:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise
            sleep(0.1 * (i + 1))


def write_ea_file(path, text, sleep=time.sleep):
    """Atomic UTF-8 write of an EA file. The EA reloads on the modify date (1 s resolution), so the new file always
    gets a modify second different from the old one."""
    old_m = None
    try:
        old_m = os.stat(path).st_mtime
    except OSError:
        pass
    atomic_write_bytes(path, text.encode("utf-8"), sleep=sleep)
    if old_m is not None:
        new_m = os.stat(path).st_mtime
        if int(new_m) <= int(old_m):
            bump = int(old_m) + 1
            os.utime(path, (bump, bump))


def write_json_atomic(path, obj):
    atomic_write_bytes(path, (json.dumps(obj, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def read_text(path, attempts=3, sleep=time.sleep):
    """File text or None when missing / unreadable."""
    for i in range(attempts):
        try:
            with open(path, "rb") as f:
                return f.read().decode("utf-8-sig", "replace")
        except FileNotFoundError:
            return None
        except PermissionError:
            sleep(0.1 * (i + 1))
        except OSError:
            return None
    return None


def read_status_file(path, attempts=4, delay=0.25, sleep=time.sleep):
    """The EA's status JSON, or None when missing. A file caught mid-write is re-read a few times."""
    for i in range(attempts):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except FileNotFoundError:
            return None
        except OSError:
            data = None
        if data is not None:
            try:
                obj = json.loads(data.decode("utf-8-sig"))
                if isinstance(obj, dict):
                    return obj
            except (ValueError, UnicodeDecodeError):
                pass
        if i < attempts - 1:
            sleep(delay)
    LOG.warning("status file unreadable after %d attempts (mid-write?)", attempts)
    return None


# ---------------------------------------------------------------------------------------------------------------------
# Time
# ---------------------------------------------------------------------------------------------------------------------
_EPOCH = datetime(1970, 1, 1)
_ISO_RE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*"
                     r"(Z|z|[+-]\d{2}(?::?\d{2})?)?\s*$")


def parse_server_dt(s):
    """'2026.11.06 23:54:59' (or without seconds / time) -> naive datetime, else None."""
    s = (s or "").strip() if isinstance(s, str) else ""
    for fmt in ("%Y.%m.%d %H:%M:%S", "%Y.%m.%d %H:%M", "%Y.%m.%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None


def naive_to_epoch(dt):
    """Treat a naive datetime as UTC."""
    return calendar.timegm(dt.timetuple())


def parse_bar_rows(text, offset_min, skip_first=True):
    """The EA's dobby2_bars.csv -> [(utc_epoch, close, vwap or None)] sorted by time, one row per bar (a later line for
    the same bar wins). Column 0 = bar_time (server time), 2 = close, 14 = vwap (newer EA rows only, used when > 0).
    skip_first: the first line is a header or the partial line of a tail read. [] when the offset is unknown."""
    if text is None or offset_min is None:
        return []
    dedup = {}
    for line in text.splitlines()[1 if skip_first else 0:]:
        parts = line.split(",")
        if len(parts) < 3:
            continue
        dt = parse_server_dt(parts[0])
        close = to_num(parts[2])
        if dt is None or close is None or close <= 0:
            continue
        vwap = to_num(parts[14]) if len(parts) > 14 else None
        t = naive_to_epoch(dt) - int(offset_min) * 60
        dedup[t] = (t, round(close, 2), round(vwap, 3) if vwap is not None and vwap > 0 else None)
    return [dedup[k] for k in sorted(dedup)]


def parse_bars_text(text, offset_min, keep=BARS_KEEP):
    """SPEC 8: the EA's dobby2_bars.csv -> {"tf": "M15", "t": [utc], "c": [close], "vwap": [vwap|None]} for the last
    `keep` bars. None when nothing usable or the server offset is unknown."""
    rows = parse_bar_rows(text, offset_min)[-keep:]
    if not rows:
        return None
    return {"tf": "M15", "t": [r[0] for r in rows], "c": [r[1] for r in rows], "vwap": [r[2] for r in rows]}


def read_appended(path, pos, sleep=time.sleep):
    """Complete lines after byte `pos` (like the journal: a half-written last line waits for the next read).
    Returns (text or None, new_pos, reset); reset = the file shrank (rewritten), so it was read from the start."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return None, pos, False
    reset = size < pos
    if reset:
        pos = 0
    if size == pos:
        return None, pos, reset
    data = None
    for i in range(3):
        try:
            with open(path, "rb") as f:
                f.seek(pos)
                data = f.read(size - pos)
            break
        except PermissionError:
            sleep(0.2 * (i + 1))
        except OSError:
            break
    if not data:
        return None, pos, reset
    last_nl = data.rfind(b"\n")
    if last_nl < 0:
        return None, pos, reset
    return data[:last_nl + 1].decode("utf-8-sig" if pos == 0 else "utf-8", "replace"), pos + last_nl + 1, reset


def epoch_to_naive(t):
    return _EPOCH + timedelta(seconds=t)


def iso_z(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def parse_utc(v):
    """ISO 8601 string (Z / offset / fraction; no zone = UTC) or epoch seconds/ms -> epoch seconds, else None."""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        x = float(v)
        return x / 1000.0 if x > 1e11 else x
    m = _ISO_RE.match(str(v))
    if not m:
        return None
    y, mo, d, hh, mi, ss, frac, tz = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(hh or 0), int(mi or 0), int(ss or 0))
    except ValueError:
        return None
    t = float(naive_to_epoch(dt))
    if frac:
        t += float("0." + frac)
    if tz and tz not in ("Z", "z"):
        sign = 1 if tz[0] == "+" else -1
        digits = tz[1:].replace(":", "")
        t -= sign * (int(digits[:2]) * 3600 + int(digits[2:4] or 0) * 60)
    return t


def raw_offset_min(status):
    """SPEC 3.4: round((server_time as UTC epoch - heartbeat_gmt_unix) / 900) * 15. None when not computable.
    Only right while ticks flow: on weekends / the daily break TimeCurrent() is frozen (see OffsetTracker)."""
    if not isinstance(status, dict):
        return None
    dt = parse_server_dt(status.get("server_time"))
    hb = status.get("heartbeat_gmt_unix")
    if dt is None or isinstance(hb, bool) or not isinstance(hb, (int, float)):
        return None
    return int(math.floor((naive_to_epoch(dt) - hb) / 900.0 + 0.5)) * 15


def offset_sample(status):
    """(heartbeat, server epoch) or None."""
    dt = parse_server_dt((status or {}).get("server_time"))
    hb = (status or {}).get("heartbeat_gmt_unix")
    if dt is None or isinstance(hb, bool) or not isinstance(hb, (int, float)):
        return None
    return [float(hb), float(naive_to_epoch(dt))]


def offset_confirmed_by(prev, cur):
    """True when two samples show the server clock running with the GMT clock (fresh ticks, not a frozen
    TimeCurrent), so the raw offset of `cur` can be trusted."""
    if not prev or not cur or cur[0] == prev[0]:
        return False
    d_server = cur[1] - prev[1]
    d_gmt = cur[0] - prev[0]
    return d_server > 0 and abs(d_server - d_gmt) <= OFFSET_TOLERANCE_S


# ---------------------------------------------------------------------------------------------------------------------
# Journal CSV
# ---------------------------------------------------------------------------------------------------------------------
def line_hash(raw):
    """sha1 of the raw journal line (without its line ending)."""
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def _jnum(s):
    return to_num(s) if (s or "").strip() != "" else None


def _jint(s):
    x = _jnum(s)
    return int(x) if x is not None else None


def parse_journal_line(text):
    """One journal line -> row dict for the `journal` table (bot_id added by the caller), or None."""
    try:
        fields = next(csv.reader([text]))
    except (csv.Error, StopIteration):
        return None
    if len(fields) < len(JOURNAL_FIELDS) or fields[0] == "time_server":
        return None
    if len(fields) > len(JOURNAL_FIELDS):  # an unquoted comma in the detail: keep it in the detail
        fields = fields[:11] + [",".join(fields[11:])]
    dt = parse_server_dt(fields[0])
    if dt is None:
        return None
    return {
        "ts_server": dt.strftime("%Y-%m-%dT%H:%M:%S"),
        "event": fields[1].strip(),
        "tag": fields[2].strip() or None,
        "side": fields[3].strip() or None,
        "lots": _jnum(fields[4]),
        "price": _jnum(fields[5]),
        "sl": _jnum(fields[6]),
        "tp": _jnum(fields[7]),
        "pnl": _jnum(fields[8]),
        "v_balance": _jnum(fields[9]),
        "step": _jint(fields[10]),
        "detail": fields[11],
        "line_hash": line_hash(text),
    }


def read_journal_chunk(path, offset, sleep=time.sleep):
    """Complete lines after byte `offset`. A half-written last line (no line end yet) is left for the next read.
    Returns (rows, ends, new_offset, reset): ends[i] = byte position after rows[i]; reset = the file shrank."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return [], [], offset, False
    reset = False
    if size < offset:
        offset, reset = 0, True
    if size == offset:
        return [], [], offset, reset
    data = None
    for i in range(3):
        try:
            with open(path, "rb") as f:
                f.seek(offset)
                data = f.read(size - offset)
            break
        except PermissionError:
            sleep(0.2 * (i + 1))
        except OSError:
            break
    if not data:
        return [], [], offset, reset
    last_nl = data.rfind(b"\n")
    if last_nl < 0:
        return [], [], offset, reset
    rows, ends, pos = [], [], 0
    while pos <= last_nl:
        nl = data.index(b"\n", pos)
        raw = data[pos:nl].rstrip(b"\r")
        pos = nl + 1
        if offset == 0 and not rows and raw.startswith(b"\xef\xbb\xbf"):
            raw = raw[3:]
        if not raw.strip():
            continue
        text = raw.decode("utf-8", "replace")
        if text.startswith("time_server,"):
            continue
        row = parse_journal_line(text)
        if row is None:
            LOG.warning("journal line not understood, skipped: %s", text[:160])
            continue
        rows.append(row)
        ends.append(offset + pos)
    return rows, ends, offset + last_nl + 1, reset


# ---------------------------------------------------------------------------------------------------------------------
# Control file (SPEC 3.6) - same format as monitor/dobby2_control.py, parsed by the EA's ReadControl()
# ---------------------------------------------------------------------------------------------------------------------
def parse_control_text(text):
    cfg, blackouts = {}, []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        eq = line.find("=")
        if eq <= 0:
            continue
        k, v = line[:eq].strip().lower(), line[eq + 1:].strip()
        if k == "blackout":
            blackouts.append(v)
        else:
            cfg[k] = v
    return {"cfg": cfg, "blackouts": blackouts, "id": cfg.get("id", ""), "note": cfg.get("note", "")}


def parse_blackout_value(v):
    """Port of the EA: dash searched from index 11; an end of <= 5 chars is HH:MM on the start's day.
    Returns (from, to) naive server datetimes, or None (the EA would warn 'bad blackout')."""
    dash = v.find("-", 11)
    if dash <= 0:
        return None
    f = parse_server_dt(v[:dash].strip())
    if f is None:
        return None
    rest = v[dash + 1:].strip()
    if len(rest) <= 5:
        rest = f.strftime("%Y.%m.%d") + " " + rest
    t = parse_server_dt(rest)
    if t is None or t < f:
        return None
    return f, t


def _blackout_raw(b):
    if not isinstance(b, dict):
        return None
    f = parse_utc(b.get("from_utc", b.get("from")))
    t = parse_utc(b.get("to_utc", b.get("to")))
    if f is None or t is None or t < f:
        return None
    return f, t


def _blackout_epochs(b):
    """(from floored, to ceiled) to whole minutes, or None."""
    raw = _blackout_raw(b)
    if raw is None:
        return None
    return math.floor(raw[0] / 60.0) * 60, math.ceil(raw[1] / 60.0) * 60


def blackout_lines(blackouts, offset_min, now_utc):
    """desired.blackouts (UTC) -> control-file values in server time. Past windows (to < now) are dropped, the start is
    floored and the end ceiled to the minute (never narrower), an end on another server day is a full datetime.
    Returns (values, bad_count)."""
    out, bad = [], 0
    for b in blackouts or []:
        raw = _blackout_raw(b)
        if raw is None:
            bad += 1
            continue
        if raw[1] < now_utc:
            continue
        f, t = _blackout_epochs(b)
        fs = epoch_to_naive(f + offset_min * 60)
        ts = epoch_to_naive(t + offset_min * 60)
        if fs.date() == ts.date():
            val = "%s-%s" % (fs.strftime("%Y.%m.%d %H:%M"), ts.strftime("%H:%M"))
        else:
            val = "%s-%s" % (fs.strftime("%Y.%m.%d %H:%M"), ts.strftime("%Y.%m.%d %H:%M"))
        out.append((fs, ts, val))
    out.sort()
    vals = []
    for _, _, v in out:
        if v not in vals:
            vals.append(v)
    return vals[:MAX_BLACKOUT_LINES], bad


def normalize_desired(desired):
    d = desired if isinstance(desired, dict) else {}
    ctl = d.get("control") if isinstance(d.get("control"), dict) else {}
    mode = "run" if str(ctl.get("mode") or "run").strip().lower() == "run" else "pause"
    lots = to_num(ctl.get("lots"))
    if lots is not None and lots <= 0:
        lots = None
    ms = to_num(ctl.get("max_spread"))
    if ms is not None and ms <= 0:
        ms = None
    al, ash = ctl.get("allow_long"), ctl.get("allow_short")
    return {
        "live": to_bool(d.get("live"), False) is True,
        "mode": mode,
        "lots": lots,
        "allow_long": True if al is None else to_bool(al, False),
        "allow_short": True if ash is None else to_bool(ash, False),
        "max_spread": ms,
        "blackouts": d.get("blackouts") if isinstance(d.get("blackouts"), list) else [],
        "params": d.get("params"),
        "note": clean_note(ctl.get("note") or d.get("note") or ""),
    }


def get_limits(cfg):
    """Local limits from the config, sanitised (garbage -> the safe value)."""
    raw = dict(DEFAULT_LIMITS)
    raw.update((cfg or {}).get("limits") or {})
    lim = {
        "allow_remote_control": to_bool(raw.get("allow_remote_control"), False) is True,
        "allow_remote_live": to_bool(raw.get("allow_remote_live"), False) is True,
        "allow_remote_params": to_bool(raw.get("allow_remote_params"), False) is True,
    }
    ml = to_num(raw.get("max_lots"))
    lim["max_lots"] = round(ml, 2) if ml is not None and ml > 0 else 0.01
    cap = to_num(raw.get("max_daily_cap_pct"))
    lim["max_daily_cap_pct"] = cap if cap is not None and cap > 0 else 1.0
    return lim


def ea_version_tuple(ver):
    """"3.04" -> (3, 4), "3.10" -> (3, 10), "v3.05.1" -> (3, 5, 1); None for anything else (compare as tuples)."""
    m = re.match(r"^\s*v?(\d+)\.(\d+)(?:\.(\d+))?", str(ver if ver is not None else ""))
    if not m:
        return None
    return tuple(int(g) for g in m.groups() if g is not None)


def ea_supports_v305(ea_version):
    """True when the EA status reports a version >= 3.05 (a missing / unparseable version counts as older)."""
    t = ea_version_tuple(ea_version)
    return t is not None and t >= V305_MIN_EA


def drop_v305_keys(params, ea_version):
    """Compatibility (contract 2026-11-10 §5): the v3.05 keys leave the remote file when the EA is below 3.05 or no
    status is known, because such an EA rejects the WHOLE file on an unknown key. Returns (params, dropped keys)."""
    if not params or ea_supports_v305(ea_version):
        return params, []
    dropped = [k for k in REMOTE_KEYS if k in V305_KEYS and k in params]
    if not dropped:
        return params, []
    return dict((k, v) for k, v in params.items() if k not in V305_KEYS), dropped


def check_params(params, limits, ea_remote=None, now=None):
    """desired.params against the allow-list (4.2), the EA bounds and the local limits (3.5).
    Returns (clean_params or None, codes, details). Any problem rejects the whole block.
    `now` (epoch seconds, default the wall clock) is the reference for the cap_reset token window."""
    if not isinstance(params, dict):
        return None, ["params_invalid"], ["params is not an object"]
    ea_remote = ea_remote if isinstance(ea_remote, dict) else {}
    ceil = ea_remote.get("ceilings") if isinstance(ea_remote.get("ceilings"), dict) else {}
    max_lots = limits["max_lots"]
    c = to_num(ceil.get("max_lots"))
    if c is not None and c > 0:
        max_lots = min(max_lots, c)
    max_cap = limits["max_daily_cap_pct"]
    c = to_num(ceil.get("max_cap_pct"))
    if c is not None and c > 0:
        max_cap = min(max_cap, c)
    codes, details, clean = [], [], {}

    def bad(code, msg):
        if code not in codes:
            codes.append(code)
        details.append(msg)

    for key, value in params.items():
        spec = REMOTE_SPEC.get(key)
        if spec is None:
            bad("params_unknown_key", "%s is not on the remote allow-list" % key)
            continue
        kind, lo, hi = spec
        if kind == "bool":
            b = value if isinstance(value, bool) else to_bool(value, None)
            if b is None or (not isinstance(value, bool) and not isinstance(value, (str, int))):
                bad("params_out_of_bounds", "%s must be true/false" % key)
            else:
                clean[key] = b
            continue
        x = to_num(value)
        if x is None:
            bad("params_out_of_bounds", "%s must be a number" % key)
            continue
        if kind == "lots":
            if x > max_lots + 1e-9:
                bad("params_lots_over_limit", "%s=%g > max_lots %.2f" % (key, x, max_lots))
            elif x < 0.01 - 1e-9:
                bad("params_out_of_bounds", "%s=%g < 0.01" % (key, x))
            else:
                clean[key] = round(x, 2)
        elif kind == "cap":
            if x > max_cap + 1e-9:
                bad("params_cap_over_limit", "%s=%g > max_daily_cap_pct %g" % (key, x, max_cap))
            elif x < lo - 1e-9:
                bad("params_out_of_bounds", "%s=%g < %g" % (key, x, lo))
            else:
                clean[key] = x
        elif kind == "int":
            if abs(x - round(x)) > 1e-9 or x < lo or x > hi:
                bad("params_out_of_bounds", "%s=%g not an integer in %d..%d" % (key, x, lo, hi))
            else:
                clean[key] = int(round(x))
        elif kind == "pos":
            if x <= 0:
                bad("params_out_of_bounds", "%s must be > 0" % key)
            else:
                clean[key] = x
        elif kind == "lock1at":
            if not (abs(x) < 1e-9 or 10 - 1e-9 <= x <= 99.5 + 1e-9):
                bad("params_out_of_bounds", "%s must be 0 or 10..LockAt-0.5" % key)
            else:
                clean[key] = x
        elif kind == "token":
            # one-shot command: an integer unix time (number or numeric string) within 48 h of the agent's UTC clock
            ref = time.time() if now is None else float(now)
            if abs(x - round(x)) > 1e-9 or x <= 0:
                bad("params_out_of_bounds", "%s must be an integer unix time in seconds" % key)
            elif abs(x - ref) > TOKEN_WINDOW_S:
                bad("params_out_of_bounds", "%s=%d is %.1f h away from now (allowed: %d h)" % (
                    key, int(round(x)), abs(x - ref) / 3600.0, TOKEN_WINDOW_S // 3600))
            else:
                clean[key] = int(round(x))
        else:
            if (lo is not None and x < lo - 1e-9) or (hi is not None and x > hi + 1e-9):
                bad("params_out_of_bounds", "%s=%g outside %s..%s" % (key, x, lo, "" if hi is None else hi))
            else:
                clean[key] = x
    # cross-checks (values not in the block come from the EA's effective values when schema 5 reports them)
    eff = ea_remote.get("effective") if isinstance(ea_remote.get("effective"), dict) else {}

    def val(k):
        return clean[k] if k in clean else to_num(eff.get(k))

    lock_keys = ("InpLockAtPct", "InpLockToPct", "InpLock1AtPct", "InpLock1ToPct")
    if any(k in clean for k in lock_keys):
        at, to, a1, t1 = (val(k) for k in lock_keys)
        if at is not None and to is not None and to > at - 0.5 + 1e-9:
            bad("params_out_of_bounds", "InpLockToPct must be <= InpLockAtPct - 0.5")
        if at is not None and a1 is not None and a1 > 1e-9 and a1 > at - 0.5 + 1e-9:
            bad("params_out_of_bounds", "InpLock1AtPct must be <= InpLockAtPct - 0.5")
        if a1 is not None and a1 > 1e-9 and t1 is not None and to is not None and t1 > min(a1, to) - 0.5 + 1e-9:
            bad("params_out_of_bounds", "InpLock1ToPct must be <= min(InpLock1AtPct, InpLockToPct) - 0.5")
    if codes:
        return None, codes, details
    return clean, [], []


def evaluate_desired(desired, limits, last_live, ea_remote=None, now=None):
    """Apply the local limits (SPEC 3.5) to the web's desired state. Pure function (`now`: see check_params)."""
    d = normalize_desired(desired)
    rejected, details = [], []
    if d["live"]:
        if limits["allow_remote_live"]:
            live = True
        else:  # keep the last applied value; refuse only an actual switch-on
            live = bool(last_live)
            if not live:
                rejected.append("live_not_allowed_locally")
                details.append("web asked live=on but allow_remote_live is off on this PC")
    else:
        live = False  # live off is ALWAYS honoured
    lots = d["lots"]
    if lots is not None:
        if lots > limits["max_lots"] + 1e-9:
            rejected.append("lots_clamped")
            details.append("lots %.2f clamped to max_lots %.2f" % (lots, limits["max_lots"]))
            lots = limits["max_lots"]
        lots = max(0.01, floor2(lots))
    ms = d["max_spread"]
    if ms is not None:
        ms = max(0.01, floor2(ms))
    params_state, params = "none", None
    if d["params"] is not None:
        if not limits["allow_remote_params"]:
            params_state = "not_allowed"
            rejected.append("params_not_allowed_locally")
            details.append("web sent params but allow_remote_params is off on this PC")
        else:
            clean, codes, det = check_params(d["params"], limits, ea_remote, now)
            if codes:
                params_state = "rejected"
                rejected += [c for c in codes if c not in rejected]
                details += det
            else:
                params_state, params = "ok", clean
    return {
        "live": live,
        "mode": "pause" if (not live or d["mode"] == "pause") else "run",
        "control_mode": d["mode"],
        "lots": lots,
        "allow_long": d["allow_long"],
        "allow_short": d["allow_short"],
        "max_spread": ms,
        "note": d["note"],
        "blackouts": d["blackouts"],
        "params_state": params_state,
        "params": params,
        "rejected": rejected,
        "details": details,
    }


def control_id(version):
    return "W%03d" % int(version)


def render_control_text(dec, blackout_values, version, written):
    """SPEC 3.6 text, CRLF line ends, keys in the order mode, lots, allow_long, allow_short, max_spread."""
    stamp = written.strftime("%Y-%m-%d %H:%M:%S")
    lines = ["# Dobby control file, written %s by dobby_agent (web v%d)" % (stamp, int(version)),
             "mode=" + dec["mode"]]
    if dec["lots"] is not None:
        lines.append("lots=%.2f" % dec["lots"])
    lines.append("allow_long=%d" % (1 if dec["allow_long"] else 0))
    lines.append("allow_short=%d" % (1 if dec["allow_short"] else 0))
    if dec["max_spread"] is not None:
        lines.append("max_spread=%.2f" % dec["max_spread"])
    lines += ["blackout=" + b for b in blackout_values]
    lines.append("id=" + control_id(version))
    note = clean_note(dec.get("note"))
    lines.append("note=web: " + note if note else "note=web")
    return "\r\n".join(lines) + "\r\n"


def file_body(text):
    """Lines that matter to the EA (comments and blank lines removed): used to skip rewrites of unchanged content."""
    return [ln.strip() for ln in (text or "").splitlines() if ln.strip() and not ln.strip().startswith("#")]


# ---------------------------------------------------------------------------------------------------------------------
# Deposits / withdrawals (SPEC 9.2)
# ---------------------------------------------------------------------------------------------------------------------
def cash_threshold(old_balance):
    """A balance change counts as a deposit / withdrawal suggestion from max(10, 0.5 % of the old balance)."""
    return max(CASH_MIN_ABS, abs(old_balance or 0.0) * CASH_MIN_PCT / 100.0)


def cash_step(cash, balance, now):
    """One cycle of the deposit / withdrawal detector. `cash` (agent state) = {"balance": baseline or None,
    "pnl": Dobby CLOSE pnl ingested since the baseline, "pending": {"amount", "since"} or None}; it is updated in
    place. unexplained = new - old - pnl. Returns the suggested amount (to insert) or None. The caller resets the
    baseline with cash_reset() once the suggestion is stored."""
    if balance is None:
        return None
    if cash.get("balance") is None:
        cash_reset(cash, balance)
        return None
    old = float(cash["balance"])
    unexplained = round(balance - old - float(cash.get("pnl") or 0.0), 2)
    if abs(unexplained) < cash_threshold(old):
        cash_reset(cash, balance)          # explained by Dobby's trades (or too small to matter): new baseline
        return None
    p = cash.get("pending")
    if not isinstance(p, dict):
        cash["pending"] = {"amount": unexplained, "since": now}
        return None                        # the CLOSE row may still be on its way: wait one cycle
    since = to_num(p.get("since"))
    if now - (now if since is None else since) < CASH_CONFIRM_S:
        p["amount"] = unexplained
        return None
    return unexplained


def cash_reset(cash, balance):
    cash["balance"] = None if balance is None else round(float(balance), 2)
    cash["pnl"] = 0.0
    cash["pending"] = None


def status_balance(status, now):
    """The account balance of a fresh, connected EA status, else None."""
    if not isinstance(status, dict):
        return None
    hb = status.get("heartbeat_gmt_unix")
    if isinstance(hb, bool) or not isinstance(hb, (int, float)) or now - hb > OFFLINE_AFTER_S:
        return None
    acc = status.get("account") if isinstance(status.get("account"), dict) else {}
    if acc.get("connected") is False:
        return None
    return to_num(acc.get("balance"))


# ---------------------------------------------------------------------------------------------------------------------
# Automatic blackouts (SPEC 9.3): ForexFactory news, weekly schedule (Thai time), NYSE holidays (New York time)
# ---------------------------------------------------------------------------------------------------------------------
_HHMM = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*$")


def parse_hhmm(v, allow_24=False):
    """'21:00' -> 1260 minutes; '24:00' only with allow_24 (end of day). None when invalid."""
    m = _HHMM.match(v) if isinstance(v, str) else None
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if mi > 59 or h > 24 or (h == 24 and (mi or not allow_24)):
        return None
    return h * 60 + mi


def _int_in(v, lo, hi):
    """An integer-valued number in lo..hi (bools refused), else None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return None
    if abs(v - round(v)) > 1e-9 or not lo <= v <= hi:
        return None
    return int(round(v))


def validate_auto_news(raw):
    """desired.auto_news -> (config or None when off, warnings). Missing / enabled != true = off. An invalid field is
    ignored (its default is used) and reported as the warning auto_news_invalid."""
    if raw is None:
        return None, []
    if not isinstance(raw, dict):
        return None, ["auto_news_invalid"]
    en = raw.get("enabled")
    if en is not True:
        return None, ([] if en in (False, None) else ["auto_news_invalid"])
    cfg = copy.deepcopy(AUTO_NEWS_DEFAULTS)
    bad = False
    for k in ("before_min", "after_min"):
        if raw.get(k) is not None:
            x = _int_in(raw[k], 0, 240)
            if x is None:
                bad = True
            else:
                cfg[k] = x
    cur = raw.get("currencies")
    if cur is not None:
        ok = isinstance(cur, list) and 0 < len(cur) <= 20 and all(
            isinstance(c, str) and re.match(r"^[A-Za-z]{3}$", c.strip()) for c in cur)
        if ok:
            cfg["currencies"] = sorted(set(c.strip().upper() for c in cur))
        else:
            bad = True
    imp = raw.get("impact")
    if imp is not None:
        canon = dict((x.lower(), x) for x in NEWS_IMPACTS)
        ok = isinstance(imp, list) and 0 < len(imp) <= len(NEWS_IMPACTS) and all(
            isinstance(i, str) and i.strip().lower() in canon for i in imp)
        if ok:
            cfg["impact"] = [x for x in NEWS_IMPACTS if x.lower() in set(i.strip().lower() for i in imp)]
        else:
            bad = True
    return cfg, (["auto_news_invalid"] if bad else [])


def validate_schedule(raw):
    """desired.schedule -> (config or None when off, warnings). weekly: <= 14 windows {dow 1..7 (Monday = 1),
    from 'HH:MM' < to 'HH:MM' | '24:00'} in Thai time. Invalid windows are skipped (warning schedule_invalid)."""
    if raw is None:
        return None, []
    if not isinstance(raw, dict):
        return None, ["schedule_invalid"]
    en = raw.get("enabled")
    if en is not True:
        return None, ([] if en in (False, None) else ["schedule_invalid"])
    bad = False
    hol = raw.get("us_holidays")
    if hol is not None and not isinstance(hol, bool):
        bad, hol = True, False
    weekly = []
    items = raw.get("weekly")
    if items is not None and not isinstance(items, list):
        bad, items = True, []
    for w in items or []:
        if len(weekly) >= WEEKLY_MAX:
            bad = True
            break
        if not isinstance(w, dict):
            bad = True
            continue
        dow = _int_in(w.get("dow"), 1, 7)
        f, t = parse_hhmm(w.get("from")), parse_hhmm(w.get("to"), allow_24=True)
        if dow is None or f is None or t is None or f >= t:
            bad = True
            continue
        weekly.append({"dow": dow, "from": f, "to": t})
    return {"us_holidays": hol is True, "weekly": weekly}, (["schedule_invalid"] if bad else [])


def normalize_ff_events(data):
    """The ForexFactory weekly JSON -> [{"title", "ts_utc", "currency", "impact", "forecast", "previous"}] sorted by
    time (unusable items skipped). ValueError when it is not a list of events."""
    if not isinstance(data, list):
        raise ValueError("calendar is not a JSON list")
    out = []
    for e in data:
        if not isinstance(e, dict):
            continue
        t = parse_utc(e.get("date"))
        title = clean_note(e.get("title"), 120)
        cur = str(e.get("country") or "").strip().upper()
        if t is None or not title or not re.match(r"^[A-Z]{3}$", cur):
            continue
        out.append({"title": title, "ts_utc": iso_z(t), "currency": cur,
                    "impact": clean_note(e.get("impact"), 20).capitalize(),
                    "forecast": clean_note(e.get("forecast"), 30) or None,
                    "previous": clean_note(e.get("previous"), 30) or None})
    if data and not out:
        raise ValueError("no usable events in the calendar")
    out.sort(key=lambda x: (x["ts_utc"], x["title"]))
    return out


def matching_news(events, cfg):
    """Events of the configured currencies and impacts."""
    if not cfg:
        return []
    return [e for e in events or [] if e.get("currency") in cfg["currencies"] and e.get("impact") in cfg["impact"]]


def news_windows(events, cfg, now, horizon_s=AUTO_HORIZON_S):
    """[(from, to, reason, kind)] = [t - before, t + after] of the matching events that are not over yet."""
    out = []
    for e in matching_news(events, cfg):
        t = parse_utc(e.get("ts_utc"))
        if t is None:
            continue
        f, to = t - cfg["before_min"] * 60, t + cfg["after_min"] * 60
        if to <= f or to < now or f >= now + horizon_s:
            continue
        out.append((f, to, e["title"], "news"))
    return out


def schedule_windows(cfg, now, horizon_s=AUTO_HORIZON_S):
    """The weekly windows (Thai time, UTC+7) that overlap [now, now + horizon]."""
    out = []
    if not cfg:
        return out
    today = epoch_to_naive(now + THAI_OFFSET_S).date()
    for d in range(0, 9):
        day = today + timedelta(days=d)
        base = naive_to_epoch(datetime(day.year, day.month, day.day)) - THAI_OFFSET_S
        for w in cfg["weekly"]:
            if w["dow"] != day.isoweekday():
                continue
            f, t = base + w["from"] * 60, base + w["to"] * 60
            if t < now or f >= now + horizon_s:
                continue
            out.append((f, t, SCHEDULE_REASON, "schedule"))
    return out


def _nth_sunday(year, month, n):
    first = datetime(year, month, 1)
    return (first + timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))).date()


def ny_utc_offset_min(day):
    """New York's UTC offset (minutes) at 00:00 of a date: EDT (-240) from the day after the second Sunday of March
    through the first Sunday of November (the switches happen at 02:00), else EST (-300)."""
    start, end = _nth_sunday(day.year, 3, 2), _nth_sunday(day.year, 11, 1)
    return -240 if start < day <= end else -300


def holiday_windows(now, horizon_s=AUTO_HORIZON_S):
    """NYSE closed days 00:00-24:00 New York time (DST aware) that overlap [now, now + horizon]."""
    out = []
    for d, name in NYSE_HOLIDAYS:
        day = datetime.strptime(d, "%Y-%m-%d").date()
        nxt = day + timedelta(days=1)
        f = naive_to_epoch(datetime(day.year, day.month, day.day)) - ny_utc_offset_min(day) * 60
        t = naive_to_epoch(datetime(nxt.year, nxt.month, nxt.day)) - ny_utc_offset_min(nxt) * 60
        if t < now or f >= now + horizon_s:
            continue
        out.append((f, t, name, "holiday"))
    return out


def merge_windows(windows):
    """[(from, to, reason, kind)] -> [{"from_utc", "to_utc", "reason", "kinds"}], overlapping or touching windows
    joined (reasons in time order, without repeats)."""
    out = []
    for f, t, reason, kind in sorted(windows, key=lambda w: (w[0], w[1])):
        if out and f <= out[-1][1]:
            cur = out[-1]
            cur[1] = max(cur[1], t)
            if reason not in cur[2]:
                cur[2].append(reason)
            if kind not in cur[3]:
                cur[3].append(kind)
        else:
            out.append([f, t, [reason], [kind]])
    return [{"from_utc": iso_z(f), "to_utc": iso_z(t), "reason": clean_note(", ".join(r), 200), "kinds": k}
            for f, t, r, k in out]


def auto_blackouts(desired, events, now):
    """SPEC 9.3: the automatic windows of the next 7 days from desired.auto_news / desired.schedule.
    Returns (windows, news_cfg, schedule_cfg, warnings); a config is None when that feature is off."""
    d = desired if isinstance(desired, dict) else {}
    news_cfg, w1 = validate_auto_news(d.get("auto_news"))
    sched_cfg, w2 = validate_schedule(d.get("schedule"))
    raw = []
    if news_cfg:
        raw += news_windows(events, news_cfg, now)
    if sched_cfg:
        raw += schedule_windows(sched_cfg, now)
        if sched_cfg["us_holidays"]:
            raw += holiday_windows(now)
    return merge_windows(raw), news_cfg, sched_cfg, w1 + w2


def blackout_key(value):
    """A control-file blackout value -> (from, to) server datetimes (format independent), or None."""
    return parse_blackout_value(value)


def strip_auto_values(values, auto_values, keep_values=()):
    """Control-file blackout values without the agent's own automatic lines (a manual line that happens to be equal
    to an automatic one is kept)."""
    auto = set(k for k in (blackout_key(v) for v in auto_values or []) if k)
    keep = set(k for k in (blackout_key(v) for v in keep_values or []) if k)
    out = []
    for v in values:
        k = blackout_key(v)
        if k is not None and k in auto and k not in keep:
            continue
        out.append(v)
    return out


class NewsFeed(object):
    """The ForexFactory weekly calendar: fetched at most every 4 h, the last good copy cached in the agent folder
    (news_cache.json) and used while fetches fail. Never raises."""

    def __init__(self, cache_path, transport, dry_run=False):
        self.cache_path = cache_path
        self.transport = transport
        self.dry_run = dry_run
        self.error = None
        self.next_try = 0.0
        self.cache = self._load()

    def _load(self):
        try:
            with open(self.cache_path, "rb") as f:
                data = json.loads(f.read().decode("utf-8"))
            if isinstance(data, dict) and isinstance(data.get("events"), list) and \
                    to_num(data.get("fetched_at")) is not None:
                return {"fetched_at": float(data["fetched_at"]), "events": data["events"]}
        except (OSError, ValueError):
            pass
        return None

    @property
    def events(self):
        return self.cache["events"] if self.cache else []

    @property
    def fetched_at(self):
        return self.cache["fetched_at"] if self.cache else None

    def due(self, now):
        if now < self.next_try:
            return False
        if not self.cache:
            return True
        age = now - self.cache["fetched_at"]
        if age < -60:                                   # the PC clock went back: fetch again
            return True
        last = max([parse_utc(e.get("ts_utc")) or 0 for e in self.cache["events"]] or [0])
        return age >= (NEWS_WEEK_OVER_REFRESH_S if last < now else NEWS_REFRESH_S)

    def refresh(self, now):
        """Fetch when due. Returns True when a new copy was stored."""
        if not self.due(now):
            return False
        try:
            r = self.transport.request("GET", NEWS_URL, headers={"User-Agent": NEWS_USER_AGENT,
                                                                 "Accept": "application/json"},
                                       timeout=NEWS_TIMEOUT_S)
            if r.status != 200:
                raise ValueError("HTTP %d" % r.status)
            body = r.content or b""
            if len(body) > NEWS_MAX_BYTES:
                raise ValueError("calendar too large (%d bytes)" % len(body))
            events = normalize_ff_events(json.loads(body.decode("utf-8-sig")))
        except Exception as e:  # network, HTTP, bad JSON, a fake transport's assertion: keep the last good copy
            self.error = clean_note(redact("%s: %s" % (type(e).__name__, e)), 200)
            self.next_try = now + NEWS_RETRY_S
            LOG.warning("news calendar not fetched (%s)%s; next try in %d min", self.error,
                        ", using the copy from %s" % iso_z(self.cache["fetched_at"]) if self.cache else "",
                        NEWS_RETRY_S // 60)
            return False
        self.cache = {"fetched_at": float(now), "events": events}
        self.error = None
        self.next_try = 0.0
        LOG.info("news calendar fetched: %d event(s) this week", len(events))
        if not self.dry_run:
            try:
                write_json_atomic(self.cache_path, {"fetched_at": now, "source": NEWS_URL, "events": events})
            except OSError as e:
                LOG.warning("cannot save %s: %s", os.path.basename(self.cache_path), e)
        return True


# ---------------------------------------------------------------------------------------------------------------------
# Remote file (SPEC 3.7, read by EA v3.04 and later)
# ---------------------------------------------------------------------------------------------------------------------
def fmt_param(key, value):
    kind = REMOTE_SPEC[key][0]
    if kind == "bool":
        return "true" if value else "false"
    if kind in ("int", "token"):
        return str(int(round(value)))
    if kind == "lots":
        return "%.2f" % value
    s = ("%.6f" % float(value)).rstrip("0")
    return s + "0" if s.endswith(".") else s


def render_remote_text(version, live, params, written):
    """SPEC 3.7 text: version, live, then the params in allow-list order (the v3.05 runner keys after the lock keys,
    `cap_reset=<int>` as the last line)."""
    lines = ["# Dobby3 remote parameters, written %s by dobby_agent (web v%d)" % (
        written.strftime("%Y-%m-%d %H:%M:%S"), int(version)), "version=%d" % int(version)]
    if live is not None:
        lines.append("live=%d" % (1 if live else 0))
    for k in REMOTE_KEYS:
        if params and k in params:
            lines.append("%s=%s" % (k, fmt_param(k, params[k])))
    return "\r\n".join(lines) + "\r\n"


def remote_semantics(text):
    """Remote-file lines without the comment and the version line (a new version alone is not a reason to rewrite;
    a changed cap_reset token IS one, like any other line)."""
    return [ln for ln in file_body(text) if not ln.lower().startswith("version=")]


def remote_file_version(text):
    for ln in file_body(text):
        if ln.lower().startswith("version="):
            try:
                return int(ln.split("=", 1)[1].strip())
            except ValueError:
                return None
    return None


# ---------------------------------------------------------------------------------------------------------------------
# Desired state built from / adopted from the EA's files
# ---------------------------------------------------------------------------------------------------------------------
def control_semantics(desired, offset_min, now):
    d = normalize_desired(desired)
    vals = blackout_lines(d["blackouts"], offset_min, now)[0] if offset_min is not None else []
    r2 = lambda x: None if x is None else round(x, 2)  # noqa: E731
    return (d["mode"], r2(d["lots"]), d["allow_long"], d["allow_short"], r2(d["max_spread"]), tuple(vals))


def file_blackouts_to_utc(values, offset_min, now, old=None):
    """Control-file blackout values (server time) -> desired.blackouts (UTC), future windows only. A window that
    matches an existing desired entry keeps that entry (and its label)."""
    old_by_key = {}
    for b in old or []:
        ep = _blackout_epochs(b)
        if ep is not None:
            old_by_key[ep] = b
    out = []
    for v in values:
        p = parse_blackout_value(v)
        if p is None:
            continue
        f = naive_to_epoch(p[0]) - offset_min * 60
        t = naive_to_epoch(p[1]) - offset_min * 60
        if t < now:
            continue
        key = (f, t)
        out.append(dict(old_by_key[key]) if key in old_by_key else
                   {"from_utc": iso_z(f), "to_utc": iso_z(t), "label": "local"})
    return out


def desired_from_files(status, parsed_ctl, offset_min, now, note="registered by dobby_agent", exclude_blackouts=None):
    """`register`: desired from the EA's current state. live = not live_locked and control mode run.
    exclude_blackouts: this PC's own automatic lines (SPEC 9.3), never copied into desired.blackouts."""
    status = status if isinstance(status, dict) else {}
    st_ctl = status.get("control") if isinstance(status.get("control"), dict) else {}
    flags = status.get("flags") if isinstance(status.get("flags"), dict) else {}
    if parsed_ctl is not None:
        cfg = parsed_ctl["cfg"]
        mode = "pause" if cfg.get("mode", "run").strip().lower() == "pause" else "run"
        lots = to_num(cfg.get("lots"))
        ms = to_num(cfg.get("max_spread"))
        allow_long = ea_bool(cfg.get("allow_long", "1"))
        allow_short = ea_bool(cfg.get("allow_short", "1"))
        vals = strip_auto_values(parsed_ctl["blackouts"], exclude_blackouts) if exclude_blackouts else             parsed_ctl["blackouts"]
        blackouts = file_blackouts_to_utc(vals, offset_min, now) if offset_min is not None else []
    else:
        mode = "pause" if str(st_ctl.get("mode", "run")).lower() == "pause" else "run"
        lots, ms, allow_long, allow_short, blackouts = None, None, True, True, []
    return {
        "live": (not bool(flags.get("live_locked"))) and mode == "run",
        "control": {"mode": mode, "lots": lots if lots and lots > 0 else None, "allow_long": allow_long,
                    "allow_short": allow_short, "max_spread": ms if ms and ms > 0 else None, "note": note},
        "blackouts": blackouts,
        "params": None,
    }


def seed_from_ea(common, cfg, clock=time.time, sleep=time.sleep, wait_s=6, exclude_blackouts=None):
    """`register` (also used by the Dobby App): the desired state built from the EA's files. Two status samples
    `wait_s` apart (the offset is only trusted while the server clock runs). None when there is no status file.
    Returns {status, desired, confirmed, offset, offset_override, now}."""
    st_path = os.path.join(common, STATUS_NAME)
    s1 = read_status_file(st_path, sleep=sleep)
    if s1 is None:
        return None
    sleep(wait_s)
    s2 = read_status_file(st_path, sleep=sleep) or s1
    ov = config_offset(cfg)
    confirmed = offset_confirmed_by(offset_sample(s1), offset_sample(s2))
    offset = ov if ov is not None else raw_offset_min(s2)
    ctl_text = read_text(os.path.join(common, CONTROL_NAME), sleep=sleep)
    parsed = parse_control_text(ctl_text) if ctl_text is not None else None
    now = clock()
    return {"status": s2, "desired": desired_from_files(s2, parsed, offset, now, exclude_blackouts=exclude_blackouts),
            "confirmed": confirmed,
            "offset": offset, "offset_override": ov is not None, "now": now}


def first_state(common, now, applied_live=None, applied_version=1, status=None, confirmed=False):
    """agent_state.json for a freshly registered bot (version 1 = the EA's own state, already applied) or a PC linked
    to an existing bot (applied_version 0: the web's state is applied at the first cycle). A control file that is
    present now is never adopted back into the web state."""
    state = default_state()
    state["applied_version"] = state["reported_version"] = int(applied_version)
    if applied_version:
        state["applied_at"] = iso_z(now)
        state["applied_live"] = applied_live
    try:
        state["control"]["adopted_mtime"] = os.stat(os.path.join(common, CONTROL_NAME)).st_mtime
    except OSError:
        pass
    if status is not None:
        state["offset"] = {"min": raw_offset_min(status) if confirmed else None, "confirmed": confirmed,
                           "sample": offset_sample(status)}
    return state


def adopt_into_desired(desired, parsed_ctl, offset_min, now, live_effective):
    """SPEC 3.4 step 5: copy the control part and the blackouts of a locally edited control file into desired.
    desired.live and desired.params are never touched (a local change can never turn live on). A 'mode=pause' that
    only exists because the agent paused for live=off does not overwrite the web's mode."""
    new = copy.deepcopy(desired) if isinstance(desired, dict) else {}
    ctl = dict(new.get("control") or {}) if isinstance(new.get("control"), dict) else {}
    cfg = parsed_ctl["cfg"]
    if cfg.get("mode", "run").strip().lower() == "pause":
        if live_effective is not False:
            ctl["mode"] = "pause"
        else:
            ctl.setdefault("mode", "run")
    else:
        ctl["mode"] = "run"
    lots = to_num(cfg.get("lots"))
    ctl["lots"] = round(lots, 2) if lots is not None and lots > 0 else None
    ctl["allow_long"] = ea_bool(cfg.get("allow_long", "1"))
    ctl["allow_short"] = ea_bool(cfg.get("allow_short", "1"))
    ms = to_num(cfg.get("max_spread"))
    ctl["max_spread"] = round(ms, 2) if ms is not None and ms > 0 else None
    fnote = clean_note(parsed_ctl.get("note"))
    ctl["note"] = "local change" + (": " + fnote if fnote and not fnote.lower().startswith("web") else "")
    new["control"] = ctl
    if offset_min is not None:
        old = new.get("blackouts") if isinstance(new.get("blackouts"), list) else []
        new["blackouts"] = file_blackouts_to_utc(parsed_ctl["blackouts"], offset_min, now, old)
    return new


# ---------------------------------------------------------------------------------------------------------------------
# HTTP + Supabase
# ---------------------------------------------------------------------------------------------------------------------
class HttpResponse(object):
    """`text` (str) and `content` (bytes) are both available; whichever was not given is derived on first use
    (a binary download is never decoded unless someone asks for its text)."""

    def __init__(self, status, text="", headers=None, content=None, encoding=None):
        self.status = int(status)
        self.headers = headers or {}
        self._text = text
        self._content = content
        self._encoding = encoding or "utf-8"

    @property
    def text(self):
        if self._text is None:
            self._text = self._content.decode(self._encoding, "replace") if self._content else ""
        return self._text or ""

    @property
    def content(self):
        if self._content is None:
            self._content = (self._text or "").encode("utf-8")
        return self._content

    def json(self):
        return json.loads(self.text) if self.text.strip() else None


class HttpTransport(object):
    """Real transport (requests). Tests inject an object with the same request() method."""

    def __init__(self, timeout=20):
        if requests is None:
            raise RuntimeError("the 'requests' package is missing: run install.bat (pip install -r requirements.txt)")
        self.timeout = timeout
        self.session = requests.Session()

    def request(self, method, url, headers=None, params=None, json_body=None, timeout=None):
        try:
            r = self.session.request(method, url, headers=headers, params=params, json=json_body,
                                     timeout=timeout or self.timeout)
        except requests.RequestException as e:
            raise NetworkError(redact("%s: %s" % (type(e).__name__, e)))
        return HttpResponse(r.status_code, None, dict(r.headers), r.content, r.encoding)


def _error_message(resp):
    try:
        data = resp.json()
    except ValueError:
        data = None
    if isinstance(data, dict):
        for k in ("error_description", "msg", "message", "error"):
            if data.get(k):
                return str(data[k])[:300], data.get("code") or data.get("error_code")
    return (resp.text or "")[:300], None


class SupabaseClient(object):
    """Auth + PostgREST over plain HTTP. The key (publishable sb_publishable_... or legacy anon JWT) goes ONLY in the
    `apikey` header; `Authorization: Bearer` carries the user's access token on REST/RPC calls and is never sent to
    the auth token endpoint."""

    def __init__(self, url, anon_key, transport, refresh_token="", on_refresh_token=None, clock=time.time):
        self.url = (url or "").rstrip("/")
        self.key = anon_key or ""
        self.transport = transport
        self.refresh_token = refresh_token or ""
        self.on_refresh_token = on_refresh_token
        self.clock = clock
        self.access_token = None
        self.expires_at = 0.0
        self.user_id = None
        add_secret(self.key)
        add_secret(self.refresh_token)

    # -- auth
    def _token_request(self, grant, body):
        headers = {"apikey": self.key, "Content-Type": "application/json", "Accept": "application/json"}
        r = self.transport.request("POST", self.url + "/auth/v1/token", headers=headers,
                                   params={"grant_type": grant}, json_body=body)
        if r.status >= 500 or r.status in (408, 429):
            raise NetworkError("auth server HTTP %d" % r.status)
        if r.status != 200:
            msg, _ = _error_message(r)
            raise AuthError(msg or ("HTTP %d" % r.status))
        data = r.json() or {}
        tok = data.get("access_token")
        if not tok:
            raise AuthError("no access token in the answer")
        self.access_token = tok
        add_secret(tok)
        exp = to_num(data.get("expires_at"))
        if exp is None:
            exp = self.clock() + (to_num(data.get("expires_in")) or 3600)
        self.expires_at = exp
        user = data.get("user") if isinstance(data.get("user"), dict) else {}
        self.user_id = user.get("id")
        new_rt = data.get("refresh_token")
        if new_rt:
            self.refresh_token = new_rt
            add_secret(new_rt)
            if self.on_refresh_token:
                self.on_refresh_token(new_rt)
        return data

    def sign_in_password(self, email, password):
        add_secret(password)
        self._token_request("password", {"email": email, "password": password})

    def refresh(self):
        if not self.refresh_token:
            raise AuthError("not logged in")
        self._token_request("refresh_token", {"refresh_token": self.refresh_token})

    def set_refresh_token(self, token):
        self.refresh_token = token or ""
        add_secret(self.refresh_token)
        self.access_token = None
        self.expires_at = 0.0

    def ensure_token(self):
        if not self.access_token or self.expires_at - self.clock() < TOKEN_MARGIN_S:
            self.refresh()

    # -- REST
    def request(self, method, path, params=None, body=None, prefer=None, _retry=True):
        self.ensure_token()
        headers = {"apikey": self.key, "Authorization": "Bearer " + self.access_token,
                   "Content-Type": "application/json", "Accept": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        r = self.transport.request(method, self.url + "/rest/v1/" + path, headers=headers, params=params,
                                   json_body=body)
        if r.status == 401 and _retry:
            self.access_token = None
            self.refresh()
            return self.request(method, path, params, body, prefer, _retry=False)
        if r.status >= 500 or r.status in (408, 429):
            raise NetworkError("HTTP %d on %s %s" % (r.status, method, path.split("?")[0]))
        if r.status >= 400:
            msg, code = _error_message(r)
            raise ApiError(r.status, msg, code)
        try:
            return r.json()
        except ValueError:
            return None

    def select(self, table, params):
        return self.request("GET", table, params=params)

    def upsert(self, table, rows, on_conflict):
        return self.request("POST", table, params={"on_conflict": on_conflict}, body=rows,
                            prefer="resolution=merge-duplicates,return=minimal")

    def insert(self, table, rows):
        return self.request("POST", table, body=rows, prefer="return=minimal")

    def insert_ignore(self, table, rows, on_conflict):
        return self.request("POST", table, params={"on_conflict": on_conflict}, body=rows,
                            prefer="resolution=ignore-duplicates,return=minimal")

    def patch(self, table, filters, body, returning=False):
        return self.request("PATCH", table, params=filters, body=body,
                            prefer="return=representation" if returning else "return=minimal")

    def rpc(self, fn, args):
        return self.request("POST", "rpc/" + fn, body=args or {})


# ---------------------------------------------------------------------------------------------------------------------
# Telegram (Thai text, one message per event, rate-limited, never raises)
# ---------------------------------------------------------------------------------------------------------------------
def _f2(x):
    return "-" if x is None else "%.2f" % x


def _server_ts(row):
    return (row.get("ts_server") or "").replace("-", ".").replace("T", " ")


def msg_journal(bot, row):
    """(telegram event, Thai text) for OPEN / CLOSE / LOCK / LOCK1 / ERROR journal rows, else None."""
    ev = (row.get("event") or "").upper()
    tag = row.get("tag") or "-"
    side = row.get("side") or ""
    head = "[%s] " % bot
    when = "เวลาเซิร์ฟเวอร์ %s" % _server_ts(row)
    if ev == "OPEN":
        return "open", "%sเปิดออเดอร์ %s %s %s lot @ %s\nSL %s | TP %s\n%s" % (
            head, tag, side, _f2(row.get("lots")), _f2(row.get("price")), _f2(row.get("sl")), _f2(row.get("tp")), when)
    if ev == "CLOSE":
        pnl = row.get("pnl") or 0.0
        m = re.search(r"reason=(\w+)", row.get("detail") or "")
        why = " (%s)" % m.group(1) if m else ""
        return "close", "%sปิดออเดอร์ %s %s %s lot @ %s%s\n%s %+.2f | virtual %s\n%s" % (
            head, tag, side, _f2(row.get("lots")), _f2(row.get("price")), why, "กำไร" if pnl >= 0 else "ขาดทุน", pnl,
            _f2(row.get("v_balance")), when)
    if ev in ("LOCK", "LOCK1"):
        stage = "ขั้นที่ 1 " if ev == "LOCK1" else ""
        return "lock", "%sล็อกกำไร%s%s %s: เลื่อน SL ไป %s\n%s" % (
            head, " " + stage if stage else " ", tag, side, _f2(row.get("sl")), row.get("detail") or "")
    if ev == "ERROR":
        return "error", "%sEA แจ้งข้อผิดพลาด (%s): %s\n%s" % (head, tag, row.get("detail") or "", when)
    return None


def msg_cap(bot, status):
    v = (status or {}).get("virtual") or {}
    return "[%s] ถึงเพดานขาดทุนรายวันแล้ว: P&L วันนี้ %+.2f (virtual %s)\nบอทจะไม่เข้าออเดอร์ใหม่จนถึงวันใหม่" % (
        bot, to_num(v.get("day_pnl")) or 0.0, _f2(to_num(v.get("balance"))))


def msg_offline(bot, age_s):
    if age_s is None:
        return "[%s] EA ออฟไลน์: ไม่พบไฟล์สถานะของ EA (ตรวจสอบว่าเปิด MT5 และ EA อยู่)" % bot
    return "[%s] EA ออฟไลน์: ไม่ได้รับสัญญาณจาก EA มา %d นาที\nตรวจสอบว่า MT5 เปิดอยู่และปุ่ม Algo Trading ทำงาน" % (
        bot, int(age_s // 60))


def msg_online(bot):
    return "[%s] EA กลับมาออนไลน์แล้ว" % bot


def msg_live(bot, on, version):
    if on:
        return "[%s] เปิดการเทรดจริงแล้ว (คำสั่งจากเว็บ v%d)" % (bot, version)
    return "[%s] ปิดการเทรดจริงแล้ว: บอทหยุดเข้าออเดอร์ใหม่ (คำสั่งจากเว็บ v%d)" % (bot, version)


def msg_live_refused(bot, version):
    return ("[%s] เว็บขอเปิดการเทรดจริง (v%d) แต่เครื่องนี้ไม่อนุญาต (allow_remote_live = off)\n"
            "ถ้าต้องการ ให้รันบนเครื่องนี้: python dobby_agent.py limits --allow-live on") % (bot, version)


def msg_daily(bot, day, status, stats):
    v = (status or {}).get("virtual") or {}
    stats = stats or {}
    lines = ["[%s] สรุปวันที่ %s (เวลาเซิร์ฟเวอร์)" % (bot, day)]
    if v.get("day") == day:
        lines.append("P&L วันนี้ %+.2f | virtual %s" % (to_num(v.get("day_pnl")) or 0.0, _f2(to_num(v.get("balance")))))
    lines.append("ปิดออเดอร์ %d ครั้ง (ชนะ %d / แพ้ %d) รวม %+.2f" % (
        stats.get("n", 0), stats.get("wins", 0), stats.get("losses", 0), stats.get("pnl", 0.0)))
    return "\n".join(lines)


def msg_agent_error(bot, err):
    return "[%s] เอเจนต์มีปัญหา: %s" % (bot, err)


def msg_login_needed(bot):
    return "[%s] เอเจนต์เข้าสู่ระบบไม่ได้ ต้อง login ใหม่: python dobby_agent.py login" % bot


def msg_test(bot):
    return "[%s] ทดสอบการแจ้งเตือนจาก Dobby agent %s สำเร็จ" % (bot, AGENT_VERSION)


class Telegram(object):
    def __init__(self, transport, token="", chat_id="", events=None, clock=time.time, dry_run=False,
                 max_per_min=20, burst=3, queue_max=30, cooldown_s=1800):
        self.transport = transport
        self.clock = clock
        self.dry_run = dry_run
        self.max_per_min = max_per_min
        self.burst = burst
        self.queue_max = queue_max
        self.cooldown_s = cooldown_s
        self.queue = []
        self.dropped = 0
        self.sent_times = []
        self.pause_until = 0.0
        self.failures = 0
        self._keys = {}
        self.configure(token, chat_id, events)

    def configure(self, token, chat_id, events=None):
        self.token = token or ""
        self.chat_id = str(chat_id or "")
        self.events = list(events) if events is not None else list(TELEGRAM_EVENTS)
        add_secret(self.token)

    @property
    def enabled(self):
        return bool(self.token and self.chat_id)

    def notify(self, event, text, key=None):
        """Queue one message. Returns True when queued. `key` de-duplicates repeats within the cooldown."""
        if not self.enabled or event not in self.events:
            return False
        now = self.clock()
        if key is not None:
            last = self._keys.get(key)
            if last is not None and now - last < self.cooldown_s:
                return False
            self._keys[key] = now
        if self.dry_run:
            LOG.info("[dry-run] telegram (%s): %s", event, text.replace("\n", " | "))
            return True
        if len(self.queue) >= self.queue_max:
            self.queue.pop(0)
            self.dropped += 1
        self.queue.append(text)
        return True

    def flush(self):
        """Send up to `burst` queued messages, at most `max_per_min` per minute. Returns how many were sent."""
        if not self.enabled or self.dry_run or not self.queue:
            return 0
        now = self.clock()
        if now < self.pause_until:
            return 0
        sent = 0
        while self.queue and sent < self.burst:
            self.sent_times = [t for t in self.sent_times if now - t < 60]
            if len(self.sent_times) >= self.max_per_min:
                break
            text = self.queue[0]
            if self.dropped:
                text = "(ข้ามข้อความเก่า %d รายการ เพราะแจ้งเตือนถี่เกินไป)\n%s" % (self.dropped, text)
            ok, retry_after = self._send(text)
            if ok:
                self.queue.pop(0)
                self.dropped = 0
                self.failures = 0
                self.sent_times.append(now)
                sent += 1
                continue
            if retry_after:
                self.pause_until = now + retry_after
            else:
                self.failures += 1
                if self.failures >= 3:
                    self.queue.pop(0)
                    self.failures = 0
                    LOG.warning("telegram: message dropped after 3 failed attempts")
            break
        return sent

    def _send(self, text):
        url = "https://api.telegram.org/bot%s/sendMessage" % self.token
        try:
            r = self.transport.request("POST", url, headers={"Content-Type": "application/json"},
                                       json_body={"chat_id": self.chat_id, "text": text[:4000],
                                                  "disable_web_page_preview": True}, timeout=15)
        except Exception as e:  # NetworkError or anything else: never let Telegram break the loop
            LOG.warning("telegram send failed: %s", redact(str(e)))
            return False, None
        if r.status == 200:
            return True, None
        retry = None
        if r.status == 429:
            try:
                retry = to_num(((r.json() or {}).get("parameters") or {}).get("retry_after")) or 30
            except ValueError:
                retry = 30
        msg, _ = _error_message(r)
        LOG.warning("telegram HTTP %d: %s", r.status, redact(msg))
        return False, retry

    def send_now(self, text):
        if not self.enabled:
            return False, "telegram token / chat_id not set"
        ok, retry = self._send(text)
        return ok, "" if ok else ("rate limited, retry in %ss" % retry if retry else "send failed (see agent.log)")


# ---------------------------------------------------------------------------------------------------------------------
# Config and state
# ---------------------------------------------------------------------------------------------------------------------
def default_config():
    return {
        "supabase_url": "",
        "anon_key": "",
        "email": "",
        "refresh_token": "",
        "bot_id": "",
        "bot_name": "",
        "common_dir": None,
        "server_utc_offset_min": None,
        "limits": dict(DEFAULT_LIMITS),
        "telegram": {"token": "", "chat_id": "", "events": list(TELEGRAM_EVENTS)},
        "poll_seconds": 5,
    }


def load_config(path):
    cfg = default_config()
    try:
        with open(path, "rb") as f:
            data = json.loads(f.read().decode("utf-8-sig"))
    except FileNotFoundError:
        return cfg
    if not isinstance(data, dict):
        raise ValueError("%s is not a JSON object" % os.path.basename(path))
    _merge(cfg, data)
    add_secret(cfg.get("refresh_token"))
    add_secret(cfg.get("anon_key"))
    add_secret((cfg.get("telegram") or {}).get("token"))
    return cfg


def save_config(path, cfg):
    write_json_atomic(path, cfg)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def update_config(path, mutate):
    """Read-modify-write so a running agent and a `limits` / `login` command never undo each other's changes."""
    cfg = load_config(path)
    mutate(cfg)
    save_config(path, cfg)
    return cfg


def default_state():
    return {
        "applied_version": 0, "applied_at": None, "applied_live": None, "applied_params": None,
        "reported_version": 0,
        "journal": {"offset": 0, "alert_offset": 0, "initialized": False, "hashes": []},
        "control": {"last_write_mtime": 0.0, "last_write_id": "", "adopted_mtime": 0.0, "auto_lines": []},
        "remote": {"version": None, "dropped": ""},     # dropped: "<ea_version>|<keys>" last noted (once per change)
        "bars_upload": {"pos": 0, "last_t": None},
        "cash": {"balance": None, "pnl": 0.0, "pending": None},
        "offset": {"min": None, "confirmed": False, "sample": None},
        "alerts": {"ea_offline": False, "cap_hit": None, "daily_done": "", "auth_alerted": False},
        "day_stats": {},
        "last_error": "",
    }


def load_state(path):
    st = default_state()
    try:
        with open(path, "rb") as f:
            data = json.loads(f.read().decode("utf-8"))
        if isinstance(data, dict):
            _merge(st, data)
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as e:
        LOG.warning("%s unreadable (%s): starting with a fresh state", STATE_NAME, e)
    return st


def config_offset(cfg):
    """Manual server UTC offset (minutes) from the config, or None."""
    x = to_num((cfg or {}).get("server_utc_offset_min"))
    return int(round(x)) if x is not None and -900 <= x <= 900 else None


def resolve_common_dir(cfg, environ=None):
    environ = os.environ if environ is None else environ
    if environ.get("DOBBY_COMMON"):
        return environ["DOBBY_COMMON"]
    if (cfg or {}).get("common_dir"):
        return cfg["common_dir"]
    base = environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "MetaQuotes", "Terminal", "Common", "Files", "Dobby")


class InstanceLock(object):
    """One `run` per agent folder (OS file lock, released automatically if the process dies)."""

    def __init__(self, path):
        self.path = path
        self.fh = None

    def acquire(self):
        self.fh = open(self.path, "a+")
        try:
            self.fh.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            self.fh.close()
            self.fh = None
            return False

    def release(self):
        if self.fh is not None:
            try:
                self.fh.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            self.fh.close()
            self.fh = None


_LOCK_AT = 1 << 20   # the byte the OS locks: far after the JSON body, so a refused agent can still read who holds it
_LOCK_BUSY = set(e for e in (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLK,
                             getattr(errno, "EDEADLOCK", errno.EDEADLK)))


def pid_alive(pid):
    """True when a process with this id is running on this PC."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        h = k32.OpenProcess(0x1000, False, pid)          # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5           # access denied: it exists (another user's process)
        try:
            code = wintypes.DWORD()
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return True
            return code.value == 259                      # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def process_started_at(pid):
    """Creation time (epoch seconds) of a running process, or None (unknown / not Windows)."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
        h = k32.OpenProcess(0x1000, False, int(pid))
        if not h:
            return None
        try:
            ft = [wintypes.FILETIME() for _ in range(4)]
            if not k32.GetProcessTimes(h, *[ctypes.byref(f) for f in ft]):
                return None
            ticks = (ft[0].dwHighDateTime << 32) | ft[0].dwLowDateTime
            return ticks / 1e7 - 11644473600.0
        finally:
            k32.CloseHandle(h)
    except Exception:
        return None


def lock_holder_alive(body, host=None):
    """Is the agent described by a lock body still running? (only used when the OS lock is not available)"""
    if not isinstance(body, dict) or not body.get("pid"):
        return False
    if (body.get("host") or "") != (host or socket.gethostname()):
        return True                                       # another PC (network drive): cannot check, assume alive
    if not pid_alive(body["pid"]):
        return False
    started = to_num(body.get("started_unix"))
    created = process_started_at(body["pid"])
    if started is not None and created is not None and created > started + 5:
        return False                                      # the pid was reused by a newer process
    return True


def lock_holder_text(body):
    """Thai description of the agent that holds the EA-folder lock."""
    if not isinstance(body, dict) or not body:
        return "โปรแกรม Dobby อีกตัว"
    parts = [str(body.get("program") or "Dobby agent")]
    if body.get("pid"):
        parts.append("PID %s" % body["pid"])
    if body.get("started"):
        parts.append("เริ่มเมื่อ %s" % body["started"])
    if body.get("host") and body.get("host") != socket.gethostname():
        parts.append("เครื่อง %s" % body["host"])
    return ", ".join(parts)


class CommonLock(object):
    """One agent per MT5: the CLI `run` and the Dobby App both take Common\\Files\\Dobby\\dobby_agent.lock, so two
    agents can never write the same control file. The OS locks one byte far after a small JSON body (pid, start time,
    host, program). The OS drops that lock when the process dies, so a file left by a crashed agent is stale and is
    taken over (`stale` = its body). A refused acquire() sets `holder` (the body of the running agent) for the message.
    Where the file system cannot lock (some network drives) the body alone decides: a dead or reused pid is stale."""

    def __init__(self, common_dir, program="dobby_agent.py run", clock=time.time, local_now=datetime.now):
        self.common_dir = common_dir
        self.path = os.path.join(common_dir, COMMON_LOCK_NAME)
        self.program = program
        self.clock = clock
        self.local_now = local_now
        self.fh = None
        self.os_locked = False
        self.holder = None
        self.stale = None
        self.error = ""

    def body(self):
        return {"pid": os.getpid(), "host": socket.gethostname(), "program": self.program,
                "started": self.local_now().strftime("%Y-%m-%d %H:%M:%S"), "started_unix": int(self.clock()),
                "agent_version": AGENT_VERSION}

    @staticmethod
    def _parse(data):
        try:
            obj = json.loads((data or b"").decode("utf-8", "replace").strip() or "null")
        except ValueError:
            return None
        return obj if isinstance(obj, dict) else None

    def read(self):
        """The current body (also readable while another process holds the lock), or None."""
        try:
            with open(self.path, "rb") as f:
                return self._parse(f.read(4096))
        except OSError:
            return None

    def _os_lock(self, fh):
        """True = locked by us, False = held by another process, None = locking not supported here."""
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(_LOCK_AT)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError as e:
            return False if e.errno in _LOCK_BUSY else None

    def acquire(self):
        self.holder = self.stale = None
        self.error = ""
        if self.fh is not None:
            return True
        try:
            os.makedirs(self.common_dir, exist_ok=True)
            fh = os.fdopen(os.open(self.path, os.O_RDWR | os.O_CREAT, 0o644), "r+b")
        except OSError as e:
            self.error = str(e)
            return False
        try:
            fh.seek(0)
            old = self._parse(fh.read(4096))
            got = self._os_lock(fh)
            if got is False or (got is None and lock_holder_alive(old)):
                fh.close()
                self.holder = old or {}
                return False
            self.stale = old if old and old.get("pid") else None
            fh.seek(0)
            fh.truncate()
            fh.write((json.dumps(self.body(), ensure_ascii=False) + "\n").encode("utf-8"))
            fh.flush()
            try:
                os.fsync(fh.fileno())
            except OSError:
                pass
        except OSError as e:
            fh.close()
            self.error = str(e)
            return False
        self.fh, self.os_locked = fh, bool(got)
        if self.stale:
            LOG.info("EA folder lock: a stale lock (pid %s, started %s) was taken over",
                     self.stale.get("pid"), self.stale.get("started"))
        return True

    def release(self):
        if self.fh is None:
            return
        fh, self.fh = self.fh, None
        try:
            fh.seek(0)
            fh.truncate()            # an empty body = free
            fh.flush()
        except OSError:
            pass
        if os.name == "nt" and self.os_locked:
            try:
                import msvcrt
                fh.seek(_LOCK_AT)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
        fh.close()
        if os.name == "nt":          # Windows refuses the delete while anyone else has it open: then it just stays
            try:
                os.remove(self.path)
            except OSError:
                pass


# ---------------------------------------------------------------------------------------------------------------------
# The agent loop (SPEC 3.4)
# ---------------------------------------------------------------------------------------------------------------------
def shadow_bar_rows(text, offset_min, keep=SHADOW_BARS):
    """SPEC 10.6: the last `keep` M15 bars of dobby2_bars.csv with the EA's indicators, for the shadow snapshot.
    Columns: 0 bar_time (server), 2 close, 3 rsi, 4 atr, 6 h4_close, 7 h4_ema, 9 trend, 14 vwap (newer EA rows)."""
    if text is None or offset_min is None:
        return []
    dedup = {}
    for line in text.splitlines()[1:]:
        p = line.split(",")
        if len(p) < 10:
            continue
        dt = parse_server_dt(p[0])
        close = to_num(p[2])
        if dt is None or close is None or close <= 0:
            continue
        t = naive_to_epoch(dt) - int(offset_min) * 60
        vwap = to_num(p[14]) if len(p) > 14 else None
        dedup[t] = {"t_utc": iso_z(t), "close": round(close, 2), "rsi": to_num(p[3]), "atr": to_num(p[4]),
                    "h4_close": to_num(p[6]), "h4_ema": to_num(p[7]), "trend": to_num(p[9]),
                    "vwap": round(vwap, 2) if vwap is not None and vwap > 0 else None}
    return [dedup[k] for k in sorted(dedup)][-keep:]


def shadow_post_http(url, headers, body, timeout):
    """One POST with its own requests session (the shadow thread never shares the main loop's session).
    Returns (status, parsed JSON or None)."""
    if requests is None:
        raise NetworkError("the 'requests' package is missing")
    try:
        r = requests.post(url, headers=headers, json=body, timeout=timeout)
    except requests.RequestException as e:
        raise NetworkError(redact("%s: %s" % (type(e).__name__, e)))
    try:
        data = r.json()
    except ValueError:
        data = None
    return r.status_code, data


class ShadowWatcher(object):
    """SPEC 10.6 shadow AI forward test. While the EA reports an open Dobby position, post a snapshot of it to the
    Edge Function `shadow` every next_after_s seconds (default 5 min) and append the answer to shadow_decisions.jsonl.
    It never writes an EA file and never changes the bot: the answers are only logged (on the website and locally).
    The call runs in a background thread with the access token the main loop already holds (the thread never
    refreshes the token, so the refresh-token rotation stays in one place). Never raises."""

    def __init__(self, agent, post=None, threaded=True, clock=time.time):
        self.agent = agent
        self.post = post or shadow_post_http
        self.threaded = threaded
        self.clock = clock
        self.log_path = os.path.join(agent.agent_dir, SHADOW_LOG_NAME)
        self.next_at = {}            # ticket -> epoch of the next question
        self.busy = set()            # tickets with a call in flight
        self.paused_until = 0.0
        self.pause_reason = ""
        self.journal = []            # recent journal rows (parsed), newest last
        self.calls = 0
        self.last_at = None
        self.last_error = ""
        self.lock = threading.Lock()

    def enabled(self):
        return bool(self.agent.config.get("shadow", True)) and not self.agent.dry_run

    def feed_journal(self, rows):
        if rows:
            self.journal = (self.journal + [r for r in rows if isinstance(r, dict)])[-200:]

    def open_positions(self, status):
        out = []
        for p in (status or {}).get("positions") or []:
            if isinstance(p, dict) and p.get("open") is True and to_num(p.get("ticket")):
                out.append(p)
        return out

    def snapshot(self, status, pos, now):
        st = status or {}
        mod = pos.get("module")
        off, _ = self.agent.effective_offset()
        try:
            bars = shadow_bar_rows(read_text(self.agent.bars_path, sleep=self.agent.sleep), off)
        except Exception:
            bars = []
        events = []
        for e in self.agent.news.events:
            t = parse_utc(e.get("ts_utc"))
            if t is not None and now - 2 * 3600 <= t <= now + 6 * 3600 and e.get("currency") == "USD" and \
                    e.get("impact") in ("High", "Medium"):
                events.append(dict((k, e.get(k)) for k in ("title", "ts_utc", "impact", "forecast", "previous")))
        jr = [dict((k, r.get(k)) for k in ("ts_server", "event", "tag", "side", "lots", "price", "sl", "tp", "pnl",
                                           "detail"))
              for r in self.journal if r.get("tag") == mod][-SHADOW_JOURNAL_ROWS:]
        modstats = [m for m in st.get("modules") or [] if isinstance(m, dict) and m.get("module") == mod]
        opts = st.get("options") or {}
        snap = {
            "now_utc": iso_z(now),
            "server_time": st.get("server_time"),
            "server_utc_offset_min": off,
            "position": dict((k, v) for k, v in pos.items() if k != "open"),
            "market": st.get("market"),
            "last_bar": st.get("last_bar"),
            "bars_m15": bars,
            "day": dict((k, (st.get("virtual") or {}).get(k)) for k in ("day", "day_start", "day_pnl", "step",
                                                                       "day_cap_hit", "balance")),
            "module_today": modstats[0] if modstats else None,
            "rules": {"params": st.get("params"), "lock": opts.get("lock"), "lock1": opts.get("lock1"),
                      "daily_cap_pct": (st.get("params") or {}).get("daily_cap_pct")},
            "news_usd": events,
            "journal_this_module": jr,
        }
        if mod == "NY":
            snap["ny"] = st.get("ny")
        return snap

    def step(self, status, now):
        """Called by the main loop after a successful login. Starts at most one call per open trade."""
        try:
            self._step(status, now)
        except Exception as e:  # a shadow bug must never disturb the bot loop
            LOG.warning("shadow AI step failed: %s", redact(str(e))[:200])

    def _step(self, status, now):
        if not self.enabled():
            return
        positions = self.open_positions(status)
        open_tickets = set(int(to_num(p["ticket"])) for p in positions)
        with self.lock:
            for t in list(self.next_at):
                if t not in open_tickets and t not in self.busy:
                    del self.next_at[t]
        if not positions or now < self.paused_until:
            return
        client = self.agent.client
        token = getattr(client, "access_token", None)
        if not token or getattr(client, "expires_at", 0) - now < SHADOW_TOKEN_LEFT_S:
            return
        bot_id = self.agent.config.get("bot_id")
        if not bot_id:
            return
        # the news calendar is also used by the snapshot (refresh is rate-limited and never raises)
        self.agent.news.refresh(now)
        for p in positions:
            ticket = int(to_num(p["ticket"]))
            with self.lock:
                if ticket in self.busy or now < self.next_at.get(ticket, 0):
                    continue
                self.busy.add(ticket)
                self.next_at[ticket] = now + SHADOW_INTERVAL_S
            body = {"bot_id": bot_id, "snapshot": self.snapshot(status, p, now)}
            headers = {"apikey": client.key, "Authorization": "Bearer " + token, "Content-Type": "application/json",
                       "Accept": "application/json"}
            args = (client.url + SHADOW_PATH, headers, body, ticket, p)
            if self.threaded:
                threading.Thread(target=self._call, args=args, name="shadow-%d" % ticket, daemon=True).start()
            else:
                self._call(*args)

    def _call(self, url, headers, body, ticket, pos):
        started = self.clock()
        entry = {"ts_utc": iso_z(started), "ticket": ticket, "module": pos.get("module"), "side": pos.get("side"),
                 "lots": pos.get("lots"), "open_price": pos.get("open_price"), "sl": pos.get("sl"), "tp": pos.get("tp"),
                 "profit": pos.get("profit"), "comment": pos.get("comment"),
                 "server_time": body["snapshot"].get("server_time"),
                 "bid": (body["snapshot"].get("market") or {}).get("bid"),
                 "ask": (body["snapshot"].get("market") or {}).get("ask")}
        nxt = SHADOW_RETRY_S
        try:
            status, data = self.post(url, headers, body, SHADOW_TIMEOUT_S)
            data = data if isinstance(data, dict) else {}
            entry["http"] = status
            if status == 200 and data.get("ok"):
                d = data.get("decision") or {}
                entry.update({"id": data.get("id"), "action": d.get("action"), "new_sl": d.get("new_sl"),
                              "confidence": d.get("confidence"), "reason": d.get("reason"), "valid": data.get("valid"),
                              "details": d.get("details") if isinstance(d.get("details"), dict) else {},
                              "model": data.get("model"), "cost_usd": data.get("cost_usd")})
                nxt = to_num(data.get("next_after_s")) or SHADOW_INTERVAL_S
                self.last_error = ""
                LOG.info("shadow AI: %s #%s -> %s (%s%%) %s", pos.get("module"), ticket, d.get("action"),
                         d.get("confidence"), clean_note(d.get("reason"), 120))
            else:
                code = str(data.get("error") or ("http_%d" % status))
                entry.update({"error": code, "message": clean_note(data.get("message"), 200), "id": data.get("id")})
                if code in SHADOW_PAUSE_S:
                    with self.lock:
                        self.paused_until = self.clock() + SHADOW_PAUSE_S[code]
                        self.pause_reason = code
                    nxt = SHADOW_PAUSE_S[code]
                elif code == "shadow_too_soon":
                    nxt = 60
                elif code == "ai_failed":
                    nxt = to_num(data.get("next_after_s")) or SHADOW_INTERVAL_S
                self.last_error = code
                LOG.info("shadow AI: %s #%s not answered (%s)", pos.get("module"), ticket, code)
        except Exception as e:  # network or anything else: try again later
            entry["error"] = "network"
            entry["message"] = clean_note(redact(str(e)), 200)
            self.last_error = "network"
        with self.lock:
            self.busy.discard(ticket)
            if ticket in self.next_at:
                self.next_at[ticket] = started + nxt
            self.calls += 1
            self.last_at = started
            try:
                with open(self.log_path, "ab") as f:
                    f.write((json.dumps(entry, ensure_ascii=False) + "\n").encode("utf-8"))
            except OSError as e:
                LOG.warning("cannot write %s: %s", SHADOW_LOG_NAME, e)

    def state(self):
        if not self.enabled():
            return None
        with self.lock:
            return {"calls": self.calls, "last_at": iso_z(self.last_at) if self.last_at else None,
                    "last_error": self.last_error or None,
                    "paused": self.pause_reason if self.clock() < self.paused_until else None}


class Agent(object):
    def __init__(self, agent_dir, common_dir, client, telegram, clock=time.time, sleep=time.sleep,
                 local_now=datetime.now, dry_run=False, news_transport=None):
        self.agent_dir = agent_dir
        self.common_dir = common_dir
        self.config_path = os.path.join(agent_dir, CONFIG_NAME)
        self.state_path = os.path.join(agent_dir, STATE_NAME)
        self.decisions_path = os.path.join(agent_dir, DECISIONS_NAME)
        self.status_path = os.path.join(common_dir, STATUS_NAME)
        self.journal_path = os.path.join(common_dir, JOURNAL_NAME)
        self.control_path = os.path.join(common_dir, CONTROL_NAME)
        self.bars_path = os.path.join(common_dir, BARS_NAME)
        self._bars_cache = (None, None, None)   # (mtime, offset, bars)
        self.remote_path = os.path.join(common_dir, REMOTE_NAME)
        self.config = load_config(self.config_path)
        self.client = client
        self.telegram = telegram
        self.clock = clock
        self.sleep = sleep
        self.local_now = local_now
        self.dry_run = dry_run
        self.state = load_state(self.state_path)
        self.backoff = 0
        self.fail_count = 0
        self.last_status = None
        self.dropped_keys = []         # v3.05 keys left out of the last remote file (EA below 3.05)
        self.raw_offset = None
        self.rejected, self.reject_details, self.warnings, self.cycle_errors = [], [], [], []
        self.last_error = self.state.get("last_error") or ""
        self._last_hb_uploaded = None
        self._last_status_upload = None
        self._last_bots_update = None
        self._force_bots = False
        self._seen = set(self.state["journal"]["hashes"])
        # SPEC 9: automatic blackouts, bars upload, deposit / withdrawal suggestions
        self.news = NewsFeed(os.path.join(agent_dir, NEWS_CACHE_NAME),
                             news_transport if news_transport is not None else getattr(client, "transport", None),
                             dry_run=dry_run)
        self.news_cfg = self.sched_cfg = None
        self.auto_windows = []
        self._auto_logged = None
        self._bars_retry_at = self._cash_retry_at = 0.0
        self._bars_error = self._cash_error = ""
        self._known_tokens = set()
        if client is not None:
            client.on_refresh_token = self._save_refresh_token
            self._known_tokens.add(client.refresh_token)
        self.shadow = ShadowWatcher(self, clock=clock)   # SPEC 10.6 (log only, never touches the EA)

    # -- helpers
    def bot_name(self):
        return self.config.get("bot_name") or "Dobby"

    def limits(self):
        return get_limits(self.config)

    def poll_seconds(self):
        p = to_num(self.config.get("poll_seconds"))
        return max(2, int(p)) if p else 5

    def _save_refresh_token(self, token):
        """Supabase rotates refresh tokens: save the new one at once (also in --dry-run, or the login is lost)."""
        self._known_tokens.add(token)
        try:
            update_config(self.config_path, lambda c: c.__setitem__("refresh_token", token))
            self.config["refresh_token"] = token
        except (OSError, ValueError) as e:
            LOG.error("could not save the new refresh token: %s", e)

    def reload_config(self):
        try:
            disk = load_config(self.config_path)
        except (OSError, ValueError) as e:
            LOG.warning("config unreadable (%s): keeping the previous one", e)
            return
        rt = disk.get("refresh_token") or ""
        if self.client is not None and rt and rt != self.client.refresh_token and rt not in self._known_tokens:
            LOG.info("new login found in the config: using it")
            self._known_tokens.add(rt)
            self.client.set_refresh_token(rt)
        self.config = disk
        tg = disk.get("telegram") or {}
        self.telegram.configure(tg.get("token"), tg.get("chat_id"), tg.get("events", TELEGRAM_EVENTS))

    def effective_offset(self):
        """(minutes, source): config override > confirmed by fresh ticks > raw (unconfirmed) > None."""
        ov = config_offset(self.config)
        if ov is not None:
            return ov, "config"
        o = self.state["offset"]
        if o.get("confirmed") and o.get("min") is not None:
            return int(o["min"]), "confirmed"
        if self.raw_offset is not None:
            return self.raw_offset, "unconfirmed"
        if o.get("min") is not None:
            return int(o["min"]), "unconfirmed"
        return None, "unknown"

    def _track_offset(self, status):
        raw = raw_offset_min(status)
        sample = offset_sample(status)
        if raw is None or sample is None:
            return
        self.raw_offset = raw
        o = self.state["offset"]
        prev = o.get("sample")
        if offset_confirmed_by(prev, sample):
            if o.get("min") != raw or not o.get("confirmed"):
                LOG.info("server UTC offset confirmed: %+d min", raw)
            o["min"], o["confirmed"] = raw, True
        if not prev or sample[0] != prev[0]:
            o["sample"] = sample

    def _ea_live_now(self):
        """Live state of the EA right now (used when no live value was ever applied by this agent)."""
        st = self.last_status or {}
        if (st.get("flags") or {}).get("live_locked"):
            return False
        text = read_text(self.control_path, sleep=self.sleep)
        if text is not None:
            return parse_control_text(text)["cfg"].get("mode", "run").lower() != "pause"
        return str((st.get("control") or {}).get("mode", "run")).lower() == "run"

    def _decision(self, now, text):
        line = "%s | %s" % (self.local_now().strftime("%Y-%m-%d %H:%M:%S"), text)
        LOG.info("decision: %s", text)
        if self.dry_run:
            return
        try:
            with open(self.decisions_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as e:
            LOG.error("cannot write %s: %s", DECISIONS_NAME, e)

    def _save_state(self):
        if self.dry_run:
            return
        j = self.state["journal"]
        j["hashes"] = j["hashes"][-SEEN_HASHES_MAX:]
        self.state["last_error"] = self.last_error
        days = sorted(self.state["day_stats"])
        for d in days[:-10]:
            del self.state["day_stats"][d]
        try:
            write_json_atomic(self.state_path, self.state)
        except OSError as e:
            LOG.error("cannot save %s: %s", STATE_NAME, e)

    def _remember(self, h):
        if h not in self._seen:
            self._seen.add(h)
            hs = self.state["journal"]["hashes"]
            hs.append(h)
            if len(hs) > SEEN_HASHES_MAX * 2:
                for old in hs[:-SEEN_HASHES_MAX]:
                    self._seen.discard(old)
                del hs[:-SEEN_HASHES_MAX]

    # -- one cycle
    def cycle(self):
        """One pass of the loop. Returns the number of seconds to wait before the next one."""
        now = self.clock()
        try:
            self._cycle(now)
        except Exception as e:  # a bug must never kill the agent: log, report, back off
            LOG.exception("cycle failed")
            self._fail("internal error: %s" % e, network=False)
        self._save_state()
        return self.backoff if self.backoff else self.poll_seconds()

    def _cycle(self, now):
        self.reload_config()
        self.warnings, self.cycle_errors = [], []
        status = read_status_file(self.status_path, sleep=self.sleep)
        if status is not None:
            self.last_status = status
            self._track_offset(status)
        self._ea_alerts(status, now)
        j = self.state["journal"]
        rows, ends, end_off, reset = read_journal_chunk(self.journal_path, j["offset"], sleep=self.sleep)
        self._journal_local(rows, ends, end_off, reset)
        self.shadow.feed_journal(rows)
        try:
            if not self.config.get("bot_id"):
                raise AuthError("this PC is not registered: run `register`")
            self.client.ensure_token()
            self._upload_status(status, now)
            self._upload_journal(rows, end_off)
            row = self._fetch_control()
            row = self._adopt_local_change(row, now)
            self._apply_control(row, now)
            self._upload_bars(now)              # SPEC 9.1 (after the control step: never delays it)
            self._cash_flows(status, now)       # SPEC 9.2
            self.shadow.step(status, now)       # SPEC 10.6 (background call, log only; never raises)
            self.last_error = self.cycle_errors[-1] if self.cycle_errors else ""
            self._update_bot_row(status, now)
            self._ok()
        except NetworkError as e:
            self._fail("network: %s" % e, network=True)
        except AuthError as e:
            self._fail("login: %s" % e, auth=True)
        except ApiError as e:
            self._fail("server: %s" % e)
        self._daily_summary(now)
        self.telegram.flush()

    def _ok(self):
        self.fail_count = 0
        self.backoff = 0
        self.state["alerts"]["auth_alerted"] = False

    def _fail(self, msg, network=False, auth=False):
        msg = redact(msg)[:300]
        self.fail_count += 1
        self.last_error = msg
        p = self.poll_seconds()
        self.backoff = MAX_BACKOFF_S if auth else min(MAX_BACKOFF_S, max(2 * p, 2 * self.backoff))
        LOG.warning("%s (next try in %d s; EA files untouched)", msg, self.backoff)
        if auth:
            if not self.state["alerts"]["auth_alerted"]:
                self.state["alerts"]["auth_alerted"] = True
                self.telegram.notify("error", msg_login_needed(self.bot_name()))
        elif self.fail_count >= 3 and not network:
            self.telegram.notify("error", msg_agent_error(self.bot_name(), msg), key="err:" + msg[:80])

    # -- step 2: status
    def _upload_status(self, status, now):
        if status is None:
            return
        hb = status.get("heartbeat_gmt_unix")
        if hb == self._last_hb_uploaded:
            return
        if self._last_status_upload is not None and now - self._last_status_upload < STATUS_MIN_INTERVAL_S:
            return
        if not self.dry_run:
            self.client.upsert("bot_status", [{"bot_id": self.config["bot_id"], "status": status,
                                               "updated_at": iso_z(now)}], "bot_id")
        self._last_hb_uploaded = hb
        self._last_status_upload = now

    # -- step 3: journal
    def _journal_local(self, rows, ends, end_off, reset):
        """Day statistics and Telegram alerts for rows not handled locally before (independent of the network)."""
        j = self.state["journal"]
        if reset:
            j["alert_offset"] = 0
        backfill = (not j["initialized"]) or reset
        cash = self.state["cash"]
        count_cash = j["initialized"] and cash.get("balance") is not None   # 9.2: Dobby pnl since the baseline
        bot = self.bot_name()
        for row, end in zip(rows, ends):
            if end <= j["alert_offset"]:
                continue
            if row["event"] == "CLOSE" and row.get("pnl") is not None:
                day = row["ts_server"][:10].replace("-", ".")
                s = self.state["day_stats"].setdefault(day, {"n": 0, "wins": 0, "losses": 0, "pnl": 0.0})
                s["n"] += 1
                s["wins"] += 1 if row["pnl"] > 0 else 0
                s["losses"] += 1 if row["pnl"] < 0 else 0
                s["pnl"] = round(s["pnl"] + row["pnl"], 2)
                if count_cash:
                    cash["pnl"] = round(float(cash.get("pnl") or 0.0) + row["pnl"], 2)
            if not backfill:
                m = msg_journal(bot, row)
                if m:
                    self.telegram.notify(m[0], m[1])
        j["alert_offset"] = max(j["alert_offset"], end_off)
        j["initialized"] = True

    def _upload_journal(self, rows, end_off):
        j = self.state["journal"]
        fresh = [r for r in rows if r["line_hash"] not in self._seen]
        bot_id = self.config["bot_id"]
        for i in range(0, len(fresh), JOURNAL_BATCH):
            batch = [dict(r, bot_id=bot_id) for r in fresh[i:i + JOURNAL_BATCH]]
            if not self.dry_run:
                try:
                    self.client.insert_ignore("journal", batch, "bot_id,line_hash")
                except ApiError as e:
                    if e.status not in (400, 409, 422):
                        raise
                    self._insert_one_by_one(batch)
            for r in batch:
                self._remember(r["line_hash"])
        if fresh:
            LOG.info("journal: %d new row(s)%s", len(fresh), " [dry-run, not uploaded]" if self.dry_run else "")
        j["offset"] = end_off

    def _insert_one_by_one(self, batch):
        for r in batch:
            try:
                self.client.insert_ignore("journal", [r], "bot_id,line_hash")
            except ApiError as e:
                LOG.warning("journal row refused (%s), skipped: %s %s", e, r.get("ts_server"), r.get("event"))
                self.cycle_errors.append("journal row refused: %s" % e)

    # -- step 4: control
    def _fetch_control(self):
        rows = self.client.select("bot_control", {"bot_id": "eq." + self.config["bot_id"],
                                                  "select": "version,desired,updated_at"})
        if not rows:
            raise ApiError(404, "no bot_control row for this bot (deleted on the website? run register --force)")
        return rows[0]

    def _write_file(self, path, text):
        name = os.path.basename(path)
        if self.dry_run:
            LOG.info("[dry-run] would write %s:\n%s", name, text.rstrip())
            return True
        try:
            write_ea_file(path, text, sleep=self.sleep)
        except OSError as e:
            LOG.error("cannot write %s: %s", name, e)
            self.cycle_errors.append("cannot write %s: %s" % (name, e))
            return False
        LOG.info("wrote %s", name)
        return True

    def _write_control(self, text, version):
        old = read_text(self.control_path, sleep=self.sleep)
        if old is not None and file_body(old) == file_body(text):
            return False
        ok = self._write_file(self.control_path, text)
        if ok and not self.dry_run:
            c = self.state["control"]
            c["last_write_mtime"] = os.stat(self.control_path).st_mtime
            c["last_write_id"] = control_id(version)
        return ok

    def _sync_remote(self, dec, version, limits, written, ea_version=None):
        st = self.state
        self.dropped_keys = []
        allow_live, allow_params = limits["allow_remote_live"], limits["allow_remote_params"]
        old = read_text(self.remote_path, sleep=self.sleep)
        if not (allow_live or allow_params):
            # both off: an old file is neutralised once (no live line -> EA uses InpAllowLive; no params)
            if old is None or not remote_semantics(old):
                return "off"
            ver = remote_file_version(old) or st["remote"]["version"] or version
            if self._write_file(self.remote_path, render_remote_text(ver, None, None, written)) and not self.dry_run:
                st["remote"]["version"] = ver
            return "neutralised"
        live = dec["live"] if allow_live else None
        params = None
        if allow_params:
            if dec["params_state"] == "ok":
                params = dec["params"]
            elif dec["params_state"] == "rejected":
                params = st["applied_params"]  # keep what the EA already has
        params, self.dropped_keys = drop_v305_keys(params, ea_version)
        text = render_remote_text(version, live, params, written)
        if old is not None and remote_semantics(old) == remote_semantics(text):
            return "unchanged"
        if self._write_file(self.remote_path, text):
            if not self.dry_run:
                st["remote"]["version"] = int(version)
            return "written"
        return "error"

    def _note_dropped(self, now, version, ea_version, allow_params):
        """The v3.05 keys left out of the remote file for an EA below 3.05 (contract §5): one decision line per
        change of (EA version, keys), not an error; another one when they are written again after an EA update."""
        dropped = self.dropped_keys
        ver = str(ea_version) if ea_version else "unknown"
        mark = ("%s|%s" % (ver, ",".join(dropped))) if dropped else ""
        rem = self.state["remote"]
        prev = rem.get("dropped") or ""
        if mark == prev:
            return
        rem["dropped"] = mark
        if dropped:
            self._decision(now, "v%d remote: dropped v3.05 keys for EA %s: %s" % (version, ver, ", ".join(dropped)))
        elif allow_params:    # params still go into the file: the keys are back (params switched off: nothing to say)
            self._decision(now, "v%d remote: v3.05 keys written again for EA %s" % (version, ver))

    def _apply_control(self, row, now):
        st = self.state
        version = int(row.get("version") or 0)
        desired = row.get("desired") if isinstance(row.get("desired"), dict) else {}
        limits = self.limits()
        last_live = st["applied_live"]
        if last_live is None:
            last_live = self._ea_live_now()
        ea_remote = (self.last_status or {}).get("remote")
        ea_version = (self.last_status or {}).get("ea_version")
        dec = evaluate_desired(desired, limits, last_live, ea_remote, now)
        auto = self._auto_blackouts(desired, now)
        off, src = self.effective_offset()
        if src == "unconfirmed":
            self.warnings.append("offset_unconfirmed")
        if off is None:
            values, bad, auto_values = [], 0, []
            if dec["blackouts"] or auto:
                self.warnings.append("offset_unknown")
        else:
            manual, bad = blackout_lines(dec["blackouts"], off, now)
            # SPEC 9.3: the automatic windows go into the same file, after the manual ones within the line limit
            auto_values = [v for v in blackout_lines(auto, off, now)[0] if v not in manual]
            auto_values = auto_values[:max(0, MAX_BLACKOUT_LINES - len(manual))]
            values = sorted(manual + auto_values, key=lambda v: (blackout_key(v) or (datetime.max, datetime.max), v))
        if bad:
            self.warnings.append("bad_blackout")
        is_new = version != st["applied_version"]  # SPEC: "> last applied"; != also survives a DB restore
        if not limits["allow_remote_control"]:
            self.rejected = ["remote_control_disabled"]
            self.reject_details = ["allow_remote_control is off on this PC: nothing is written"]
            if is_new and st["reported_version"] != version:
                st["reported_version"] = version
                self._decision(now, "v%d NOT applied: remote_control_disabled" % version)
                self._force_bots = True
            return
        self.rejected, self.reject_details = list(dec["rejected"]), list(dec["details"])
        if not os.path.isdir(self.common_dir):
            self.cycle_errors.append("EA folder not found: %s" % self.common_dir)
            return
        written = self.local_now()
        ctl_changed = self._write_control(render_control_text(dec, values, version, written), version)
        if not self.dry_run:
            self._remember_auto_lines(auto_values, off, now)
        remote = self._sync_remote(dec, version, limits, written, ea_version)
        self._note_dropped(now, version, ea_version, limits["allow_remote_params"])
        if not is_new:
            return
        prev_live = st["applied_live"]
        st["applied_version"] = version
        st["reported_version"] = version
        st["applied_at"] = iso_z(now)
        st["applied_live"] = dec["live"]
        if dec["params_state"] == "ok":
            st["applied_params"] = dec["params"]
        elif dec["params_state"] == "none":
            st["applied_params"] = None
        self._decision(now, "v%d applied | live=%s mode=%s lots=%s long=%d short=%d spread=%s blackouts=%d%s | "
                            "rejected: %s | control: %s, remote: %s%s" % (
                                version, "on" if dec["live"] else "off", dec["mode"],
                                "-" if dec["lots"] is None else "%.2f" % dec["lots"], dec["allow_long"],
                                dec["allow_short"], "-" if dec["max_spread"] is None else "%.2f" % dec["max_spread"],
                                len(values), " (auto %d)" % len(auto_values) if auto_values else "",
                                ",".join(dec["rejected"]) or "none",
                                "written" if ctl_changed else "unchanged", remote,
                                " | " + "; ".join(dec["details"]) if dec["details"] else ""))
        bot = self.bot_name()
        if prev_live is not None and prev_live != dec["live"]:
            self.telegram.notify("live", msg_live(bot, dec["live"], version))
        if "live_not_allowed_locally" in dec["rejected"]:
            self.telegram.notify("live", msg_live_refused(bot, version))
        self._force_bots = True

    # -- step 5: local change adoption
    def _adopt_local_change(self, row, now):
        try:
            mtime = os.stat(self.control_path).st_mtime
        except OSError:
            return row
        c = self.state["control"]
        if mtime <= c["last_write_mtime"] + 1e-3 or abs(mtime - c["adopted_mtime"]) < 1e-3:
            return row
        text = read_text(self.control_path, sleep=self.sleep)
        if text is None:
            return row
        parsed = parse_control_text(text)
        if parsed["id"].upper().startswith("W"):
            return row  # our own format: the web's state is re-applied below
        desired = row.get("desired") if isinstance(row.get("desired"), dict) else {}
        off, _ = self.effective_offset()
        auto_lines = self.state["control"].get("auto_lines") or []
        if auto_lines:   # SPEC 9.3: the agent's automatic lines are never synced back into desired.blackouts
            manual = blackout_lines(normalize_desired(desired)["blackouts"], off, now)[0] if off is not None else []
            parsed = dict(parsed, blackouts=strip_auto_values(parsed["blackouts"], auto_lines, manual))
        live_eff = self.state["applied_live"]
        if live_eff is None:
            live_eff = self._ea_live_now()
        new = adopt_into_desired(desired, parsed, off, now, live_eff)
        if control_semantics(new, off, now) == control_semantics(desired, off, now):
            if not self.dry_run:
                c["adopted_mtime"] = mtime
            return row
        if self.dry_run:
            LOG.info("[dry-run] would adopt local change %s into the web state", parsed["id"] or "(no id)")
            return row
        res = self.client.patch("bot_control", {"bot_id": "eq." + self.config["bot_id"],
                                                "version": "eq.%d" % int(row.get("version") or 0)},
                                {"desired": new}, returning=True)
        c["adopted_mtime"] = mtime
        if not res:
            LOG.warning("local change %s not adopted: the web changed meanwhile (the web wins)", parsed["id"])
            return self._fetch_control()
        new_row = res[0]
        self._decision(now, "local change %s adopted as web v%s (live kept %s)" % (
            parsed["id"] or "(no id)", new_row.get("version"), "on" if to_bool(desired.get("live"), False) else "off"))
        self._force_bots = True
        return new_row

    # -- SPEC 9.3 automatic blackouts
    def _auto_blackouts(self, desired, now):
        """Refresh the news calendar when due (only with auto_news on) and build the automatic windows."""
        news_on, _ = validate_auto_news((desired or {}).get("auto_news"))
        if news_on:
            self.news.refresh(now)
        windows, news_cfg, sched_cfg, warns = auto_blackouts(desired, self.news.events if news_on else [], now)
        self.news_cfg, self.sched_cfg = news_cfg, sched_cfg
        self.auto_windows = windows
        for w in warns:
            if w not in self.warnings:
                self.warnings.append(w)
        key = tuple((w["from_utc"], w["to_utc"], w["reason"]) for w in windows) if (news_cfg or sched_cfg) else None
        if key != self._auto_logged:
            if windows:
                LOG.info("auto blackouts: %d window(s) in the next 7 days, next %s - %s (%s)", len(windows),
                         windows[0]["from_utc"], windows[0]["to_utc"], windows[0]["reason"])
            elif key is not None:
                LOG.info("auto blackouts: none in the next 7 days")
            elif self._auto_logged:
                LOG.info("auto blackouts: off")
            self._auto_logged = key
        return windows

    def _remember_auto_lines(self, auto_values, off, now):
        """Keep the automatic lines this agent wrote (until a day after they ended) so a local edit of the file never
        turns them into manual blackouts."""
        c = self.state["control"]
        keep = []
        for v in list(c.get("auto_lines") or []) + list(auto_values or []):
            k = blackout_key(v)
            if k is None or v in keep:
                continue
            if off is not None and naive_to_epoch(k[1]) - off * 60 < now - 86400:
                continue
            keep.append(v)
        c["auto_lines"] = keep[-200:]

    # -- SPEC 9.1 bars upload
    def _upload_bars(self, now):
        """New complete rows of dobby2_bars.csv -> table `bars` (bot_id, t UTC, close, vwap), incrementally by file
        position; the first upload goes back at most 45 days. Only with a confirmed / configured server offset. A
        refused upload (e.g. the table does not exist yet) is retried after 10 minutes and never blocks the agent."""
        off, src = self.effective_offset()
        if off is None or src not in ("confirmed", "config") or now < self._bars_retry_at:
            return
        b = self.state["bars_upload"]
        pos = int(to_num(b.get("pos")) or 0)
        text, new_pos, reset = read_appended(self.bars_path, pos, sleep=self.sleep)
        if text is None:
            if reset:
                b["pos"] = new_pos
            return
        last_t = to_num(b.get("last_t"))
        floor = last_t if last_t is not None else now - BARS_BACKFILL_S - 1
        fresh = [r for r in parse_bar_rows(text, off, skip_first=False) if floor < r[0] <= now + 3600]
        bot_id = self.config["bot_id"]
        for i in range(0, len(fresh), BARS_BATCH):
            chunk = fresh[i:i + BARS_BATCH]
            body = [{"bot_id": bot_id, "t": iso_z(t), "close": c, "vwap": v} for t, c, v in chunk]
            if not self.dry_run:
                try:
                    self.client.insert_ignore("bars", body, "bot_id,t")
                except ApiError as e:
                    self._bars_retry_at = now + API_RETRY_S
                    self._bars_error = redact(str(e))[:200]
                    LOG.warning("bars not uploaded (%s): retry in %d min", self._bars_error, API_RETRY_S // 60)
                    return
            b["last_t"] = chunk[-1][0]
        b["pos"] = new_pos
        self._bars_error = ""
        if fresh:
            LOG.info("bars: %d bar(s) uploaded%s", len(fresh), " [dry-run, not uploaded]" if self.dry_run else "")

    # -- SPEC 9.2 deposit / withdrawal suggestions
    def _cash_flows(self, status, now):
        """A balance change that Dobby's CLOSE rows do not explain -> a 'suggested' cash_flows row for the owner."""
        if now < self._cash_retry_at:
            return
        cash = self.state["cash"]
        bal = status_balance(status, now)
        amount = cash_step(cash, bal, now)
        if amount is None:
            return
        row = {"bot_id": self.config["bot_id"], "ts": iso_z(now), "amount": amount, "source": "auto",
               "status": "suggested", "balance_after": round(bal, 2), "note": CASH_NOTE}
        if self.dry_run:
            LOG.info("[dry-run] would suggest a cash flow of %+.2f (balance %.2f)", amount, bal)
        else:
            try:
                self.client.insert("cash_flows", [row])
            except ApiError as e:
                self._cash_retry_at = now + API_RETRY_S
                self._cash_error = redact(str(e))[:200]
                LOG.warning("cash flow suggestion not stored (%s): retry in %d min", self._cash_error,
                            API_RETRY_S // 60)
                return
            LOG.info("cash flow suggested on the website: %+.2f (balance %.2f not explained by Dobby trades)",
                     amount, bal)
        self._cash_error = ""
        cash_reset(cash, bal)

    # -- bots row
    def recent_bars(self):
        """SPEC 8: last 24 h of M15 bars for the website, only with a confirmed (or configured) server offset."""
        off, src = self.effective_offset()
        if off is None or src not in ("confirmed", "config"):
            return None
        try:
            mtime = os.stat(self.bars_path).st_mtime
        except OSError:
            return None
        if self._bars_cache[0] == mtime and self._bars_cache[1] == off:
            return self._bars_cache[2]
        bars = parse_bars_text(read_text(self.bars_path, sleep=self.sleep), off)
        self._bars_cache = (mtime, off, bars)
        return bars

    def agent_state(self, now):
        st = self.state
        age = None
        hb = (self.last_status or {}).get("heartbeat_gmt_unix")
        if isinstance(hb, (int, float)) and not isinstance(hb, bool):
            age = int(now - hb)
        text = read_text(self.control_path, sleep=self.sleep)
        _, src = self.effective_offset()
        out = {
            "agent_version": AGENT_VERSION,
            "applied_version": st["applied_version"],
            "applied_at": st["applied_at"],
            "limits": self.limits(),
            "rejected": list(self.rejected),
            "last_error": self.last_error or None,
            "ea_heartbeat_age_s": age,
            "control_file_id": parse_control_text(text)["id"] or None if text is not None else None,
            "remote_file_version": st["remote"]["version"],
            "reject_details": list(self.reject_details),
            "warnings": list(self.warnings) + [w for w, on in (("bars_upload_failed", self._bars_error),
                                                                ("cash_flow_failed", self._cash_error)) if on],
            "offset_source": src,
        }
        bars = self.recent_bars()
        if bars:
            out["bars"] = bars
        sh = self.shadow.state()            # SPEC 10.6
        if sh:
            out["shadow"] = sh
        # SPEC 9.3: automatic blackouts (keys only while auto_news / schedule is on)
        if self.news_cfg or self.sched_cfg:
            out["auto_blackouts"] = [dict(w) for w in self.auto_windows]
        if self.news_cfg:
            out["news"] = [dict((k, e.get(k)) for k in ("title", "ts_utc", "currency", "impact", "forecast",
                                                        "previous"))
                           for e in matching_news(self.news.events, self.news_cfg)][:NEWS_REPORT_MAX]
            if self.news.fetched_at is not None:
                out["news_fetched_at"] = iso_z(self.news.fetched_at)
            if self.news.error or self.news.fetched_at is None:
                out["news_error"] = self.news.error or "not fetched yet"
        return out

    def _update_bot_row(self, status, now):
        if not self._force_bots and self._last_bots_update is not None and \
                now - self._last_bots_update < BOTS_MIN_INTERVAL_S:
            return
        body = {"last_seen": iso_z(now), "agent_version": AGENT_VERSION, "agent_state": self.agent_state(now)}
        if status:
            if status.get("ea_version"):
                body["ea_version"] = str(status["ea_version"])
            if status.get("symbol"):
                body["symbol"] = str(status["symbol"])
        off, src = self.effective_offset()
        if off is not None and src in ("config", "confirmed"):
            body["server_utc_offset_min"] = int(off)
        if not self.dry_run:
            self.client.patch("bots", {"id": "eq." + self.config["bot_id"]}, body)
        self._last_bots_update = now
        self._force_bots = False

    # -- step 6: alerts that come from the status
    def _ea_alerts(self, status, now):
        a = self.state["alerts"]
        hb = (status or {}).get("heartbeat_gmt_unix")
        age = now - hb if isinstance(hb, (int, float)) and not isinstance(hb, bool) else None
        offline = age is None or age > OFFLINE_AFTER_S
        bot = self.bot_name()
        if offline and not a["ea_offline"]:
            a["ea_offline"] = True
            LOG.warning("EA offline (heartbeat age %s s)", "?" if age is None else int(age))
            self.telegram.notify("offline", msg_offline(bot, age))
        elif not offline and a["ea_offline"]:
            a["ea_offline"] = False
            LOG.info("EA back online")
            self.telegram.notify("offline", msg_online(bot))
        if status and not offline:
            cap = bool((status.get("virtual") or {}).get("day_cap_hit"))
            if a["cap_hit"] is False and cap:
                self.telegram.notify("cap", msg_cap(bot, status))
            a["cap_hit"] = cap

    def _daily_summary(self, now):
        off, _ = self.effective_offset()
        if off is None:
            return
        sdt = epoch_to_naive(now + off * 60)
        if sdt.weekday() >= 5 or (sdt.hour, sdt.minute) < (23, 30):
            return
        day = sdt.strftime("%Y.%m.%d")
        a = self.state["alerts"]
        if a["daily_done"] == day:
            return
        a["daily_done"] = day
        self.telegram.notify("daily", msg_daily(self.bot_name(), day, self.last_status,
                                                self.state["day_stats"].get(day)))


# ---------------------------------------------------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------------------------------------------------
class Runtime(object):
    """Everything a command touches outside this file (injectable for tests)."""

    def __init__(self, agent_dir=None, transport=None, input_fn=None, getpass_fn=None, out=None, clock=time.time,
                 sleep=time.sleep, local_now=datetime.now, environ=None, setup_logs=True):
        self.agent_dir = agent_dir
        self._transport = transport
        self.input = input_fn or input
        self.getpass = getpass_fn or getpass.getpass
        self.out = out or (lambda s="": print(s))
        self.clock = clock
        self.sleep = sleep
        self.local_now = local_now
        self.environ = os.environ if environ is None else environ
        self.setup_logs = setup_logs

    def transport(self):
        if self._transport is None:
            self._transport = HttpTransport()
        return self._transport


def _cfg_path(rt):
    return os.path.join(rt.agent_dir, CONFIG_NAME)


def _ask(rt, label, current=None):
    hint = " [Enter = %s]" % current if current else ""
    v = rt.input("%s%s: " % (label, hint)).strip()
    return v or (current or "")


def _make_client(cfg, rt):
    path = _cfg_path(rt)

    def save(tok):
        update_config(path, lambda c: c.__setitem__("refresh_token", tok))

    return SupabaseClient(cfg["supabase_url"], cfg["anon_key"], rt.transport(), cfg.get("refresh_token", ""),
                          on_refresh_token=save, clock=rt.clock)


def _need(cfg, rt, keys):
    msgs = {
        "supabase_url": "ยังไม่ได้ตั้งค่า Supabase: รัน  python dobby_agent.py setup",
        "anon_key": "ยังไม่ได้ตั้งค่า Supabase: รัน  python dobby_agent.py setup",
        "refresh_token": "ยังไม่ได้เข้าสู่ระบบ: รัน  python dobby_agent.py login",
        "bot_id": "เครื่องนี้ยังไม่ได้ลงทะเบียนบอท: รัน  python dobby_agent.py register --name \"ชื่อเครื่อง\"",
    }
    for k in keys:
        if not cfg.get(k):
            rt.out(msgs[k])
            return False
    return True


def _valid_url(url):
    return url.startswith("https://") or url.startswith("http://localhost") or url.startswith("http://127.0.0.1")


def cmd_setup(args, rt):
    path = _cfg_path(rt)
    cfg = load_config(path)
    interactive = not args.non_interactive
    url = (args.url or (_ask(rt, "Supabase URL (https://xxxx.supabase.co)", cfg.get("supabase_url"))
                        if interactive else cfg.get("supabase_url")) or "").strip().rstrip("/")
    if not _valid_url(url):
        rt.out("URL ไม่ถูกต้อง: ต้องขึ้นต้นด้วย https://")
        return EXIT_CONFIG
    key = args.anon_key
    if not key and interactive:
        cur = cfg.get("anon_key")
        key = rt.input("Publishable key (sb_publishable_...) or anon key%s: " % (
            " [Enter = ใช้ค่าเดิม]" if cur else "")).strip() or cur
    key = (key or cfg.get("anon_key") or "").strip()
    if not key:
        rt.out("ต้องใส่ Publishable key (sb_publishable_...) หรือ anon key จากหน้า Settings > API ของ Supabase")
        return EXIT_CONFIG
    if args.common_dir:
        cfg["common_dir"] = args.common_dir
    common = resolve_common_dir(cfg, rt.environ)
    rt.out("โฟลเดอร์ไฟล์ของ EA: %s" % common)
    st = read_status_file(os.path.join(common, STATUS_NAME), attempts=2, sleep=rt.sleep)
    if st:
        hb = st.get("heartbeat_gmt_unix")
        age = int(rt.clock() - hb) if isinstance(hb, (int, float)) else None
        rt.out("  พบไฟล์สถานะ: EA %s %s, สัญญาณล่าสุด %s วินาทีที่แล้ว" % (
            st.get("ea_version", "?"), st.get("symbol", "?"), age))
    else:
        rt.out("  ยังไม่พบ %s (เปิด MT5 + EA Dobby3 ก่อน หรือระบุโฟลเดอร์อื่น)" % STATUS_NAME)
    if interactive and not args.common_dir:
        ans = rt.input("กด Enter ถ้าโฟลเดอร์นี้ถูกต้อง หรือพิมพ์โฟลเดอร์อื่น: ").strip()
        if ans:
            cfg["common_dir"] = ans
    tg = cfg.setdefault("telegram", {"token": "", "chat_id": "", "events": list(TELEGRAM_EVENTS)})
    if args.telegram_token is not None:
        tg["token"] = args.telegram_token.strip()
    if args.telegram_chat_id is not None:
        tg["chat_id"] = args.telegram_chat_id.strip()
    if interactive and args.telegram_token is None:
        if rt.input("ตั้งค่าการแจ้งเตือน Telegram ตอนนี้ไหม? (y/N): ").strip().lower() in ("y", "yes"):
            tok = rt.getpass("Telegram bot token จาก @BotFather (จะไม่แสดงบนจอ): ").strip()
            if tok:
                tg["token"] = tok
            tg["chat_id"] = _ask(rt, "Telegram chat id", tg.get("chat_id"))
    if args.poll_seconds:
        cfg["poll_seconds"] = max(2, int(args.poll_seconds))
    cfg["supabase_url"], cfg["anon_key"] = url, key
    save_config(path, cfg)
    rt.out("บันทึกการตั้งค่าแล้ว: %s" % path)
    rt.out("ขั้นต่อไป: python dobby_agent.py login")
    return EXIT_OK


def cmd_login(args, rt):
    path = _cfg_path(rt)
    cfg = load_config(path)
    if not _need(cfg, rt, ["supabase_url", "anon_key"]):
        return EXIT_CONFIG
    email = (args.email or _ask(rt, "อีเมล", cfg.get("email"))).strip()
    if not email:
        rt.out("ต้องใส่อีเมล")
        return EXIT_CONFIG
    password = rt.getpass("รหัสผ่าน (พิมพ์แล้วจะไม่แสดงบนจอ): ")
    client = _make_client(cfg, rt)
    try:
        client.sign_in_password(email, password)
    except AuthError as e:
        rt.out("เข้าสู่ระบบไม่สำเร็จ: %s" % redact(str(e)))
        return EXIT_CONFIG
    except NetworkError as e:
        rt.out("เชื่อมต่อ Supabase ไม่ได้: %s" % redact(str(e)))
        return EXIT_CRASH
    finally:
        password = None  # noqa: F841 - drop the reference at once
    update_config(path, lambda c: c.__setitem__("email", email))
    rt.out("เข้าสู่ระบบสำเร็จ (เก็บไว้เฉพาะ refresh token ใน %s)" % CONFIG_NAME)
    try:
        if client.rpc("is_approved", {}) is not True:
            rt.out("หมายเหตุ: บัญชียังไม่ได้รับอนุมัติ ให้ใส่รหัสเชิญบนเว็บไซต์ก่อน แล้วค่อย register")
    except (ApiError, NetworkError, AuthError):
        pass
    if not cfg.get("bot_id"):
        rt.out("ขั้นต่อไป: python dobby_agent.py register --name \"Main PC\"")
    return EXIT_OK


def cmd_register(args, rt):
    path = _cfg_path(rt)
    cfg = load_config(path)
    if not _need(cfg, rt, ["supabase_url", "anon_key", "refresh_token"]):
        return EXIT_CONFIG
    if cfg.get("bot_id") and not args.force:
        rt.out("เครื่องนี้ลงทะเบียนแล้ว (%s, %s) ถ้าต้องการสร้างบอทใหม่ใช้ --force" % (
            cfg.get("bot_name"), cfg["bot_id"]))
        return EXIT_CONFIG
    name = (args.name or cfg.get("bot_name") or socket.gethostname()).strip()[:100]
    common = resolve_common_dir(cfg, rt.environ)
    old_state = load_state(os.path.join(rt.agent_dir, STATE_NAME))
    seed = seed_from_ea(common, cfg, clock=rt.clock, sleep=rt.sleep,
                        exclude_blackouts=old_state["control"].get("auto_lines"))
    if seed is None:
        rt.out("ไม่พบ %s ใน %s: เปิด MT5 + EA Dobby3 ก่อน แล้วลองใหม่" % (STATUS_NAME, common))
        return EXIT_CONFIG
    if not seed["confirmed"] and not seed["offset_override"]:
        rt.out("หมายเหตุ: ตลาดปิดหรือ EA ไม่ได้รับราคา ค่าเวลาเซิร์ฟเวอร์ (UTC%+d นาที) ยังไม่ยืนยัน "
               "agent จะยืนยันเองเมื่อตลาดเปิด" % (seed["offset"] or 0))
    desired, now = seed["desired"], seed["now"]
    client = _make_client(cfg, rt)
    try:
        bot_id = client.rpc("register_bot", {"p_name": name, "p_desired": desired})
    except AuthError as e:
        rt.out("เข้าสู่ระบบไม่ได้ (%s): รัน login ใหม่" % redact(str(e)))
        return EXIT_CONFIG
    except ApiError as e:
        if "not_approved" in str(e):
            rt.out("บัญชียังไม่ได้รับอนุมัติ: ใส่รหัสเชิญบนเว็บไซต์ก่อน")
        else:
            rt.out("ลงทะเบียนไม่สำเร็จ: %s" % e)
        return EXIT_CONFIG
    except NetworkError as e:
        rt.out("เชื่อมต่อ Supabase ไม่ได้: %s" % e)
        return EXIT_CRASH
    if not isinstance(bot_id, str) or not bot_id:
        rt.out("ลงทะเบียนไม่สำเร็จ: คำตอบจากเซิร์ฟเวอร์ไม่มี bot id")
        return EXIT_CRASH

    def mut(c):
        c["bot_id"], c["bot_name"] = bot_id, name
    update_config(path, mut)
    state = first_state(common, now, applied_live=desired["live"], status=seed["status"], confirmed=seed["confirmed"])
    write_json_atomic(os.path.join(rt.agent_dir, STATE_NAME), state)
    ctl = desired["control"]
    rt.out("ลงทะเบียนบอท \"%s\" สำเร็จ (id %s)" % (name, bot_id))
    rt.out("  สถานะเริ่มต้น: live=%s mode=%s lots=%s long=%s short=%s blackouts=%d" % (
        "on" if desired["live"] else "off", ctl["mode"], ctl["lots"] if ctl["lots"] else "(ค่าใน EA)",
        ctl["allow_long"], ctl["allow_short"], len(desired["blackouts"])))
    rt.out("ขั้นต่อไป: ตรวจขีดจำกัด  python dobby_agent.py limits  แล้วรัน  run_agent.bat")
    return EXIT_OK


def cmd_run(args, rt):
    path = _cfg_path(rt)
    try:
        cfg = load_config(path)
    except ValueError as e:
        rt.out("อ่าน %s ไม่ได้: %s" % (CONFIG_NAME, e))
        return EXIT_CONFIG
    if not _need(cfg, rt, ["supabase_url", "anon_key", "refresh_token", "bot_id"]):
        return EXIT_CONFIG
    common = resolve_common_dir(cfg, rt.environ)
    lock = common_lock = None
    if not args.dry_run:
        lock = InstanceLock(os.path.join(rt.agent_dir, LOCK_NAME))
        if not lock.acquire():
            rt.out("มี agent อีกตัวกำลังรันอยู่ในโฟลเดอร์นี้แล้ว")
            return EXIT_RUNNING
        # one agent per MT5: the Dobby App and other agent folders take the same lock in the EA folder
        common_lock = CommonLock(common, program="dobby_agent.py run", clock=rt.clock, local_now=rt.local_now)
        if not common_lock.acquire():
            lock.release()
            if common_lock.holder is not None:
                rt.out("มี Dobby agent อีกตัวทำงานกับ MT5 นี้อยู่แล้ว (%s): ปิดตัวนั้นก่อน (แอป Dobby กดหยุด)"
                       % lock_holder_text(common_lock.holder))
                return EXIT_RUNNING
            rt.out("สร้างไฟล์ล็อกในโฟลเดอร์ EA ไม่ได้ (%s): %s" % (common, common_lock.error))
            return EXIT_CONFIG
    tg_cfg = cfg.get("telegram") or {}
    tg = Telegram(rt.transport(), tg_cfg.get("token"), tg_cfg.get("chat_id"), tg_cfg.get("events", TELEGRAM_EVENTS),
                  clock=rt.clock, dry_run=args.dry_run)
    agent = Agent(rt.agent_dir, common, _make_client(cfg, rt), tg, clock=rt.clock, sleep=rt.sleep,
                  local_now=rt.local_now, dry_run=args.dry_run)
    lim = agent.limits()
    LOG.info("Dobby agent %s start: bot \"%s\", EA folder %s%s | remote control %s, live %s, params %s, max lots "
             "%.2f, max cap %g%%", AGENT_VERSION, agent.bot_name(), common, " [DRY-RUN]" if args.dry_run else "",
             "on" if lim["allow_remote_control"] else "OFF", "on" if lim["allow_remote_live"] else "off",
             "on" if lim["allow_remote_params"] else "off", lim["max_lots"], lim["max_daily_cap_pct"])
    if not os.path.isdir(common):
        LOG.warning("EA folder not found: %s (setup / DOBBY_COMMON)", common)
    try:
        while True:
            delay = agent.cycle()
            if args.once:
                break
            rt.sleep(delay)
    except KeyboardInterrupt:
        LOG.info("stopped by the user")
    finally:
        if common_lock:
            common_lock.release()
        if lock:
            lock.release()
    return EXIT_CRASH if (args.once and agent.last_error) else EXIT_OK


def cmd_status(args, rt):
    path = _cfg_path(rt)
    cfg = load_config(path)
    st = load_state(os.path.join(rt.agent_dir, STATE_NAME))
    lim = get_limits(cfg)
    tg = cfg.get("telegram") or {}
    common = resolve_common_dir(cfg, rt.environ)
    on = lambda b: "on" if b else "off"  # noqa: E731
    rt.out("Dobby agent %s" % AGENT_VERSION)
    rt.out("config: %s" % path)
    rt.out("  supabase_url: %s" % (cfg.get("supabase_url") or "(not set)"))
    rt.out("  key: %s" % ("(set)" if cfg.get("anon_key") else "(not set)"))
    rt.out("  email: %s | login: %s" % (cfg.get("email") or "-", "refresh token saved" if cfg.get("refresh_token")
                                        else "not logged in"))
    rt.out("  bot: %s %s" % (cfg.get("bot_name") or "-", cfg.get("bot_id") or "(not registered)"))
    rt.out("  EA folder: %s (%s)" % (common, "found" if os.path.isdir(common) else "NOT FOUND"))
    rt.out("  telegram: %s, events %s" % (
        "configured" if tg.get("token") and tg.get("chat_id") else "off", ",".join(tg.get("events") or [])))
    rt.out("limits: remote control %s | remote live %s | remote params %s | max lots %.2f | max daily cap %g%%" % (
        on(lim["allow_remote_control"]), on(lim["allow_remote_live"]), on(lim["allow_remote_params"]),
        lim["max_lots"], lim["max_daily_cap_pct"]))
    rt.out("last applied version: %s (at %s)" % (st["applied_version"] or "-", st["applied_at"] or "-"))
    status = read_status_file(os.path.join(common, STATUS_NAME), attempts=2, sleep=rt.sleep)
    if status:
        hb = status.get("heartbeat_gmt_unix")
        age = int(rt.clock() - hb) if isinstance(hb, (int, float)) else None
        rt.out("EA heartbeat age: %s s (Dobby %s, %s, live_locked=%s)%s" % (
            age, status.get("ea_version", "?"), status.get("symbol", "?"),
            (status.get("flags") or {}).get("live_locked"), "  <- OFFLINE" if age is None or age > OFFLINE_AFTER_S
            else ""))
    else:
        rt.out("EA heartbeat: no status file")
    text = read_text(os.path.join(common, CONTROL_NAME), sleep=rt.sleep)
    rt.out("control file: %s" % ("id=" + (parse_control_text(text)["id"] or "(none)") if text is not None
                                 else "(none: EA uses its inputs)"))
    o = st["offset"]
    rt.out("server offset: %s" % ("UTC%+d min (%s)" % (o["min"], "confirmed" if o["confirmed"] else "unconfirmed")
                                  if o.get("min") is not None else "unknown yet"))
    if st.get("last_error"):
        rt.out("last error: %s" % redact(st["last_error"]))
    return EXIT_OK


def cmd_limits(args, rt):
    path = _cfg_path(rt)
    cfg = load_config(path)
    lim = get_limits(cfg)
    changed = False
    for flag, key in (("allow_live", "allow_remote_live"), ("allow_params", "allow_remote_params"),
                      ("allow_control", "allow_remote_control")):
        v = getattr(args, flag)
        if v is not None:
            lim[key] = (v == "on")
            changed = True
    if args.max_lots is not None:
        if not (0 < args.max_lots <= 100):
            rt.out("--max-lots ต้องมากกว่า 0")
            return EXIT_CONFIG
        lim["max_lots"] = round(args.max_lots, 2) if args.max_lots >= 0.01 else 0.01
        changed = True
    if args.max_cap is not None:
        if not (0 < args.max_cap <= 100):
            rt.out("--max-cap ต้องอยู่ระหว่าง 0-100")
            return EXIT_CONFIG
        lim["max_daily_cap_pct"] = float(args.max_cap)
        changed = True
    if changed:
        update_config(path, lambda c: c.__setitem__("limits", lim))
        rt.out("บันทึกขีดจำกัดแล้ว (agent ที่กำลังรันจะใช้ค่าใหม่ในรอบถัดไป ภายในไม่กี่วินาที)")
    on = lambda b: "on" if b else "off"  # noqa: E731
    rt.out("  รับคำสั่งจากเว็บ (allow_remote_control): %s" % on(lim["allow_remote_control"]))
    rt.out("  เปิด/ปิดเทรดจริงจากเว็บ (allow_remote_live): %s" % on(lim["allow_remote_live"]))
    rt.out("  ส่งพารามิเตอร์จากเว็บ (allow_remote_params): %s" % on(lim["allow_remote_params"]))
    rt.out("  lot สูงสุด (max_lots): %.2f" % lim["max_lots"])
    rt.out("  เพดานขาดทุนรายวันสูงสุด (max_daily_cap_pct): %g%%" % lim["max_daily_cap_pct"])
    return EXIT_OK


def cmd_test_telegram(args, rt):
    cfg = load_config(_cfg_path(rt))
    tg_cfg = cfg.get("telegram") or {}
    tg = Telegram(rt.transport(), tg_cfg.get("token"), tg_cfg.get("chat_id"), clock=rt.clock)
    if not tg.enabled:
        rt.out("ยังไม่ได้ตั้งค่า Telegram (token / chat id): รัน  python dobby_agent.py setup")
        return EXIT_CONFIG
    ok, info = tg.send_now(msg_test(cfg.get("bot_name") or "Dobby"))
    rt.out("ส่งข้อความทดสอบแล้ว" if ok else "ส่งไม่สำเร็จ: %s" % info)
    return EXIT_OK if ok else EXIT_CRASH


_THAI = re.compile("[฀-๿]")


def clean_bot_name(name):
    """NFC, single spaces, at most 100 characters (the website's limit)."""
    import unicodedata
    return " ".join(unicodedata.normalize("NFC", str(name or "")).split())[:100]


def repair_mojibake(name):
    """Thai typed into a console with the wrong code page arrives as UTF-8 bytes read as cp1252 / cp874 / latin-1
    (e.g. 'à¸„à¸­à¸¡'). Undo that when the result is clean UTF-8 Thai; otherwise return the name unchanged."""
    for enc in ("cp1252", "latin-1", "cp874"):
        try:
            fixed = name.encode(enc).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
        if fixed != name and _THAI.search(fixed) and "�" not in fixed:
            return fixed
    return name


def read_name_file(path):
    """The first non-empty line of a text file (Notepad: UTF-8 with/without BOM, UTF-16, or Thai ANSI cp874)."""
    with open(path, "rb") as f:
        data = f.read(8192)
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = data.decode("utf-16")
    elif data[:3] == b"\xef\xbb\xbf":
        text = data[3:].decode("utf-8", "replace")
    else:
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            text = data.decode("cp874", "replace")
    for ln in text.splitlines():
        if ln.strip():
            return ln.strip()
    return ""


def name_problem(name):
    """Thai reason why a name cannot be stored (mangled by a console), or None."""
    if not name:
        return "ชื่อว่าง"
    if "�" in name or "?" in name:
        return "ชื่อมีตัวอักษรที่อ่านไม่ได้ ('?'): หน้าต่างคำสั่งแปลงภาษาไทยผิด"
    if any(0xD800 <= ord(c) <= 0xDFFF or ord(c) < 32 for c in name):
        return "ชื่อมีตัวอักษรที่อ่านไม่ได้"
    return None


def unicode_escape(name):
    return name.encode("unicode_escape").decode("ascii")


def cmd_rename(args, rt):
    """Fix the bot name stored on this PC (agent_config.json bot_name), e.g. "คอมหลก" -> "คอมหลัก".
    Unicode-safe sources: --name (the wide Windows command line), --name-file (a text file, any Notepad encoding),
    --from-web (the name of this bot on the website). The website's name is not changed."""
    path = _cfg_path(rt)
    cfg = load_config(path)
    given = [x for x in (args.name is not None, bool(args.name_file), bool(args.from_web)) if x]
    if len(given) > 1:
        rt.out("ใช้ได้ทีละแบบ: --name หรือ --name-file หรือ --from-web")
        return EXIT_CONFIG
    if args.from_web:
        if not _need(cfg, rt, ["supabase_url", "anon_key", "refresh_token", "bot_id"]):
            return EXIT_CONFIG
        try:
            rows = _make_client(cfg, rt).select("bots", {"id": "eq." + cfg["bot_id"], "select": "name"})
        except AuthError as e:
            rt.out("เข้าสู่ระบบไม่ได้ (%s): รัน login ใหม่" % redact(str(e)))
            return EXIT_CONFIG
        except (ApiError, NetworkError) as e:
            rt.out("อ่านชื่อจากเว็บไม่ได้: %s" % redact(str(e)))
            return EXIT_CRASH
        if not rows or not isinstance(rows[0], dict) or not rows[0].get("name"):
            rt.out("ไม่พบบอทนี้บนเว็บ (id %s)" % cfg["bot_id"])
            return EXIT_CONFIG
        raw, source = rows[0]["name"], "เว็บ"
    elif args.name_file:
        try:
            raw, source = read_name_file(args.name_file), "ไฟล์ %s" % args.name_file
        except OSError as e:
            rt.out("อ่านไฟล์ไม่ได้: %s" % e)
            return EXIT_CONFIG
    elif args.name is not None:
        raw, source = args.name, "--name"
    else:
        raw, source = rt.input("ชื่อบอทใหม่ (ภาษาไทยได้): "), "พิมพ์"
    name = clean_bot_name(repair_mojibake(raw or ""))
    problem = name_problem(name)
    if problem:
        rt.out("ไม่ได้เปลี่ยนชื่อ: %s" % problem)
        rt.out("  ที่ได้รับ: %s" % unicode_escape(raw or ""))
        rt.out("  ทางเลือก: เขียนชื่อในไฟล์ (Notepad) แล้วใช้  rename --name-file name.txt  หรือใช้ชื่อบนเว็บ  rename --from-web")
        return EXIT_CONFIG
    old = cfg.get("bot_name") or ""
    update_config(path, lambda c: c.__setitem__("bot_name", name))
    rt.out("เปลี่ยนชื่อบอทในเครื่องนี้แล้ว (จาก%s): %s -> %s" % (source, old or "-", name))
    rt.out("  ตรวจตัวอักษร: %s" % unicode_escape(name))
    if name != (raw or "").strip():
        rt.out("  (ปรับให้ถูกต้องจาก: %s)" % unicode_escape(raw or ""))
    rt.out("  ชื่อบนเว็บไม่เปลี่ยน agent ที่กำลังรันจะใช้ชื่อใหม่ในรอบถัดไป")
    return EXIT_OK


def build_parser():
    p = argparse.ArgumentParser(prog="dobby_agent.py", description="Dobby Web PC agent %s" % AGENT_VERSION,
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n")[1])
    p.add_argument("--dir", help="agent folder for config/state/logs (default: the folder of this script)")
    p.add_argument("--verbose", action="store_true", help="debug logging")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("setup", help="Supabase URL + key, EA folder check, Telegram")
    s.add_argument("--url")
    s.add_argument("--anon-key", help="publishable key (sb_publishable_...) or legacy anon key")
    s.add_argument("--common-dir")
    s.add_argument("--telegram-token")
    s.add_argument("--telegram-chat-id")
    s.add_argument("--poll-seconds", type=int)
    s.add_argument("--non-interactive", action="store_true", help="no questions; use the flags and the saved config")
    lg = sub.add_parser("login", help="sign in (email + password typed by you)")
    lg.add_argument("--email")
    r = sub.add_parser("register", help="create this bot on the website from the EA's current state")
    r.add_argument("--name")
    r.add_argument("--force", action="store_true")
    rn = sub.add_parser("run", help="the agent loop")
    rn.add_argument("--once", action="store_true", help="one cycle, then exit")
    rn.add_argument("--dry-run", action="store_true", help="never write the EA files, never upload")
    sub.add_parser("status", help="config (secrets hidden), limits, applied version, EA heartbeat")
    lm = sub.add_parser("limits", help="local limits (never changeable from the web)")
    lm.add_argument("--allow-live", choices=["on", "off"])
    lm.add_argument("--allow-params", choices=["on", "off"])
    lm.add_argument("--allow-control", choices=["on", "off"])
    lm.add_argument("--max-lots", type=float)
    lm.add_argument("--max-cap", type=float)
    sub.add_parser("test-telegram", help="send a Telegram test message")
    rr = sub.add_parser("rename", help="fix the bot name stored on this PC (Unicode-safe; the website is not changed)")
    rr.add_argument("--name", help="the new name (Thai is fine)")
    rr.add_argument("--name-file", help="read the name from a text file (UTF-8 / UTF-16 / Thai ANSI)")
    rr.add_argument("--from-web", action="store_true", help="use this bot's name on the website")
    return p


COMMANDS = {"setup": cmd_setup, "login": cmd_login, "register": cmd_register, "run": cmd_run, "status": cmd_status,
            "limits": cmd_limits, "test-telegram": cmd_test_telegram, "rename": cmd_rename}


def _safe_console():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass


def main(argv=None, rt=None):
    rt = rt or Runtime()
    _safe_console()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.cmd:
        parser.print_help()
        return EXIT_CONFIG
    rt.agent_dir = os.path.abspath(args.dir or rt.agent_dir or rt.environ.get("DOBBY_AGENT_HOME") or script_dir())
    if not os.path.isdir(rt.agent_dir):
        rt.out("ไม่พบโฟลเดอร์ agent: %s" % rt.agent_dir)
        return EXIT_CONFIG
    if rt.setup_logs:
        setup_logging(rt.agent_dir, console=(args.cmd == "run"), verbose=args.verbose)
    try:
        return COMMANDS[args.cmd](args, rt)
    except KeyboardInterrupt:
        rt.out("หยุดแล้ว")
        return EXIT_OK
    except ValueError as e:  # e.g. a broken agent_config.json
        rt.out("ผิดพลาด: %s" % redact(str(e)))
        return EXIT_CONFIG


if __name__ == "__main__":
    sys.exit(main())
