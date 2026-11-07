# -*- coding: utf-8 -*-
"""desired -> control file / remote file text, and the local limits (SPEC 3.5 - 3.7)."""
from datetime import datetime

import dobby_agent as da
from conftest import utc

NOW = utc(2026, 11, 7, 8, 0, 0)
WRITTEN = datetime(2026, 11, 7, 10, 0, 0)
LIM_ALL = {"allow_remote_control": True, "allow_remote_live": True, "allow_remote_params": True, "max_lots": 0.10,
           "max_daily_cap_pct": 10.0}


def limits(**kw):
    d = dict(LIM_ALL)
    d.update(kw)
    return da.get_limits({"limits": d})


def render(desired, version=17, lim=None, last_live=False, offset=120, now=NOW):
    dec = da.evaluate_desired(desired, lim or limits(), last_live)
    values, bad = da.blackout_lines(dec["blackouts"], offset, now)
    return da.render_control_text(dec, values, version, WRITTEN), dec, bad


SPEC_DESIRED = {
    "live": True,
    "control": {"mode": "pause", "lots": 0.08, "allow_long": True, "allow_short": False, "max_spread": 0.6,
                "note": "NFP week"},
    "blackouts": [
        {"from_utc": "2026-11-05T13:00:00Z", "to_utc": "2026-11-05T14:30:00Z", "label": "past, dropped"},
        {"from_utc": "2026-11-10T21:00:00.000Z", "to_utc": "2026-11-10T23:00:00Z", "label": "crosses midnight"},
        {"from_utc": "2026-11-10T13:00:00Z", "to_utc": "2026-11-10T14:30:00+00:00", "label": "NFP"},
    ],
    "params": None,
}


def test_control_file_exact_text_matches_spec_example():
    text, dec, bad = render(SPEC_DESIRED)
    assert text == ("# Dobby control file, written 2026-11-07 10:00:00 by dobby_agent (web v17)\r\n"
                    "mode=pause\r\n"
                    "lots=0.08\r\n"
                    "allow_long=1\r\n"
                    "allow_short=0\r\n"
                    "max_spread=0.60\r\n"
                    "blackout=2026.11.10 15:00-16:30\r\n"
                    "blackout=2026.11.10 23:00-2026.11.11 01:00\r\n"
                    "id=W017\r\n"
                    "note=web: NFP week\r\n")
    assert bad == 0 and dec["rejected"] == []
    assert not text.encode("utf-8").startswith(b"\xef\xbb\xbf")


def ea_parse(text):
    """Independent port of the EA's ReadControl() (Dobby3_v303.mq5): what the EA would load from our file."""
    out = {"pause": False, "long": True, "short": True, "lots": 0.0, "spread": 0.0, "bo": [], "warn": ""}
    for line in text.split("\r\n"):
        line = line.strip()
        if not line or line[0] == "#":
            continue
        eq = line.find("=")
        if eq <= 0:
            out["warn"] += "bad line;"
            continue
        k, v = line[:eq].strip().lower(), line[eq + 1:].strip()
        if k == "mode":
            out["pause"] = v.lower() == "pause"
        elif k == "lots":
            out["lots"] = float(v)
        elif k in ("allow_long", "allow_short"):
            out["long" if k == "allow_long" else "short"] = v.lower() in ("1", "true", "yes", "on")
        elif k == "max_spread":
            out["spread"] = float(v)
        elif k == "blackout":
            dash = v.find("-", 11)
            f = datetime.strptime(v[:dash], "%Y.%m.%d %H:%M")
            rest = v[dash + 1:].strip()
            if len(rest) <= 5:
                rest = f.strftime("%Y.%m.%d") + " " + rest
            t = datetime.strptime(rest, "%Y.%m.%d %H:%M")
            assert t >= f, "the EA would reject this blackout"
            out["bo"].append((f, t))
        elif k not in ("id", "note"):
            out["warn"] += "unknown key %s;" % k
    return out


def test_ea_reads_our_file_like_we_mean_it():
    text, _, _ = render(SPEC_DESIRED)
    ea = ea_parse(text)
    assert ea["warn"] == "" and ea["pause"] and ea["long"] and not ea["short"]
    assert ea["lots"] == 0.08 and ea["spread"] == 0.60
    assert ea["bo"] == [(datetime(2026, 11, 10, 15, 0), datetime(2026, 11, 10, 16, 30)),
                        (datetime(2026, 11, 10, 23, 0), datetime(2026, 11, 11, 1, 0))]


def test_live_false_forces_pause_and_live_true_with_run_is_run():
    d = dict(SPEC_DESIRED, live=False, control=dict(SPEC_DESIRED["control"], mode="run"))
    assert "mode=pause\r\n" in render(d)[0]
    d2 = dict(d, live=True)
    assert "mode=run\r\n" in render(d2)[0]
    d3 = dict(d2, live=None)                                     # missing / null live = off
    assert "mode=pause\r\n" in render(d3)[0]


def test_unset_lots_and_spread_are_not_written_and_ids_are_padded():
    d = {"live": True, "control": {"mode": "run", "lots": None, "allow_long": False, "allow_short": True,
                                   "max_spread": None}, "blackouts": []}
    text = render(d, version=1)[0]
    assert text.split("\r\n")[1:-1] == ["mode=run", "allow_long=0", "allow_short=1", "id=W001", "note=web"]
    assert "id=W1234\r\n" in render(d, version=1234)[0]


def test_bad_and_past_blackouts():
    d = {"live": True, "control": {"mode": "run"}, "blackouts": [
        {"from_utc": "2026-11-10T14:30:00Z", "to_utc": "2026-11-10T13:00:00Z"},           # to < from
        {"from_utc": "garbage", "to_utc": "2026-11-10T13:00:00Z"},
        {"from_utc": "2026-11-07T07:00:00Z", "to_utc": "2026-11-07T07:59:59Z"},           # ended before now
        {"from_utc": "2026-11-07T07:30:00Z", "to_utc": "2026-11-07T08:30:00Z"},           # running now: kept
        {"from_utc": "2026-11-07T07:30:20Z", "to_utc": "2026-11-07T08:30:10Z"},           # widened to whole minutes
    ]}
    text, _, bad = render(d)
    assert bad == 2
    assert [ln for ln in text.split("\r\n") if ln.startswith("blackout=")] == [
        "blackout=2026.11.07 09:30-10:30", "blackout=2026.11.07 09:30-10:31"]


# ---------------------------------------------------------------------------------------------------------------- limits
def test_control_lots_clamped_to_local_max_lots():
    d = {"live": True, "control": {"mode": "run", "lots": 0.25}}
    text, dec, _ = render(d, lim=limits(max_lots=0.05))
    assert "lots=0.05\r\n" in text and dec["rejected"] == ["lots_clamped"]
    text, dec, _ = render({"live": True, "control": {"mode": "run", "lots": 0.049}}, lim=limits(max_lots=0.05))
    assert "lots=0.04\r\n" in text and dec["rejected"] == []          # rounded down, never up


def test_live_not_allowed_locally_keeps_last_value():
    lim = limits(allow_remote_live=False)
    dec = da.evaluate_desired({"live": True, "control": {"mode": "run"}}, lim, last_live=False)
    assert dec["live"] is False and dec["mode"] == "pause" and dec["rejected"] == ["live_not_allowed_locally"]
    dec = da.evaluate_desired({"live": True, "control": {"mode": "run"}}, lim, last_live=True)
    assert dec["live"] is True and dec["mode"] == "run" and dec["rejected"] == []


def test_live_false_is_always_honoured():
    for lim in (limits(allow_remote_live=False), limits(allow_remote_live=True)):
        for last in (True, False, None):
            dec = da.evaluate_desired({"live": False, "control": {"mode": "run"}}, lim, last_live=last)
            assert dec["live"] is False and dec["mode"] == "pause"


def test_params_not_allowed_locally():
    dec = da.evaluate_desired({"live": False, "params": {"InpLotsA": 0.05}}, limits(allow_remote_params=False), False)
    assert dec["params_state"] == "not_allowed" and dec["params"] is None
    assert dec["rejected"] == ["params_not_allowed_locally"]


def test_params_over_local_limits_unknown_keys_and_bounds_reject_the_block():
    lim = limits(max_lots=0.10, max_daily_cap_pct=10.0)
    cases = [
        ({"InpLotsA": 0.05, "InpMaxLots": 0.20}, "params_lots_over_limit"),
        ({"InpLotsAsia": 0.11}, "params_lots_over_limit"),
        ({"InpDailyCapPct": 12.5}, "params_cap_over_limit"),
        ({"InpLotsA": 0.05, "InpAllowLive": True}, "params_unknown_key"),          # not remote: never
        ({"InpA_SLCap": 6.0}, "params_unknown_key"),
        ({"InpMaxAttempts": 5}, "params_out_of_bounds"),
        ({"InpUseA": "maybe"}, "params_out_of_bounds"),
        ({"InpLockAtPct": 90, "InpLockToPct": 90}, "params_out_of_bounds"),
        ({"InpLock1AtPct": 5}, "params_out_of_bounds"),
    ]
    for params, code in cases:
        dec = da.evaluate_desired({"live": True, "params": params}, lim, True)
        assert dec["params_state"] == "rejected" and dec["params"] is None, params
        assert code in dec["rejected"], (params, dec["rejected"])


def test_valid_params_pass_and_ea_ceiling_applies():
    lim = limits(max_lots=0.10)
    p = {"InpLotsA": 0.1, "InpUseAsia": False, "InpMaxAttempts": 3, "InpDailyCapPct": 8, "InpLockAtPct": 95,
         "InpLockToPct": 93, "InpLock1AtPct": 82, "InpLock1ToPct": 80}
    dec = da.evaluate_desired({"live": True, "params": p}, lim, True)
    assert dec["params_state"] == "ok" and dec["rejected"] == [] and dec["params"]["InpMaxAttempts"] == 3
    # schema-5 status: the EA's own ceiling (InpRemoteMaxLots) is lower than the agent's max_lots
    dec = da.evaluate_desired({"live": True, "params": {"InpLotsA": 0.08}}, lim, True,
                              ea_remote={"ceilings": {"max_lots": 0.05, "max_cap_pct": 10}})
    assert dec["rejected"] == ["params_lots_over_limit"]


def test_garbage_limits_fall_back_to_safe_values():
    lim = da.get_limits({"limits": {"allow_remote_control": "yes please", "allow_remote_live": "on",
                                    "max_lots": "lots", "max_daily_cap_pct": -1}})
    assert lim["allow_remote_control"] is False and lim["allow_remote_live"] is True
    assert lim["max_lots"] == 0.01 and lim["max_daily_cap_pct"] == 1.0


# ---------------------------------------------------------------------------------------------------------------- remote
def test_remote_file_exact_text():
    p = {"InpLockToPct": 93, "InpLotsA": 0.1, "InpUseAsia": False, "InpMaxAttempts": 3.0, "InpDailyCapPct": 8,
         "InpLockAtPct": 95, "InpRecoveryMult": 1.5, "InpVirtualStart": 280}
    text = da.render_remote_text(17, True, p, WRITTEN)
    assert text == ("# Dobby3 remote parameters, written 2026-11-07 10:00:00 by dobby_agent (web v17)\r\n"
                    "version=17\r\n"
                    "live=1\r\n"
                    "InpUseAsia=false\r\n"
                    "InpLotsA=0.10\r\n"
                    "InpRecoveryMult=1.5\r\n"
                    "InpMaxAttempts=3\r\n"
                    "InpDailyCapPct=8.0\r\n"
                    "InpVirtualStart=280.0\r\n"
                    "InpLockAtPct=95.0\r\n"
                    "InpLockToPct=93.0\r\n")
    assert da.render_remote_text(18, False, None, WRITTEN).split("\r\n")[1:-1] == ["version=18", "live=0"]
    assert da.render_remote_text(18, None, None, WRITTEN).split("\r\n")[1:-1] == ["version=18"]
    assert da.remote_semantics(da.render_remote_text(18, True, None, WRITTEN)) == ["live=1"]
