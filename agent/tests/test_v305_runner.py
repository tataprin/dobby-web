# -*- coding: utf-8 -*-
"""v3.05 (contract 2026-11-10, SPEC 11): the eight runner keys, the `cap_reset` token, the remote-file line order and
the drop rule for EAs below 3.05 - in the pure functions, in the agent loop and in the app (preset, demo EA)."""
import os
import time
from datetime import datetime

import pytest

import dobby_agent as da
import dobby_app_core as core
from conftest import Env, T0, utc

NOW = utc(2026, 11, 10, 12, 0, 0)          # the agent's UTC clock in the pure tests
WRITTEN = datetime(2026, 11, 10, 19, 0, 0)
LIM = da.get_limits({"limits": {"allow_remote_control": True, "allow_remote_live": True,
                                "allow_remote_params": True, "max_lots": 0.10, "max_daily_cap_pct": 10.0}})
EA_V305 = {"ceilings": {"max_lots": 0.5, "max_cap_pct": 10}}
RUNNER = {"InpRunnerEnable": True, "InpRunner_A": True, "InpRunner_NY": False, "InpRunner_C5G": True,
          "InpRunnerKeepPct": 75, "InpRunnerStep": 0.5, "InpRunnerMaxSteps": 0, "InpRunnerSafetyTP": 4}
RUNNER_LINES = ["InpRunnerEnable=true", "InpRunner_A=true", "InpRunner_NY=false", "InpRunner_C5G=true",
                "InpRunnerKeepPct=75.0", "InpRunnerStep=0.5", "InpRunnerMaxSteps=0", "InpRunnerSafetyTP=4.0"]
ALL_V305 = ("InpRunnerEnable, InpRunner_A, InpRunner_NY, InpRunner_C5G, InpRunnerKeepPct, InpRunnerStep, "
            "InpRunnerMaxSteps, InpRunnerSafetyTP, cap_reset")


def check(params, now=NOW):
    return da.check_params(params, LIM, EA_V305, now)


def decisions(e):
    with open(os.path.join(e.agent_dir, da.DECISIONS_NAME), encoding="utf-8") as fh:
        return fh.read()


def desired(params, live=True):
    return {"live": live, "control": {"mode": "run", "lots": 0.03, "allow_long": True, "allow_short": True,
                                      "max_spread": None, "note": ""}, "blackouts": [], "params": params}


# ---------------------------------------------------------------------------------------------------------- allow-list
def test_allow_list_order_kinds_and_bounds():
    assert da.REMOTE_KEYS[-11:-3] == list(da.V305_KEYS[:8]) and da.REMOTE_KEYS[-1] == "cap_reset"   # cap_reset last
    assert da.REMOTE_KEYS[-3] == "InpC5_VwapTol" and da.REMOTE_SPEC["InpC5_VwapTol"] == ("float", 0.0, 0.5)   # v3.07
    assert da.REMOTE_KEYS[-2] == "InpC5_M15Trend" and da.REMOTE_SPEC["InpC5_M15Trend"] == ("bool", None, None)   # v3.08
    assert da.REMOTE_KEYS[da.REMOTE_KEYS.index("InpLock1ToPct") + 1] == "InpRunnerEnable"   # right after the locks
    assert len(da.REMOTE_KEYS) == len(set(da.REMOTE_KEYS)) == 40
    for k in ("InpRunnerEnable", "InpRunner_A", "InpRunner_NY", "InpRunner_C5G"):
        assert da.REMOTE_SPEC[k] == ("bool", None, None), k
    assert da.REMOTE_SPEC["InpRunnerKeepPct"] == ("float", 50.0, 99.0)
    assert da.REMOTE_SPEC["InpRunnerStep"] == ("float", 0.1, 2.0)
    assert da.REMOTE_SPEC["InpRunnerMaxSteps"] == ("int", 0, 50)
    assert da.REMOTE_SPEC["InpRunnerSafetyTP"] == ("float", 0.0, 10.0)
    assert da.REMOTE_SPEC["cap_reset"] == ("token", None, None)
    assert da.TOKEN_WINDOW_S == 48 * 3600 and da.V305_MIN_EA == (3, 5) and da.V307_MIN_EA == (3, 7) and da.V308_MIN_EA == (3, 8)
    assert da.AGENT_VERSION == "1.3.2" and core.APP_VERSION == "1.3.2"


@pytest.mark.parametrize("key,value,ok", [
    ("InpRunnerEnable", True, True), ("InpRunnerEnable", "false", True), ("InpRunnerEnable", 0, True),
    ("InpRunnerEnable", "maybe", False), ("InpRunnerEnable", 2.5, False),
    ("InpRunner_A", 1, True), ("InpRunner_A", "x", False),
    ("InpRunner_NY", "off", True), ("InpRunner_NY", None, False),
    ("InpRunner_C5G", "on", True), ("InpRunner_C5G", "", False),
    ("InpRunnerKeepPct", 50, True), ("InpRunnerKeepPct", 99, True), ("InpRunnerKeepPct", "75", True),
    ("InpRunnerKeepPct", 49.9, False), ("InpRunnerKeepPct", 99.5, False), ("InpRunnerKeepPct", "abc", False),
    ("InpRunnerStep", 0.1, True), ("InpRunnerStep", 2.0, True), ("InpRunnerStep", 0.25, True),
    ("InpRunnerStep", 0.05, False), ("InpRunnerStep", 2.5, False), ("InpRunnerStep", 0, False),
    ("InpRunnerMaxSteps", 0, True), ("InpRunnerMaxSteps", 50, True), ("InpRunnerMaxSteps", 7.0, True),
    ("InpRunnerMaxSteps", 51, False), ("InpRunnerMaxSteps", -1, False), ("InpRunnerMaxSteps", 2.5, False),
    ("InpRunnerSafetyTP", 0, True), ("InpRunnerSafetyTP", 10, True), ("InpRunnerSafetyTP", 4.0, True),
    ("InpRunnerSafetyTP", 10.1, False), ("InpRunnerSafetyTP", -0.1, False), ("InpRunnerSafetyTP", True, False),
])
def test_runner_key_bounds(key, value, ok):
    clean, codes, det = check({key: value})
    if ok:
        assert codes == [] and det == [] and key in clean, (key, value)
    else:
        assert clean is None and codes == ["params_out_of_bounds"] and key in det[0], (key, value)
    # through evaluate_desired: a bad value rejects the whole params block, the rest of the desired state survives
    dec = da.evaluate_desired(desired(dict(RUNNER, **{key: value})), LIM, True, EA_V305, NOW)
    assert dec["params_state"] == ("ok" if ok else "rejected") and dec["live"] is True and dec["mode"] == "run"


def test_runner_values_are_cleaned_like_the_other_kinds():
    clean, codes, _ = check(dict(RUNNER, InpRunnerMaxSteps=7.0, InpRunnerKeepPct="80", InpRunner_NY="0"))
    assert codes == []
    assert clean["InpRunnerMaxSteps"] == 7 and isinstance(clean["InpRunnerMaxSteps"], int)
    assert clean["InpRunnerKeepPct"] == 80.0 and clean["InpRunner_NY"] is False and clean["InpRunnerEnable"] is True
    # runner keys alone, without any lock key, trigger no lock cross-check
    assert check({"InpRunnerEnable": False})[1] == []


# --------------------------------------------------------------------------------------------------------------- token
def test_cap_reset_token_valid_now_as_number_string_and_float():
    t = int(NOW) - 90
    for value in (t, str(t), float(t), " %d " % t):
        clean, codes, det = check({"cap_reset": value})
        assert codes == [] and det == [] and clean == {"cap_reset": t}, value
        assert isinstance(clean["cap_reset"], int)
    # the 48 h window, both ways
    assert check({"cap_reset": int(NOW) - 48 * 3600 + 1})[1] == []
    assert check({"cap_reset": int(NOW) + 48 * 3600 - 1})[1] == []
    assert check({"cap_reset": int(NOW) - 48 * 3600 - 1})[1] == ["params_out_of_bounds"]
    assert check({"cap_reset": int(NOW) + 48 * 3600 + 1})[1] == ["params_out_of_bounds"]
    # without `now` the wall clock is the reference (what the CLI / the app use)
    assert da.check_params({"cap_reset": int(time.time())}, LIM, EA_V305)[1] == []
    assert da.check_params({"cap_reset": int(time.time()) - 3 * 86400}, LIM, EA_V305)[1] == ["params_out_of_bounds"]


def test_cap_reset_stale_token_three_days_old_rejects_the_block():
    t = int(NOW) - 3 * 86400
    clean, codes, det = check({"cap_reset": t})
    assert clean is None and codes == ["params_out_of_bounds"]
    assert det == ["cap_reset=%d is 72.0 h away from now (allowed: 48 h)" % t]
    dec = da.evaluate_desired(desired(dict(RUNNER, InpLotsA=0.05, cap_reset=t)), LIM, True, EA_V305, NOW)
    assert dec["params_state"] == "rejected" and dec["params"] is None and dec["rejected"] == ["params_out_of_bounds"]
    assert dec["live"] is True                                           # only the params block is refused


@pytest.mark.parametrize("value", [1762794000.5, "1762794000.7", "abc", "", None, True, False, 0, -5, [1762794000],
                                   {"t": 1762794000}])
def test_cap_reset_non_integer_rejected(value):
    clean, codes, det = check({"cap_reset": value})
    assert clean is None and codes == ["params_out_of_bounds"] and det[0].startswith("cap_reset")


# ---------------------------------------------------------------------------------------------------------- file text
def test_remote_file_runner_lines_after_the_locks_and_cap_reset_last():
    p = {"cap_reset": 1762794000, "InpRunnerSafetyTP": 4, "InpLotsA": 0.1, "InpRunnerEnable": True,
         "InpLockToPct": 93, "InpRunnerMaxSteps": 3.0, "InpRunnerStep": 0.5, "InpRunnerKeepPct": 75,
         "InpRunner_NY": False, "InpLockAtPct": 95, "InpUseAsia": False}
    clean, codes, _ = check(p, now=1762794000 + 600)
    assert codes == []
    text = da.render_remote_text(21, True, clean, WRITTEN)
    assert text == ("# Dobby3 remote parameters, written 2026-11-10 19:00:00 by dobby_agent (web v21)\r\n"
                    "version=21\r\n"
                    "live=1\r\n"
                    "InpUseAsia=false\r\n"
                    "InpLotsA=0.10\r\n"
                    "InpLockAtPct=95.0\r\n"
                    "InpLockToPct=93.0\r\n"
                    "InpRunnerEnable=true\r\n"
                    "InpRunner_NY=false\r\n"
                    "InpRunnerKeepPct=75.0\r\n"
                    "InpRunnerStep=0.5\r\n"
                    "InpRunnerMaxSteps=3\r\n"
                    "InpRunnerSafetyTP=4.0\r\n"
                    "cap_reset=1762794000\r\n")
    # the full allow-list in one file: every key once, in REMOTE_KEYS order, cap_reset the last line
    full = dict((k, 1) for k in da.REMOTE_KEYS)
    lines = da.render_remote_text(1, None, full, WRITTEN).split("\r\n")[2:-1]
    assert [ln.split("=")[0] for ln in lines] == da.REMOTE_KEYS and lines[-1] == "cap_reset=1"
    assert da.fmt_param("cap_reset", 1762794000.0) == "1762794000"


def test_changed_token_is_a_semantic_change_a_new_version_alone_is_not():
    p = dict(RUNNER, InpLotsA=0.05, cap_reset=1762794000)
    a = da.render_remote_text(21, True, p, WRITTEN)
    same = da.render_remote_text(22, True, dict(p), WRITTEN)
    new_token = da.render_remote_text(22, True, dict(p, cap_reset=1762794060), WRITTEN)
    assert da.remote_semantics(a) == da.remote_semantics(same)
    assert da.remote_semantics(a) != da.remote_semantics(new_token)
    assert da.remote_semantics(new_token)[-1] == "cap_reset=1762794060"


# ---------------------------------------------------------------------------------------------------- compatibility
@pytest.mark.parametrize("ver,supported", [
    ("3.05", True), ("3.10", True), ("3.5", True), ("4.0", True), ("3.05.1", True), ("v3.05", True), (3.05, True),
    ("3.04", False), ("3.03", False), ("2.99", False), (3.04, False), (None, False), ("", False), ("garbage", False),
    ("3", False), ("v3", False)])
def test_ea_version_compare(ver, supported):
    assert da.ea_supports_v305(ver) is supported
    assert (da.ea_version_tuple("3.04") < da.ea_version_tuple("3.05") < da.ea_version_tuple("3.10"))


def test_drop_v305_keys_pure():
    full = dict(RUNNER, InpLotsA=0.05, cap_reset=1762794000)
    kept, dropped = da.drop_v305_keys(full, "3.04")
    assert kept == {"InpLotsA": 0.05} and dropped == list(da.V305_KEYS)
    assert da.drop_v305_keys(full, "3.05") == (full, [])
    assert da.drop_v305_keys({"InpLotsA": 0.05}, "3.04") == ({"InpLotsA": 0.05}, [])     # nothing to drop: no note
    assert da.drop_v305_keys(None, "3.04") == (None, [])
    assert da.drop_v305_keys({"cap_reset": 1762794000}, None) == ({}, ["cap_reset"])


def test_drop_v307_vwap_tolerance_key():
    """v3.07: InpC5_VwapTol reaches only an EA >= 3.07; below that it leaves the file (the EA would reject it)."""
    full = dict(RUNNER, InpLotsA=0.05, InpC5_VwapTol=0.15, cap_reset=1762794000)
    kept, dropped = da.drop_v305_keys(full, "3.06")
    assert dropped == ["InpC5_VwapTol"] and kept == dict(RUNNER, InpLotsA=0.05, cap_reset=1762794000)
    kept, dropped = da.drop_v305_keys(full, "3.04")
    assert kept == {"InpLotsA": 0.05} and dropped == [k for k in da.REMOTE_KEYS if k in full and k != "InpLotsA"]
    assert da.drop_v305_keys(full, "3.07") == (full, [])
    assert da.drop_v305_keys(full, "3.10") == (full, [])
    # v3.08: the C5G H4-or-M15 switch reaches only an EA >= 3.08
    f8 = dict(full, InpC5_M15Trend=True)
    kept, dropped = da.drop_v305_keys(f8, "3.07")
    assert dropped == ["InpC5_M15Trend"] and kept == full
    assert da.drop_v305_keys(f8, "3.06")[1] == ["InpC5_VwapTol", "InpC5_M15Trend"]
    assert da.drop_v305_keys(f8, "3.08") == (f8, [])
    l8 = da.render_remote_text(5, None, {"InpC5_M15Trend": True, "InpC5_VwapTol": 0.15, "cap_reset": 1762794000}, WRITTEN).split("\r\n")
    assert l8.index("InpC5_VwapTol=0.15") < l8.index("InpC5_M15Trend=true") < l8.index("cap_reset=1762794000")
    ok8, codes8, _ = da.check_params({"InpC5_M15Trend": True}, dict(da.DEFAULT_LIMITS, allow_remote_params=True))
    assert ok8 == {"InpC5_M15Trend": True} and not codes8
    assert da.check_params({"InpC5_M15Trend": "maybe"}, dict(da.DEFAULT_LIMITS, allow_remote_params=True))[0] is None
    lines = da.render_remote_text(4, None, {"InpC5_VwapTol": 0.15, "cap_reset": 1762794000}, WRITTEN).split("\r\n")
    assert lines.index("InpC5_VwapTol=0.15") < lines.index("cap_reset=1762794000")       # cap_reset stays last
    lim = dict(da.DEFAULT_LIMITS, allow_remote_params=True)
    ok, codes, _ = da.check_params({"InpC5_VwapTol": 0.15}, lim)
    assert ok == {"InpC5_VwapTol": 0.15} and not codes
    for bad in (-0.01, 0.51, "x", True):
        assert da.check_params({"InpC5_VwapTol": bad}, lim)[0] is None, bad
    assert da.render_remote_text(3, None, {}, WRITTEN).split("\r\n")[1:-1] == ["version=3"]


def test_loop_drops_v305_keys_for_ea_304_and_writes_them_after_the_update(tmp_path):
    tok = int(T0) - 60
    e = Env(tmp_path, desired=desired(dict(RUNNER, InpLotsA=0.05, cap_reset=tok)), version=1,
            limits={"allow_remote_params": True})
    e.write_status(ea_version="3.04")
    a = e.agent()
    a.cycle()
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=1", "InpLotsA=0.05"]
    ast = e.fake.bots_patches[-1]["agent_state"]
    assert ast["rejected"] == [] and ast["reject_details"] == [] and ast["applied_version"] == 1   # not an error
    assert e.state()["applied_params"]["cap_reset"] == tok              # kept for the day the EA is updated
    assert decisions(e).count("v1 remote: dropped v3.05 keys for EA 3.04: " + ALL_V305) == 1
    assert "v1 applied | live=on" in decisions(e)
    for _ in range(3):                                                  # said once per change, not every cycle
        e.tick(5, ea_version="3.04")
        a.cycle()
    assert decisions(e).count("dropped v3.05 keys") == 1
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=1", "InpLotsA=0.05"]
    # the EA is updated to 3.05: the keys come back into the file (same web version, the content changed)
    e.tick(5, ea_version="3.05")
    a.cycle()
    body = e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1]
    assert body == ["version=1", "InpLotsA=0.05"] + RUNNER_LINES + ["cap_reset=%d" % tok]
    assert decisions(e).count("v1 remote: v3.05 keys written again for EA 3.05") == 1
    e.tick(5, ea_version="3.05")
    a.cycle()
    assert decisions(e).count("v1 remote:") == 2                        # nothing new to say
    # a new click on the website = a new token: rewritten with the new version, token still the last line
    e.fake.web_set(desired(dict(RUNNER, InpLotsA=0.05, cap_reset=tok + 600)))
    e.tick(5, ea_version="3.05")
    a.cycle()
    body = e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1]
    assert body[0] == "version=2" and body[-1] == "cap_reset=%d" % (tok + 600) and len(body) == 11
    assert e.fake.bots_patches[-1]["agent_state"]["remote_file_version"] == 2
    # the same desired a cycle later: not rewritten
    m = os.stat(e.path(da.REMOTE_NAME)).st_mtime
    e.tick(5, ea_version="3.05")
    a.cycle()
    assert os.stat(e.path(da.REMOTE_NAME)).st_mtime == m


def test_loop_drops_v305_keys_when_no_status_is_known(tmp_path):
    e = Env(tmp_path, desired=desired({"InpRunnerEnable": True, "InpLotsA": 0.04}), version=1,
            limits={"allow_remote_params": True, "allow_remote_live": True})
    os.remove(e.path(da.STATUS_NAME))                                   # MT5 not running yet: no EA version at all
    a = e.agent()
    a.cycle()
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=1", "live=1", "InpLotsA=0.04"]
    assert decisions(e).count("v1 remote: dropped v3.05 keys for EA unknown: InpRunnerEnable") == 1
    assert e.fake.bots_patches[-1]["agent_state"]["rejected"] == []
    # params switched off on this PC: no params in the file at all, and no "written again" line
    da.update_config(e.cfg_path, lambda c: c["limits"].update({"allow_remote_params": False}))
    e.clock.advance(5)
    a.cycle()
    assert e.read(da.REMOTE_NAME).decode().split("\r\n")[1:-1] == ["version=1", "live=1"]
    assert decisions(e).count("v1 remote:") == 1 and "written again" not in decisions(e)
    da.update_config(e.cfg_path, lambda c: c["limits"].update({"allow_remote_params": True}))
    e.clock.advance(5)
    a.cycle()                                                           # back on, EA still unknown: dropped again
    assert decisions(e).count("dropped v3.05 keys for EA unknown") == 2


def test_loop_stale_token_rejects_the_block_and_keeps_the_last_file(tmp_path):
    e = Env(tmp_path, desired=desired({"InpLotsA": 0.05, "InpRunnerEnable": False}), version=1,
            limits={"allow_remote_params": True})
    e.write_status(ea_version="3.05")
    a = e.agent()
    a.cycle()
    good = e.read(da.REMOTE_NAME)
    assert good.decode().split("\r\n")[1:-1] == ["version=1", "InpLotsA=0.05", "InpRunnerEnable=false"]
    e.fake.web_set(desired({"InpLotsA": 0.06, "InpRunnerEnable": False, "cap_reset": int(T0) - 3 * 86400}))
    e.tick(5, ea_version="3.05")
    a.cycle()
    assert e.read(da.REMOTE_NAME) == good                               # the EA keeps what it has
    ast = e.fake.bots_patches[-1]["agent_state"]
    assert ast["rejected"] == ["params_out_of_bounds"] and "72.0 h away" in ast["reject_details"][0]


# ----------------------------------------------------------------------------------------------------------------- app
def test_app_installs_the_v305_pair_and_knows_the_runner_inputs():
    assert core.EA_CHART_NAME == "Dobby3_v305" and core.WEB_PRESET_NAME == "Dobby3_v305_web.set"
    keys = [k for k, _, _ in core.EA_INPUTS]
    assert keys[-8:] == list(da.V305_KEYS[:8]) and "cap_reset" not in keys          # a command, not an input
    assert core.RUNNER_DEFAULTS == {"InpRunnerEnable": False, "InpRunner_A": True, "InpRunner_NY": True,
                                    "InpRunner_C5G": True, "InpRunnerKeepPct": 75.0, "InpRunnerStep": 0.5,
                                    "InpRunnerMaxSteps": 0, "InpRunnerSafetyTP": 4.0}
    v = core.web_preset_values()
    assert v["InpRunnerEnable"] is False and v["InpRunnerKeepPct"] == 75.0 and v["InpRemoteParams"] is True
    text = core.render_set(v, core.WEB_PRESET_COMMENTS)
    assert "Dobby3_v305_web.set" in text and text.rstrip("\r\n").split("\r\n")[-8:] == [
        "InpRunnerEnable=false||false||0||true||N", "InpRunner_A=true||false||0||true||N",
        "InpRunner_NY=true||false||0||true||N", "InpRunner_C5G=true||false||0||true||N",
        "InpRunnerKeepPct=75.0||75.0||0||75.0||N", "InpRunnerStep=0.5||0.5||0||0.5||N",
        "InpRunnerMaxSteps=0||0||0||0||N", "InpRunnerSafetyTP=4.0||4.0||0||4.0||N"]
    # the simple settings never carry the v3.05 keys; an EA status that has them is still understood
    p = core.settings_to_params(core.auto_settings(300))
    assert not set(p) & set(da.V305_KEYS) and len(p) == 29
    eff = dict(p, cap_reset=1762794000, **core.RUNNER_DEFAULTS)
    assert core.params_to_settings(eff) == core.params_to_settings(p)
    assert core.status_to_settings({"remote": {"effective": eff}})[1] == "ea"
    # the demo storage offers v305 and the picker takes it over v304 (the real bucket needs the upload first)
    demo = [{"name": n, "kind": core.install_kind(n), "updated_at": u} for n, _, u in core.DemoServer().files]
    assert "Dobby3_v305.ex5" in [f["name"] for f in demo] and core.pick_ea_file(demo)["name"] == "Dobby3_v305.ex5"
    assert core.pick_ea_file([{"name": "Dobby3_v304.ex5", "kind": "ea", "updated_at": "2026-11-11"},
                              {"name": "Dobby3_v305.ex5", "kind": "ea", "updated_at": "2026-11-10"}])["name"] == \
        "Dobby3_v305.ex5"


def test_demo_ea_reports_v305_and_handles_the_cap_reset_token(tmp_path):
    common = str(tmp_path / "common")
    os.makedirs(common)
    ea = core.DemoEA(common, clock=lambda: T0)
    st = ea.status()
    assert st["ea_version"] == "3.05" and st["schema_version"] == 6
    assert st["params"]["runner"] == {"enable": False, "a": True, "ny": True, "c5g": True, "keep_pct": 75.0,
                                      "step": 0.5, "max_steps": 0, "safety_tp": 4.0}
    assert st["positions"][2]["runner"] == {"on": False, "converted": False, "k": 0, "sl_floor": None, "target": None}
    assert st["virtual"]["cap_reset_applied"] == 0 and st["virtual"]["cap_resets_today"] == 0
    assert st["remote"]["effective"]["InpRunnerEnable"] is False and st["virtual"]["day_cap_hit"] is False
    tok = int(T0) - 30
    path = os.path.join(common, da.REMOTE_NAME)
    da.write_ea_file(path, da.render_remote_text(7, True, {"InpRunnerEnable": True, "cap_reset": tok},
                                                 da.epoch_to_naive(T0)), sleep=lambda s: None)
    st = ea.status()
    assert st["remote"]["effective"]["InpRunnerEnable"] is True and st["positions"][2]["runner"]["on"] is True
    assert st["virtual"]["cap_reset_applied"] == 0                                 # cap not hit: ignored, remembered
    assert ("DAYCAP_RESET", "IGNORED: cap not hit, token %d" % tok) in ea._journal_add
    ea.day_cap_hit = True
    da.write_ea_file(path, da.render_remote_text(8, True, {"InpRunnerEnable": True, "cap_reset": tok},
                                                 da.epoch_to_naive(T0)), sleep=lambda s: None)
    assert ea.status()["virtual"]["day_cap_hit"] is True                           # the same token again: nothing
    da.write_ea_file(path, da.render_remote_text(9, True, {"InpRunnerEnable": True, "cap_reset": tok + 60},
                                                 da.epoch_to_naive(T0)), sleep=lambda s: None)
    st = ea.status()
    assert st["virtual"]["day_cap_hit"] is False and st["virtual"]["cap_reset_applied"] == tok + 60
    assert st["virtual"]["cap_resets_today"] == 1
    assert ("DAYCAP_RESET", "day P&L -> 0.00, token %d" % (tok + 60)) in ea._journal_add
