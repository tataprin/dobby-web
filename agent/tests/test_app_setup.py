# -*- coding: utf-8 -*-
"""The new setup flow (no window): SPEC 7.3 auto from balance, the 7.2 settings <-> EA keys mapping, the generated
preset Dobby3_v304_web.set (7.4), "open MT5 with Dobby" (startup ini + every refusal, fake folders, fake launcher),
linking an existing bot vs creating one, the main screen's hero state and the plain-Thai activity."""
import json
import os
import re

import pytest

import dobby_agent as da
import dobby_app_core as core
import dobby_app_gfx as gfx
from conftest import BOT, Env

MQ5 = r"D:\Dobby\mt5\Dobby3_v305.mq5"
WEB_SET = r"D:\Dobby\mt5\presets\Dobby3_v305_web.set"        # the preset the EA builder ships next to the .ex5


# ---------------------------------------------------------------------------------------------------------------------
# SPEC 7.3: auto from balance
# ---------------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("balance,lot", [
    (300, 0.03), (1000, 0.10), (150, 0.01), (99, 0.01), (60000, 0.50), (100, 0.01), (299.99, 0.02), (4999, 0.49),
    (5000, 0.50), (280, 0.02), (1, 0.01), (0, 0.01), (-5, 0.01), (None, 0.01), ("abc", 0.01), ("1000", 0.10)])
def test_auto_lot(balance, lot):
    assert core.auto_lot(balance) == lot


def test_auto_settings_rule_7_3():
    s = core.auto_settings(300)
    assert s == {"balance": 300, "use_a": True, "use_ny": True, "use_c5g": True, "use_asia": False,
                 "lot_mode": "same", "lot": 0.03, "lot_a": 0.03, "lot_ny": 0.03, "lot_c5g": 0.03, "lot_asia": 0.01,
                 "lock_stages": 2, "lock_at": 95.0, "lock_to": 93.0, "lock1_at": 85.0, "lock1_to": 83.0,
                 "daily_cap": 10.0, "recovery": 1.5, "attempts": 4, "conf_mult": 1.5, "conf_min": 60,
                 "max_spread": 1.0, "vol_gate": False, "vol_gate_pct": 1.75}
    assert core.settings_line(s) == "3 สูตรเปิด · ล็อต 0.03 · ล็อก 2 ชั้น 85→83 / 95→93 · เอเชียปิด · หยุดเมื่อขาดทุน 10%/วัน"
    cards = dict((c["key"], c) for c in core.settings_summary(s))
    assert cards["strategies"]["sub"] == "A_new · NY · C5G" and cards["cap"]["sub"] == "≈ 30.00 USD ต่อวัน"
    assert core.auto_settings(1000)["lot"] == 0.10 and core.auto_settings(1000)["balance"] == 1000
    assert core.validate_settings(core.auto_settings(300)) == {}
    assert "balance" in core.validate_settings(core.auto_settings(None))


@pytest.mark.parametrize("lot,local", [(0.01, 0.02), (0.03, 0.06), (0.10, 0.20), (0.25, 0.50), (0.50, 0.50)])
def test_local_max_lots_default(lot, local):
    assert core.default_local_max_lots(lot) == local
    lim = core.recommended_limits(lot)
    assert lim == {"allow_remote_control": True, "allow_remote_live": True, "allow_remote_params": True,
                   "max_lots": local, "max_daily_cap_pct": 10.0}
    assert da.get_limits({"limits": lim}) == lim


# ---------------------------------------------------------------------------------------------------------------------
# SPEC 7.2: simple settings -> EA keys
# ---------------------------------------------------------------------------------------------------------------------
EA_CEILINGS = {"ceilings": {"max_lots": core.PRESET_MAX_LOTS, "max_cap_pct": core.PRESET_MAX_CAP}}


def test_params_full_remote_key_set_and_values():
    p = core.settings_to_params(core.auto_settings(300))
    assert list(p) == [k for k in da.REMOTE_KEYS if k not in da.V305_KEYS]   # every v3.04 key, allow-list order
    assert p == {
        "InpUseA": True, "InpUseNY": True, "InpUseC5G": True, "InpUseAsia": False,
        "InpLotsA": 0.03, "InpLotsNY": 0.03, "InpLotsC5G": 0.03, "InpMaxLots": 0.03, "InpLotsAsia": 0.01,
        "InpRecoveryMult": 1.5, "InpMaxAttempts": 4, "InpConfluenceMult": 1.5, "InpConfluenceMin": 60,
        "InpDailyCapPct": 10.0, "InpKillBalance": 0.0, "InpVirtualStart": 300.0, "InpMaxSpread": 1.0,
        "InpVolGate": False, "InpVolGatePct": 1.75,
        "InpLockEnable": True, "InpLock_A": True, "InpLock_NY": True, "InpLock_C5G": True, "InpLockShadow": True,
        "InpLock1Enable": True, "InpLockAtPct": 95.0, "InpLockToPct": 93.0, "InpLock1AtPct": 85.0,
        "InpLock1ToPct": 83.0}
    clean, codes, _ = da.check_params(p, core.recommended_limits(0.03), EA_CEILINGS)
    assert codes == [] and clean == p                                    # the agent accepts it unchanged


@pytest.mark.parametrize("stages,lock,lock1", [(0, False, False), (1, True, False), (2, True, True)])
def test_lock_stage_mapping(stages, lock, lock1):
    s = dict(core.auto_settings(1000), lock_stages=stages)
    p = core.settings_to_params(s)
    assert (p["InpLockEnable"], p["InpLock1Enable"]) == (lock, lock1)
    assert not da.check_params(p, core.recommended_limits(0.10), EA_CEILINGS)[1]
    back = core.params_to_settings(p)
    assert back["lock_stages"] == stages


def test_hidden_lock_values_are_made_valid():
    # 1 stage at 80 -> 78: the (hidden) first stage 85 -> 83 would break the EA cross-check; it is pulled below
    s = dict(core.auto_settings(300), lock_stages=1, lock_at=80.0, lock_to=78.0)
    p = core.settings_to_params(s)
    assert p["InpLockAtPct"] == 80.0 and p["InpLock1AtPct"] <= 79.5 and p["InpLock1ToPct"] <= 77.5
    assert not da.check_params(p, core.recommended_limits(0.03), EA_CEILINGS)[1]
    s = dict(core.auto_settings(300), lock_stages=0, lock_at=20.0, lock_to=90.0)          # nonsense while hidden
    p = core.settings_to_params(s)
    assert (p["InpLockAtPct"], p["InpLockToPct"]) == (95.0, 93.0) and not p["InpLockEnable"]
    assert not da.check_params(p, core.recommended_limits(0.03), EA_CEILINGS)[1]


def test_per_strategy_lots_and_max_lots():
    s = dict(core.auto_settings(500), lot_mode="each", lot_a=0.05, lot_ny=0.02, lot_c5g=0.04, use_asia=True,
             lot_asia=0.06)
    p = core.settings_to_params(s)
    assert (p["InpLotsA"], p["InpLotsNY"], p["InpLotsC5G"], p["InpLotsAsia"]) == (0.05, 0.02, 0.04, 0.06)
    assert p["InpMaxLots"] == 0.06 and core.settings_max_lot(s) == 0.06    # the EA caps ASIA16 at InpMaxLots too
    assert p["InpUseAsia"] is True
    assert not da.check_params(p, core.recommended_limits(core.settings_max_lot(s)), EA_CEILINGS)[1]
    assert core.settings_summary(s)[1] == {"key": "lot", "title": "ล็อตแยกสูตร", "sub": "A 0.05 · NY 0.02 · C5G 0.04"}
    back = core.params_to_settings(p)
    assert back["lot_mode"] == "each" and (back["lot_a"], back["lot_ny"], back["lot_c5g"]) == (0.05, 0.02, 0.04)
    same = core.settings_to_params(dict(s, lot_mode="same", lot=0.07))
    assert same["InpLotsA"] == same["InpLotsNY"] == same["InpLotsC5G"] == 0.07 and same["InpMaxLots"] == 0.07


def test_roundtrip_params_settings():
    for s in (core.auto_settings(300), dict(core.auto_settings(2500), use_ny=False, daily_cap=6.0, attempts=2,
                                            conf_min=90, max_spread=0.6, vol_gate=True, vol_gate_pct=2.25,
                                            recovery=1.2, conf_mult=1.0)):
        p = core.settings_to_params(s)
        assert core.settings_to_params(core.params_to_settings(p)) == p


@pytest.mark.parametrize("change,field", [
    ({"balance": "abc"}, "balance"), ({"balance": 0}, "balance"),
    ({"use_a": False, "use_ny": False, "use_c5g": False}, "strategies"),
    ({"lot": 0.0}, "lot"), ({"lot": 0.51}, "lot"), ({"lot_mode": "each", "lot_ny": 0.001}, "lot_ny"),
    ({"use_asia": True, "lot_asia": 0.9}, "lot_asia"),
    ({"lock1_at": 96.0}, "lock1_at"),                  # stage 1 must be below the near-TP stage
    ({"lock1_to": 93.0}, "lock1_to"),                  # SL of stage 1 below min(stage-1 trigger, near-TP SL)
    ({"lock_to": 95.0}, "lock_to"), ({"lock_at": 45.0}, "lock_at"),
    ({"daily_cap": 12.0}, "daily_cap"), ({"attempts": 2.5}, "attempts"), ({"conf_min": 300}, "conf_min"),
    ({"recovery": 2.5}, "recovery"), ({"max_spread": 0.0}, "max_spread"),
    ({"vol_gate": True, "vol_gate_pct": 9.0}, "vol_gate_pct")])
def test_validation_inline_errors(change, field):
    errs = core.validate_settings(dict(core.auto_settings(300), **change))
    assert field in errs and errs[field]


def test_validation_ignores_hidden_fields():
    s = dict(core.auto_settings(300), lock_stages=1, lock1_at=99.0)       # stage 1 hidden: not an error
    assert core.validate_settings(s) == {}
    s = dict(core.auto_settings(300), lock_stages=0, lock_at=10.0)
    assert core.validate_settings(s) == {}
    s = dict(core.auto_settings(300), use_asia=False, lot_asia=5)
    assert core.validate_settings(s) == {}


def test_settings_from_status_v303_and_v304():
    with open(os.path.join(os.path.dirname(__file__), "fixtures", "dobby2_status.json"), encoding="utf-8") as f:
        st = json.load(f)
    s, src = core.status_to_settings(st)
    assert src == "ea_v303"
    assert (s["use_a"], s["use_ny"], s["use_c5g"], s["use_asia"]) == (True, True, True, False)
    assert s["lot"] == 0.03 and s["lock_stages"] == 2 and (s["lock1_at"], s["lock_at"]) == (85.0, 95.0)
    assert s["balance"] == 280.0 and s["daily_cap"] == 10.0 and s["attempts"] == 4
    eff = core.settings_to_params(core.auto_settings(1000))
    s, src = core.status_to_settings(dict(st, remote={"effective": eff}))
    assert src == "ea" and s["lot"] == 0.10 and s["balance"] == 1000
    assert core.status_to_settings(None) == (None, None)
    assert core.current_settings(None, {"params": eff}, False)[1] == "web"
    assert core.current_settings(st, None, True)[1] == "ea_v303"
    assert core.current_settings(st, {"params": eff}, False)[1] == "web"
    assert core.current_settings(st, None, False)[1] == "ea_last"


def test_risk_estimate_spec_5_1_scaling():
    r = core.risk_estimate(280, 0.03)
    assert r["kind"] == "in" and abs(r["median"] - 151.79) < 1e-6 and abs(r["half_pct"] - 28.7) < 1e-9
    r = core.risk_estimate(560, 0.10)                     # eq lot 0.05 -> row 0.05, money x 2
    assert r["kind"] == "in" and abs(r["median"] - 264.84) < 1e-6 and abs(r["p10"] + 585.30) < 1e-6
    r = core.risk_estimate(280, 0.035)                    # interpolated between 0.03 and 0.04
    assert abs(r["median"] - (151.79 + 135.40) / 2) < 1e-6
    r = core.risk_estimate(300, 0.03)                     # the auto lot: just under the tested range
    assert r["kind"] == "near" and "โดยประมาณ" in r["text"] and "+163 USD" in r["text"]
    assert core.risk_estimate(150, 0.01)["kind"] == "below"
    assert core.risk_estimate(280, 0.10)["kind"] == "above" and "แนะนำลดล็อต" in core.risk_estimate(280, 0.10)["text"]
    assert core.risk_estimate(0, 0.03) is None and core.risk_estimate(300, None) is None
    assert core.RISK_DISCLAIMER in core.risk_estimate(300, 0.03)["details"]


# ---------------------------------------------------------------------------------------------------------------------
# SPEC 7.4: the generated preset Dobby3_v304_web.set
# ---------------------------------------------------------------------------------------------------------------------
def test_web_preset_file_format_and_values():
    data = core.web_preset_bytes()
    assert data[:2] == b"\xff\xfe" and data == core.web_preset_bytes()        # UTF-16LE BOM, deterministic
    text = data[2:].decode("utf-16-le")
    assert "\r\n" in text and "\n" not in text.replace("\r\n", "") and text.endswith("\r\n")
    pairs = core.parse_set(data)
    keys = [k for k, _ in pairs]
    assert keys == [k for k, _, _ in core.EA_INPUTS] and len(keys) == len(set(keys)) == 80   # each input once
    v = dict(pairs)
    expect = {"InpRemoteParams": "true", "InpRemoteLive": "true", "InpRemoteMaxLots": "0.5",
              "InpRemoteMaxCapPct": "10.0", "InpAllowLive": "false", "InpUseA": "true", "InpUseNY": "true",
              "InpUseC5G": "true", "InpUseAsia": "false", "InpLotsA": "0.03", "InpLotsNY": "0.03",
              "InpLotsC5G": "0.03", "InpMaxLots": "0.03", "InpLotsAsia": "0.01", "InpVirtualStart": "300.0",
              "InpLockEnable": "true", "InpLockAtPct": "95.0", "InpLockToPct": "93.0", "InpLock1Enable": "true",
              "InpLock1AtPct": "85.0", "InpLock1ToPct": "83.0", "InpRecoveryMult": "1.5", "InpMaxAttempts": "4",
              "InpConfluenceMult": "1.5", "InpConfluenceMin": "60", "InpDailyCapPct": "10.0", "InpMaxSpread": "1.0",
              "InpVolGate": "false", "InpKillBalance": "0.0",
              # EA defaults kept
              "InpUseControl": "true", "InpA_SLCap": "6.0", "InpNY_RangeMin": "990", "InpMagicA": "26102402",
              "InpStartDate": "0", "InpRemoteFile": "Dobby\\dobby3_remote.txt", "InpRemoteTesterFrom": "0",
              "InpControlInTester": "false", "InpAsia_MaxSpread": "0.4", "InpNY_Buffer": "0.2",
              # v3.05 runner inputs at their defaults, runner OFF (contract §1 / §5)
              "InpRunnerEnable": "false", "InpRunner_A": "true", "InpRunner_NY": "true", "InpRunner_C5G": "true",
              "InpRunnerKeepPct": "75.0", "InpRunnerStep": "0.5", "InpRunnerMaxSteps": "0", "InpRunnerSafetyTP": "4.0"}
    assert keys[-8:] == list(da.V305_KEYS[:8])                                 # after the v3.04 remote group
    for k, want in expect.items():
        assert v[k] == want, k
    lines = dict((ln.split("=", 1)[0], ln) for ln in text.split("\r\n") if ln and not ln.startswith(";"))
    assert lines["InpAllowLive"] == "InpAllowLive=false||false||0||true||N"
    assert lines["InpLotsA"] == "InpLotsA=0.03||0.03||0||0.03||N"
    assert lines["InpMaxAttempts"] == "InpMaxAttempts=4||4||0||4||N"
    assert lines["InpRemoteFile"] == "InpRemoteFile=Dobby\\dobby3_remote.txt"


@pytest.mark.skipif(not os.path.isfile(MQ5), reason="the private EA source is not on this PC")
def test_ea_input_list_matches_the_mq5():
    src = open(MQ5, encoding="utf-8", errors="replace").read()
    rx = re.compile(r"^input\s+(\w+)\s+(\w+)\s*=\s*([^;]+);", re.M)
    found = [(m.group(2), m.group(1), m.group(3).strip()) for m in rx.finditer(src)]
    assert [k for k, _, _ in found] == [k for k, _, _ in core.EA_INPUTS]
    kinds = {"bool": "bool", "int": "int", "long": "long", "double": "double", "datetime": "datetime",
             "string": "string"}
    for (k, t, d), (k2, t2, d2) in zip(found, core.EA_INPUTS):
        assert kinds[t] == t2, k
        if t2 == "bool":
            assert (d == "true") == d2, k
        elif t2 == "string":
            assert d.strip('"').replace("\\\\", "\\") == d2, k
        else:
            assert float(d) == float(d2), k


@pytest.mark.skipif(not os.path.isfile(WEB_SET), reason="Dobby3_v305_web.set is not on this PC")
def test_app_preset_matches_the_shipped_v305_web_set():
    """The app writes its own Dobby3_v305_web.set; it must say the same as the file shipped with the EA."""
    shipped = dict(core.parse_set(open(WEB_SET, "rb").read()))
    ours = dict(core.parse_set(core.web_preset_bytes()))
    assert sorted(shipped) == sorted(ours)
    for k, v in ours.items():
        kind = core.EA_INPUT_KIND[k]
        if kind in ("bool", "string"):
            assert shipped[k].lower() == v.lower(), k
        else:
            assert float(shipped[k]) == float(v), k


def test_install_web_preset_and_pick_ea(tmp_path):
    d = str(tmp_path / "mt5")
    os.makedirs(os.path.join(d, "MQL5"))
    target, res = core.install_web_preset(d)
    assert target == os.path.join(d, "MQL5", "Presets", "Dobby3_v305_web.set") and res == "installed"
    assert core.install_web_preset(d)[1] == "same"
    files = [{"name": "Dobby3_v303.ex5", "kind": "ea", "updated_at": "2026-11-09"},
             {"name": "Dobby3_v304.ex5", "kind": "ea", "updated_at": "2026-11-01"},
             {"name": "Dobby3_usd280.set", "kind": "preset"}, {"name": "DobbyApp.exe", "kind": None},
             {"name": "Other_v999.ex5", "kind": "ea"}]
    assert core.pick_ea_file(files)["name"] == "Dobby3_v304.ex5"            # the highest v3xx wins
    files.append({"name": "Dobby3_v304.ex5 ", "kind": "ea", "updated_at": "2026-11-08"})
    assert core.pick_ea_file(files)["updated_at"] == "2026-11-08"          # same version: the newest upload
    files.append({"name": "Dobby3_v305.ex5", "kind": "ea", "updated_at": "2026-10-01"})
    assert core.pick_ea_file(files)["name"] == "Dobby3_v305.ex5"            # v305 beats v304 whatever the upload date
    assert core.pick_ea_file([{"name": "x.set", "kind": "preset"}]) is None
    assert core.pick_ea_file([{"name": "Dobby.ex5", "kind": "ea"}])["name"] == "Dobby.ex5"
    os.makedirs(os.path.join(d, "MQL5", "Experts", "Dobby"))
    for n in ("Dobby3_v303.ex5", "Dobby3_v304.ex5"):
        open(os.path.join(d, "MQL5", "Experts", "Dobby", n), "wb").close()
    assert core.installed_ea_name(d) == "Dobby3_v304.ex5"


# ---------------------------------------------------------------------------------------------------------------------
# "เปิด MT5 พร้อม Dobby": startup ini and every refusal (fake folders, fake process list, fake launcher)
# ---------------------------------------------------------------------------------------------------------------------
HEX = "D0E8209F77C8CF37AD8BF550E51FF075"


def _mt5(tmp_path, ea=True, preset=True, exe=True, charts=()):
    """A fake MT5: data folder (origin.txt -> install folder with a dummy terminal64.exe) under tmp_path."""
    install = str(tmp_path / "Programs" / "Broker MT5")
    os.makedirs(install)
    if exe:
        open(os.path.join(install, core.TERMINAL_EXE), "wb").write(b"dummy, never started")
    data = str(tmp_path / "appdata" / "MetaQuotes" / "Terminal" / HEX)
    for sub in (("MQL5", "Experts", "Dobby"), ("MQL5", "Presets"), ("bases", "Broker-Live", "history", "XAUUSD"),
                ("bases", "Broker-Live", "ticks", "XAUUSDm"), ("bases", "Broker-Live", "history", "EURUSD"),
                ("bases", "Default", "history", "XAUEUR")):
        os.makedirs(os.path.join(data, *sub), exist_ok=True)
    with open(os.path.join(data, "origin.txt"), "wb") as f:
        f.write(b"\xff\xfe" + install.encode("utf-16-le"))
    if ea:
        open(os.path.join(data, "MQL5", "Experts", "Dobby", "Dobby3_v304.ex5"), "wb").write(b"ex5")
    if preset:
        core.install_web_preset(data)
    for profile, name, symbol, experts, ind in charts:
        core.write_chart(data, profile, name, symbol, experts, ind)
    common = str(tmp_path / "common")
    os.makedirs(common)
    return data, install, common


def _codes(chk):
    return [p["code"] for p in chk["problems"]]


def test_startup_ini_text():
    assert core.startup_ini_text("Dobby\\Dobby3_v304", "Dobby3_v304_web.set", "XAUUSD") == (
        "[StartUp]\r\nExpert=Dobby\\Dobby3_v304\r\nExpertParameters=Dobby3_v304_web.set\r\nSymbol=XAUUSD\r\n"
        "Period=M15\r\n[Experts]\r\nEnabled=1\r\nAllowLiveTrading=1\r\n")
    assert core.startup_ini_bytes("a\r\n") == b"\xff\xfea\x00\r\x00\n\x00"


def test_autostart_ok_writes_the_ini_and_calls_the_fake_launcher(tmp_path):
    data, install, common = _mt5(tmp_path, charts=[("Default", "chart01.chr", "EURUSD",
                                                    [("MACD Sample", "Experts\\MACD Sample.ex5")], "Dobby3_View")])
    chk = core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", procs=[])
    assert chk["ok"] and chk["problems"] == [] and chk["charts"] == []         # an indicator / other EA is fine
    assert chk["exe"] == os.path.join(install, "terminal64.exe") and chk["install_dir"] == install
    assert chk["expert"] == "Dobby\\Dobby3_v304"                             # the ex5 that is installed...
    assert chk["ini"] == core.startup_ini_text("Dobby\\Dobby3_v304", "Dobby3_v305_web.set", "XAUUSD")   # ...our preset
    calls = []
    ctx = core.AppContext(str(tmp_path / "app"), environ={"APPDATA": str(tmp_path / "appdata")},
                          launcher=lambda cmd, cwd: calls.append((cmd, cwd)) or 777, processes=[])
    ok, info = core.start_mt5(ctx, chk)
    ini = os.path.join(str(tmp_path / "app"), core.STARTUP_INI_NAME)
    assert ok and info["pid"] == 777 and info["ini"] == ini
    assert calls == [('"%s" /config:"%s"' % (chk["exe"], ini), install)]
    raw = open(ini, "rb").read()
    assert raw[:2] == b"\xff\xfe" and raw[2:].decode("utf-16-le") == chk["ini"]
    assert ctx.launched == calls


def test_autostart_refusals(tmp_path):
    data, install, common = _mt5(tmp_path)
    exe = os.path.join(install, "terminal64.exe")
    # this MT5 is running
    chk = core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", procs=[{"pid": 1, "path": exe.upper()}])
    assert not chk["ok"] and _codes(chk) == ["mt5_running"]
    # a terminal64.exe whose path Windows hides: assume it is this one
    assert _codes(core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", [{"pid": 2, "path": ""}])) == [
        "mt5_running"]
    # another MT5 installation running is fine; an unknown process list is not
    assert core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD",
                                [{"pid": 3, "path": r"C:\Other MT5\terminal64.exe"}])["ok"]
    assert _codes(core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", None)) == ["mt5_unknown"]
    # a Dobby EA already on a chart of any profile (two Dobby EAs on one account would double-trade)
    core.write_chart(data, "Euro", "chart03.chr", "XAUUSD", experts=[("Dobby3_v303", "Experts\\Dobby\\Dobby3_v303.ex5")])
    chk = core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", [])
    assert _codes(chk) == ["dobby_attached"] and chk["charts"][0]["profile"] == "Euro"
    assert "XAUUSD" in chk["problems"][0]["text"] and "chart03.chr" in chk["problems"][0]["text"]
    chk = core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", [{"pid": 1, "path": exe}])
    assert _codes(chk) == ["dobby_attached", "mt5_running"]                  # the most useful reason first
    os.remove(os.path.join(data, "MQL5", "Profiles", "Charts", "Euro", "chart03.chr"))
    # a Dobby EA of another MT5 writes a fresh heartbeat into the shared EA folder
    da.write_json_atomic(os.path.join(common, da.STATUS_NAME), {"heartbeat_gmt_unix": 1000})
    assert _codes(core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", [], now=1030)) == ["dobby_running"]
    assert core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", [], now=1000 + 600)["ok"]
    # nothing to start / files missing / bad symbol
    assert _codes(core.autostart_check(data, "", common, "XAUUSD", [], now=5000)) == ["no_ea"]
    assert _codes(core.autostart_check(data, "Dobby3_v304.ex5", common, "XAU USD", [], now=5000)) == ["bad_symbol"]
    assert _codes(core.autostart_check("", "Dobby3_v304.ex5", common, "XAUUSD", [], now=5000)) == ["no_mt5"]
    os.remove(core.preset_target(data))
    assert _codes(core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", [], now=5000)) == ["no_preset"]
    os.remove(exe)
    assert "no_terminal" in _codes(core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD", [], now=5000))


def test_refused_check_never_launches(tmp_path):
    data, install, common = _mt5(tmp_path)
    calls = []
    ctx = core.AppContext(str(tmp_path / "app"), launcher=lambda c, d: calls.append(c), processes=[])
    chk = core.autostart_check(data, "Dobby3_v304.ex5", common, "XAUUSD",
                               [{"pid": 1, "path": os.path.join(install, "terminal64.exe")}])
    ok, probs = core.start_mt5(ctx, chk)
    assert not ok and probs[0]["code"] == "mt5_running" and calls == []
    assert not os.path.exists(os.path.join(str(tmp_path / "app"), core.STARTUP_INI_NAME))


def test_demo_context_never_reaches_the_real_launcher(tmp_path):
    ctx = core.AppContext(str(tmp_path / "app"), demo=True)
    assert ctx.launch('"x" /config:"y"', None) is None and ctx.launched == [('"x" /config:"y"', None)]
    assert ctx.terminal_processes() == []
    real = core.AppContext(str(tmp_path / "app2"))
    with pytest.raises(AssertionError):                        # conftest: a real start would fail the test
        real.launch('"x"', None)


def test_chart_scan_symbols_and_processes(tmp_path):
    data, install, common = _mt5(tmp_path, charts=[
        ("Default", "chart01.chr", "XAUUSD", [("Dobby3_v304", "Experts\\Dobby\\Dobby3_v304.ex5")], None),
        ("Default", "chart02.chr", "EURUSD", [], "Dobby3_View")])
    ex = core.chart_experts(data)
    assert [(e["file"], e["symbol"], e["name"]) for e in ex] == [("chart01.chr", "XAUUSD", "Dobby3_v304")]
    assert core.dobby_charts(data) == ex
    p = os.path.join(data, "MQL5", "Profiles", "Charts", "Default", "chart03.chr")
    with open(p, "w", encoding="utf-8") as f:                  # an ANSI file, an unterminated block
        f.write("<chart>\nsymbol=GOLD\n<expert>\nname=dobby copy\npath=Experts\\Dobby\\x.ex5\n")
    assert [e["symbol"] for e in core.dobby_charts(data)] == ["XAUUSD", "GOLD"]
    assert core.broker_symbols(data) == ["XAUUSD", "XAUUSDm"]   # broker servers only (Default skipped), XAUUSD first
    assert core.valid_symbol("XAUUSD.s") and not core.valid_symbol("XAU USD") and not core.valid_symbol("")
    exe = os.path.join(install, "terminal64.exe")
    assert core.terminal_running(install, [{"path": exe}]) is True
    assert core.terminal_running(install, [{"path": r"C:\x\terminal64.exe"}]) is False
    assert core.terminal_running(install, []) is False and core.terminal_running(install, None) is None
    assert core.mt5_install_dir(data) == install
    portable = str(tmp_path / "portable")
    os.makedirs(os.path.join(portable, "MQL5"))
    open(os.path.join(portable, "terminal64.exe"), "wb").close()
    assert core.mt5_install_dir(portable) == portable


def test_remote_live_now(tmp_path):
    common = str(tmp_path)
    assert core.remote_live_now(common) is False
    with open(os.path.join(common, da.REMOTE_NAME), "w") as f:
        f.write("# x\r\nversion=3\r\nlive=1\r\n")
    assert core.remote_live_now(common) is True


# ---------------------------------------------------------------------------------------------------------------------
# Linking an existing bot vs creating a new one
# ---------------------------------------------------------------------------------------------------------------------
def test_demo_server_users_bots_and_controls():
    srv = core.DemoServer()
    calls = []

    class Rec(object):
        def request(self, method, url, **kw):
            calls.append((method, url, kw.get("params")))
            return srv.request(method, url, **kw)
    c = core.AppClient(core.DEFAULT_URL, core.DEFAULT_KEY, Rec())
    core.sign_in(c, "owner@example.com", "pw")
    bots = c.bots_with_controls()
    ctl = [x for x in calls if x[1].endswith("/rest/v1/bot_control")]
    assert len(ctl) == 1 and ctl[0][0] == "GET" and ctl[0][2] == {
        "select": "bot_id,version,desired", "bot_id": "in.(%s,%s)" % (bots[0]["id"], bots[1]["id"])}
    assert [b["name"] for b in bots] == ["คอมหลัก", "DESKTOP-NPNL85P"]
    assert bots[0]["control"]["desired"]["control"]["lots"] == 0.10 and bots[0]["control"]["version"] == 12
    assert core.bot_online(bots[0], core.time.time()) and not core.bot_online(bots[1], core.time.time())
    assert core.bot_max_lot(bots[0]["control"]["desired"]) == 0.10 and core.bot_max_lot({}) is None
    assert core.default_bot_name(bots) == "Dobby"
    assert core.default_bot_name([{"name": "Dobby"}, {"name": "dobby 2"}]) == "Dobby 3"
    c2 = core.AppClient(core.DEFAULT_URL, core.DEFAULT_KEY, srv)
    core.sign_in(c2, "new.friend@example.com", "pw")
    assert c2.list_bots() == [] and c2.bot_controls([]) == {}


def test_create_bot_with_the_chosen_settings(tmp_path):
    srv = core.DemoServer()
    client = core.AppClient(core.DEFAULT_URL, core.DEFAULT_KEY, srv)
    core.sign_in(client, "friend@example.com", "pw")
    data, common = str(tmp_path / "app"), str(tmp_path / "common")
    os.makedirs(common)
    with open(os.path.join(common, da.CONTROL_NAME), "w") as f:        # a control file left by someone else
        f.write("mode=pause\r\nid=C009\r\n")
    params = core.settings_to_params(core.auto_settings(300))
    limits = core.recommended_limits(0.03)
    bot_id = core.create_bot(client, data, common, "  Dobby   ของฉัน ", params, limits, clock=lambda: 1794000000.0)
    assert len(srv.registered) == 1
    assert srv.registered[0] == {"p_name": "Dobby ของฉัน", "p_desired": {
        "live": True, "control": {"mode": "run", "allow_long": True, "allow_short": True}, "blackouts": [],
        "params": params}}
    cfg = core.load_app_config(data)
    assert cfg["bot_id"] == bot_id and cfg["bot_name"] == "Dobby ของฉัน" and cfg["limits"] == limits
    assert cfg["app"]["wizard_done"] is True and cfg["app"]["bot_kind"] == "dobby"
    st = da.load_state(core.state_path(data))
    assert st["applied_version"] == 0                                   # v1 (the settings) is applied at Start
    assert st["control"]["adopted_mtime"] == os.stat(os.path.join(common, da.CONTROL_NAME)).st_mtime
    with pytest.raises(ValueError):
        core.create_bot(client, data, common, "   ", params, limits)
    assert len(srv.registered) == 1


def test_created_bot_reaches_the_ea_files_after_start(tmp_path):
    """create_bot -> the agent's first cycle writes mode=run and live=1 + every setting into dobby3_remote.txt."""
    e = Env(tmp_path, desired={}, version=1)
    params = core.settings_to_params(core.auto_settings(300))
    rec = {}

    class Rpc(object):
        def rpc(self, fn, args):
            rec.update(args)
            return BOT
    core.create_bot(Rpc(), e.agent_dir, e.common, "Dobby", params, core.recommended_limits(0.03), clock=e.clock)
    e.fake.control = {"version": 1, "desired": rec["p_desired"], "updated_at": "2026-11-09T00:00:00Z"}
    da.update_config(e.cfg_path, lambda c: c.update(common_dir=e.common))
    a = e.agent()
    a.cycle()
    ctl = e.read(da.CONTROL_NAME).decode()
    rem = e.read(da.REMOTE_NAME).decode()
    assert "mode=run" in ctl and "id=W001" in ctl
    assert "live=1" in rem and "InpLotsA=0.03" in rem and "InpLock1Enable=true" in rem and "InpVirtualStart=300.0" in rem
    assert a.rejected == [] and a.state["applied_version"] == 1


def test_link_existing_bot_does_not_create_or_change_it(tmp_path):
    srv = core.DemoServer()
    client = core.AppClient(core.DEFAULT_URL, core.DEFAULT_KEY, srv)
    core.sign_in(client, "owner@example.com", "pw")
    bot = client.bots_with_controls()[0]
    before = json.dumps(srv.control[bot["id"]], sort_keys=True)
    data, common = str(tmp_path / "app"), str(tmp_path / "common")
    core.link_bot(data, common, bot, core.recommended_limits(core.bot_max_lot(bot["control"]["desired"])))
    cfg = core.load_app_config(data)
    assert srv.registered == [] and json.dumps(srv.control[bot["id"]], sort_keys=True) == before
    assert cfg["bot_id"] == bot["id"] and cfg["bot_name"] == "คอมหลัก" and cfg["app"]["wizard_done"]
    assert da.get_limits(cfg)["max_lots"] == 0.20
    assert da.load_state(core.state_path(data))["applied_version"] == 0   # the web state applies at Start


# ---------------------------------------------------------------------------------------------------------------------
# Main screen: hero state, activity
# ---------------------------------------------------------------------------------------------------------------------
def _st(now, **over):
    with open(os.path.join(os.path.dirname(__file__), "fixtures", "dobby2_status.json"), encoding="utf-8") as f:
        st = json.load(f)
    st["heartbeat_gmt_unix"] = int(now) - 3
    st.update(over)
    return st


CFG = {"supabase_url": "https://x.supabase.co", "anon_key": "k", "refresh_token": "rt", "bot_id": BOT,
       "bot_name": "Main PC", "limits": {}, "app": {}}


def test_hero_states():
    now = 1794002099.0
    st = _st(now)
    snap = {"last_error": "", "rejected": [], "last_ok_at": now - 4}
    h = core.hero_state
    assert h({}, None, None, now, False)["action"] == "wizard"
    assert h({"refresh_token": "x"}, None, None, now, False)["title"] == "ยังตั้งค่าไม่เสร็จ"
    s = h(CFG, st, None, now, False)
    assert (s["tone"], s["title"], s["action"]) == ("idle", "Dobby หยุดอยู่", None)
    assert h(CFG, None, None, now, False)["action"] == "mt5"                  # stopped and no Dobby in MT5
    s = h(CFG, st, snap, now, True, started_at=now - 7200)
    assert (s["tone"], s["title"]) == ("good", "Dobby กำลังเทรดจริง") and "2 ชม." in s["text"]
    assert h(CFG, _st(now, account=dict(st["account"], mode="DEMO")), snap, now, True)["title"] == \
        "Dobby กำลังเทรด (บัญชีทดลอง)"
    old = _st(now)
    old["heartbeat_gmt_unix"] = int(now) - 900
    s = h(CFG, old, snap, now, True)
    assert (s["tone"], s["title"], s["action"]) == ("warn", "รอ MT5", "mt5") and "15 นาที" in s["text"]
    assert h(CFG, None, snap, now, True)["action"] == "mt5"
    s = h(CFG, _st(now, account=dict(st["account"], trade_permitted=False)), snap, now, True)
    assert s["action"] == "algo_help" and "Algo Trading" in s["text"]
    assert h(CFG, _st(now, flags={"live_locked": True}, remote={"live_enabled": True}), snap, now, True)[
        "title"] == "Dobby ยังไม่เปิดเทรดจริง"
    assert h(CFG, _st(now, control=dict(st["control"], mode="pause")), snap, now, True)["title"] == "Dobby หยุดชั่วคราว"
    assert h(CFG, _st(now, virtual=dict(st["virtual"], day_cap_hit=True)), snap, now, True)["title"] == \
        "วันนี้หยุดเทรดแล้ว"
    assert h(CFG, st, dict(snap, last_error="network: down"), now, True)["title"] == "เชื่อมต่อเว็บไม่ได้"
    assert h(CFG, st, dict(snap, last_error="login: Invalid Refresh Token"), now, True)["action"] == "signin"
    assert h(CFG, st, dict(snap, rejected=["live_not_allowed_locally"]), now, True)["action"] == "safety"
    s = h(CFG, st, None, now, False, lock_problem={"holder": {"program": "dobby_agent.py run", "pid": 5}})
    assert s["tone"] == "bad" and "dobby_agent.py run" in s["text"] and s["action"] == "start"
    assert h(CFG, st, snap, now, True, stopping=True)["title"] == "กำลังหยุด…"


def test_activity_in_plain_thai(tmp_path):
    p = str(tmp_path / "j.csv")
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(da.JOURNAL_HEADER + "\r\n")
        f.write("2026.11.09 09:45:00,OPEN,C5G,BUY,0.03,2512.30,2505.90,2521.90,0.00,312.40,0,demo\r\n")
        f.write("2026.11.09 10:15:00,CLOSE,C5G,BUY,0.03,2521.90,,,28.80,341.20,0,reason=tp\r\n")
        f.write("2026.11.09 10:16:00,REMOTE,ALL,NONE,0,,,,0,341.2,0,APPLY v3: InpLotsA 0.03->0.04\r\n")
        f.write("2026.11.09 10:17:00,BARS,ALL,NONE,0,,,,0,341.2,0,nothing to show\r\n")
    rows = core.journal_tail(p, 10)
    assert [r["event"] for r in rows] == ["OPEN", "CLOSE", "REMOTE", "BARS"]
    texts = [core.journal_activity(r) for r in rows]
    assert texts[0] == ("info", "เปิดไม้ C5G ซื้อ 0.03 ล็อต ที่ราคา 2512.30")
    assert texts[1] == ("good", "ปิดไม้ C5G กำไร +28.80")
    assert texts[2] == ("good", "Dobby ใช้การตั้งค่าใหม่จากเว็บแล้ว") and texts[3] is None
    assert core.journal_tail(str(tmp_path / "missing.csv")) == []
    assert core.app_activity("decision: v7 applied | live=on mode=run") == ("good", "รับคำสั่งจากเว็บแล้ว (เทรดจริงเปิด)")
    assert core.app_activity("bot \"คอมหลัก\" created on the website (live on, 29 settings)") == (
        "good", "สร้างบอท \"คอมหลัก\" บนเว็บแล้ว")
    assert core.app_activity("wrote dobby2_control.txt") is None
    assert core.friendly_log("EA install: Dobby3_v304.ex5 -> C:\\x (same)") == "Dobby3_v304.ex5 มีอยู่แล้วใน MT5 (ไฟล์เดียวกัน)"


def test_status_watcher_posts_the_journal_tail(tmp_path):
    common = str(tmp_path)
    with open(os.path.join(common, da.JOURNAL_NAME), "w", encoding="utf-8", newline="") as f:
        f.write(da.JOURNAL_HEADER + "\r\n2026.11.09 09:45:00,OPEN,C5G,BUY,0.03,2512.30,2505.90,2521.90,0,1,0,x\r\n")
    got = []
    w = core.StatusWatcher(lambda: common, got.append, every=0.05)
    w.start()
    try:
        deadline = core.time.time() + 5
        while core.time.time() < deadline and not any(g[0] == "journal" for g in got):
            core.time.sleep(0.02)
    finally:
        w.stop()
    j = [g for g in got if g[0] == "journal"]
    assert j and j[0][1][0]["event"] == "OPEN"
    assert len(j) == 1                                    # posted again only when the file changes


def test_gfx_images():
    for which in ("tl", "tr", "bl", "br"):
        png = gfx.corner_png(12, "#FFFFFF", "#E2E7EE", 1, which)
        assert png.startswith(b"\x89PNG") and png[16:24] == (12).to_bytes(4, "big") * 2
    for kind in ("ok", "bad", "warn", "idle", "info", "play", "stop", "pause", "dot"):
        assert gfx.mark_png(20, kind, "#1FA155").startswith(b"\x89PNG")
    assert gfx.pill_png(44, 24, "#2F5BEA").startswith(b"\x89PNG") and gfx.knob_png(18).startswith(b"\x89PNG")
    img = gfx.Raster(8, 8).draw(gfx.sd_circle(4, 4, 3), "#FF0000")
    rgba = img.rgba()
    assert rgba[(4 * 8 + 4) * 4:(4 * 8 + 4) * 4 + 4] == bytes((255, 0, 0, 255)) and rgba[3] == 0


def test_demo_mode_fake_launcher_starts_a_fake_dobby(tmp_path):
    """--demo: "open MT5" never starts anything real; a fake Dobby starts writing its status a moment later."""
    import dobby_app as app
    ctx, server, state, fake = app.demo_context(str(tmp_path), latency=0.0, external=False)
    assert ctx.demo and ctx.terminal_processes() == [] and fake.startswith(str(tmp_path))
    common = ctx.common_dir(core.load_app_config(ctx.data_dir))
    assert common.startswith(str(tmp_path))
    ctx.launch('"x\terminal64.exe" /config:"y.ini"', None)
    try:
        deadline = core.time.time() + 8
        while core.time.time() < deadline and da.read_status_file(os.path.join(common, da.STATUS_NAME),
                                                                   attempts=1) is None:
            core.time.sleep(0.1)
        st = da.read_status_file(os.path.join(common, da.STATUS_NAME), attempts=1)
        assert st and st["ea_version"] == "3.05" and st["schema_version"] == 6
        assert st["remote"]["effective"]["InpLotsA"] == 0.03 and st["remote"]["effective"]["InpRunnerEnable"] is False
        assert st["params"]["runner"]["keep_pct"] == 75.0 and st["virtual"]["cap_reset_applied"] == 0
    finally:
        if state["ea"]:
            state["ea"].stop()
    terms = core.detect_terminals(ctx.appdata)
    assert len(terms) == 2 and all(t["install_dir"].startswith(str(tmp_path)) for t in terms)
    assert core.dobby_charts(terms[1]["data_dir"]) and not core.dobby_charts(terms[0]["data_dir"])


# ---------------------------------------------------------------------------------------------------------------------
# "Hallmark" look (docs/DESIGN.md): bundled OFL fonts, the stamp, the price line from the EA's bar file, sentences
# ---------------------------------------------------------------------------------------------------------------------
def test_fonts_are_bundled_with_their_licences():
    import dobby_app_ui as ui
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assert ui.font_dir() == os.path.join(here, "fonts")
    for sub, name in ui.FONT_FILES:
        path = os.path.join(here, "fonts", sub, name)
        assert open(path, "rb").read(4) == b"\x00\x01\x00\x00", name           # TrueType
    for sub in ("anuphan", "chakrapetch"):
        assert "SIL Open Font License" in open(os.path.join(here, "fonts", sub, "OFL.txt"), encoding="utf-8").read()


def test_hallmark_and_price_line_images():
    for tone, ink in (("gold", None), ("slate", "#5E676D"), ("cinnabar", "#B83A2A")):
        png = gfx.stamp_png(60, tone, ink)
        assert png.startswith(b"\x89PNG") and png[16:24] == (60).to_bytes(4, "big") * 2
    oc = gfx.sd_octagon(50, 50, 100, 10)
    assert oc(50, 50) < 0 and oc(50, 1) < 0 and oc(50, -2) > 0 and oc(2, 2) > 0          # flat sides, cut corners
    assert gfx.brand_png(26).startswith(b"\x89PNG") and gfx.tick_png(12, "#1E7656").startswith(b"\x89PNG")
    line = gfx.polyline_png(40, 20, [(2, 18), (20, 2), (38, 10)], 1.7, "#20262A")
    assert line.startswith(b"\x89PNG") and line[16:24] == (40).to_bytes(4, "big") + (20).to_bytes(4, "big")
    for which in ("tl", "tr", "bl", "br"):
        assert gfx.shadow_corner_png(10, 12, 5.0, 0.15, which, "#28241A", "#F1F2EE").startswith(b"\x89PNG")
    assert gfx.mix("#000000", "#FFFFFF", 0.5) == "#808080"
    assert gfx.tri_png(12, True, "#1E7656").startswith(b"\x89PNG") and gfx.diamond_png(12, "#85621A").startswith(
        b"\x89PNG")


def test_settings_as_a_sentence_and_chips():
    s = core.auto_settings(300)
    t = core.settings_sentence(s)
    assert t == ("เปิด 3 สูตร (A_new, NY, C5G) ล็อต 0.03 ทุกสูตร จากทุน 300 USD ล็อกกำไร 2 ชั้น (85→83 และ 95→93) "
                 "ปิดสูตรเอเชีย และหยุดเปิดไม้เมื่อขาดทุนถึง 10% ต่อวัน")
    assert "·" not in t and [c for c, _ in core.settings_chips(s)] == ["3 สูตร", "ล็อต 0.03", "ล็อก 2 ชั้น", "เอเชียปิด",
                                                                     "หยุดที่ 10%/วัน"]
    s.update(lock_stages=0, use_asia=True, lot_mode="each", lot_a=0.05, lot_ny=0.02, lot_c5g=0.04)
    t = core.settings_sentence(s)
    assert "ไม่ล็อกกำไร" in t and "เปิดสูตรเอเชีย" in t and "A 0.05, NY 0.02, C5G 0.04" in t


def test_hero_stamp_follows_the_state():
    now = 1794002099.0
    st = _st(now)
    snap = {"last_error": "", "rejected": [], "last_ok_at": now - 4}
    h = core.hero_state
    assert h(CFG, st, snap, now, True)["stamp"] == ("gold", "เทรดจริง")
    assert h(CFG, st, None, now, False)["stamp"] == ("slate", "หยุดอยู่")
    old = _st(now)
    old["heartbeat_gmt_unix"] = int(now) - 900
    assert h(CFG, old, snap, now, True)["stamp"] == ("cinnabar", "รอ MT5")
    assert h(CFG, st, dict(snap, last_error="network: down"), now, True)["stamp"][0] == "cinnabar"
    assert h(CFG, _st(now, control=dict(st["control"], mode="pause")), snap, now, True)["stamp"][0] == "slate"
    assert "·" not in h(CFG, st, snap, now, True, started_at=now - 60)["text"]


def test_price_line_bars_from_the_ea_file_read_only(tmp_path):
    ea = core.DemoEA(str(tmp_path))                     # the fake EA writes its bar file into the TEMP common folder
    ea.write()
    path = str(tmp_path / da.BARS_NAME)
    text = core.read_bars_tail(path)
    bars, off = core.bars_for_chart(text, 120)
    assert off == 120 and len(bars["c"]) == 96 and bars["c"][-1] == 4015.98 and bars["vwap"][-1]
    assert bars["t"][-1] - bars["t"][0] == 95 * 900
    plain, off = core.bars_for_chart(text, None)        # no server offset: same line, no time axis
    assert off is None and plain["c"] == bars["c"] and plain["t"][0] - bars["t"][0] == 120 * 60
    tail = core.read_bars_tail(path, max_bytes=2000)    # a tail that starts mid-row still parses
    assert core.bars_for_chart(tail, 120)[0]["c"][-1] == 4015.98
    assert core.read_bars_tail(str(tmp_path / "missing.csv")) is None and core.bars_for_chart(None, 120) == (None,
                                                                                                          None)


def test_status_watcher_posts_the_bars_when_they_change(tmp_path):
    common = str(tmp_path)
    core.DemoEA(common).write()
    got = []
    w = core.StatusWatcher(lambda: common, got.append, every=0.05)
    w.start()
    try:
        deadline = core.time.time() + 5
        while core.time.time() < deadline and not any(g[0] == "bars" for g in got):
            core.time.sleep(0.02)
        core.time.sleep(0.3)
    finally:
        w.stop()
    b = [g for g in got if g[0] == "bars"]
    assert len(b) == 1 and "bar_time" in b[0][1]
