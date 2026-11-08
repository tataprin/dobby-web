# -*- coding: utf-8 -*-
"""Dobby App - connects this PC's MT5 + Dobby EA to the Dobby website, without Python or a terminal.

Double-click DobbyApp.exe -> 7 friendly Thai steps (ยินดีต้อนรับ, เข้าสู่ระบบ, เลือกบอท, ตั้งค่าบอท, เชื่อม MT5,
ความปลอดภัย, เสร็จแล้ว) -> press "เริ่มทำงาน Dobby" -> done.

  DobbyApp.exe                                   normal start (data in %APPDATA%\\DobbyApp)
  DobbyApp.exe --autostart                       started by Windows: minimized, presses Start if the setup is complete
  DobbyApp.exe --demo                            the whole UI against fake data (no network, temp folders, fake MT5)
  DobbyApp.exe --selftest out.png --data-dir D   builds every screen and state with fake data, saves screenshots
  python dobby_app.py --make-icon dobby.ico      writes the app icon (build step)

The agent loop is dobby_agent.Agent (same rules as the CLI: SPEC section 3). It runs in a background thread only after
Start, behind the EA-folder lock (one agent per MT5), and stops writing the EA files the moment Stop is pressed.
The app starts MT5 only when the user presses "เปิด MT5 พร้อม Dobby" and confirms, only when that MT5 is closed and
no chart of it already runs Dobby (dobby_app_core.autostart_check); --demo / --selftest use a fake launcher.
"""
import argparse
import base64
import collections
import logging
import os
import queue
import sys
import tempfile
import threading
import time
import traceback

import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, ttk

import dobby_agent as da
import dobby_app_core as core
import dobby_app_ui as ui_kit
from dobby_app_core import APP_NAME, APP_VERSION, WEB_URL, LOG
from dobby_app_ui import (C, F, FONTS, GLYPH, ICON_FONT, MAX_RUN_BYTES, THAI_MARKS, TONE_DOT, TONE_INK,  # noqa: F401
                          TONE_LINE, TONE_SOFT, Banner, Bar, Box, BrandMark, Btn, Centered, Chip, ChoiceDialog,
                          Expander, Field, Hallmark, IconBadge, L, Ladder, Link, Mark, NumBadge, PriceLine, Row,
                          ScrollFrame, Segmented, StepBar, Stepper, Toggle, _bg, badge, bind_tree, bullet_list, col,
                          frame, glyph, group, hair_for, hline, load_private_fonts, log_wrap, manual_steps, num_text,
                          px, round_box, section, setup_theme, shadow_margins, wrap_text)

WIZ_STEPS = ["ยินดีต้อนรับ", "เข้าสู่ระบบ", "เลือกบอท", "ตั้งค่าบอท", "เชื่อม MT5", "ความปลอดภัย", "เสร็จแล้ว"]
STEP_WELCOME, STEP_SIGNIN, STEP_BOT, STEP_SETTINGS, STEP_MT5, STEP_SAFETY, STEP_FINISH = range(7)


def new_wizard_state():
    return {"choice": None, "bot": None, "bots": None, "kind": "dobby", "settings": None, "custom": False,
            "limits": None, "limits_custom": False, "name": "", "mt5_result": None, "done": False}


# ---------------------------------------------------------------------------------------------------------------------
# Screens: common parts
# ---------------------------------------------------------------------------------------------------------------------
class Screen(tk.Frame):
    def __init__(self, ui):
        tk.Frame.__init__(self, ui.container, bg=C["bg"], bd=0, highlightthickness=0)
        self.ui = ui

    def on_show(self, **kw):
        pass

    def refresh(self):
        pass


def app_header(screen, title=None, back=None):
    """The top bar on porcelain: [กลับ] brand mark Dobby | title ............ right side (returned frame)."""
    bar = frame(screen, bg="bg")
    bar.pack(fill="x")
    inner = frame(bar)
    inner.pack(fill="x", padx=px(20), pady=px(10))
    if back:
        Btn(inner, "กลับ", back, style="quiet", size="sm", icon="chev_l").pack(side="left", padx=(0, px(16)))
    BrandMark(inner, 26).pack(side="left")
    L(inner, "Dobby", font="brand").pack(side="left", padx=(px(10), 0))
    if title:
        frame(inner, bg="hair2", width=1, height=px(18)).pack(side="left", padx=px(14))
        L(inner, title, font="base", fg="slate").pack(side="left")
    right = frame(inner)
    right.pack(side="right")
    frame(screen, bg="hair", height=1).pack(fill="x")
    return inner, right


# ---------------------------------------------------------------------------------------------------------------------
# Bot settings editor (wizard step 4): balance + "ตั้งให้อัตโนมัติ", the result as a sentence and a few chips, "ปรับเอง"
# ---------------------------------------------------------------------------------------------------------------------
class SettingsEditor(tk.Frame):
    def __init__(self, parent, ui, on_change=None):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.ui, self.on_change = ui, on_change
        self.s = core.auto_settings(None)
        self.applied = False
        self._loading = False
        self.steppers, self.err_l, self.stage_notes = {}, {}, {}
        # 1. the balance
        c1 = self.c1 = frame(self)
        c1.pack(fill="x")
        section(c1, "เงินในบัญชีเทรด", "แอปเลือกล็อตให้พอดีกับเงิน (ทุก 100 USD = 0.01 ล็อต) และใช้ยอดนี้เป็นทุนตั้งต้นของ Dobby")
        row = frame(c1)
        row.pack(fill="x", pady=(px(14), 0))
        self.bal = Field(row, width=8, font="numM", suffix="USD", pady=4, padx=14)
        self.bal.pack(side="left")
        self.auto_btn = Btn(row, "ตั้งให้อัตโนมัติ", self.do_auto, size="lg")
        self.auto_btn.pack(side="left", padx=(px(12), 0), anchor="center")
        self.bal_err = L(c1, "", font="sbold", fg="cinnabar")
        self.bal_hint = L(c1, "", font="small", fg="slate", wrap=True)
        self.bal_hint.pack(fill="x", pady=(px(8), 0))
        self.bal.entry.bind("<Return>", lambda e: self.do_auto())
        self.bal.var.trace_add("write", lambda *a: self._balance_typed())
        # 2. the result: one sentence, a few chips, the risk note
        self.result = frame(self)
        rb = self.result
        frame(rb, bg="hair", height=1).pack(fill="x", pady=(0, px(18)))
        L(rb, "Dobby จะใช้ค่านี้", font="h3").pack(fill="x")
        self.res_text = L(rb, "", font="lead", fg="ink", wrap=True)
        self.res_text.pack(fill="x", pady=(px(6), 0))
        self.tiles = frame(rb)
        self.tiles.pack(fill="x", pady=(px(12), 0))
        self.risk = Box(rb, fill="well", border=None, radius=14, padx=16, pady=14)
        self.risk.pack(fill="x", pady=(px(18), 0))
        top = frame(self.risk.body)
        top.pack(fill="x")
        glyph(top, "pulse", "icon", fg="gold_ink").pack(side="left", anchor="n", padx=(0, px(10)), pady=(px(3), 0))
        self.risk_txt = L(top, "", font="med", fg="ink", wrap=True)
        self.risk_txt.pack(side="left", fill="x", expand=True)
        self.risk_more = Expander(self.risk.body, "ดูรายละเอียด")
        self.risk_more.pack(fill="x", pady=(px(8), 0), padx=(px(26), 0))
        self.risk_lines = frame(self.risk_more.body)
        self.risk_lines.pack(fill="x")
        L(self.risk.body, core.RISK_DISCLAIMER, font="small", fg="slate", wrap=True).pack(
            fill="x", pady=(px(8), 0), padx=(px(26), 0))
        # 3. "ปรับเอง"
        self.custom = tk.BooleanVar(value=False)
        self.crow = Row(self, "ปรับเอง", "ไม่ต้องแก้ก็ได้ ค่าอัตโนมัติด้านบนใช้ได้ทันที เปิดเพื่อเลือกสูตร ล็อต ชั้นล็อกกำไร และจุดหยุด"
                                       "ขาดทุนเอง", pady=16)
        Toggle(self.crow.ctl, self.custom, command=self._custom_changed).pack()
        # 4. the custom panel
        self.cp = frame(self)
        self._build_custom(self.cp)

    # -- custom panel
    def _err_label(self, parent, key, after):
        lbl = L(parent, "", font="sbold", fg="cinnabar", wrap=True)
        self.err_l[key] = (lbl, after)

    def _num_row(self, parent, key, label, lo, hi, step, fmt, suffix=None, sub=None, rule=True, font="bold"):
        r = Row(parent, label, sub, rule=rule, font=font)
        r.pack(fill="x")
        st = Stepper(r.ctl, None, lo, hi, step, fmt, on_change=lambda v, k=key: self._set(k, v), suffix=suffix)
        st.pack()
        self.steppers[key] = st
        self._err_label(r.text, key, r.sub or r.title)
        return r

    def _head(self, parent, title, why):
        """A group heading with its control on the right (segmented choices)."""
        r = Row(parent, title, why, rule=False, pady=0, font="h3")
        r.pack(fill="x")
        return r.ctl

    def _build_custom(self, p):
        # strategies
        g = group(p, "สูตรที่ใช้", "แต่ละสูตรหาจังหวะเข้าคนละแบบ เปิดหลายสูตรแล้วบอทจะเทรดบ่อยขึ้น")
        self.use_vars = {}
        last = None
        for i, key in enumerate(("a", "ny", "c5g", "asia")):
            name, desc = core.STRATEGY_TH[key]
            r = Row(g, name, desc, rule=i > 0)
            r.pack(fill="x", pady=(px(6) if i == 0 else 0, 0))
            v = tk.BooleanVar(value=bool(self.s["use_" + key]))
            Toggle(r.ctl, v, command=lambda k=key, v=v: self._set("use_" + k, bool(v.get()))).pack()
            self.use_vars[key] = v
            last = r
        self._err_label(g, "strategies", last)
        # lots
        g = group(p)
        self.lot_mode = tk.StringVar(value="same")
        Segmented(self._head(g, "ล็อต", "ล็อตใหญ่ได้และเสียต่อไม้มากขึ้นเท่ากัน 0.01 ล็อตเท่ากับราว 1 USD ต่อทองขยับ 1 ดอลลาร์"),
                  [("same", "เท่ากันทุกสูตร"), ("each", "แยกแต่ละสูตร")], self.lot_mode, command=self._lot_mode).pack()
        self.lot_rows = frame(g)
        self.lot_rows.pack(fill="x", pady=(px(10), 0))
        self.same_box = frame(self.lot_rows)
        self._num_row(self.same_box, "lot", "ล็อตทุกสูตร", core.LOT_MIN, core.LOT_MAX, 0.01, "%.2f")
        self.each_box = frame(self.lot_rows)
        for key, name in (("lot_a", "A_new"), ("lot_ny", "NY"), ("lot_c5g", "C5G")):
            self._num_row(self.each_box, key, "ล็อต " + name, core.LOT_MIN, core.LOT_MAX, 0.01, "%.2f")
        self.asia_box = frame(self.lot_rows)
        self._num_row(self.asia_box, "lot_asia", "ล็อต ASIA16", core.LOT_MIN, core.LOT_MAX, 0.01, "%.2f",
                      sub="สูตรเสริมใช้ล็อตของตัวเอง")
        self.lots_card = g
        # locks: the price ladder, then one row of two steppers per stage
        g = group(p)
        self.stages = tk.StringVar(value="2")
        Segmented(self._head(g, "ล็อกกำไร", "เมื่อราคาวิ่งเข้าใกล้ TP Dobby เลื่อน SL ขึ้นมาเก็บกำไรไว้ ถ้าราคากลับตัวก็ยังได้กำไร"),
                  [("0", "ไม่ล็อก"), ("1", "1 ชั้น"), ("2", "2 ชั้น")], self.stages, command=self._stages,
                  seg_min=56).pack()
        self.lockbar = Ladder(g)
        self.lockbar.pack(fill="x", pady=(px(16), 0))
        self.stage_rows = frame(g)
        self.stage_rows.pack(fill="x")
        self.stage1_box = frame(self.stage_rows)
        self._stage_row(self.stage1_box, "ชั้นแรก", "lock1_at", "lock1_to")
        self.stage2_box = frame(self.stage_rows)
        self._stage_row(self.stage2_box, "ชั้นใกล้ TP", "lock_at", "lock_to")
        self.lock_card = g
        # daily loss cap
        g = group(p)
        r = self._num_row(g, "daily_cap", "หยุดเมื่อขาดทุนต่อวัน", 1, core.PRESET_MAX_CAP, 1, "%g", suffix="%",
                          sub="วันที่ตลาดไม่เป็นใจ Dobby หยุดเปิดไม้ใหม่เอง ไม่เสียเกินนี้ต่อวัน (สูงสุด 10% ของทุนต้นวัน)",
                          rule=False, font="h3")
        self.cap_sub = L(r.text, "", font="small", fg="ink")
        self.cap_sub.pack(fill="x", pady=(px(2), 0))
        # advanced
        g = group(p)
        self.adv = Expander(g, "ขั้นสูง", sub="ไม่ต้องแก้ก็ได้")
        self.adv.pack(fill="x")
        a = self.adv.body
        self._num_row(a, "recovery", "ไม้แก้หลังขาดทุน (เท่าของล็อต)", 1.0, 2.0, 0.1, "%.1f", suffix="×", rule=False)
        self._num_row(a, "attempts", "เข้าได้กี่ครั้งต่อสูตรต่อวัน", 1, 4, 1, "%d", suffix="ครั้ง")
        self._num_row(a, "conf_mult", "เพิ่มล็อตเมื่อสองสูตรเห็นตรงกัน", 1.0, 2.0, 0.1, "%.1f", suffix="×")
        self._num_row(a, "conf_min", "นับว่าเห็นตรงกันภายใน", 0, 240, 15, "%d", suffix="นาที")
        self._num_row(a, "max_spread", "ไม่เปิดไม้เมื่อสเปรดเกิน", 0.05, 2.0, 0.05, "%.2f", suffix="$")
        r = Row(a, "เทรด NY และ C5G เฉพาะวันที่ตลาดคึกคัก", "วัดจากช่วงราคาเฉลี่ย 20 วัน (ปกติปิด)")
        r.pack(fill="x")
        self.vol_var = tk.BooleanVar(value=False)
        Toggle(r.ctl, self.vol_var, command=lambda: self._set("vol_gate", bool(self.vol_var.get()))).pack()
        self.vol_box = frame(a)
        self._num_row(self.vol_box, "vol_gate_pct", "ช่วงราคาเฉลี่ยขั้นต่ำ", 0.5, 5.0, 0.25, "%.2f", suffix="%")

    def _stage_row(self, parent, title, k_at, k_to):
        frame(parent, bg="hair", height=1).pack(fill="x", pady=(px(14), px(12)))
        L(parent, title, font="bold").pack(fill="x", pady=(0, px(8)))
        r = frame(parent)
        r.pack(fill="x")
        c1 = frame(r)
        c1.pack(side="left", anchor="n")
        L(c1, "เมื่อกำไรถึง (% ของทางไป TP)", font="small", fg="slate").pack(anchor="w", pady=(0, px(5)))
        s1 = Stepper(c1, None, 10, 99.5, 0.5, "%g", width=5, suffix="%", on_change=lambda v: self._set(k_at, v))
        s1.pack(anchor="w")
        c2 = frame(r)
        c2.pack(side="left", anchor="n", padx=(px(24), 0))
        L(c2, "เลื่อน SL ไปที่ (% ของทางไป TP)", font="small", fg="slate").pack(anchor="w", pady=(0, px(5)))
        s2 = Stepper(c2, None, 1, 99, 0.5, "%g", width=5, suffix="%", on_change=lambda v: self._set(k_to, v))
        s2.pack(anchor="w")
        note = L(parent, "", font="small", fg="ink", wrap=True)
        note.pack(fill="x", pady=(px(8), 0))
        self.stage_notes[(k_at, k_to)] = note
        self.steppers[k_at], self.steppers[k_to] = s1, s2
        self._err_label(parent, k_at, r)
        self._err_label(parent, k_to, r)

    # -- state
    def load(self, settings, keep_balance=False):
        self._loading = True
        try:
            self.s = dict(core.SETTING_DEFAULTS)
            self.s.update(settings or {})
            if not keep_balance:
                b = self.s.get("balance")
                self.bal.set(("%g" % b) if isinstance(b, (int, float)) and b else "")
            for key, v in self.use_vars.items():
                v.set(bool(self.s.get("use_" + key)))
            self.lot_mode.set(self.s.get("lot_mode") or "same")
            self.stages.set(str(int(self.s.get("lock_stages") or 0)))
            self.vol_var.set(bool(self.s.get("vol_gate")))
            for key, st in self.steppers.items():
                st.set(self.s.get(key), quiet=True)
        finally:
            self._loading = False
        self._layout()
        self._refresh()

    def get(self):
        s = dict(self.s)
        s["balance"] = da.to_num(self.bal.get().replace(",", "").strip())
        return s

    def errors(self):
        return core.validate_settings(self.get())

    def _set(self, key, value):
        if self._loading:
            return
        self.s[key] = value
        self._layout()
        self._refresh()

    def _custom_changed(self):
        self.ui.wiz["custom"] = bool(self.custom.get())
        self._layout()
        if self.on_change:
            self.on_change()

    def _lot_mode(self):
        mode = self.lot_mode.get()
        if mode == "each" and self.s.get("lot_mode") != "each":
            for k in ("lot_a", "lot_ny", "lot_c5g"):
                self.s[k] = self.s.get("lot")
                self.steppers[k].set(self.s[k], quiet=True)
        elif mode == "same" and self.s.get("lot_mode") != "same":
            self.s["lot"] = max(da.to_num(self.s.get(k)) or core.LOT_MIN for k in ("lot_a", "lot_ny", "lot_c5g"))
            self.steppers["lot"].set(self.s["lot"], quiet=True)
        self._set("lot_mode", mode)

    def _stages(self):
        self._set("lock_stages", int(self.stages.get()))

    def _layout(self):
        """Show / hide the parts that depend on the state."""
        def show(w, on, **kw):
            if on and not w.winfo_manager():
                w.pack(**kw)
            elif not on and w.winfo_manager():
                w.pack_forget()
        applied = self.applied
        show(self.result, applied, fill="x", pady=(px(24), 0), after=self.c1)
        show(self.crow, applied, fill="x", pady=(px(22), 0), after=self.result)
        show(self.cp, applied and bool(self.custom.get()), fill="x", after=self.crow)
        each = self.s.get("lot_mode") == "each"
        st = int(self.s.get("lock_stages") or 0)
        key = (each, bool(self.s.get("use_asia")), st)
        if key != getattr(self, "_layout_key", None):
            self._layout_key = key
            for w in (self.same_box, self.each_box, self.asia_box, self.stage1_box, self.stage2_box):
                w.pack_forget()
            (self.each_box if each else self.same_box).pack(fill="x")
            if self.s.get("use_asia"):
                self.asia_box.pack(fill="x")
            if st >= 2:
                self.stage1_box.pack(fill="x")
            if st >= 1:
                self.stage2_box.pack(fill="x")
        show(self.vol_box, bool(self.s.get("vol_gate")), fill="x")

    def _refresh(self):
        s = self.get()
        errs = core.validate_settings(s)
        self._render_tiles(s)
        self._render_risk(s)
        self.lockbar.set(int(s.get("lock_stages") or 0), da.to_num(s.get("lock_at")), da.to_num(s.get("lock_to")),
                         da.to_num(s.get("lock1_at")), da.to_num(s.get("lock1_to")))
        for (k_at, k_to), note in self.stage_notes.items():
            a, t = da.to_num(s.get(k_at)), da.to_num(s.get(k_to))
            note.configure(text=("เมื่อกำไรวิ่งถึง %s%% ของทางไป TP บอทจะเลื่อน SL ไปที่ %s%% ต่อให้ราคากลับ ก็ยังได้กำไร"
                                 "ราว %s%% ของ TP" % (core.pct_text(a), core.pct_text(t), core.pct_text(t)))
                           if a is not None and t is not None else "")
        b, cap = s.get("balance"), da.to_num(s.get("daily_cap"))
        self.cap_sub.configure(text=("เท่ากับราว %s USD ต่อวันจากทุน %s USD" % (core.money(b * cap / 100.0),
                                                                             format(b, ",.0f"))) if b and cap else "")
        for key, (lbl, after) in self.err_l.items():
            msg = errs.get(key)
            if msg:
                lbl.configure(text=msg)
                if not lbl.winfo_manager():
                    lbl.pack(fill="x", pady=(px(4), 0), after=after)
            elif lbl.winfo_manager():
                lbl.pack_forget()
            if key in self.steppers:
                self.steppers[key].set_error(bool(msg))
        if self.on_change:
            self.on_change()

    def _render_tiles(self, s):
        """The auto result: one plain sentence and a few chips (no grid of identical cards)."""
        sentence = "Dobby จะ" + core.settings_sentence(s)
        b, cap = da.to_num(s.get("balance")), da.to_num(s.get("daily_cap"))
        if b and cap:
            sentence += " (ราว %s USD)" % core.money(b * cap / 100.0)
        key = (sentence, tuple(core.settings_chips(s)))
        if key == getattr(self, "_tiles_key", None):
            return
        self._tiles_key = key
        self.res_text.configure(text=sentence)
        for w in self.tiles.winfo_children():
            w.destroy()
        for text, tone in key[1]:
            Chip(self.tiles, text, tone).pack(side="left", padx=(0, px(6)))

    def _render_risk(self, s):
        lots = core.settings_lots(s)
        lot = max([lots[k] for k in ("a", "ny", "c5g") if s.get("use_" + k)] or [lots["a"]])
        r = core.risk_estimate(s.get("balance"), lot, da.to_num(s.get("daily_cap")))
        self.risk_txt.configure(text=r["text"] if r else "ใส่ยอดเงินเพื่อดูประมาณความเสี่ยง")
        key = tuple(r["details"]) if r else ()
        if key != getattr(self, "_risk_key", None):
            self._risk_key = key
            for w in self.risk_lines.winfo_children():
                w.destroy()
            for i, line in enumerate(r["details"][:-1] if r else []):
                if i:
                    frame(self.risk_lines, bg="hair2", height=1).pack(fill="x")
                L(self.risk_lines, line, font="small", fg="ink", wrap=True).pack(fill="x", pady=px(5))

    def do_auto(self):
        b = da.to_num(self.bal.get().replace(",", "").strip())
        if b is None or b <= 0:
            self.bal.set_error(True)
            self.bal_err.configure(text="ใส่ยอดเงินเป็นตัวเลขมากกว่า 0 เช่น 300")
            if not self.bal_err.winfo_manager():
                self.bal_err.pack(fill="x", pady=(px(6), 0), before=self.bal_hint)
            self.bal.entry.focus_set()
            return False
        first = not self.applied
        self.applied = True
        self.custom.set(False)
        self.ui.wiz["custom"] = False
        self.load(core.auto_settings(b), keep_balance=True)
        if first:
            self.after(60, lambda: self.ui.scroll_into_view(self.result))
        return True

    def _balance_typed(self):
        if self._loading:
            return
        self.bal.set_error(False)
        if self.bal_err.winfo_manager():
            self.bal_err.pack_forget()
        b = da.to_num(self.bal.get().replace(",", "").strip())
        if not self.applied:
            return
        if self.custom.get() or not b or b <= 0:
            self.s["balance"] = b
            self._refresh()
        else:
            self.load(core.auto_settings(b), keep_balance=True)


# ---------------------------------------------------------------------------------------------------------------------
# Safety (wizard step 6 and Settings)
# ---------------------------------------------------------------------------------------------------------------------
class SafetyForm(tk.Frame):
    CHECKS = [
        ("allow_remote_control", "ให้เว็บควบคุม Dobby",
         "หยุดชั่วคราว ทำงานต่อ ลดล็อต และตั้งช่วงงดเทรดข่าวจากเว็บ (ปิดไว้ แอปจะไม่เขียนไฟล์ควบคุมให้ Dobby เลย)"),
        ("allow_remote_live", "ให้เว็บเปิด-ปิดเทรดจริง",
         "เว็บขอรหัสผ่านซ้ำทุกครั้งก่อนเปิดเทรดจริง (ปิดไว้ เว็บสั่งปิดได้อย่างเดียว)"),
        ("allow_remote_params", "ให้เว็บส่งการตั้งค่าให้ Dobby",
         "ล็อต ล็อกกำไร และทุน (Dobby v3.04 ขึ้นไป) ชุดที่เกินเพดานด้านล่างจะถูกปฏิเสธทั้งชุด"),
    ]

    def __init__(self, parent, ui, on_change=None):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.ui, self.on_change = ui, on_change
        self.default_max = 0.06
        top = Row(self, "ให้เว็บควบคุมได้ทุกอย่าง (แนะนำ)", None, rule=False, pady=0, font="h3")
        top.pack(fill="x")
        self.desc = L(top.text, "", font="base", fg="ink", wrap=True)
        self.desc.pack(fill="x", pady=(px(4), 0))
        self.rec = tk.BooleanVar(value=True)
        Toggle(top.ctl, self.rec, command=self._rec_changed).pack()
        L(self, "คุณจะดูและสั่ง Dobby จากมือถือได้ ส่วนเพดานด้านล่างเก็บไว้ในเครื่องนี้เท่านั้น เว็บเปลี่ยนไม่ได้",
          font="small", fg="slate", wrap=True).pack(fill="x", pady=(px(10), 0))
        frame(self, bg=hair_for(self), height=1).pack(fill="x", pady=(px(18), px(16)))
        self.exp = Expander(self, "ปรับเอง", sub="เลือกทีละข้อ และตั้งเพดานของเครื่องนี้")
        self.exp.pack(fill="x")
        b = self.exp.body
        self.vars = {}
        for i, (key, title, text) in enumerate(self.CHECKS):
            r = Row(b, title, text, rule=i > 0)
            r.pack(fill="x")
            v = tk.BooleanVar(value=True)
            self.vars[key] = v
            Toggle(r.ctl, v, command=self._detail_changed).pack()
        self.steppers = {}
        for key, title, text, lo, hi, step, fmt, unit in (
                ("max_lots", "ล็อตสูงสุดที่เว็บสั่งได้", "ล็อตจากเว็บที่เกินนี้จะถูกลดลงเหลือเท่านี้", 0.01, 5.0, 0.01, "%.2f",
                 None),
                ("max_daily_cap_pct", "ขาดทุนต่อวันสูงสุดที่เว็บตั้งได้", "การตั้งค่าจากเว็บที่เกินนี้จะถูกปฏิเสธ", 1, 10,
                 0.5, "%g", "%")):
            r = Row(b, title, text)
            r.pack(fill="x")
            st = Stepper(r.ctl, None, lo, hi, step, fmt, on_change=lambda v: self._detail_changed(), suffix=unit)
            st.pack()
            self.steppers[key] = st
        self.err = L(b, "", font="sbold", fg="cinnabar")
        self._quiet = False

    def set(self, limits, default_max=None):
        if default_max is not None:
            self.default_max = default_max
        lim = da.get_limits({"limits": limits})
        self._quiet = True
        try:
            for k, v in self.vars.items():
                v.set(bool(lim[k]))
            self.steppers["max_lots"].set(lim["max_lots"], quiet=True)
            self.steppers["max_daily_cap_pct"].set(min(lim["max_daily_cap_pct"], 10.0), quiet=True)
            self.rec.set(all(v.get() for v in self.vars.values()))
        finally:
            self._quiet = False
        self._describe()

    def _rec_changed(self):
        if self.rec.get():
            for v in self.vars.values():
                v.set(True)
            if self.steppers["max_lots"].value() is None:
                self.steppers["max_lots"].set(self.default_max, quiet=True)
        else:
            self.exp.open(True)
        self._describe()
        if self.on_change:
            self.on_change()

    def _detail_changed(self):
        if self._quiet:
            return
        self.rec.set(all(v.get() for v in self.vars.values()))
        self._describe()
        if self.on_change:
            self.on_change()

    def _describe(self):
        lots = self.steppers["max_lots"].value()
        cap = self.steppers["max_daily_cap_pct"].value()
        guard = "ส่วนเครื่องนี้ยังกันไว้ว่าล็อตไม่เกิน %s และขาดทุนต่อวันไม่เกิน %s%%" % (
            "%.2f" % lots if lots else "-", core.pct_text(cap) if cap else "-")
        if self.rec.get():
            self.desc.configure(text="เว็บเปิด-ปิดเทรดจริง หยุดชั่วคราว และส่งการตั้งค่าให้ Dobby ได้ " + guard)
        else:
            on = [t for (k, t, _), v in zip(self.CHECKS, self.vars.values()) if v.get()]
            self.desc.configure(text=("เปิดไว้เฉพาะ " + " และ ".join(on) + " " + guard) if on else
                                ("เว็บดูได้อย่างเดียว สั่งอะไรไม่ได้ " + guard))

    def get(self):
        """(limits, None) or (None, Thai error)."""
        out = dict((k, bool(v.get())) for k, v in self.vars.items())
        lots, cap = self.steppers["max_lots"].value(), self.steppers["max_daily_cap_pct"].value()
        if lots is None or not (0 < lots <= 100):
            return None, "ล็อตสูงสุดต้องเป็นตัวเลขมากกว่า 0 เช่น 0.06"
        if cap is None or not (0 < cap <= 100):
            return None, "ขาดทุนต่อวันสูงสุดต้องอยู่ระหว่าง 1 ถึง 10"
        out["max_lots"] = round(lots, 2) if lots >= 0.01 else 0.01
        out["max_daily_cap_pct"] = float(cap)
        return out, None

    def summary(self):
        lim, err = self.get()
        if err:
            return err
        head = "เว็บควบคุมได้ทุกอย่าง" if all(lim[k] for k, _, _ in self.CHECKS) else \
            "เว็บควบคุมได้บางส่วน" if any(lim[k] for k, _, _ in self.CHECKS) else "เว็บดูได้อย่างเดียว"
        return "%s โดยล็อตไม่เกิน %.2f และขาดทุนต่อวันไม่เกิน %s%%" % (head, lim["max_lots"],
                                                                   core.pct_text(lim["max_daily_cap_pct"]))


# ---------------------------------------------------------------------------------------------------------------------
# MT5 (wizard step 5 and the MT5 screen): choose the MT5, install Dobby, open MT5 with Dobby or the manual steps
# ---------------------------------------------------------------------------------------------------------------------
class Mt5Panel(tk.Frame):
    def __init__(self, parent, ui, on_change=None):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.ui, self.on_change = ui, on_change
        self.busy = False
        self.terminals = []
        self.check = None
        self.installed_for = None
        self.files = []
        self.launched = None
        # MT5 in this PC
        g = group(self, "MT5 ในเครื่องนี้", "Dobby ทำงานใน MT5 ที่ล็อกอินบัญชีเทรดของคุณ", rule=False)
        self.term_box = frame(g)
        self.term_box.pack(fill="x", pady=(px(12), 0))
        row = frame(g)
        row.pack(fill="x", pady=(px(10), 0))
        Btn(row, "ค้นหาอีกครั้ง", self.scan, style="secondary", size="sm", icon="refresh").pack(side="left")
        Btn(row, "เลือกโฟลเดอร์เอง…", self.pick, style="ghost", size="sm", icon="folder").pack(side="left",
                                                                                              padx=(px(8), 0))
        # install
        g = group(self, "ติดตั้ง Dobby ลงใน MT5",
                  "แอปดาวน์โหลด Dobby เวอร์ชันล่าสุดจากเว็บ และสร้างพรีเซ็ตที่ให้เว็บตั้งค่าแทนคุณได้")
        self.inst_rows = frame(g)
        self.inst_rows.pack(fill="x", pady=(px(12), 0))
        self.inst_banner = Banner(g, pady=(px(10), 0))
        self.inst_banner.pack(fill="x")
        row = frame(g)
        row.pack(fill="x", pady=(px(10), 0))
        self.reinstall_btn = Btn(row, "ติดตั้งอีกครั้ง", lambda: self.install(force=True), style="secondary", size="sm",
                                 icon="download")
        self.reinstall_btn.pack(side="left")
        self.files_exp = Expander(g, "เลือกไฟล์เอง", sub="ขั้นสูง", on_toggle=self._files_toggle)
        self.files_exp.pack(fill="x", pady=(px(14), 0))
        self.files_box = frame(self.files_exp.body)
        self.files_box.pack(fill="x")
        # A: open MT5 with Dobby
        g = group(self)
        head = Row(g, "เปิด MT5 พร้อม Dobby ให้อัตโนมัติ",
                   "แอปเปิด MT5 พร้อมกราฟใหม่ที่มี Dobby และเปิดปุ่ม Algo Trading ให้ ไม่ต้องลากเอง", rule=False, pady=0,
                   font="h3")
        head.pack(fill="x")
        badge(head.ctl, "แนะนำ", "gold").pack()
        row = frame(g)
        row.pack(fill="x", pady=(px(16), 0))
        L(row, "สัญลักษณ์ทองของโบรก", font="bold").pack(side="left")
        self.symbol = Field(row, width=12, pady=6)
        self.symbol.pack(side="left", padx=(px(12), px(10)))
        L(row, "กราฟ M15", font="small", fg="slate").pack(side="left")
        self.sym_chips = frame(g)
        self.sym_chips.pack(fill="x", pady=(px(8), 0))
        self.symbol.var.trace_add("write", lambda *a: self._symbol_typed())
        self.auto_rows = frame(g)
        self.auto_rows.pack(fill="x", pady=(px(12), 0))
        row = frame(g)
        row.pack(fill="x", pady=(px(14), 0))
        self.start_btn = Btn(row, "เปิด MT5 พร้อม Dobby", self.do_start, size="lg", icon="play")
        self.start_btn.pack(side="left")
        Btn(row, "ตรวจอีกครั้ง", self.check_auto, style="secondary", size="md", icon="refresh").pack(
            side="left", padx=(px(10), 0))
        self.auto_banner = Banner(g, pady=(px(12), 0))
        self.auto_banner.pack(fill="x")
        self.auto_card = g
        # B: manual
        g = group(self)
        self.man = Expander(g, "ทำเองใน MT5", sub="6 ขั้นตอน ทำครั้งเดียว")
        self.man.pack(fill="x")
        self.man_box = frame(self.man.body)
        self.man_box.pack(fill="x")
        self.man_key = None

    # -- config helpers
    @property
    def data_dir(self):
        return (self.ui.cfg.get("app") or {}).get("mt5_data_dir") or ""

    @property
    def ea_name(self):
        d = self.data_dir
        name = (self.ui.cfg.get("app") or {}).get("ea_file") or ""
        if name and core.ea_installed(d, name):
            return name
        return core.installed_ea_name(d) if d else ""

    def _save_app(self, **kw):
        core.update_app_config(self.ui.ctx.data_dir, lambda c: c["app"].update(kw))
        self.ui.reload_cfg()

    # -- MT5 choice
    def on_enter(self):
        sym = (self.ui.cfg.get("app") or {}).get("symbol") or "XAUUSD"
        if self.symbol.get() != sym:
            self.symbol.set(sym)
        self.scan()

    def scan(self):
        found = core.detect_terminals(self.ui.ctx.appdata)
        chosen = self.data_dir
        if chosen and core.is_data_dir(chosen) and not any(
                os.path.normcase(t["data_dir"]) == os.path.normcase(chosen) for t in found):
            found.insert(0, core.describe_terminal(chosen))
        self.terminals = found
        if found and not any(t["data_dir"] == chosen for t in found):
            self._save_app(mt5_data_dir=found[0]["data_dir"])
        elif not found and chosen and not core.is_data_dir(chosen):
            self._save_app(mt5_data_dir="")
        self._render_terminals()
        self._render_manual()
        self._render_symbols()
        if self.data_dir and self.installed_for != self.data_dir and not self.busy:
            self.install()
        else:
            self._render_install()
            self.check_auto()

    def _render_terminals(self):
        for w in self.term_box.winfo_children():
            w.destroy()
        if not self.terminals:
            bn = Banner(self.term_box)
            bn.pack(fill="x")
            bn.show("warn", "ยังไม่พบ MT5 ในเครื่องนี้",
                    "ติดตั้ง MT5 จากเว็บโบรกเกอร์ของคุณ เปิดและล็อกอินบัญชีหนึ่งครั้ง แล้วกด ค้นหาอีกครั้ง")
            return
        for i, t in enumerate(self.terminals):
            sel = t["data_dir"] == self.data_dir
            prev_sel = i > 0 and self.terminals[i - 1]["data_dir"] == self.data_dir
            if i and not sel and not prev_sel:
                frame(self.term_box, bg="hair", height=1).pack(fill="x", padx=px(12))
            box = Box(self.term_box, fill="gold_tint" if sel else "bg", border=None, radius=14, padx=14, pady=12)
            box.pack(fill="x")
            r = box.body
            mark = px(18)
            img = ui_kit.dot_image(mark, "gold") if sel else ui_kit.dot_image(mark, "bg", "hair2")
            tk.Label(r, image=img, bg=box.fill, bd=0).pack(side="left", anchor="n", pady=(px(3), 0))
            c = frame(r)
            c.pack(side="left", fill="x", expand=True, padx=(px(12), 0))
            top = frame(c)
            top.pack(fill="x")
            L(top, t["name"], font="bold").pack(side="left")
            if t["ea_files"]:
                badge(top, "มี Dobby แล้ว", "good").pack(side="left", padx=(px(8), 0))
            bits = []
            if t["servers"]:
                bits.append("เซิร์ฟเวอร์ " + ", ".join(t["servers"][:3]))
            if t["last_used"]:
                bits.append("ใช้ล่าสุดเมื่อ " + time.strftime("%d/%m/%Y %H:%M", time.localtime(t["last_used"])))
            L(c, " ".join(bits) or "MetaTrader 5", font="small", fg="ink").pack(fill="x", pady=(px(1), 0))
            L(c, t["install_dir"] or t["data_dir"], font="small", fg="slate", wrap=True).pack(fill="x")
            if sel:
                L(r, "เลือกอยู่", font="smed", fg="ink").pack(side="right", anchor="n", pady=(px(2), 0))
            else:
                Btn(r, "ใช้ตัวนี้", lambda d=t["data_dir"]: self.choose(d), style="secondary", size="sm").pack(
                    side="right", anchor="n")

    def choose(self, d):
        if self.busy:
            return
        self._save_app(mt5_data_dir=d)
        self.launched = None
        self.auto_banner.hide()
        self.scan()

    def pick(self):
        d = filedialog.askdirectory(parent=self.ui.root, title="เลือกโฟลเดอร์ข้อมูลของ MT5 (ที่มีโฟลเดอร์ MQL5)",
                                    initialdir=core.terminals_root(self.ui.ctx.appdata))
        if not d:
            return
        d = core.normalize_data_dir(d)
        if not core.is_data_dir(d):
            self.ui.alert("โฟลเดอร์นี้ไม่ใช่ MT5", "เลือกโฟลเดอร์ที่มีโฟลเดอร์ MQL5 อยู่ข้างใน\n"
                                                 "(ใน MT5 กด File > Open Data Folder เพื่อดูว่าอยู่ที่ไหน)")
            return
        self.choose(d)

    # -- install
    def _inst_row(self, state, text, detail=""):
        r = frame(self.inst_rows)
        r.pack(fill="x", pady=(0, px(6)))
        Mark(r, state, size=18, quiet=True).pack(side="left", anchor="n", pady=(px(2), 0))
        c = frame(r)
        c.pack(side="left", fill="x", expand=True, padx=(px(10), 0))
        L(c, text, font="med" if state != "idle" else "base", fg="ink" if state != "idle" else "slate").pack(fill="x")
        if detail:
            L(c, detail, font="small", fg="slate", wrap=True).pack(fill="x")

    def _render_install(self, rows=None):
        for w in self.inst_rows.winfo_children():
            w.destroy()
        d = self.data_dir
        if not d:
            self._inst_row("idle", "เลือก MT5 ก่อน")
            self.reinstall_btn.set(enabled=False)
            return
        self.reinstall_btn.set(enabled=not self.busy)
        if rows is None:
            ea = self.ea_name
            preset = os.path.isfile(core.preset_target(d))
            rows = [("ok" if ea else "idle", "Dobby EA: %s" % ea if ea else "Dobby EA ยังไม่ได้ติดตั้ง",
                     "MQL5\\Experts\\Dobby" if ea else ""),
                    ("ok" if preset else "idle", "พรีเซ็ต %s" % core.WEB_PRESET_NAME + ("" if preset else " ยังไม่มี"),
                     "MQL5\\Presets" if preset else "")]
        for state, text, detail in rows:
            self._inst_row(state, text, detail)

    def install(self, force=False):
        d = self.data_dir
        if not d or self.busy:
            return
        self.busy = True
        self.inst_banner.hide()
        self._render_install([("info", "กำลังดาวน์โหลด Dobby เวอร์ชันล่าสุดจากเว็บ…", ""),
                              ("idle", "ติดตั้งใน MQL5\\Experts\\Dobby", ""),
                              ("idle", "สร้างพรีเซ็ต %s" % core.WEB_PRESET_NAME, "")])
        client = self.ui.client

        def work():
            files = core.storage_files(client.list_files())
            pick = core.pick_ea_file(files)
            return files, pick, (client.download_file(pick["name"]) if pick else None)
        self.ui.bg(work, lambda res: self._downloaded(d, res), self._install_failed)
        if self.on_change:
            self.on_change()

    def _install_failed(self, exc):
        self.busy = False
        self._render_install()
        if isinstance(exc, da.NetworkError):
            t = "เชื่อมต่อเว็บไม่ได้"
        elif isinstance(exc, da.AuthError):
            t = "ต้องเข้าสู่ระบบใหม่"
        else:
            t = "ดาวน์โหลด Dobby ไม่สำเร็จ"
        self.inst_banner.show("bad", t, da.redact(str(exc))[:200], [("ลองใหม่", lambda: self.install(force=True))])
        self.check_auto()
        if self.on_change:
            self.on_change()

    def _downloaded(self, d, res):
        files, pick, data = res
        self.files = files
        rows = []
        ea_name = ""
        if pick is None:
            rows.append(("warn", "ไม่พบไฟล์ Dobby บนเว็บ", "ผู้ดูแลยังไม่ได้อัปโหลด ใช้ เลือกไฟล์เอง ด้านล่าง หรือติดตั้งเอง"))
        else:
            target = core.ea_target(d, pick["name"])
            overwrite = False
            if core.file_state(target, data) == "different":
                overwrite = self.ui.ask_yes_no(
                    "มี %s อยู่แล้ว" % pick["name"],
                    "ใน MT5 มีไฟล์ชื่อนี้อยู่แล้ว แต่ไม่เหมือนไฟล์ใหม่บนเว็บ\n%s\n\nแทนที่ด้วยไฟล์จากเว็บไหม?\n"
                    "(ถ้า Dobby ตัวนี้ติดกราฟอยู่และ MT5 เปิดอยู่ MT5 จะโหลด Dobby ใหม่เอง)" % target)
            try:
                r = core.install_file(target, data, overwrite=overwrite)
                LOG.info("EA install: %s -> %s (%s)", pick["name"], target, r)
                ea_name = pick["name"]
                rows.append(("ok", "ดาวน์โหลด %s (%s)" % (pick["name"], core.fmt_size(pick.get("size"))),
                             "เวอร์ชันล่าสุดบนเว็บ"))
                rows.append(("ok", {"installed": "ติดตั้งใน MQL5\\Experts\\Dobby แล้ว",
                                    "same": "มีอยู่แล้วใน MQL5\\Experts\\Dobby (ไฟล์เดียวกัน)",
                                    "kept": "เก็บไฟล์เดิมใน MQL5\\Experts\\Dobby ไว้"}[r], ""))
            except OSError as e:
                rows.append(("bad", "ติดตั้ง %s ไม่สำเร็จ" % pick["name"], str(e)))
        try:
            target, r = core.install_web_preset(d)
            rows.append(("ok", "สร้างพรีเซ็ต %s แล้ว" % core.WEB_PRESET_NAME, "ใน MQL5\\Presets ให้เว็บตั้งล็อต ทุน และล็อกกำไรได้"))
        except OSError as e:
            rows.append(("bad", "สร้างพรีเซ็ตไม่สำเร็จ", str(e)))
        if ea_name:
            self._save_app(ea_file=ea_name)
        self.installed_for = d
        self.busy = False
        self._render_install(rows)
        self._render_files()
        self._render_manual()
        self.check_auto()
        if self.on_change:
            self.on_change()

    def _files_toggle(self, opened):
        if opened and not self.files and not self.busy:
            self.ui.bg(lambda: core.storage_files(self.ui.client.list_files()), self._got_files,
                       lambda e: self._got_files([]))
        self._render_files()

    def _got_files(self, files):
        self.files = files
        self._render_files()

    def _render_files(self):
        for w in self.files_box.winfo_children():
            w.destroy()
        files = [f for f in self.files if f["kind"]]
        if not files:
            L(self.files_box, "ยังไม่มีรายการไฟล์ (กดติดตั้งอีกครั้งเพื่อโหลด)", font="small", fg="slate").pack(fill="x")
            return
        self.file_vars = {}
        for f in files:
            v = tk.BooleanVar(value=False)
            self.file_vars[f["name"]] = v
            r = frame(self.files_box)
            r.pack(fill="x")
            ttk.Checkbutton(r, text=f["name"], variable=v, style="S.TCheckbutton").pack(side="left")
            L(r, "%s ขนาด %s" % ({"ea": "EA", "preset": "พรีเซ็ต"}[f["kind"]], core.fmt_size(f["size"])), font="small",
              fg="slate").pack(side="left", padx=(px(10), 0))
        Btn(self.files_box, "ติดตั้งไฟล์ที่เลือก", self._install_selected, style="secondary", size="sm").pack(
            anchor="w", pady=(px(8), 0))

    def _install_selected(self):
        d = self.data_dir
        names = [n for n, v in getattr(self, "file_vars", {}).items() if v.get()]
        if not d or not names or self.busy:
            return
        self.busy = True
        client = self.ui.client
        self.ui.bg(lambda: [(n, client.download_file(n)) for n in names], lambda got: self._write_selected(d, got),
                   self._install_failed)

    def _write_selected(self, d, got):
        done = []
        for name, data in got:
            target = core.install_target(d, name)
            if target is None:
                continue
            overwrite = core.file_state(target, data) != "different" or self.ui.ask_yes_no(
                "มีไฟล์ชื่อนี้อยู่แล้ว", "%s\nแทนที่ด้วยไฟล์จากเว็บไหม?" % target)
            r = core.install_file(target, data, overwrite=overwrite)
            LOG.info("EA install: %s -> %s (%s)", name, target, r)
            done.append(name)
            if core.install_kind(name) == "ea":
                self._save_app(ea_file=name)
        self.busy = False
        self.inst_banner.show("good", "ติดตั้งแล้ว %d ไฟล์" % len(done), ", ".join(done))
        self._render_install()
        self.check_auto()

    # -- open MT5 with Dobby
    def _render_symbols(self):
        for w in self.sym_chips.winfo_children():
            w.destroy()
        syms = core.broker_symbols(self.data_dir) if self.data_dir else []
        if syms:
            L(self.sym_chips, "พบในโบรกของคุณ", font="small", fg="slate").pack(side="left", padx=(0, px(8)))
            for s in syms[:6]:
                Btn(self.sym_chips, s, lambda s=s: self.symbol.set(s), style="soft", size="sm").pack(
                    side="left", padx=(0, px(6)))

    def _symbol_typed(self):
        sym = self.symbol.get().strip()
        if core.valid_symbol(sym) and sym != (self.ui.cfg.get("app") or {}).get("symbol"):
            self._save_app(symbol=sym)
        if self.check is not None:
            self.check_auto()

    def check_auto(self):
        d = self.data_dir
        procs = self.ui.ctx.terminal_processes() if d else []
        common = self.ui.ctx.common_dir(self.ui.cfg)
        self.check = core.autostart_check(d, self.ea_name, common, self.symbol.get().strip(), procs)
        for w in self.auto_rows.winfo_children():
            w.destroy()
        codes = [p["code"] for p in self.check["problems"]]
        if self.busy:
            codes = ["busy"]
            probs = [{"code": "busy", "title": "รอติดตั้ง Dobby ให้เสร็จก่อน", "text": ""}]
        else:
            probs = self.check["problems"]
        if self.launched is not None and not self.busy:
            r = frame(self.auto_rows)
            r.pack(fill="x")
            Mark(r, "ok", size=18, quiet=True).pack(side="left", anchor="n", pady=(px(2), 0))
            L(r, "เปิด MT5 พร้อม Dobby แล้ว", font="med", fg="ink").pack(side="left", padx=(px(10), 0))
            self.start_btn.set(enabled=False)
            if self.on_change:
                self.on_change()
            return self.check
        if self.check["ok"] and not self.busy:
            r = frame(self.auto_rows)
            r.pack(fill="x")
            Mark(r, "ok", size=18, quiet=True).pack(side="left", anchor="n", pady=(px(2), 0))
            L(r, "พร้อมแล้ว MT5 ปิดอยู่และยังไม่มี Dobby ติดกราฟ", font="med", fg="ink").pack(
                side="left", padx=(px(10), 0))
        for p in probs[:3]:
            r = frame(self.auto_rows)
            r.pack(fill="x", pady=(0, px(6)))
            tone = "ok" if p["code"] in ("dobby_attached", "dobby_running") else \
                "idle" if p["code"] in ("busy", "no_ea", "no_preset") else "warn"
            Mark(r, tone, size=18, quiet=True).pack(side="left", anchor="n", pady=(px(2), 0))
            c = frame(r)
            c.pack(side="left", fill="x", expand=True, padx=(px(10), 0))
            L(c, p["title"], font="med").pack(fill="x")
            if p["text"]:
                L(c, p["text"], font="small", fg="slate", wrap=True).pack(fill="x")
        self.start_btn.set(enabled=self.check["ok"] and not self.busy)
        if "dobby_attached" in codes or "dobby_running" in codes:
            if self.launched is None:
                self.ui.wiz["mt5_result"] = "attached"
        if self.on_change:
            self.on_change()
        return self.check

    def do_start(self):
        check = self.check_auto()
        if not check["ok"]:
            return
        common = self.ui.ctx.common_dir(self.ui.cfg)
        ea = os.path.splitext(self.ea_name)[0]
        items = ["เปิดโปรแกรม MT5: %s" % check["exe"],
                 "เปิดกราฟใหม่ %s M15 ที่มี %s พร้อมพรีเซ็ต %s" % (check["symbol"], ea, core.WEB_PRESET_NAME),
                 "เปิดปุ่ม Algo Trading และอนุญาตให้ Dobby ส่งคำสั่งซื้อขาย"]
        note = ("ไฟล์คำสั่งเดิมในเครื่องนี้เปิดเทรดจริงไว้: Dobby อาจเริ่มเทรดทันทีที่ MT5 เปิด"
                if core.remote_live_now(common) else
                "Dobby จะเริ่มเทรดจริงเมื่อแอปส่งคำสั่งจากเว็บ (หลังกด เริ่มทำงาน Dobby)")

        def extra(parent):
            bullet_list(parent, items, icon="check", tone="info")
            L(parent, note, font="small", fg="slate", wrap=True).pack(fill="x", pady=(px(8), 0))
        ans = self.ui.choose("เปิด MT5 พร้อม Dobby?", "แอปจะทำ 3 อย่างนี้:",
                             [("go", "เปิด MT5", "primary"), (None, "ยกเลิก", "secondary")], kind="info", extra=extra)
        if ans != "go":
            return
        check = self.check_auto()          # MT5 may have been opened meanwhile
        ok, info = core.start_mt5(self.ui.ctx, check)
        if not ok:
            self.auto_banner.show("bad", "เปิด MT5 ไม่ได้", "; ".join(p["title"] for p in info))
            return
        self.launched = info
        self.ui.wiz["mt5_result"] = "launched"
        self._save_app(mt5_launched=time.time())
        self.check_auto()
        self.auto_banner.show("good", "เปิด MT5 แล้ว",
                              "รอสักครู่ MT5 จะเปิดกราฟ %s M15 ที่มี Dobby และปุ่ม Algo Trading เป็นสีเขียว "
                              "ถ้า MT5 ถามว่าอนุญาตให้ Dobby เทรดไหม ให้ตอบ OK" % check["symbol"])

    def _render_manual(self):
        key = (self.ea_name, self.symbol.get().strip())
        if key == self.man_key:
            return
        self.man_key = key
        for w in self.man_box.winfo_children():
            w.destroy()
        manual_steps(self.man_box, core.mt5_steps(self.ea_name or core.EA_CHART_NAME,
                                                  self.symbol.get().strip() or "XAUUSD")).pack(fill="x")

    def mt5_summary(self):
        res = self.ui.wiz.get("mt5_result")
        name = next((t["name"] for t in self.terminals if t["data_dir"] == self.data_dir), "MT5")
        if not self.data_dir:
            return "ยังไม่ได้เลือก MT5 (ทำภายหลังได้ที่ ตั้งค่า > บอท)"
        if res == "launched":
            return "%s เปิดพร้อม Dobby แล้ว" % name
        if res == "attached":
            return "%s มี Dobby ติดกราฟอยู่แล้ว" % name
        if self.ea_name:
            return "%s ติดตั้ง Dobby แล้ว แต่ต้องติด Dobby บนกราฟเอง (ดู ทำเองใน MT5)" % name
        return "%s ยังไม่ได้ติดตั้ง Dobby" % name


# ---------------------------------------------------------------------------------------------------------------------
# Wizard pages
# ---------------------------------------------------------------------------------------------------------------------
class Page(tk.Frame):
    title = ""
    subtitle = ""
    next_label = "ถัดไป"
    next_icon = None
    show_next = True

    head_stamp = None          # (tone, state): the large hallmark beside the page title (welcome, sign-in)

    def __init__(self, wiz):
        tk.Frame.__init__(self, wiz.column, bg=C["bg"], bd=0, highlightthickness=0)
        self.wiz, self.ui = wiz, wiz.ui
        self.busy = False
        self.inset = shadow_margins()[0] if self.head_stamp else 0
        head = frame(self)
        head.pack(fill="x", pady=(0, px(22)), padx=(self.inset, 0))
        if self.head_stamp:
            self.stamp = Hallmark(head, 108, *self.head_stamp)
            self.stamp.pack(side="left", anchor="n", padx=(0, px(22)))
        hc = frame(head)
        hc.pack(side="left", fill="x", expand=True, anchor="n" if not self.head_stamp else "center")
        self.t1 = L(hc, self.title, font="h1")
        self.t1.pack(fill="x")
        self.t2 = L(hc, self.subtitle, font="base", fg="slate", wrap=True)
        self.t2.pack(fill="x", pady=(px(4), 0))
        self.build()

    def set_head(self, title, sub):
        self.t1.configure(text=title)
        self.t2.configure(text=sub)

    @property
    def skip(self):
        return False

    def build(self):
        pass

    def on_enter(self):
        pass

    def can_next(self):
        return not self.busy

    def on_next(self):
        return True

    def set_busy(self, on):
        self.busy = on
        self.wiz.update_nav()


class WelcomePage(Page):
    title = "ยินดีต้อนรับสู่ Dobby"
    subtitle = "แอปนี้เชื่อม MT5 ในเครื่องของคุณกับเว็บ Dobby ให้บอทเทรดทองให้อัตโนมัติ ตั้งค่าครั้งเดียวใช้เวลาราว 5 นาที"
    next_label = "เริ่มตั้งค่า"

    head_stamp = ("gold", "XAUUSD")

    def build(self):
        body = frame(self)
        body.pack(fill="x", padx=(self.inset, 0))
        g = group(body, "แอปนี้ทำอะไรให้คุณ", rule=False)
        for i, (title, text) in enumerate((
                ("ติดตั้ง Dobby ลงใน MT5 ให้เอง", "ดาวน์โหลดบอทเวอร์ชันล่าสุด เปิดกราฟ และเปิด Algo Trading ให้"),
                ("ตั้งค่าบอทจากยอดเงินในคลิกเดียว", "ใส่ยอดเงินแล้วแอปเลือกล็อต ล็อกกำไร และจุดหยุดขาดทุนให้"),
                ("ดูและสั่งบอทจากเว็บได้ทุกที่", "ส่งสถานะขึ้นเว็บ Dobby ให้ดูกำไรและหยุดหรือเริ่มบอทได้จากมือถือ"))):
            if i:
                frame(g, bg="hair", height=1).pack(fill="x", padx=(px(44), 0))
            r = frame(g)
            r.pack(fill="x", pady=(px(12) if i else px(10), px(12)))
            NumBadge(r, i + 1, 28).pack(side="left", anchor="n")
            c = frame(r)
            c.pack(side="left", fill="x", expand=True, padx=(px(16), 0))
            L(c, title, font="bold").pack(fill="x")
            L(c, text, font="small", fg="slate", wrap=True).pack(fill="x")
        g = group(body, "ก่อนเริ่ม ต้องมี", top=14)
        self.need_mt5 = frame(g)
        self.need_mt5.pack(fill="x", pady=(px(10), 0))
        frame(g, bg="hair", height=1).pack(fill="x", pady=(px(12), 0), padx=(px(32), 0))
        r = frame(g)
        r.pack(fill="x", pady=(px(12), 0))
        Mark(r, "ok", size=20, quiet=True).pack(side="left", anchor="n", pady=(px(1), 0))
        c = frame(r)
        c.pack(side="left", fill="x", expand=True, padx=(px(12), 0))
        L(c, "บัญชีเว็บ Dobby", font="bold").pack(fill="x")
        rr = frame(c)
        rr.pack(fill="x")
        L(rr, "อีเมลและรหัสผ่านที่สมัครไว้บนเว็บ", font="small", fg="slate").pack(side="left")
        Link(rr, "ยังไม่มีบัญชี สมัครบนเว็บ", lambda: self.ui.ctx.open_url(WEB_URL), font="slink").pack(
            side="left", padx=(px(12), 0))

    def on_enter(self):
        for w in self.need_mt5.winfo_children():
            w.destroy()
        found = core.detect_terminals(self.ui.ctx.appdata)
        Mark(self.need_mt5, "ok" if found else "warn", size=20, quiet=True).pack(side="left", anchor="n",
                                                                                pady=(px(1), 0))
        c = frame(self.need_mt5)
        c.pack(side="left", fill="x", expand=True, padx=(px(12), 0))
        L(c, "MT5 ติดตั้งและล็อกอินบัญชีโบรกเกอร์แล้ว", font="bold").pack(fill="x")
        L(c, ("พบ MT5 ในเครื่องนี้ %d ตัว" % len(found)) if found else
          "ยังไม่พบ MT5 ในเครื่องนี้ ติดตั้งจากเว็บโบรกเกอร์ของคุณแล้วล็อกอินหนึ่งครั้ง (ทำต่อไปก่อนได้ ค่อยติดตั้งทีหลัง)",
          font="small", fg="slate", wrap=True).pack(fill="x")


class SignInPage(Page):
    title = "เข้าสู่ระบบ"
    subtitle = "ใช้อีเมลและรหัสผ่านเดียวกับบนเว็บ Dobby แอปไม่เก็บรหัสผ่าน เก็บไว้แค่กุญแจเข้าระบบในเครื่องนี้"
    head_stamp = ("gold", "XAUUSD")

    def build(self):
        self.card = Box(self, fill="sheet", radius=22, padx=26, pady=24, shadow=True)
        self.card.pack(anchor="w")
        frame(self.card.body, width=px(380), height=1).pack()       # the sheet keeps its width when signed in
        self.banner = Banner(self.card.body, pady=(0, px(16)))
        self.banner.pack(fill="x")
        self.done_box = frame(self.card.body)
        self.form = frame(self.card.body)
        f = self.form
        L(f, "อีเมล", font="med").pack(fill="x", pady=(0, px(6)))
        self.email_f = Field(f, width=40, pady=9)
        self.email_f.pack(fill="x")
        self.email = self.email_f.entry
        L(f, "รหัสผ่าน", font="med").pack(fill="x", pady=(px(16), px(6)))
        self.password_f = Field(f, width=40, show="•", pady=9)
        self.password_f.pack(fill="x")
        self.password = self.password_f.entry
        self.password.bind("<Return>", lambda e: self.do_sign_in())
        self.email.bind("<Return>", lambda e: self.password.focus_set())
        if self.ui.ctx.demo:
            note = Box(f, fill="gold_tint_s", border=None, radius=10, padx=12, pady=8)
            note.pack(fill="x", pady=(px(16), 0))
            L(note.body, "โหมดตัวอย่าง ใช้อีเมลอะไรก็ได้ อีเมลที่มีคำว่า new คือผู้ใช้ใหม่ที่ยังไม่มีบอท และรหัส wrong "
                         "คือรหัสผิด", font="small", fg="ink", wrap=True).pack(fill="x")
        self.btn = Btn(f, "เข้าสู่ระบบ", self.do_sign_in, size="lg")
        self.btn.pack(fill="x", pady=(px(18), 0))
        row = frame(f)
        row.pack(fill="x", pady=(px(14), 0))
        Link(row, "ยังไม่มีบัญชี สมัครบนเว็บ", lambda: self.ui.ctx.open_url(WEB_URL), font="slink").pack(side="left")
        Link(row, "ลืมรหัสผ่าน", lambda: self.ui.ctx.open_url(WEB_URL), font="slink", fg="slate").pack(side="right")
        self.adv = Expander(self, "ที่อยู่เซิร์ฟเวอร์", sub="ขั้นสูง ปกติไม่ต้องแก้", on_toggle=self._adv_toggle)
        self.adv.pack(fill="x", pady=(px(18), 0), padx=(self.inset, 0))
        L(self.adv.body, "Supabase URL", font="med").pack(fill="x")
        self.url = Field(self.adv.body, width=52, pady=6)
        self.url.pack(fill="x", pady=(px(4), px(10)))
        L(self.adv.body, "Publishable key (คีย์สาธารณะ)", font="med").pack(fill="x")
        self.key = Field(self.adv.body, width=52, pady=6)
        self.key.pack(fill="x", pady=(px(4), 0))
        L(self.adv.body, "ค่าเริ่มต้นคือเว็บ Dobby ของผู้ดูแล", font="small", fg="slate").pack(fill="x", pady=(px(4), 0))

    def _adv_toggle(self, opened):
        if opened:
            self.url.set(self.ui.cfg.get("supabase_url") or "")
            self.key.set(self.ui.cfg.get("anon_key") or "")

    def on_enter(self):
        cfg = self.ui.cfg
        if cfg.get("refresh_token") and self.ui.approved is None and not self.busy:
            self.set_busy(True)
            self.ui.bg(self.ui.client.is_approved, self._approved, self._approved_failed)
        self.show_state()

    def _approved(self, ok):
        self.set_busy(False)
        self.ui.approved = bool(ok)
        if not ok:
            self._signed(self.ui.cfg.get("email") or "", False)
        self.show_state()

    def _approved_failed(self, exc):
        self.set_busy(False)
        if isinstance(exc, da.AuthError):      # the saved login is no longer valid: sign in again
            core.sign_out(self.ui.ctx.data_dir, self.ui.client)
            self.ui.reload_cfg()
            self.ui.approved = None
            self.banner.show("warn", core.AUTH_TH["session"])
        else:
            self.banner.show("bad", "ตรวจบัญชีไม่ได้ เพราะเชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ตแล้วลองใหม่",
                             [("ลองใหม่", self.on_enter)])
        self.show_state()

    def show_state(self):
        cfg = self.ui.cfg
        for w in self.done_box.winfo_children():
            w.destroy()
        if cfg.get("refresh_token") and self.ui.approved is not False:
            self.form.pack_forget()
            self.done_box.pack(fill="x")
            row = frame(self.done_box)
            row.pack(fill="x")
            Mark(row, "ok" if self.ui.approved else "idle", size=36).pack(side="left", anchor="n")
            c = frame(row)
            c.pack(side="left", fill="x", expand=True, padx=(px(14), px(24)))
            L(c, "เข้าสู่ระบบแล้ว" if self.ui.approved else "กำลังตรวจบัญชี…", font="h3").pack(fill="x")
            L(c, cfg.get("email") or "", font="base", fg="slate").pack(fill="x")
            Btn(row, "ใช้บัญชีอื่น", self.use_other, style="secondary", size="sm").pack(side="right", anchor="center")
            if self.ui.approved:
                self.banner.hide()
        else:
            self.done_box.pack_forget()
            self.form.pack(fill="x")
            if not self.email.get():
                self.email.insert(0, cfg.get("email") or "")
        self.wiz.update_nav()

    def use_other(self):
        if self.ui.runner.running:
            self.banner.show("bad", "หยุดการทำงานก่อน", "กดหยุดทำงานที่หน้าหลักก่อนเปลี่ยนบัญชี")
            return
        core.sign_out(self.ui.ctx.data_dir, self.ui.client)
        self.ui.reload_cfg()
        self.ui.approved = None
        self.ui.wiz = new_wizard_state()
        self.banner.hide()
        self.show_state()
        self.email.focus_set()

    def _save_advanced(self):
        if not self.adv.opened:
            return True
        url = self.url.get().strip().rstrip("/")
        key = self.key.get().strip()
        if not da._valid_url(url) or not key:
            self.banner.show("bad", "ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง", "URL ต้องขึ้นต้นด้วย https:// และต้องมีคีย์")
            return False
        if url != self.ui.cfg.get("supabase_url") or key != self.ui.cfg.get("anon_key"):
            core.update_app_config(self.ui.ctx.data_dir, lambda c: c.update(supabase_url=url, anon_key=key,
                                                                             refresh_token=""))
            self.ui.reload_cfg()
            self.ui.rebuild_client()
        return True

    def do_sign_in(self):
        if self.busy:
            return
        email, pw = self.email.get().strip(), self.password.get()
        self.email_f.set_error(False)
        self.password_f.set_error(False)
        if "@" not in email or " " in email:
            self.banner.show("bad", "ใส่อีเมลให้ถูกต้อง", "เช่น name@gmail.com")
            self.email_f.set_error(True)
            self.email.focus_set()
            return
        if not pw:
            self.banner.show("bad", "ใส่รหัสผ่าน")
            self.password_f.set_error(True)
            self.password.focus_set()
            return
        if not self._save_advanced():
            return
        self.password.delete(0, "end")
        self.set_busy(True)
        self.btn.set(text="กำลังเข้าสู่ระบบ…", enabled=False)
        self.banner.hide()
        client = self.ui.client
        self.ui.bg(lambda: core.sign_in(client, email, pw), lambda ok: self._signed(email, ok), self._failed)
        pw = None  # noqa: F841 - drop the reference

    def _signed(self, email, approved):
        self.set_busy(False)
        self.btn.set(text="เข้าสู่ระบบ", enabled=True)
        core.update_app_config(self.ui.ctx.data_dir, lambda c: c.__setitem__("email", email))
        self.ui.reload_cfg()
        self.ui.approved = bool(approved)
        self.ui.wiz["bots"] = None
        if approved:
            self.banner.show("good", "เข้าสู่ระบบสำเร็จ", "กด ถัดไป เพื่อเลือกบอท")
        else:
            self.banner.show("warn", "บัญชีนี้ยังไม่ได้รับอนุมัติ",
                             "เข้าเว็บ Dobby ด้วยบัญชีนี้ แล้วใส่รหัสเชิญที่ได้จากผู้ดูแล จากนั้นกด ตรวจอีกครั้ง",
                             [("เปิดเว็บ Dobby", lambda: self.ui.ctx.open_url(WEB_URL)), ("ตรวจอีกครั้ง", self.recheck)])
        self.show_state()

    def recheck(self):
        self.banner.show("info", "กำลังตรวจบัญชี…")
        self.set_busy(True)
        self.ui.bg(self.ui.client.is_approved, lambda ok: self._signed(self.ui.cfg.get("email") or "", ok),
                   self._failed)

    def _failed(self, exc):
        self.set_busy(False)
        self.btn.set(text="เข้าสู่ระบบ", enabled=True)
        if isinstance(exc, da.AuthError):
            p = core.auth_problem(exc)
            self.banner.show("bad", core.AUTH_TH[p], "" if p != "other" else da.redact(str(exc)))
            self.password_f.set_error(p == "wrong_password")
        elif isinstance(exc, da.NetworkError):
            self.banner.show("bad", "เชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ตแล้วลองใหม่")
        else:
            self.banner.show("bad", "เข้าสู่ระบบไม่สำเร็จ", da.redact(str(exc)))
        self.password.focus_set()
        self.show_state()

    def can_next(self):
        return not self.busy and bool(self.ui.cfg.get("refresh_token")) and self.ui.approved is True


class ChooseBotPage(Page):
    title = "เลือกบอท"
    subtitle = ""
    show_next = False

    def build(self):
        self.body = frame(self)
        self.body.pack(fill="x")
        self.view = None
        self.banner = Banner(self, pady=(px(12), 0))
        self.banner.pack(fill="x")

    def on_enter(self):
        w = self.ui.wiz
        if w.get("bots") is None:
            self._loading()
            self.set_busy(True)
            self.ui.bg(self.ui.client.bots_with_controls, self._loaded, self._failed)
        else:
            self.show(self.view if self.view == "catalog" or not w["bots"] else "list")

    def _clear(self):
        for c in self.body.winfo_children():
            c.destroy()

    def _loading(self):
        self._clear()
        self.set_head("เลือกบอท", "กำลังโหลดบอทในบัญชีของคุณ…")
        L(self.body, "กำลังโหลด…", font="base", fg="slate").pack(fill="x")

    def _loaded(self, bots):
        self.set_busy(False)
        self.ui.wiz["bots"] = bots
        self.banner.hide()
        self.show("list" if bots else "catalog")

    def _failed(self, exc):
        self.set_busy(False)
        self._clear()
        if isinstance(exc, da.AuthError) and core.auth_problem(exc) == "session" and not self.ui.runner.running:
            # the saved login is no longer valid (signed out elsewhere, password changed): forget it, back to sign-in
            core.sign_out(self.ui.ctx.data_dir, self.ui.client)
            self.ui.reload_cfg()
            self.ui.approved = None
            self.wiz.go(STEP_SIGNIN, direction=-1)
            self.wiz.pages[STEP_SIGNIN].banner.show("warn", core.AUTH_TH["session"], "พิมพ์อีเมลและรหัสผ่านแล้วกด เข้าสู่ระบบ")
            return
        if isinstance(exc, da.AuthError) and core.auth_problem(exc) == "session":
            self.banner.show("bad", core.AUTH_TH["session"], "กดหยุดทำงานที่หน้าหลักก่อน แล้วเข้าสู่ระบบใหม่")
            return
        self.banner.show("bad", "โหลดรายการบอทไม่ได้", "ตรวจอินเทอร์เน็ตแล้วลองใหม่ (%s)" % da.redact(str(exc))[:120],
                         [("ลองใหม่", self.on_enter)])

    def show(self, view):
        self.view = view
        self._clear()
        bots = self.ui.wiz.get("bots") or []
        if view == "list" and bots:
            self.set_head("เลือกบอทสำหรับเครื่องนี้", "บอทบนเว็บหนึ่งตัวใช้กับ MT5 หนึ่งเครื่อง (บัญชีเทรดเดียว) "
                          "บัญชีนี้มีบอทอยู่ %d ตัว" % len(bots))
            self._list(bots)
        else:
            self.set_head("เลือกบอทที่จะใช้", "ตอนนี้มีให้เลือกหนึ่งแบบ และจะมีเพิ่มในอนาคต")
            self._catalog(bool(bots))
        self.wiz.update_nav()

    def _list(self, bots):
        now = time.time()
        section(self.body, "ใช้บอทที่มีอยู่", "เลือกถ้าเคยตั้ง Dobby ไว้แล้ว เครื่องนี้จะใช้บอทเดิมบนเว็บ ไม่สร้างใหม่")
        lst = frame(self.body)
        lst.pack(fill="x", pady=(px(12), 0))
        mine = self.ui.cfg.get("bot_id")
        chosen = (self.ui.wiz.get("bot") or {}).get("id") if self.ui.wiz.get("choice") == "existing" else None
        for i, b in enumerate(bots):
            sel = b["id"] == chosen
            if i and not sel and bots[i - 1]["id"] != chosen:
                frame(lst, bg="hair", height=1).pack(fill="x", padx=px(14))
            card = Box(lst, fill="gold_tint" if sel else "bg", border=None, radius=14, padx=14, pady=14)
            card.pack(fill="x")
            r = card.body
            c = frame(r)
            c.pack(side="left", fill="x", expand=True, padx=(0, px(14)))
            top = frame(c)
            top.pack(fill="x")
            L(top, b.get("name") or "-", font="h3").pack(side="left")
            online = core.bot_online(b, now)
            if b["id"] == mine:
                badge(top, "ใช้อยู่ในเครื่องนี้", "gold").pack(side="left", padx=(px(10), 0))
            elif online:
                badge(top, "ออนไลน์อยู่ที่เครื่องอื่น", "warn").pack(side="left", padx=(px(10), 0))
            age = core.bot_seen_age(b, now)
            seen = ("ออนไลน์ " + core.ago_th(age)) if age is not None and online else \
                ("ออนไลน์ล่าสุด " + core.ago_th(age)) if age is not None else "ยังไม่เคยออนไลน์"
            ea = "Dobby v%s" % b["ea_version"] if b.get("ea_version") else "Dobby"
            L(c, "%s %s" % (ea, seen), font="small", fg="ink").pack(fill="x", pady=(px(2), 0))
            desc = self._settings_text(b)
            if desc:
                L(c, desc, font="small", fg="slate", wrap=True).pack(fill="x")
            Btn(r, "ใช้บอทนี้", lambda b=b: self.use_existing(b), style="primary" if sel else "secondary",
                size="md").pack(side="right", anchor="center")
        sep = frame(self.body)
        sep.pack(fill="x", pady=(px(14), px(12)))
        frame(sep, bg="hair", height=1).pack(side="left", fill="x", expand=True, pady=px(11))
        L(sep, "หรือ", font="small", fg="slate").pack(side="left", padx=px(12))
        frame(sep, bg="hair", height=1).pack(side="left", fill="x", expand=True, pady=px(11))
        r = frame(self.body)
        r.pack(fill="x", padx=px(14))
        c = frame(r)
        c.pack(side="left", fill="x", expand=True, padx=(0, px(14)))
        L(c, "เพิ่มบอทใหม่", font="h3").pack(fill="x")
        L(c, "เลือกเมื่อเครื่องนี้จะเทรดบัญชีอื่นที่ยังไม่มีบอทบนเว็บ", font="small", fg="slate",
          wrap=True).pack(fill="x", pady=(px(2), 0))
        Btn(r, "เพิ่มบอทใหม่", lambda: self.show("catalog"), style="secondary", icon="add").pack(side="right")

    @staticmethod
    def _settings_text(b):
        d = (b.get("control") or {}).get("desired") if isinstance(b.get("control"), dict) else None
        if not isinstance(d, dict):
            return ""
        if isinstance(d.get("params"), dict) and d["params"]:
            return core.settings_sentence(core.params_to_settings(d["params"]))
        lots = da.to_num((d.get("control") or {}).get("lots")) if isinstance(d.get("control"), dict) else None
        return ("ล็อตจากเว็บ %.2f ส่วนการตั้งค่าอื่นอยู่ใน MT5" % lots) if lots else "การตั้งค่าอยู่ใน MT5 ของเครื่องนั้น"

    def _catalog(self, has_bots):
        for entry in core.BOT_CATALOG:
            g = frame(self.body)
            g.pack(fill="x")
            top = frame(g)
            top.pack(fill="x")
            Hallmark(top, 92, "gold", "XAUUSD").pack(side="left", anchor="n")
            c = frame(top)
            c.pack(side="left", fill="x", expand=True, padx=(px(22), 0))
            L(c, entry["name"], font="h1").pack(fill="x")
            L(c, entry["desc"], font="base", fg="ink", wrap=True).pack(fill="x", pady=(px(2), 0))
            chips = frame(c)
            chips.pack(fill="x", pady=(px(12), 0))
            for fct in entry["facts"]:
                Chip(chips, fct).pack(side="left", padx=(0, px(6)))
            L(c, entry["why"], font="small", fg="slate", wrap=True).pack(fill="x", pady=(px(12), 0))
            frame(g, bg="hair", height=1).pack(fill="x", pady=(px(22), px(16)))
            row = frame(g)
            row.pack(fill="x")
            Btn(row, "ใช้ Dobby", lambda k=entry["kind"]: self.use_new(k), size="lg", width=200).pack(side="right")
            L(row, "ตั้งค่าในขั้นถัดไป ใช้เวลาไม่ถึงนาที", font="small", fg="slate").pack(side="right", padx=px(16))
        if has_bots:
            Link(self.body, "กลับไปใช้บอทที่มีอยู่", lambda: self.show("list"), font="slink").pack(
                anchor="w", pady=(px(16), 0))

    def use_existing(self, b):
        now = time.time()
        if core.bot_online(b, now) and b["id"] != self.ui.cfg.get("bot_id"):
            ans = self.ui.choose(
                "บอท \"%s\" ออนไลน์อยู่ที่เครื่องอื่น" % (b.get("name") or ""),
                "ถ้าใช้บอทนี้กับเครื่องนี้ด้วย สองเครื่องจะส่งข้อมูลทับกันบนเว็บ และรับคำสั่งเดียวกัน "
                "ให้หยุดแอป Dobby ที่เครื่องเดิมก่อน หรือเลือก เพิ่มบอทใหม่ ถ้าเครื่องนี้ใช้บัญชีเทรดอื่น",
                [("go", "ใช้บอทนี้กับเครื่องนี้", "primary"), (None, "ยกเลิก", "secondary")], kind="warn")
            if ans != "go":
                return
        w = self.ui.wiz
        w.update(choice="existing", bot=b, settings=None, limits=None if not w.get("limits_custom") else w["limits"])
        self.wiz.go(STEP_MT5)

    def use_new(self, kind):
        w = self.ui.wiz
        if w.get("choice") != "new":
            w.update(choice="new", bot=None, kind=kind, limits=None if not w.get("limits_custom") else w["limits"])
        w["name"] = w.get("name") or core.default_bot_name(w.get("bots") or [])
        self.wiz.go(STEP_SETTINGS)

    def can_next(self):
        return not self.busy and self.ui.wiz.get("choice") is not None


class BotSettingsPage(Page):
    title = "ตั้งค่าบอท"
    subtitle = "ใส่เงินในบัญชีเทรด แล้วกด ตั้งให้อัตโนมัติ แอปจะเลือกทุกอย่างให้ หรือเปิด ปรับเอง เพื่อเลือกเอง"

    def build(self):
        self.editor = SettingsEditor(self, self.ui, on_change=self.wiz.update_nav)
        self.editor.pack(fill="x")

    @property
    def skip(self):
        return self.ui.wiz.get("choice") == "existing"

    def on_enter(self):
        w = self.ui.wiz
        if w.get("settings"):
            if not self.editor.applied:
                self.editor.applied = True
                self.editor.load(w["settings"])
        elif not self.editor.applied and not self.editor.bal.get():
            st = self.ui.status or {}
            bal = da.to_num((st.get("account") or {}).get("balance")) if isinstance(st.get("account"), dict) else None
            if bal and bal > 0:
                self.editor.bal.set("%g" % round(bal, 2))
                self.editor.bal_hint.configure(text="ยอดเงินจาก MT5 คือ %s %s (แก้ได้)" % (
                    core.money(bal), (st.get("account") or {}).get("currency") or "USD"))
            else:
                self.editor.bal_hint.configure(text="เช่น 300 USD ได้ล็อต 0.03 และ 1,000 USD ได้ล็อต 0.10 ดูยอดเงินได้ใน MT5 "
                                                    "แท็บ Trade ช่อง Balance")
            self.editor.bal.entry.focus_set()

    def can_next(self):
        return not self.busy and bool(da.to_num(self.editor.bal.get().replace(",", "").strip()))

    def on_next(self):
        if not self.editor.applied and not self.editor.do_auto():
            return False
        errs = self.editor.errors()
        if errs:
            self.editor._refresh()
            return False
        self.ui.wiz["settings"] = self.editor.get()
        return True


class Mt5Page(Page):
    title = "เชื่อม MT5"
    subtitle = "แอปติดตั้ง Dobby ลงใน MT5 ให้ แล้วเลือกได้ว่าจะให้แอปเปิด MT5 พร้อม Dobby หรือทำเองตามขั้นตอน"

    def build(self):
        self.panel = Mt5Panel(self, self.ui, on_change=self.wiz.update_nav)
        self.panel.pack(fill="x")

    def on_enter(self):
        self.panel.on_enter()

    def can_next(self):
        return not self.panel.busy


class SafetyPage(Page):
    title = "ความปลอดภัย"
    subtitle = "เลือกว่าเว็บสั่ง Dobby ในเครื่องนี้ได้แค่ไหน ค่าแนะนำเหมาะกับเกือบทุกคน และเปลี่ยนภายหลังได้ที่หน้าตั้งค่า"

    def build(self):
        self.form = SafetyForm(self, self.ui, on_change=self._changed)
        self.form.pack(fill="x")
        self.banner = Banner(self, pady=(px(12), 0))
        self.banner.pack(fill="x")

    def _default_max_lot(self):
        w = self.ui.wiz
        if w.get("choice") == "new" and w.get("settings"):
            return core.settings_max_lot(w["settings"])
        b = w.get("bot") or {}
        return core.bot_max_lot((b.get("control") or {}).get("desired")) or 0.03

    def on_enter(self):
        w = self.ui.wiz
        lot = self._default_max_lot()
        rec = core.recommended_limits(lot)
        if w.get("limits") and w.get("limits_custom"):
            self.form.set(w["limits"], rec["max_lots"])
        else:
            self.form.set(rec, rec["max_lots"])
            w["limits"] = rec

    def _changed(self):
        lim, err = self.form.get()
        if lim:
            self.ui.wiz["limits"] = lim
            self.ui.wiz["limits_custom"] = True
        self.wiz.update_nav()

    def on_next(self):
        lim, err = self.form.get()
        if err:
            self.banner.show("bad", err)
            return False
        self.ui.wiz["limits"] = lim
        return True


class FinishPage(Page):
    title = "เกือบเสร็จแล้ว"
    subtitle = "ตรวจสรุปด้านล่าง แล้วกดปุ่มเพื่อบันทึก"

    @property
    def show_next(self):
        return not self.ui.wiz.get("done")

    @property
    def next_label(self):
        if self.busy:
            return "กำลังสร้างบอท…" if self.ui.wiz.get("choice") == "new" else "กำลังบันทึก…"
        return "สร้างบอทและบันทึก" if self.ui.wiz.get("choice") == "new" else "ใช้บอทนี้และบันทึก"

    @property
    def btn(self):
        return self.wiz.next_btn

    def on_next(self):
        self.do_save()
        return False

    def build(self):
        self.body = frame(self)
        self.body.pack(fill="x")
        self.banner = Banner(self, pady=(px(12), 0))
        self.banner.pack(fill="x")
        self.name = None

    def on_enter(self):
        if self.ui.wiz.get("done"):
            self._done_view()
        else:
            self._summary_view()

    def _row(self, parent, icon, label, value, step=None, first=False):
        if not first:
            frame(parent, bg="hair", height=1).pack(fill="x")
        r = frame(parent)
        r.pack(fill="x", pady=px(14))
        c = frame(r)
        c.pack(side="left", fill="x", expand=True, padx=(0, px(16)))
        L(c, label, font="small", fg="slate").pack(fill="x")
        L(c, value, font="base", fg="ink", wrap=True).pack(fill="x", pady=(px(1), 0))
        if step is not None:
            Btn(r, "แก้ไข", lambda: self.wiz.go(step), style="ghost", size="sm").pack(side="right", anchor="n")
        return c

    def _summary_view(self):
        for w in self.body.winfo_children():
            w.destroy()
        w = self.ui.wiz
        self.set_head("เกือบเสร็จแล้ว", "ตรวจสรุปด้านล่าง แล้วกดปุ่มเพื่อบันทึก")
        b = frame(self.body)
        b.pack(fill="x")
        new = w.get("choice") == "new"
        if new:
            c = self._row(b, "robot", "บอท", "Dobby (บอทใหม่)", STEP_BOT, first=True)
            L(c, "ชื่อบอทบนเว็บ", font="med").pack(fill="x", pady=(px(12), px(6)))
            self.name = Field(c, width=30, pady=7)
            self.name.pack(anchor="w")
            self.name.set(w.get("name") or core.default_bot_name(w.get("bots") or []))
            self.name.var.trace_add("write", lambda *a: w.__setitem__("name", self.name.get()))
            self._row(b, "list", "การตั้งค่า", core.settings_sentence(w["settings"]) if w.get("settings") else "-",
                      STEP_SETTINGS)
        else:
            bot = w.get("bot") or {}
            self.name = None
            self._row(b, "robot", "บอท", "%s (มีอยู่แล้วบนเว็บ)" % (bot.get("name") or "-"), STEP_BOT, first=True)
            self._row(b, "list", "การตั้งค่า", "ใช้ค่าเดิมของบอทบนเว็บโดยไม่เปลี่ยน แก้ได้บนเว็บ")
        mt5 = self.wiz.pages[STEP_MT5].panel.mt5_summary()
        self._row(b, "laptop", "MT5", mt5, STEP_MT5)
        self._row(b, "shield", "ความปลอดภัย", self.wiz.pages[STEP_SAFETY].form.summary(), STEP_SAFETY)
        frame(b, bg="hair", height=1).pack(fill="x")
        L(self.body, "การบันทึกจะเก็บค่าไว้ในเครื่องนี้และบนเว็บ Dobby ยังไม่เริ่มเทรดจนกว่าจะกด เริ่มทำงาน Dobby",
          font="small", fg="slate", wrap=True).pack(fill="x", pady=(px(14), 0))

    def do_save(self):
        ui, w = self.ui, self.ui.wiz
        if self.busy:
            return
        if ui.runner.running:
            self.banner.show("bad", "หยุดการทำงานก่อน", "กดหยุดทำงานที่หน้าหลักก่อนเปลี่ยนบอท")
            return
        limits = w.get("limits") or core.recommended_limits(0.03)
        common = ui.ctx.common_dir(ui.cfg)
        if w.get("choice") == "existing":
            bot = w["bot"]
            core.link_bot(ui.ctx.data_dir, common, bot, limits)
            ui.reload_cfg()
            self._saved({"kind": "link", "name": bot.get("name")})
            return
        name = core.clean_bot_name(self.name.get() if self.name else w.get("name"))
        if not name:
            self.banner.show("warn", "ตั้งชื่อบอทก่อน", "เช่น Dobby หรือ คอมที่บ้าน")
            if self.name:
                self.name.set_error(True)
            return
        if not w.get("settings"):
            self.banner.show("warn", "ยังไม่ได้ตั้งค่าบอท", "กลับไปขั้น ตั้งค่าบอท")
            return
        params = core.settings_to_params(w["settings"])
        self.set_busy(True)
        self.banner.hide()
        client, data_dir = ui.client, ui.ctx.data_dir
        ui.bg(lambda: core.create_bot(client, data_dir, common, name, params, limits),
              lambda bid: self._saved({"kind": "new", "name": name, "id": bid}), self._failed)

    def _failed(self, exc):
        self.set_busy(False)
        if "not_approved" in str(exc):
            self.banner.show("bad", "บัญชียังไม่ได้รับอนุมัติ", "ใส่รหัสเชิญบนเว็บ Dobby ก่อน")
        elif isinstance(exc, da.NetworkError):
            self.banner.show("bad", "เชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ตแล้วลองใหม่")
        elif isinstance(exc, da.AuthError):
            self.banner.show("bad", "ต้องเข้าสู่ระบบใหม่", "กลับไปขั้น เข้าสู่ระบบ")
        else:
            self.banner.show("bad", "สร้างบอทไม่สำเร็จ", da.redact(str(exc))[:200])

    def _saved(self, info):
        self.set_busy(False)
        self.ui.reload_cfg()
        self.ui.wiz["done"] = info
        LOG.info("setup wizard finished")
        self._done_view()
        self.wiz.update_nav()

    def _done_view(self):
        for w in self.body.winfo_children():
            w.destroy()
        info = self.ui.wiz.get("done") or {}
        self.set_head("เสร็จแล้ว", "ตั้งค่าเรียบร้อย เหลืออีกขั้นเดียว")
        top = frame(self.body)
        top.pack(fill="x")
        Mark(top, "ok", size=40).pack(side="left", anchor="n", pady=(px(2), 0))
        c = frame(top)
        c.pack(side="left", fill="x", expand=True, padx=(px(16), 0))
        L(c, ("สร้างบอท \"%s\" บนเว็บแล้ว" if info.get("kind") == "new" else "เครื่องนี้ใช้บอท \"%s\" แล้ว")
          % (info.get("name") or "Dobby"), font="h2").pack(fill="x")
        L(c, "บันทึกการตั้งค่าในเครื่องนี้แล้ว กด เริ่มทำงาน Dobby แล้วไม่ต้องทำอะไรอีก Dobby จะทำงานเอง "
             "(เปิดแอปค้างไว้ หรือเปิด ตั้งค่า > เปิดพร้อม Windows)", font="base", fg="slate", wrap=True).pack(
            fill="x", pady=(px(4), 0))
        frame(self.body, bg="hair", height=1).pack(fill="x", pady=(px(22), px(18)))
        row = frame(self.body)
        row.pack(fill="x")
        self.start_btn = Btn(row, "เริ่มทำงาน Dobby", self.start, size="lg", icon="play", width=240)
        self.start_btn.pack(side="left")
        Btn(row, "เปิดเว็บดูบอท", lambda: self.ui.ctx.open_url(WEB_URL), style="secondary", size="lg",
            icon="globe").pack(side="left", padx=(px(12), 0))

    def start(self):
        self.ui.show("main")
        self.ui.start_agent()


class WizardScreen(Screen):
    PAGES = [WelcomePage, SignInPage, ChooseBotPage, BotSettingsPage, Mt5Page, SafetyPage, FinishPage]

    def __init__(self, ui):
        Screen.__init__(self, ui)
        inner, right = app_header(self, "ตั้งค่า Dobby")
        Btn(right, "วิธีใช้", ui.open_help, style="quiet", size="sm", icon="help").pack(side="left")
        self.home_btn = Btn(right, "กลับหน้าหลัก", lambda: ui.show("main"), style="secondary", size="sm")
        self.bar = StepBar(self, WIZ_STEPS)
        self.bar.pack(fill="x", padx=px(24), pady=(px(14), px(4)))
        navbar = frame(self, bg="bg")
        navbar.pack(side="bottom", fill="x")
        frame(navbar, bg="hair", height=1).pack(fill="x")
        nav = frame(navbar)
        nav.pack(fill="x", padx=px(24), pady=px(12))
        self.back_btn = Btn(nav, "ย้อนกลับ", self.back, style="secondary")
        self.back_btn.pack(side="left")
        self.next_btn = Btn(nav, "ถัดไป", self.next, size="md", minw=150)
        self.next_btn.pack(side="right")
        self.step_lbl = L(nav, "", font="small", fg="slate")
        self.step_lbl.pack(side="right", padx=px(16))
        self.scroll = ScrollFrame(self, bg="bg")
        self.scroll.pack(fill="both", expand=True)
        self.center = Centered(self.scroll.inner, maxw=720)
        self.center.pack(fill="both", expand=True, pady=(px(18), px(28)))
        self.column = self.center.col
        self.index = -1
        self.pages = [cls(self) for cls in self.PAGES]

    def on_show(self, step=0, **kw):
        if (self.ui.cfg.get("app") or {}).get("wizard_done") and core.config_complete(self.ui.cfg):
            if not self.home_btn.winfo_manager():
                self.home_btn.pack(side="left", padx=(px(8), 0))
        elif self.home_btn.winfo_manager():
            self.home_btn.pack_forget()
        self.go(step)

    def go(self, i, direction=1):
        i = max(0, min(len(self.pages) - 1, i))
        while 0 < i < len(self.pages) - 1 and self.pages[i].skip:
            i += 1 if direction >= 0 else -1
        if 0 <= self.index < len(self.pages):
            self.pages[self.index].pack_forget()
        self.index = i
        page = self.pages[i]
        page.pack(fill="x")
        self.scroll.to_top()
        self.bar.set(i, skipped=[STEP_SETTINGS] if self.pages[STEP_SETTINGS].skip else [])
        page.on_enter()
        self.update_nav()

    def update_nav(self):
        if not (0 <= self.index < len(self.pages)):
            return
        page = self.pages[self.index]
        done = bool(self.ui.wiz.get("done"))
        if page.show_next:
            if not self.next_btn.winfo_manager():
                self.next_btn.pack(side="right", before=self.step_lbl)
            self.next_btn.set(text=page.next_label, enabled=page.can_next())
        elif self.next_btn.winfo_manager():
            self.next_btn.pack_forget()
        self.back_btn.set(enabled=self.index > 0 and not (done and self.index == STEP_FINISH) and not page.busy)
        if done and self.index == STEP_FINISH and self.bar.current != len(self.pages):
            self.bar.set(len(self.pages), skipped=self.bar.skipped)
        self.step_lbl.configure(text="ขั้นที่ %d จาก %d" % (self.index + 1, len(self.pages)))

    def back(self):
        if self.index > 0:
            self.go(self.index - 1, direction=-1)

    def next(self):
        page = self.pages[self.index]
        if not page.can_next():
            return
        res = page.on_next()
        if res is False:
            return
        if isinstance(res, int) and not isinstance(res, bool):
            self.go(res)
        elif self.index < len(self.pages) - 1:
            self.go(self.index + 1)


# ---------------------------------------------------------------------------------------------------------------------
# Main screen
# ---------------------------------------------------------------------------------------------------------------------
class Figure(tk.Frame):
    """One number of the engraved row: a slate label, the value in Chakra Petch with its unit, one sentence."""

    def __init__(self, parent, label, padx=(0, 0)):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        inner = frame(self)
        inner.pack(fill="both", expand=True, padx=padx, pady=(px(14), px(12)))
        L(inner, label, font="small", fg="slate").pack(fill="x")
        vr = frame(inner)
        vr.pack(fill="x")
        self.value = L(vr, "-", font="num", fg="faint")
        self.value.pack(side="left")
        drop = tkfont.Font(font=F["num"]).metrics("ascent") - tkfont.Font(font=F["small"]).metrics("ascent")
        self.unit = L(vr, "", font="small", fg="slate")
        self.unit.pack(side="left", anchor="n", pady=(max(0, drop), 0), padx=(px(5), 0))
        self.bar = Bar(inner, height=4)
        self.sub = L(inner, "", font="small", fg="slate", wrap=True)
        self.sub.pack(fill="x")
        self._key = None

    def set(self, value, unit="", sub="", tone=None, bar=None):
        key = (value, unit, sub, tone, bar)
        if key == self._key:
            return
        self._key = key
        self.value.configure(text=value, fg=TONE_INK.get(tone, "ink") if tone else ("faint" if value == "-" else "ink"))
        self.unit.configure(text=unit)
        self.sub.configure(text=sub)
        if bar is None:
            if self.bar.winfo_manager():
                self.bar.pack_forget()
        else:
            if not self.bar.winfo_manager():
                self.bar.pack(fill="x", pady=(px(4), px(6)), before=self.sub)
            self.bar.set(bar[0], bar[1])


class TradeMeter(tk.Canvas):
    """SL ──●────|─── TP: where the price is between the stop loss and the take profit (| = entry)."""

    def __init__(self, parent, width=190):
        tk.Canvas.__init__(self, parent, width=px(width), height=px(26), bg=_bg(parent), highlightthickness=0, bd=0)
        self.v = None
        self.bind("<Configure>", lambda e: self.redraw())

    def set(self, side, entry, sl, tp, price, tone):
        self.v = (side, entry, sl, tp, price, tone)
        self.redraw()

    def redraw(self):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 40 or not self.v:
            return
        side, entry, sl, tp, price, tone = self.v
        if None in (entry, sl, tp) or sl == tp:
            return
        x0, x1, cy = px(22), w - px(22), h / 2.0

        def X(p):
            f = (p - sl) / float(tp - sl)
            return x0 + (x1 - x0) * max(0.0, min(1.0, f))
        self.create_text(px(2), cy, text="SL", anchor="w", font=F["numT"], fill=C["slate"])
        self.create_text(w - px(2), cy, text="TP", anchor="e", font=F["numT"], fill=C["slate"])
        self.create_line(x0, cy, x1, cy, fill=C["hair2"], width=2)
        self.create_rectangle(X(entry) - 1, cy - px(5), X(entry) + 1, cy + px(5), fill=C["ink"], outline="")
        if price is not None:
            d = px(10)
            self.create_image(X(price) - d / 2.0, cy - d / 2.0, anchor="nw", image=ui_kit.dot_image(
                d, TONE_DOT.get(tone, "ink") if tone else "ink", _bg(self), 1.5))


class MainScreen(Screen):
    def __init__(self, ui):
        Screen.__init__(self, ui)
        inner, right = app_header(self)
        self.bot_btn = Btn(inner, "", lambda: ui.show("settings", tab="bot"), style="ghost", size="sm")
        self.bot_btn.pack(side="left", padx=(px(14), 0))
        Btn(right, "ตั้งค่า", lambda: ui.show("settings"), style="secondary", size="sm", icon="settings").pack(
            side="right")
        Btn(right, "เปิดเว็บ", lambda: ui.ctx.open_url(WEB_URL), style="quiet", size="sm", icon="globe").pack(
            side="right", padx=(0, px(6)))
        Btn(right, "วิธีใช้", ui.open_help, style="quiet", size="sm", icon="help").pack(side="right")
        self.ticker = frame(right)          # XAUUSD 4,015.98 +27.44 ใน 24 ชม. (shown when the bars are known)
        L(self.ticker, "XAUUSD", font="smed", fg="slate").pack(side="left")
        self.tk_price = L(self.ticker, "", font="numB")
        self.tk_price.pack(side="left", padx=(px(8), 0))
        self.tk_chg = L(self.ticker, "", font="numXS")
        self.tk_chg.pack(side="left", padx=(px(8), 0))
        self.tk_note = L(self.ticker, "", font="small", fg="slate")
        self.tk_note.pack(side="left", padx=(px(4), 0))
        self.scroll = ScrollFrame(self, bg="bg")
        self.scroll.pack(fill="both", expand=True)
        side, mtop, mbot = shadow_margins()
        self.side = side
        body = frame(self.scroll.inner)
        body.pack(fill="both", expand=True, padx=max(0, px(24) - side), pady=(max(0, px(18) - mtop), px(22)))
        # the hero: stamp, one sentence, today's P&L, the 24 h price line, the settings in use and Start / Stop
        self.hero = Box(body, fill="sheet", radius=22, padx=24, pady=20, shadow=True)
        self.hero.pack(fill="x")
        h = self.hero.body
        toprow = frame(h)
        toprow.pack(fill="x")
        self.stamp = Hallmark(toprow, 88, "slate", "หยุดอยู่")
        self.stamp.pack(side="left", anchor="n")
        self.hc = hc = frame(toprow)
        hc.pack(side="left", fill="x", expand=True, padx=(px(20), px(12)), anchor="n")
        self.hero_title = L(hc, "", font="hero", wrap=True)
        self.hero_title.pack(fill="x", pady=(px(2), 0))
        self.hero_text = L(hc, "", font="base", fg="slate", wrap=True)
        self.hero_text.pack(fill="x", pady=(px(2), 0))
        self.hero_meta = L(hc, "", font="small", fg="slate", wrap=True)
        self.next_bo = L(hc, "", font="small", fg="slate", wrap=True)     # SPEC 9.3: the next automatic blackout
        self.hero_act_row = frame(hc)
        self.hero_act = Btn(self.hero_act_row, "", self._hero_action, style="secondary", size="sm")
        self.hero_act.pack(side="left")
        self.today = frame(toprow)
        L(self.today, "กำไรขาดทุนวันนี้", font="small", fg="slate", anchor="e").pack(fill="x")
        tv = frame(self.today)
        tv.pack(anchor="e")
        self.today_val = L(tv, "", font="numL")
        self.today_val.pack(side="left")
        drop = tkfont.Font(font=F["numL"]).metrics("ascent") - tkfont.Font(font=F["small"]).metrics("ascent")
        self.today_unit = L(tv, "USD", font="small", fg="slate")
        self.today_unit.pack(side="left", anchor="n", pady=(max(0, drop - px(2)), 0), padx=(px(6), 0))
        self.chart = PriceLine(h, height=150)
        self.chart.pack(fill="x", pady=(px(14), 0))
        frame(h, bg="hair_s", height=1).pack(fill="x", pady=(px(10), px(14)))
        foot = frame(h)
        foot.pack(fill="x")
        self.big = Btn(foot, "เริ่มทำงาน Dobby", self.toggle, size="md", icon="play")
        self.big.pack(side="right", anchor="center")
        self.web_btn = Btn(foot, "แก้ไขบนเว็บ", lambda: ui.ctx.open_url(WEB_URL), style="secondary", size="md",
                           icon="open")
        self.web_btn.pack(side="right", anchor="center", padx=(0, px(8)))
        sc = frame(foot)
        sc.pack(side="left", fill="x", expand=True, padx=(0, px(18)))
        self.set_src = L(sc, "", font="sbold", fg="ink", wrap=True)
        self.set_src.pack(fill="x")
        self.set_lines = L(sc, "", font="small", fg="slate", wrap=True)
        self.set_lines.pack(fill="x")
        self.hero_key = None
        self.hero_action = None
        self.set_key = None
        # the engraved numbers row
        figs = frame(body)
        figs.pack(fill="x", padx=side, pady=(px(14), 0))
        frame(figs, bg="hair", height=1).grid(row=0, column=0, columnspan=7, sticky="ew")
        self.f_balance = Figure(figs, "ยอดเงินในบัญชี", padx=(0, px(18)))
        self.f_equity = Figure(figs, "มูลค่ารวมไม้ที่เปิด", padx=(px(18), px(18)))
        self.f_today = Figure(figs, "วันนี้", padx=(px(18), px(18)))
        self.f_start = Figure(figs, "ตั้งแต่เริ่ม", padx=(px(18), 0))
        for i, f in enumerate((self.f_balance, self.f_equity, self.f_today, self.f_start)):
            f.grid(row=1, column=2 * i, sticky="nsew")
            figs.columnconfigure(2 * i, weight=1, uniform="figs")
            if i < 3:
                frame(figs, bg="hair", width=1).grid(row=1, column=2 * i + 1, sticky="ns")
        frame(figs, bg="hair", height=1).grid(row=2, column=0, columnspan=7, sticky="ew")
        self.figs = figs
        # open trades
        self.pos_g = frame(body)
        L(self.pos_g, "ไม้ที่เปิดอยู่", font="h3").pack(fill="x", pady=(0, px(4)))
        self.pos_rows = frame(self.pos_g)
        self.pos_rows.pack(fill="x")
        self.pos_key = None
        # readiness (a quiet list) and recent activity (a clean list)
        low = self.low = frame(body)
        low.pack(fill="both", expand=True, padx=side, pady=(px(26), 0))
        low.columnconfigure(0, weight=5, uniform="low")
        low.columnconfigure(1, minsize=px(40))
        low.columnconfigure(2, weight=7, uniform="low")
        chk = frame(low)
        chk.grid(row=0, column=0, sticky="nsew")
        L(chk, "ความพร้อม", font="h3").pack(fill="x", pady=(0, px(4)))
        self.rows = {}
        for i, key in enumerate(("signin", "linked", "ea", "algo", "live", "web")):
            if i:
                frame(chk, bg="hair", height=1).pack(fill="x", padx=(px(28), 0))
            r = frame(chk)
            r.pack(fill="x", pady=px(7))
            ic = Mark(r, "idle", size=18, quiet=True)
            ic.pack(side="left", anchor="n", pady=(px(2), 0))
            c = frame(r)
            c.pack(side="left", fill="x", expand=True, padx=(px(10), 0))
            t = L(c, "", font="med")
            t.pack(fill="x")
            d = L(c, "", font="small", fg="slate", wrap=True)
            d.pack(fill="x")
            self.rows[key] = (r, ic, t, d)
        act = frame(low)
        act.grid(row=0, column=2, sticky="nsew")
        ah = frame(act)
        ah.pack(fill="x", pady=(0, px(4)))
        L(ah, "ล่าสุด", font="h3").pack(side="left")
        Link(ah, "ดูบันทึกละเอียด", lambda: ui.show("log"), font="slink").pack(side="right", anchor="s",
                                                                              pady=(0, px(3)))
        self.act_box = frame(act)
        self.act_box.pack(fill="x")
        self.act_key = None
        self._bars_cache = (object(), None, (None, None))

    def on_show(self, **kw):
        self.refresh()

    def toggle(self):
        ui = self.ui
        if ui.runner.running:
            if not ui.runner.stopping:
                ui.stop_agent()
        elif not core.config_complete(ui.cfg):
            ui.start_wizard(STEP_SIGNIN if not ui.cfg.get("refresh_token") else STEP_BOT)
        else:
            ui.start_agent()
        self.refresh()

    def _hero_action(self):
        a = self.hero_action
        ui = self.ui
        if a == "start":
            ui.start_agent()
        elif a == "wizard":
            ui.start_wizard(STEP_SIGNIN if not ui.cfg.get("refresh_token") else STEP_BOT)
        elif a == "signin":
            ui.approved = None              # the login failed: re-check the saved login instead of showing "signed in"
            ui.start_wizard(STEP_SIGNIN)
        elif a == "mt5":
            ui.show("mt5")
        elif a == "algo_help":
            ui.algo_help()
        elif a == "web":
            ui.ctx.open_url(WEB_URL)
        elif a == "safety":
            ui.show("settings", tab="safety")
        self.refresh()

    def _offset(self, running, snap):
        """The agent's effective server offset (config, or confirmed by fresh ticks) for the price line's times."""
        off = (snap or {}).get("offset") if running else None
        if isinstance(off, (list, tuple)) and len(off) == 2 and off[0] is not None and off[1] in ("confirmed",
                                                                                                    "config"):
            return int(off[0])
        return da.config_offset(self.ui.cfg)

    def _bars(self, text, offset):
        if self._bars_cache[:2] != (text, offset):
            self._bars_cache = (text, offset, core.bars_for_chart(text, offset))
        return self._bars_cache[2]

    def refresh(self):
        ui = self.ui
        cfg = ui.cfg
        now = time.time()
        running, stopping = ui.runner.running, ui.runner.stopping
        snap = ui.snap if running else None
        status = ui.status
        complete = core.config_complete(cfg)
        self.bot_btn.set(text=("บอท " + cfg.get("bot_name")) if cfg.get("bot_name") else "ยังไม่ได้เลือกบอท")
        hs = core.hero_state(cfg, status, snap, now, running, stopping, ui.phase, ui.lock_problem, ui.agent_error,
                             ui.runner.started_at if running else None)
        key = (hs["tone"], hs["title"], hs["action"], hs["action_label"], hs.get("stamp"))
        if key != self.hero_key:
            self.hero_key = key
            self.stamp.set(*(hs.get("stamp") or ("slate", "")))
            self.hero_title.configure(text=hs["title"])
            self.hero_action = hs["action"] if hs["action"] != "start" else None
            if self.hero_action:
                self.hero_act.set(text=hs["action_label"] or "")
                if not self.hero_act_row.winfo_manager():
                    self.hero_act_row.pack(fill="x", pady=(px(10), 0))
            elif self.hero_act_row.winfo_manager():
                self.hero_act_row.pack_forget()
        self.hero_text.configure(text=hs["text"])
        if stopping:
            self.big.set("กำลังหยุด…", style="secondary", icon="timer", enabled=False)
        elif running:
            self.big.set("หยุดทำงาน", style="secondary", icon="stop", enabled=True)
        elif complete:
            self.big.set("เริ่มทำงาน Dobby", style="primary", icon="play", enabled=True)
        else:
            self.big.set("ตั้งค่าให้เสร็จ", style="primary", icon="", enabled=True)
        # checklist
        items = core.build_checklist(cfg, status, snap, now, running)
        for it in items:
            r, ic, t, d = self.rows[it["key"]]
            ic.set(it["state"])
            t.configure(text=it["title"], fg="ink" if it["state"] != "idle" else "slate")
            d.configure(text=it["detail"])
        # numbers
        s = core.summarize_status(status, now)
        ea_on = s["age"] is not None and s["age"] < core.EA_ONLINE_S
        cur = s["currency"] or "USD"
        bars, offset = self._bars(ui.bars_text, self._offset(running, snap))
        price = bars["c"][-1] if bars else None
        self._ticker(bars)
        if s["has_status"]:
            mode = {"REAL": "บัญชีจริงที่โบรก", "DEMO": "บัญชีทดลองที่โบรก"}.get(s["mode"], "บัญชี %s" % (s["mode"] or "-"))
            self.f_balance.set(num_text(s["balance"]), cur, mode)
            open_pl = sum(da.to_num(p.get("profit")) or 0.0 for p in s["positions"])
            self.f_equity.set(num_text(s["equity"]), cur, ("ไม้ที่เปิดอยู่ %s" % num_text(open_pl, True))
                              if s["positions"] else "ไม่มีไม้เปิดอยู่")
            pnl = s["day_pnl"]
            tone = "good" if (pnl or 0) > 0 else "bad" if (pnl or 0) < 0 else None
            used = s["cap_used"]
            if s["cap_hit"]:
                sub = "ถึงเพดานขาดทุนวันนี้แล้ว Dobby หยุดเปิดไม้ใหม่ถึงวันใหม่"
            elif s["cap_amount"]:
                stop = "%s\u00a0(%s%%)" % (num_text(-s["cap_amount"]), core.pct_text(s["cap_pct"]))
                sub = ("ยังไม่ขาดทุน จุดหยุดอยู่ที่ %s" % stop) if not used else \
                    ("ใช้เพดานไป %d%% ของจุดหยุดที่ %s" % (round(used * 100), stop))
            else:
                sub = "เทียบกับทุนต้นวัน"
            bar = (used or 0.0, "bad" if s["cap_hit"] or (used or 0) >= 0.8 else "warn" if (used or 0) >= 0.5
                   else "good") if s["cap_amount"] else None
            self.f_today.set(num_text(pnl, True), cur, sub, tone, bar)
            vb, vs = s["v_balance"], s["v_start"]
            if vb is not None and vs:
                gain = vb - vs
                bits = "%s จากทุน\u00a0%s" % (num_text(gain / vs * 100.0, True, 1) + "%", format(vs, ",.0f"))
                if s["trades"]:
                    bits += " ใน\u00a0%d\u00a0ไม้" % s["trades"]
                    if s["wins"] is not None:
                        bits += " ชนะ\u00a0%d%%" % round(100.0 * s["wins"] / s["trades"])
                self.f_start.set(num_text(gain, True), cur, bits, "good" if gain > 0 else "bad" if gain < 0 else None)
            else:
                self.f_start.set("-", "", "")
            self.today_val.configure(text=num_text(pnl, True), fg=("slate" if not ea_on else
                                                                   TONE_INK.get(tone, "ink") if tone else "ink"))
            self.today_unit.configure(text=cur)
            if not self.today.winfo_manager():
                self.today.pack(side="right", anchor="n", before=self.hc)
            meta = ("มีไม้เปิดอยู่ %d ไม้" % len(s["positions"])) if s["positions"] else "ไม่มีไม้เปิดอยู่"
            self.hero_meta.configure(text=meta if ea_on else "ข้อมูลล่าสุดจาก Dobby เมื่อ %s" % core.ago_th(s["age"]))
            if not self.hero_meta.winfo_manager():
                self.hero_meta.pack(fill="x", pady=(px(2), 0), after=self.hero_text)
        else:
            self.f_balance.set("-", "", "รอข้อมูลจาก Dobby ใน MT5")
            for f in (self.f_equity, self.f_today, self.f_start):
                f.set("-", "", "")
            if self.today.winfo_manager():
                self.today.pack_forget()
            if self.hero_meta.winfo_manager():
                self.hero_meta.pack_forget()
        nb = core.next_blackout_th((snap or {}).get("auto_blackouts"), now) if running else ""
        if nb:
            self.next_bo.configure(text=nb)
            if not self.next_bo.winfo_manager():
                self.next_bo.pack(fill="x", pady=(px(2), 0),
                                  after=self.hero_meta if self.hero_meta.winfo_manager() else self.hero_text)
        elif self.next_bo.winfo_manager():
            self.next_bo.pack_forget()
        marks = []
        if offset is not None:
            for p in s["positions"]:
                dt = da.parse_server_dt(p.get("open_time"))
                op = da.to_num(p.get("open_price"))
                if dt is not None and op:
                    marks.append((da.naive_to_epoch(dt) - offset * 60, op,
                                  "sell" if str(p.get("side") or "").upper() == "SELL" else "buy"))
        self.chart.set(bars, offset, marks)
        self._positions(s if s["has_status"] else None, price)
        self._settings_card(status, (snap or {}).get("web_desired") or ui.web_desired, ea_on)
        self._activity()

    def _ticker(self, bars):
        if not bars or len(bars["c"]) < 2:
            if self.ticker.winfo_manager():
                self.ticker.pack_forget()
            return
        c = bars["c"]
        chg = c[-1] - c[0]
        self.tk_price.configure(text=num_text(c[-1]))
        self.tk_chg.configure(text=num_text(chg, True), fg="jade" if chg > 0 else "cinnabar" if chg < 0 else "slate")
        span = bars["t"][-1] - bars["t"][0]
        self.tk_note.configure(text="ใน 24 ชม." if span >= 20 * 3600 else "ใน %d ชม." % max(1, round(span / 3600.0)))
        if not self.ticker.winfo_manager():
            self.ticker.pack(side="right", padx=(0, px(18)))

    def _positions(self, s, price):
        if s is None:
            if self.pos_g.winfo_manager():
                self.pos_g.pack_forget()
            return
        if not self.pos_g.winfo_manager():
            self.pos_g.pack(fill="x", padx=self.side, pady=(px(22), 0), before=self.low)
        pos = s["positions"]
        key = (tuple((p.get("module"), p.get("side"), p.get("lots"), p.get("open_price"), p.get("sl"), p.get("tp"),
                      p.get("profit")) for p in pos), price)
        if key == self.pos_key:
            return
        self.pos_key = key
        for w in self.pos_rows.winfo_children():
            w.destroy()
        if not pos:
            L(self.pos_rows, "ตอนนี้ไม่มีไม้เปิดอยู่", font="small", fg="slate").pack(fill="x", pady=(px(2), 0))
            return
        for i, p in enumerate(pos):
            if i:
                frame(self.pos_rows, bg="hair", height=1).pack(fill="x")
            r = frame(self.pos_rows)
            r.pack(fill="x", pady=px(8))
            prof = da.to_num(p.get("profit"))
            tone = "good" if (prof or 0) > 0 else "bad" if (prof or 0) < 0 else None
            sell = str(p.get("side") or "").upper() == "SELL"
            L(r, p.get("module") or "-", font="bold").pack(side="left")
            L(r, core.SIDE_TH.get(str(p.get("side") or "").upper(), p.get("side") or ""), font="med",
              fg="cinnabar" if sell else "jade").pack(side="left", padx=(px(10), 0))
            L(r, da._f2(da.to_num(p.get("lots"))), font="numS").pack(side="left", padx=(px(12), 0))
            L(r, "ล็อต เข้าที่", font="small", fg="slate").pack(side="left", padx=(px(4), 0))
            L(r, num_text(da.to_num(p.get("open_price"))), font="numS").pack(side="left", padx=(px(4), 0))
            L(r, num_text(prof, True) if prof is not None else "-", font="numB",
              fg=TONE_INK.get(tone, "ink") if tone else "ink").pack(side="right")
            m = TradeMeter(r)
            m.pack(side="right", padx=(0, px(24)))
            m.set("SELL" if sell else "BUY", da.to_num(p.get("open_price")), da.to_num(p.get("sl")),
                  da.to_num(p.get("tp")), price, tone)

    def _settings_card(self, status, desired, ea_on):
        s, src = core.current_settings(status, desired, ea_on)
        sentence = core.settings_sentence(s) if s else ""
        key = (sentence, src)
        if key == self.set_key:
            return
        self.set_key = key
        if not s:
            self.set_src.configure(text="ค่าที่ใช้อยู่")
            self.set_lines.configure(text="จะแสดงเมื่อ Dobby ใน MT5 ทำงาน")
            return
        self.set_src.configure(text=core.SETTINGS_SOURCE_TH.get(src, "ค่าที่ใช้อยู่"))
        self.set_lines.configure(text=sentence)

    def _activity(self):
        items = list(self.ui.activity)[-6:][::-1]
        key = tuple((it["t"], it["text"]) for it in items)
        if key == self.act_key:
            return
        self.act_key = key
        for w in self.act_box.winfo_children():
            w.destroy()
        if not items:
            L(self.act_box, "ยังไม่มีความเคลื่อนไหว กด เริ่มทำงาน Dobby แล้วรายการจะขึ้นที่นี่", font="small", fg="slate",
              wrap=True).pack(fill="x", pady=(px(6), 0))
            return
        for i, it in enumerate(items):
            if i:
                frame(self.act_box, bg="hair", height=1).pack(fill="x")
            r = frame(self.act_box)
            r.pack(fill="x", pady=px(7))
            L(r, it["when"], font="numXS", fg="slate", width=5).pack(side="left", anchor="n", pady=(px(1), 0))
            tk.Label(r, image=ui_kit.dot_image(px(7), TONE_DOT.get(it["tone"], "slate")), bg=_bg(r),
                     bd=0).pack(side="left", anchor="n", pady=(px(8), 0), padx=(px(6), px(10)))
            L(r, it["text"], font="small", fg="ink", wrap=True).pack(side="left", fill="x", expand=True)


# ---------------------------------------------------------------------------------------------------------------------
# MT5 screen (from the main screen: "เชื่อม MT5" / Settings > บอท)
# ---------------------------------------------------------------------------------------------------------------------
class Mt5Screen(Screen):
    def __init__(self, ui):
        Screen.__init__(self, ui)
        app_header(self, "เชื่อม MT5", back=lambda: ui.show("main"))
        self.scroll = ScrollFrame(self, bg="bg")
        self.scroll.pack(fill="both", expand=True)
        center = Centered(self.scroll.inner, maxw=720)
        center.pack(fill="both", expand=True, pady=(px(22), px(28)))
        L(center.col, "เชื่อม MT5 กับ Dobby", font="h1").pack(fill="x")
        L(center.col, "ติดตั้ง Dobby ลงใน MT5 แล้วให้แอปเปิด MT5 พร้อม Dobby หรือทำเองตามขั้นตอน", font="base", fg="slate",
          wrap=True).pack(fill="x", pady=(px(4), px(22)))
        self.panel = Mt5Panel(center.col, ui)
        self.panel.pack(fill="x")

    def on_show(self, **kw):
        self.scroll.to_top()
        self.panel.on_enter()


# ---------------------------------------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------------------------------------
class SettingsScreen(Screen):
    SECTIONS = [("safety", "ความปลอดภัย", "shield"), ("bot", "บอท", "robot"), ("telegram", "Telegram", "send"),
                ("startup", "เปิดพร้อม Windows", "power"), ("account", "บัญชี", "person"),
                ("advanced", "ขั้นสูง", "gears")]

    def __init__(self, ui):
        Screen.__init__(self, ui)
        app_header(self, "ตั้งค่า", back=self.close)
        bottom = frame(self, bg="bg")
        bottom.pack(side="bottom", fill="x")
        frame(bottom, bg="hair", height=1).pack(fill="x")
        bb = frame(bottom)
        bb.pack(fill="x", padx=px(24), pady=px(12))
        Btn(bb, "บันทึกการตั้งค่า", self.save, icon="check").pack(side="right")
        Btn(bb, "ยกเลิก", self.close, style="secondary").pack(side="right", padx=(0, px(8)))
        self.saved_lbl = L(bb, "", font="med", fg="jade")
        self.saved_lbl.pack(side="left")
        body = frame(self)
        body.pack(fill="both", expand=True, padx=(px(14), px(8)), pady=(px(18), px(6)))
        nav = frame(body)
        nav.pack(side="left", fill="y")
        self.nav_items = {}
        for key, title, icon in self.SECTIONS:
            row = frame(nav)
            row.pack(fill="x", pady=(0, px(2)))
            bar = frame(row, bg="bg", width=px(3))
            bar.pack(side="left", fill="y", padx=(0, px(6)))
            item = Box(row, fill="bg", border=None, radius=10, padx=12, pady=8)
            item.pack(side="left", fill="x", expand=True)
            g = glyph(item.body, icon, "icon", fg="slate")
            g.pack(side="left")
            t = L(item.body, title, font="med", fg="ink", width=17)
            t.pack(side="left", padx=(px(10), 0))
            for w in (item, item.body, g, t):
                w.configure(cursor="hand2")
                w.bind("<Button-1>", lambda e, k=key: self.select(k))
            self.nav_items[key] = (item, g, t, bar)
        frame(body, bg="hair", width=1).pack(side="left", fill="y", padx=(px(14), 0))
        right = frame(body)
        right.pack(side="left", fill="both", expand=True, padx=(px(26), 0))
        self.banner = Banner(right, pady=(0, px(12)))
        self.banner.pack(fill="x")
        self.scroll = ScrollFrame(right, bg="bg")
        self.scroll.pack(fill="both", expand=True)
        self.pages = {}
        for key, title, icon in self.SECTIONS:
            f = frame(self.scroll.inner)
            self.pages[key] = f
            getattr(self, "_build_" + key)(f)
        self.current = None

    def select(self, key):
        for k, (item, g, t, bar) in self.nav_items.items():
            on = k == key
            item.set_fill("well2" if on else "bg")
            bar.configure(bg=C["gold"] if on else C["bg"])
            g.configure(fg=C["ink"] if on else C["slate"])
            t.configure(font="bold" if on else "med")
        if self.current:
            self.pages[self.current].pack_forget()
        self.current = key
        self.pages[key].pack(fill="x", padx=(0, px(18)), pady=(0, px(12)))
        self.scroll.to_top()

    # -- sections
    def _card(self, parent, title, why=None, icon=None):
        """A settings group: a hairline above (not on the first), the heading and one sentence."""
        first = not parent.winfo_children()
        return group(parent, title, why, rule=not first, top=26)

    def _build_safety(self, p):
        self.safety = SafetyForm(p, self.ui)
        self.safety.pack(fill="x")

    def _build_bot(self, p):
        b = self._card(p, "บอทของเครื่องนี้", "บอทบนเว็บหนึ่งตัวใช้กับ MT5 หนึ่งเครื่อง ข้อมูลและคำสั่งของบอทนี้ใช้กับ MT5 ในเครื่องนี้")
        self.bot_info = frame(b)
        self.bot_info.pack(fill="x", pady=(px(14), 0))
        row = frame(b)
        row.pack(fill="x", pady=(px(16), 0))
        Btn(row, "เปลี่ยนหรือเชื่อมบอทอื่น", lambda: self.ui.start_wizard(STEP_BOT), style="secondary",
            icon="link").pack(side="left")
        Btn(row, "เชื่อม MT5", lambda: self.ui.show("mt5"), style="secondary", icon="laptop").pack(side="left",
                                                                                                 padx=(px(8), 0))
        b = self._card(p, "ยกเลิกการเชื่อม", "เครื่องนี้จะเลิกส่งข้อมูลและรับคำสั่งจากบอท ส่วนบอทบนเว็บยังอยู่ (ลบได้ที่เว็บ)")
        self.unlink_btn = Btn(b, "ยกเลิกการเชื่อมเครื่องนี้", self.unlink, style="danger", size="sm")
        self.unlink_btn.pack(anchor="w", pady=(px(14), 0))

    def _build_telegram(self, p):
        b = self._card(p, "แจ้งเตือนทาง Telegram (ไม่บังคับ)",
                       "แจ้งเมื่อเปิดหรือปิดไม้ ล็อกกำไร ถึงเพดานขาดทุน Dobby ออฟไลน์ และสรุปรายวัน")
        L(b, "Bot token (จาก @BotFather)", font="med").pack(fill="x", pady=(px(16), px(6)))
        self.tg_token = Field(b, width=50, show="•", pady=7)
        self.tg_token.pack(fill="x")
        r = frame(b)
        r.pack(fill="x", pady=(px(8), 0))
        self.tg_show = tk.BooleanVar(value=False)
        Toggle(r, self.tg_show, command=lambda: self.tg_token.entry.configure(
            show="" if self.tg_show.get() else "•")).pack(side="left")
        L(r, "แสดง token", font="small", fg="ink").pack(side="left", padx=(px(10), 0))
        L(b, "Chat id", font="med").pack(fill="x", pady=(px(14), px(6)))
        self.tg_chat = Field(b, width=22, pady=7)
        self.tg_chat.pack(anchor="w")
        L(b, "ใน Telegram คุยกับ @BotFather แล้วพิมพ์ /newbot จะได้ token จากนั้นส่งข้อความหาบอทของคุณ 1 ครั้ง และถาม "
             "@userinfobot เพื่อดูตัวเลข chat id", font="small", fg="slate", wrap=True).pack(fill="x", pady=(px(8), 0))
        r = frame(b)
        r.pack(fill="x", pady=(px(14), 0))
        self.tg_btn = Btn(r, "ส่งข้อความทดสอบ", self.test_telegram, style="secondary", size="sm", icon="send")
        self.tg_btn.pack(side="left")
        self.tg_result = L(r, "", font="med", fg="slate")
        self.tg_result.pack(side="left", padx=(px(12), 0))

    def _build_startup(self, p):
        b = self._card(p, "การเริ่มทำงาน", "ให้ Dobby ทำงานเองหลังเปิดเครื่อง ไม่ต้องจำ")
        self.with_windows = tk.BooleanVar()
        self.auto_start = tk.BooleanVar()
        for i, (var, title, text) in enumerate((
                (self.with_windows, "เปิดพร้อม Windows",
                 "เปิดแอปเองหลังเปิดเครื่อง (ย่อไว้ที่แถบงาน) และเริ่มทำงานให้ถ้าตั้งค่าครบ โดยสร้างไฟล์เล็ก ๆ หนึ่งไฟล์ "
                 "ในโฟลเดอร์ Startup ของผู้ใช้นี้เท่านั้น ปิดเมื่อไรก็ลบไฟล์นั้นให้"),
                (self.auto_start, "เริ่มทำงานอัตโนมัติเมื่อเปิดแอป", "ไม่ต้องกดปุ่ม เริ่มทำงาน Dobby ทุกครั้งที่เปิดแอป"))):
            r = Row(b, title, text, rule=i > 0)
            r.pack(fill="x", pady=(px(8) if i == 0 else 0, 0))
            Toggle(r.ctl, var).pack()
        self.launcher_lbl = L(b, "", font="small", fg="slate", wrap=True)
        self.launcher_lbl.pack(fill="x", pady=(px(12), 0))

    def _build_account(self, p):
        b = self._card(p, "บัญชีเว็บ Dobby")
        r = frame(b)
        r.pack(fill="x", pady=(px(12), 0))
        self.acc_btn = Btn(r, "ออกจากระบบ", self.sign_out, style="secondary", size="sm")
        self.acc_btn.pack(side="right")
        self.acc_lbl = L(r, "", font="base", fg="ink")
        self.acc_lbl.pack(side="left")
        b = self._card(p, "ตัวช่วยตั้งค่า", "ใช้เมื่อต้องการเปลี่ยนบัญชี เปลี่ยนบอท หรือตั้ง MT5 ใหม่")
        Btn(b, "เปิดตัวช่วยตั้งค่าอีกครั้ง", lambda: self.ui.start_wizard(STEP_WELCOME), style="secondary",
            size="sm").pack(anchor="w", pady=(px(14), 0))

    def _build_advanced(self, p):
        b = self._card(p, "เซิร์ฟเวอร์", "ปกติไม่ต้องแก้ ถ้าเปลี่ยนต้องเข้าสู่ระบบใหม่")
        L(b, "Supabase URL", font="med").pack(fill="x", pady=(px(14), px(6)))
        self.adv_url = Field(b, width=56, pady=7)
        self.adv_url.pack(fill="x")
        L(b, "Publishable key (คีย์สาธารณะ)", font="med").pack(fill="x", pady=(px(12), px(6)))
        self.adv_key = Field(b, width=56, pady=7)
        self.adv_key.pack(fill="x")
        b = self._card(p, "โฟลเดอร์ไฟล์ของ Dobby",
                       "ว่างไว้เพื่อใช้ค่าเริ่มต้นของ MT5 (Common\\Files\\Dobby) มีผลตอนกดเริ่มครั้งถัดไป")
        r = frame(b)
        r.pack(fill="x", pady=(px(14), 0))
        self.adv_common = Field(r, width=48, pady=7)
        self.adv_common.pack(side="left", fill="x", expand=True)
        Btn(r, "เลือก…", self.pick_common, style="secondary", size="sm").pack(side="left", padx=(px(8), 0))
        b = self._card(p, "ข้อมูลของแอป")
        r = frame(b)
        r.pack(fill="x", pady=(px(14), 0))
        Btn(r, "เปิดโฟลเดอร์", lambda: self.ui.ctx.open_path(self.ui.ctx.data_dir), style="secondary",
            size="sm", icon="folder").pack(side="right", anchor="n", padx=(px(12), 0))
        L(r, self.ui.ctx.data_dir, font="small", fg="ink", wrap=True).pack(side="left", fill="x", expand=True)
        r = frame(b)
        r.pack(fill="x", pady=(px(12), 0))
        Btn(r, "ดูบันทึกละเอียด", lambda: self.ui.show("log"), style="secondary", size="sm", icon="list").pack(
            side="left")
        L(b, "Dobby App รุ่น %s ใช้ agent รุ่น %s" % (APP_VERSION, da.AGENT_VERSION), font="small", fg="slate").pack(
            fill="x", pady=(px(14), 0))

    # -- behaviour
    def on_show(self, tab=None, **kw):
        cfg = self.ui.cfg
        self.banner.hide()
        self.saved_lbl.configure(text="")
        lim = da.get_limits(cfg)
        self.safety.set(lim, lim["max_lots"])
        tg = cfg.get("telegram") or {}
        for f, v in ((self.tg_token, tg.get("token") or ""), (self.tg_chat, str(tg.get("chat_id") or "")),
                     (self.adv_url, cfg.get("supabase_url") or ""), (self.adv_key, cfg.get("anon_key") or ""),
                     (self.adv_common, cfg.get("common_dir") or "")):
            f.set(v)
        self.tg_result.configure(text="")
        app = cfg.get("app") or {}
        folder = self.ui.ctx.startup_folder()
        self.with_windows.set(core.launcher_exists(folder))
        self.auto_start.set(bool(app.get("auto_start")))
        self.launcher_lbl.configure(text="ไฟล์เปิดพร้อม Windows อยู่ที่ %s" % core.launcher_path(folder))
        self.refresh_account()
        self.select(tab or self.current or "safety")

    def refresh_account(self):
        cfg = self.ui.cfg
        if cfg.get("refresh_token"):
            self.acc_lbl.configure(text="เข้าสู่ระบบด้วย %s" % (cfg.get("email") or "-"))
            self.acc_btn.set(text="ออกจากระบบ", command=self.sign_out)
        else:
            self.acc_lbl.configure(text="ยังไม่ได้เข้าสู่ระบบ")
            self.acc_btn.set(text="เข้าสู่ระบบ", command=lambda: self.ui.start_wizard(STEP_SIGNIN))
        for w in self.bot_info.winfo_children():
            w.destroy()
        pending = (cfg.get("app") or {}).get("pending_bot_name")
        c = frame(self.bot_info)
        c.pack(fill="x")
        st = self.ui.status or {}
        if cfg.get("bot_id"):
            L(c, cfg.get("bot_name") or "Dobby", font="h2").pack(fill="x")
            L(c, "Dobby%s รหัสบอท %s…" % ((" v" + str(st["ea_version"])) if st.get("ea_version") else "",
                                         cfg["bot_id"][:8]), font="small", fg="slate").pack(fill="x")
            self.unlink_btn.set(enabled=True)
        elif pending:
            L(c, pending, font="h2").pack(fill="x")
            L(c, "รอสร้างบอทบนเว็บเมื่อ Dobby ใน MT5 ทำงาน", font="small", fg="slate").pack(fill="x")
            self.unlink_btn.set(enabled=True)
        else:
            L(c, "ยังไม่ได้เชื่อมกับบอท", font="h2").pack(fill="x")
            L(c, "กด เปลี่ยนหรือเชื่อมบอทอื่น เพื่อเลือกบอท", font="small", fg="slate").pack(fill="x")
            self.unlink_btn.set(enabled=False)
        mt5 = (cfg.get("app") or {}).get("mt5_data_dir")
        L(c, "MT5 ที่ใช้: %s" % (mt5 or "ยังไม่ได้เลือก"), font="small", fg="slate", wrap=True).pack(fill="x",
                                                                                               pady=(px(6), 0))

    def close(self):
        self.ui.show("main" if (self.ui.cfg.get("app") or {}).get("wizard_done") else "wizard")

    def pick_common(self):
        d = filedialog.askdirectory(parent=self.ui.root, title="เลือกโฟลเดอร์ไฟล์ของ Dobby (Common\\Files\\Dobby)")
        if d:
            self.adv_common.set(os.path.normpath(d))

    def save(self):
        ui = self.ui
        lim, err = self.safety.get()
        if err:
            self.select("safety")
            self.banner.show("bad", err)
            return
        url, key = self.adv_url.get().strip().rstrip("/"), self.adv_key.get().strip()
        if not da._valid_url(url) or not key:
            self.select("advanced")
            self.banner.show("bad", "ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง", "URL ต้องขึ้นต้นด้วย https:// และต้องมีคีย์")
            return
        server_changed = url != ui.cfg.get("supabase_url") or key != ui.cfg.get("anon_key")
        if server_changed and ui.runner.running:
            self.select("advanced")
            self.banner.show("bad", "หยุดการทำงานก่อนเปลี่ยนเซิร์ฟเวอร์")
            return
        common = self.adv_common.get().strip() or None
        token, chat = self.tg_token.get().strip(), self.tg_chat.get().strip()

        def mut(c):
            c["limits"] = lim
            c.setdefault("telegram", {}).update(token=token, chat_id=chat)
            c["telegram"].setdefault("events", list(da.TELEGRAM_EVENTS))
            c["common_dir"] = common
            c["app"]["auto_start"] = bool(self.auto_start.get())
            c["app"]["start_with_windows"] = bool(self.with_windows.get())
            if server_changed:
                c.update(supabase_url=url, anon_key=key, refresh_token="")
        core.update_app_config(ui.ctx.data_dir, mut)
        da.add_secret(token)
        folder = ui.ctx.startup_folder()
        try:
            if self.with_windows.get():
                core.create_launcher(folder, core.app_command())
            else:
                core.remove_launcher(folder)
        except OSError as e:
            self.banner.show("bad", "ตั้งค่าเปิดพร้อม Windows ไม่สำเร็จ", str(e))
        ui.reload_cfg()
        if server_changed:
            ui.rebuild_client()
            ui.approved = None
        self.refresh_account()
        LOG.info("settings saved (limits: control %s, live %s, params %s, max lots %.2f, max cap %g%%)",
                 lim["allow_remote_control"], lim["allow_remote_live"], lim["allow_remote_params"], lim["max_lots"],
                 lim["max_daily_cap_pct"])
        self.saved_lbl.configure(text="บันทึกแล้ว" + (" เข้าสู่ระบบใหม่ในตัวช่วยตั้งค่า" if server_changed else ""))

    def test_telegram(self):
        token, chat = self.tg_token.get().strip(), self.tg_chat.get().strip()
        if not token or not chat:
            self.tg_result.configure(text="ใส่ token และ chat id ก่อน", fg="cinnabar")
            return
        self.tg_btn.set(enabled=False)
        self.tg_result.configure(text="กำลังส่ง…", fg="slate")
        tg = da.Telegram(self.ui.ctx.transport(), token, chat)
        name = self.ui.cfg.get("bot_name") or "Dobby"
        self.ui.bg(lambda: tg.send_now(da.msg_test(name)), self._tg_done, lambda e: self._tg_done((False, str(e))))

    def _tg_done(self, res):
        ok, info = res
        self.tg_btn.set(enabled=True)
        self.tg_result.configure(text="ส่งแล้ว ดูใน Telegram ของคุณ" if ok else "ส่งไม่สำเร็จ ตรวจ token และ chat id",
                                 fg="jade" if ok else "cinnabar")

    def sign_out(self):
        ui = self.ui
        if not ui.ask_yes_no("ออกจากระบบ?", "แอปจะลืมการเข้าสู่ระบบของเครื่องนี้ และหยุดทำงาน (ถ้ากำลังทำงานอยู่)\n"
                                             "เข้าสู่ระบบใหม่ได้ในตัวช่วยตั้งค่า"):
            return
        ui.stop_agent()
        core.sign_out(ui.ctx.data_dir, ui.client)
        ui.approved = None
        ui.wiz = new_wizard_state()
        ui.reload_cfg()
        LOG.info("signed out (refresh token forgotten)")
        self.refresh_account()
        self.banner.show("good", "ออกจากระบบแล้ว")

    def unlink(self):
        ui = self.ui
        if not ui.ask_yes_no("ยกเลิกการเชื่อมเครื่องนี้?", "เครื่องนี้จะเลิกส่งข้อมูลและรับคำสั่งจากบอท \"%s\"\n"
                                                         "บอทบนเว็บยังอยู่ (ลบได้ที่เว็บ) เชื่อมใหม่ได้ในตัวช่วยตั้งค่า"
                             % (ui.cfg.get("bot_name") or "")):
            return
        if ui.runner.running:
            ui.stop_agent()
            self.banner.show("info", "กำลังหยุดทำงาน… กดอีกครั้งเมื่อหยุดแล้ว")
            return
        core.unlink_pc(ui.ctx.data_dir)
        ui.reload_cfg()
        LOG.info("this PC was unlinked from its bot")
        self.refresh_account()
        self.banner.show("good", "ยกเลิกการเชื่อมแล้ว", "กด เปลี่ยนหรือเชื่อมบอทอื่น เพื่อเลือกบอทใหม่")


# ---------------------------------------------------------------------------------------------------------------------
# Raw log
# ---------------------------------------------------------------------------------------------------------------------
class LogScreen(Screen):
    def __init__(self, ui):
        Screen.__init__(self, ui)
        app_header(self, "บันทึกละเอียด", back=lambda: ui.show("main" if (ui.cfg.get("app") or {}).get(
            "wizard_done") else "wizard"))
        bottom = frame(self)
        bottom.pack(side="bottom", fill="x", padx=px(24), pady=(px(10), px(14)))
        Btn(bottom, "เปิดไฟล์บันทึก (agent.log)", lambda: ui.ctx.open_path(os.path.join(ui.ctx.data_dir, da.LOG_NAME)),
            style="secondary", size="sm", icon="doc").pack(side="left")
        Btn(bottom, "เปิดโฟลเดอร์ข้อมูล", lambda: ui.ctx.open_path(ui.ctx.data_dir), style="secondary", size="sm",
            icon="folder").pack(side="left", padx=(px(8), 0))
        L(bottom, "ไม่มีรหัสผ่านหรือ token ในบันทึก", font="small", fg="slate").pack(side="right")
        card = Box(self, fill="bg", border="hair", radius=14, pad=6)
        card.pack(fill="both", expand=True, padx=px(24), pady=(px(18), 0))
        self.text = tk.Text(card.body, bd=0, highlightthickness=0, bg=C["bg"], fg=C["ink"], font=F["small"],
                            wrap="word", padx=px(12), pady=px(8), cursor="arrow", spacing1=px(2), spacing3=px(2),
                            selectbackground=C["gold_soft"], selectforeground=C["ink"])
        vsb = ttk.Scrollbar(card.body, orient="vertical", command=self.text.yview, style="Thin.Vertical.TScrollbar")
        self.text.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self.text.pack(fill="both", expand=True)
        self.text.tag_configure("warn", foreground=C["gold_ink"])
        self.text.tag_configure("error", foreground=C["cinnabar"])
        self.text.tag_configure("time", foreground=C["slate"], font=F["numXS"])

    def on_show(self, **kw):
        self.text.configure(state="normal")
        self.text.delete("1.0", "end")
        for line in list(self.ui.log_lines):
            self.add_log(line, scroll=False)
        if not self.ui.log_lines:
            self.text.insert("end", "ยังไม่มีบันทึก\n", "time")
        self.text.see("end")
        self.text.configure(state="disabled")

    def add_log(self, line, scroll=True):
        t, level, msg = line
        self.text.configure(state="normal")
        self.text.insert("end", t + "  ", "time")
        msg = log_wrap(msg)
        self.text.insert("end", msg + "\n", "error" if level >= logging.ERROR else "warn" if level >= logging.WARNING
                         else "")
        if scroll:
            self.text.see("end")
        self.text.configure(state="disabled")


# ---------------------------------------------------------------------------------------------------------------------
# Controller
# ---------------------------------------------------------------------------------------------------------------------
class GuiLogHandler(logging.Handler):
    def __init__(self, q):
        logging.Handler.__init__(self, logging.INFO)
        self.q = q
        self.addFilter(da.RedactFilter())

    def emit(self, record):
        try:
            msg = record.getMessage()
            self.q.put(("log", (time.strftime("%H:%M:%S", time.localtime(record.created)), record.levelno,
                                core.friendly_log(msg)), core.app_activity(msg), record.created))
        except Exception:  # pragma: no cover
            pass


class DobbyUI(object):
    SCREENS = {"wizard": WizardScreen, "main": MainScreen, "settings": SettingsScreen, "log": LogScreen,
               "mt5": Mt5Screen}

    def __init__(self, root, ctx):
        self.root, self.ctx = root, ctx
        self.q = queue.Queue()
        self.cfg = core.load_app_config(ctx.data_dir)
        self.approved = None
        self.status, self.snap, self.phase = None, None, None
        self.web_desired = None
        self.bars_text = None               # the EA's dobby2_bars.csv (tail), read by the status watcher
        self.lock_problem = None
        self.agent_error = None
        self.log_lines = collections.deque(maxlen=500)
        self.activity = collections.deque(maxlen=60)
        self._seen_rows = set()
        self.wiz = new_wizard_state()
        self.dialog_hook = None
        self.client = None
        self.rebuild_client()
        self.runner = core.AgentRunner(ctx, self.client, self.q.put)
        self.watcher = core.StatusWatcher(lambda: ctx.common_dir(self.cfg), self.q.put)
        self.watcher.start()
        self.log_handler = GuiLogHandler(self.q)
        LOG.addHandler(self.log_handler)
        self.icon64 = tk.PhotoImage(data=base64.b64encode(core.icon_png(64)).decode("ascii"))
        root.iconphoto(True, self.icon64)
        root.title(APP_NAME + (" (โหมดตัวอย่าง)" if ctx.demo else ""))
        root.configure(bg=C["bg"])
        w, h = px(1000), px(700)
        sw, sh = root.winfo_screenwidth(), root.winfo_screenheight()
        w, h = min(w, sw - px(40)), min(h, sh - px(80))
        root.geometry("%dx%d+%d+%d" % (w, h, max(0, (sw - w) // 2), max(0, (sh - h) // 3)))
        root.minsize(min(px(880), w), min(px(600), h))
        self.container = frame(root, bg=C["bg"])
        self.container.pack(fill="both", expand=True)
        self.screens = {}
        self.current = None
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.report_callback_exception = self._tk_error
        self.closing = False
        self._cfg_t = time.time()
        root.after(100, self._poll)
        root.after(1000, self._tick)

    # -- plumbing
    def rebuild_client(self):
        cfg = self.cfg
        old = self.client
        self.client = core.AppClient(cfg["supabase_url"], cfg["anon_key"], self.ctx.transport(),
                                     cfg.get("refresh_token", ""), on_refresh_token=self.ctx.save_refresh_token)
        if old is not None and getattr(self, "runner", None) is not None:
            self.runner.client = self.client

    def reload_cfg(self):
        self.cfg = core.load_app_config(self.ctx.data_dir)
        self._cfg_t = time.time()
        if self.client is not None and not self.cfg.get("refresh_token"):
            self.client.set_refresh_token("")
        return self.cfg

    def bg(self, fn, done=None, fail=None):
        """Run fn in a worker thread; done(result) / fail(exception) run on the Tk thread."""
        def work():
            try:
                res = fn()
            except Exception as e:  # delivered to the UI
                if not isinstance(e, (da.NetworkError, da.AuthError, da.ApiError, core.NoEaStatus)):
                    LOG.warning("background task failed: %s", da.redact(traceback.format_exc()[-600:]))
                self.q.put(("call", fail, e))
                return
            self.q.put(("call", done, res))
        t = threading.Thread(target=work, name="dobby-ui-task")
        t.daemon = True
        t.start()
        return t

    def _tk_error(self, exc, val, tb):
        LOG.error("UI error: %s", da.redact("".join(traceback.format_exception(exc, val, tb))[-1500:]))

    def _poll(self):
        n = 0
        try:
            while n < 300:
                item = self.q.get_nowait()
                n += 1
                self._dispatch(item)
        except queue.Empty:
            pass
        if not self.closing:
            self.root.after(120, self._poll)

    def add_activity(self, t, tone, text, when=None):
        self.activity.append({"t": t, "tone": tone, "text": text,
                              "when": when or time.strftime("%H:%M", time.localtime(t))})

    def _journal(self, rows):
        offset = da.raw_offset_min(self.status) if isinstance(self.status, dict) else None
        fresh = [r for r in rows if r["line_hash"] not in self._seen_rows]
        if not self._seen_rows:
            fresh = fresh[-5:]
        for r in rows:
            self._seen_rows.add(r["line_hash"])
        for r in fresh:
            a = core.journal_activity(r)
            if not a:
                continue
            dt = da.parse_server_dt(da._server_ts(r))
            if dt is not None and offset is not None:
                t = da.naive_to_epoch(dt) - offset * 60
                self.add_activity(t, a[0], a[1])
            else:
                self.add_activity(time.time(), a[0], a[1], when=r["ts_server"][11:16])
        self.activity = collections.deque(sorted(self.activity, key=lambda x: x["t"]), maxlen=60)

    def _dispatch(self, item):
        kind = item[0]
        if kind == "log":
            self.log_lines.append(item[1])
            if len(item) > 2 and item[2]:
                self.add_activity(item[3], item[2][0], item[2][1])
            s = self.screens.get("log")
            if s is not None:
                s.add_log(item[1])
        elif kind == "status":
            self.status = item[1]
        elif kind == "journal":
            self._journal(item[1])
        elif kind == "bars":
            self.bars_text = item[1]
        elif kind == "agent":
            self.snap = item[1]
            self.phase = "running"
            if item[1].get("status") is not None:
                self.status = item[1]["status"]
            if item[1].get("web_desired") is not None:
                self.web_desired = item[1]["web_desired"]
            self.refresh_now()
        elif kind == "phase":
            self.phase = item[1]
        elif kind == "registered":
            self.reload_cfg()
        elif kind == "agent_error":
            self.agent_error = item[1]
            self.reload_cfg()
        elif kind == "agent_stopped":
            self.phase = None
            self.refresh_now()
        elif kind == "call":
            fn, value = item[1], item[2]
            if fn is not None:
                fn(value)

    def _tick(self):
        if self.closing:
            return
        if time.time() - self._cfg_t > 5:
            self.reload_cfg()
        self.refresh_now()
        self.root.after(1000, self._tick)

    def refresh_now(self):
        if self.current is not None:
            try:
                self.screens[self.current].refresh()
            except tk.TclError:
                pass

    def screen(self, name):
        if name not in self.screens:
            self.screens[name] = self.SCREENS[name](self)
        return self.screens[name]

    def show(self, name, **kw):
        self.reload_cfg()
        scr = self.screen(name)
        if self.current and self.current != name:
            self.screens[self.current].pack_forget()
        self.current = name
        scr.pack(fill="both", expand=True)
        scr.on_show(**kw)

    def start_wizard(self, step=STEP_WELCOME):
        """A fresh wizard (new state, new pages) at `step`."""
        self.wiz = new_wizard_state()
        old = self.screens.pop("wizard", None)
        if old is not None:
            if self.current == "wizard":
                self.current = None
            old.destroy()
        self.show("wizard", step=step)

    def open_help(self):
        self.ctx.open_url(core.GUIDE_URL)

    def scroll_into_view(self, widget):
        """Scroll the current screen so that `widget` is visible (top aligned when it is below the view)."""
        scr = self.screens.get(self.current)
        sc = getattr(scr, "scroll", None)
        if sc is None:
            return
        try:
            self.root.update_idletasks()
            total = max(1, sc.inner.winfo_height())
            y = widget.winfo_rooty() - sc.inner.winfo_rooty()
            top, bottom = sc.canvas.yview()
            if y / float(total) > bottom - 0.05 or y / float(total) < top:
                sc.canvas.yview_moveto(max(0.0, (y - px(16)) / float(total)))
        except tk.TclError:
            pass

    # -- questions
    def choose(self, title, text, choices, kind="warn", extra=None):
        if self.ctx.auto_answer is not None:
            dlg = ChoiceDialog(self, title, text, choices, kind, extra)
            value = choices[0][0] if self.ctx.auto_answer else None
            if self.dialog_hook:
                value = self.dialog_hook(dlg, value)
            dlg.close(value)
            return value
        return ChoiceDialog(self, title, text, choices, kind, extra).run()

    def alert(self, title, text, kind="warn"):
        LOG.info("message: %s | %s", title, text.replace("\n", " "))
        self.choose(title, text, [(True, "ตกลง", "primary")], kind=kind)

    def ask_yes_no(self, title, text):
        if self.ctx.auto_answer is not None and not self.dialog_hook:
            return bool(self.ctx.auto_answer)
        return self.choose(title, text, [(True, "ใช่", "primary"), (False, "ไม่", "secondary")], kind="warn") is True

    def algo_help(self):
        steps = core.mt5_steps((self.cfg.get("app") or {}).get("ea_file") or core.EA_CHART_NAME)
        self.choose("เปิด Algo Trading ใน MT5", "Dobby ส่งคำสั่งซื้อขายได้เมื่อเปิด 2 อย่างนี้:",
                    [(True, "เข้าใจแล้ว", "primary")], kind="info",
                    extra=lambda p: manual_steps(p, steps[4:]).pack(fill="x", pady=(px(12), 0)))

    # -- agent
    def start_agent(self, quiet=False):
        self.reload_cfg()
        if not core.config_complete(self.cfg):
            self.start_wizard(STEP_SIGNIN if not self.cfg.get("refresh_token") else STEP_BOT)
            return False
        ok, info = self.runner.start()
        if not ok:
            if info.get("error") == "still stopping":
                return False
            self.lock_problem = info
            LOG.warning("start refused: %s", "EA folder lock held by " + da.lock_holder_text(info["holder"])
                        if info.get("holder") is not None else info.get("error"))
            self.refresh_now()
            return False
        self.lock_problem = None
        self.agent_error = None
        self.snap = None
        self.phase = "starting"
        self.refresh_now()
        return True

    def stop_agent(self):
        if self.runner.running:
            LOG.info("stop pressed: no more EA file writes")
            self.runner.stop()
        self.refresh_now()

    def close_choices(self):
        return [("minimize", "ย่อหน้าต่างไว้ (ทำงานต่อ)", "primary"), ("stop", "หยุดและปิดแอป", "danger"),
                (None, "ยกเลิก", "secondary")]

    def on_close(self):
        if self.runner.running and not self.runner.stopping:
            choice = ChoiceDialog(self, "Dobby กำลังทำงาน",
                                  "ถ้าปิดแอป Dobby จะหยุดส่งข้อมูลขึ้นเว็บและหยุดรับคำสั่งจากเว็บ "
                                  "(Dobby ใน MT5 ยังทำงานต่อตามคำสั่งล่าสุด)", self.close_choices()).run()
            if choice == "minimize":
                self.root.iconify()
                return
            if choice != "stop":
                return
        self.shutdown()

    def shutdown(self, wait=4.0):
        self.closing = True
        self.runner.stop()
        self.watcher.stop()
        end = time.time() + wait
        while self.runner.running and time.time() < end:
            try:
                self.root.update()
            except tk.TclError:
                break
            time.sleep(0.05)
        LOG.removeHandler(self.log_handler)
        try:
            self.root.destroy()
        except tk.TclError:
            pass


# ---------------------------------------------------------------------------------------------------------------------
# Start-up
# ---------------------------------------------------------------------------------------------------------------------
def enable_dpi_awareness():
    if os.name != "nt":
        return
    try:
        import ctypes
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def make_root():
    enable_dpi_awareness()
    load_private_fonts()            # Anuphan + Chakra Petch for this process only, before the first Tk font
    root = tk.Tk()
    root.withdraw()
    setup_theme(root)
    return root


def first_screen(ui):
    cfg = ui.cfg
    if (cfg.get("app") or {}).get("wizard_done") and core.config_complete(cfg):
        return "main"
    return "wizard"


def demo_context(base, latency=0.25, external=True, **kw):
    """--demo / --selftest: fake %APPDATA% (2 MT5 + their dummy installs), in-memory server, fake launcher."""
    fake = core.build_demo_appdata(os.path.join(base, "fake-appdata"))
    app_dir = os.path.join(base, "app")
    os.makedirs(app_dir, exist_ok=True)
    server = core.DemoServer(latency=latency)
    state = {"procs": [], "ea": None}

    def launcher(cmdline, cwd):            # "MT5" starts: a fake Dobby begins writing its status a moment later
        LOG.info("[demo] would start: %s", cmdline)
        if state["ea"] is None:
            ea = core.DemoEA(da.resolve_common_dir({}, {"APPDATA": fake}))
            state["ea"] = ea
            threading.Timer(2.0, lambda: ea.start(every=2.0)).start()
        return None
    ctx = core.AppContext(app_dir, environ={"APPDATA": fake}, transport=server, demo=True, external=external,
                          startup_folder=os.path.join(base, "fake-startup"), launcher=kw.pop("launcher", launcher),
                          processes=kw.pop("processes", lambda: state["procs"]), **kw)
    return ctx, server, state, fake


def run_app(data_dir, autostart=False, demo=False):
    demo_state = None
    if demo:
        base = data_dir or tempfile.mkdtemp(prefix="dobby-demo-")
        ctx, server, demo_state, fake = demo_context(base)
        data_dir = ctx.data_dir
    data_dir = data_dir or core.app_data_dir()
    os.makedirs(data_dir, exist_ok=True)
    da.setup_logging(data_dir)
    single = da.InstanceLock(os.path.join(data_dir, core.APP_LOCK_NAME))
    if not single.acquire():
        if not autostart:
            from tkinter import messagebox
            r = tk.Tk()
            r.withdraw()
            messagebox.showinfo(APP_NAME, "Dobby App เปิดอยู่แล้ว ดูที่แถบงาน (taskbar) ด้านล่างของจอ")
            r.destroy()
        return 0
    if not demo:
        ctx = core.AppContext(data_dir)
    root = make_root()
    ui = DobbyUI(root, ctx)
    LOG.info("Dobby App %s opened (data folder %s)%s", APP_VERSION, data_dir, " [DEMO]" if demo else "")
    cfg = ui.cfg
    folder = ctx.startup_folder()
    if core.launcher_exists(folder) and not core.launcher_up_to_date(folder, core.app_command()):
        try:
            core.create_launcher(folder, core.app_command())   # the exe was moved: keep the launcher pointing at it
        except OSError:
            pass
    ui.show(first_screen(ui))
    root.deiconify()
    if autostart:
        root.iconify()
    if core.config_complete(cfg) and (cfg.get("app") or {}).get("wizard_done") and (
            autostart or (cfg.get("app") or {}).get("auto_start")):
        root.after(800, lambda: ui.start_agent(quiet=autostart))
    try:
        root.mainloop()
    finally:
        if demo_state and demo_state.get("ea"):
            demo_state["ea"].stop()
        single.release()
    return 0


# ---------------------------------------------------------------------------------------------------------------------
# Self-test: every screen and state with fake data, screenshots, no network, no real folders, MT5 never started
# ---------------------------------------------------------------------------------------------------------------------
def layout_issues(win):
    """Texts cut off (a label narrower than its text), buttons narrower than their label, widgets outside the window."""
    issues = []
    try:
        top_y = win.winfo_rooty()
        top_h = win.winfo_height()
        top_x, top_w = win.winfo_rootx(), win.winfo_width()
    except tk.TclError:
        return issues

    def walk(w, in_scroll=False):
        for c in w.winfo_children():
            if not c.winfo_ismapped():
                continue
            scroll = in_scroll or getattr(c, "_scroll_inner", False)
            try:
                if isinstance(c, (tk.Label, ttk.Label, ttk.Checkbutton)):
                    text = str(c.cget("text") or "")
                    if text and c.winfo_reqwidth() > c.winfo_width() + 2:
                        issues.append("clipped (%d<%d px): %s" % (c.winfo_width(), c.winfo_reqwidth(), text[:60]))
                    if text and c.winfo_reqheight() > c.winfo_height() + 2:
                        issues.append("clipped height: %s" % text[:60])
                if isinstance(c, Btn) and c.text and c.natural_width() > c.winfo_width() + 2:
                    issues.append("button too narrow (%d<%d px): %s" % (c.winfo_width(), c.natural_width(),
                                                                        c.text[:40]))
                y2 = c.winfo_rooty() + c.winfo_height()
                x2 = c.winfo_rootx() + c.winfo_width()
                if not scroll and c.winfo_height() > 1 and (y2 > top_y + top_h + 2 or x2 > top_x + top_w + 2):
                    issues.append("outside the window: %s %s" % (c.winfo_class(), str(c.cget("text"))[:40]
                                                                   if "text" in c.keys() else ""))
            except (tk.TclError, ValueError):
                pass
            walk(c, scroll)
    walk(win)
    return sorted(set(issues))


def run_selftest(out_png, data_dir):
    t_start = time.time()
    data_dir = os.path.abspath(data_dir or tempfile.mkdtemp(prefix="dobby-selftest-"))
    out_png = os.path.abspath(out_png)
    os.makedirs(os.path.dirname(out_png) or ".", exist_ok=True)
    stem = os.path.splitext(out_png)[0]
    launched = []
    procs = []
    ctx, server, demo_state, fake = demo_context(
        data_dir, latency=0.0, external=False, register_wait_s=1, auto_answer=True,
        launcher=lambda cmd, cwd: launched.append((cmd, cwd)), processes=lambda: list(procs))
    app_dir = ctx.data_dir
    da.setup_logging(app_dir)
    root = make_root()
    ui = DobbyUI(root, ctx)
    root.geometry("+20+20")
    ui.show(first_screen(ui))
    root.deiconify()
    report, shots, checks = [], [], []
    common = ctx.common_dir(ui.cfg)
    real_appdata = os.environ.get("APPDATA") or ""
    demo_ea = None

    def pump(seconds=0.3, until=None, timeout=20.0):
        end = time.time() + (timeout if until else seconds)
        while time.time() < end:
            root.update()
            if until is not None and until():
                for _ in range(5):
                    root.update()
                    time.sleep(0.02)
                return True
            time.sleep(0.03)
        return until is None

    def shot(name, win=None):
        win = win or root
        pump(0.45)
        win.update_idletasks()
        path = "%s_%02d_%s.png" % (stem, len(shots) + 1, name)
        hwnd = int(win.wm_frame(), 16)
        try:
            method = core.capture_hwnd(hwnd, path)
        except Exception as e:
            report.append("FAIL %-30s capture: %s" % (name, e))
            return
        issues = layout_issues(win)
        shots.append(path)
        report.append("ok   %-30s %s (%s)%s" % (name, os.path.basename(path), method,
                                                 "".join("\n       - " + i for i in issues)))

    def scroll_shot(name, frac):
        sc = ui.screens[ui.current].scroll
        pump(0.2)
        sc.canvas.yview_moveto(frac)
        shot(name)

    def check(name, ok, detail=""):
        checks.append(bool(ok))
        report.append("%s %s%s" % ("PASS" if ok else "FAIL", name, (": " + detail) if detail else ""))

    def dialog_shot(name):
        def hook(dlg, value):
            shot(name, dlg.top)
            return value
        return hook

    def scroll_to(widget, margin=8):
        """Scroll the current screen so that `widget` starts near the top of the view."""
        sc = ui.screens[ui.current].scroll
        pump(0.2)
        total = max(1, sc.inner.winfo_height())
        y = widget.winfo_rooty() - sc.inner.winfo_rooty()
        sc.canvas.yview_moveto(max(0.0, (y - px(margin)) / float(total)))

    def sized_shot(name, w, h, frac=None):
        root.geometry("%dx%d" % (px(w), px(h)))
        pump(0.6)
        if frac is not None:
            ui.screens[ui.current].scroll.canvas.yview_moveto(frac)
        shot(name)

    def default_size():
        root.geometry("%dx%d" % (px(1000), px(700)))
        pump(0.6)

    wiz = ui.screen("wizard")
    try:
        check("bundled fonts loaded privately: Anuphan (Thai / UI) and Chakra Petch (numbers)",
              FONTS["anuphan"] and FONTS["chakra"] and FONTS["dir"] and FONTS["dir"].endswith("fonts"),
              "%s from %s" % (", ".join(FONTS["loaded"]) or "none", FONTS["dir"]))
        # ---- 1 welcome
        shot("wizard_welcome")
        check("default window 1000 x 700", abs(root.winfo_width() - px(1000)) <= 2 and
              abs(root.winfo_height() - px(700)) <= 2, "%dx%d" % (root.winfo_width(), root.winfo_height()))
        check("welcome: the fake MT5 folders are found", len(core.detect_terminals(ctx.appdata)) == 2)
        wiz.next()
        # ---- 2 sign in: empty, wrong password, not approved, ok
        p = wiz.pages[STEP_SIGNIN]
        pump()
        shot("wizard_signin")
        p.email.insert(0, "owner@example.com")
        p.password.insert(0, "wrong")
        p.do_sign_in()
        pump(until=lambda: not p.busy)
        shot("wizard_signin_wrong_password")
        check("wrong password is refused and not stored", not ui.cfg.get("refresh_token"))
        p.email.delete(0, "end")
        p.email.insert(0, "pending@example.com")
        p.password.insert(0, "demo-password")
        p.do_sign_in()
        pump(until=lambda: not p.busy)
        shot("wizard_signin_unapproved")
        check("unapproved account blocks Next", not p.can_next())
        p.use_other()
        p.email.delete(0, "end")
        p.email.insert(0, "owner@example.com")
        p.password.insert(0, "demo-password")
        p.do_sign_in()
        pump(until=lambda: not p.busy and ui.approved)
        shot("wizard_signed_in")
        cfg_text = open(core.config_path(app_dir), encoding="utf-8").read()
        check("password never stored, refresh token stored", "demo-password" not in cfg_text and
              bool(ui.cfg.get("refresh_token")))
        # ---- 3 choose bot: existing bots, then the catalog
        wiz.next()
        cb = wiz.pages[STEP_BOT]
        pump(until=lambda: ui.wiz.get("bots") is not None)
        shot("wizard_choose_existing")
        names = [b["name"] for b in ui.wiz["bots"]]
        check("existing bots listed (คอมหลัก, DESKTOP-NPNL85P)", names == ["คอมหลัก", "DESKTOP-NPNL85P"], str(names))
        check("Next stays off until a bot is chosen", not wiz.next_btn.winfo_manager() or not wiz.next_btn.enabled)
        cb.show("catalog")
        pump()
        shot("wizard_catalog")
        cb.use_new("dobby")
        pump()
        # ---- 4 bot settings
        ed = wiz.pages[STEP_SETTINGS].editor
        check("step 4 shown for a new bot", wiz.index == STEP_SETTINGS)
        shot("wizard_settings_empty")
        ed.bal.set("abc")
        ed.do_auto()
        pump()
        check("balance 'abc' refused inline", ed.bal.error and "มากกว่า 0" in ed.bal_err.cget("text"))
        ed.bal.set("300")
        ed.do_auto()
        pump()
        line = core.settings_line(ed.get())
        check("auto 300 -> 3 สูตร, ล็อต 0.03, ล็อก 2 ชั้น 85→83 / 95→93, เอเชียปิด, 10%/วัน",
              line == "3 สูตรเปิด · ล็อต 0.03 · ล็อก 2 ชั้น 85→83 / 95→93 · เอเชียปิด · หยุดเมื่อขาดทุน 10%/วัน",
              line.encode("unicode_escape").decode()[:80])
        shot("wizard_settings_auto")
        ed.risk_more.open(True)
        ed.custom.set(True)
        ed._custom_changed()
        pump()
        scroll_shot("wizard_settings_custom", 0.28)
        scroll_to(ed.lock_card)
        shot("wizard_settings_lock_ladder")
        check("lock ladder: TP, 2 triggers, 2 new SLs, entry, original SL",
              [r[1] for r in ed.lockbar.rows] == ["tp", "at", "to", "at", "to", "gap", "entry", "sl"],
              str([r[1] for r in ed.lockbar.rows]))
        sized_shot("wizard_settings_small_window", 880, 600)
        default_size()
        ed.lot_mode.set("each")
        ed._lot_mode()
        ed.steppers["lot_ny"].set(0.02)
        ed.use_vars["asia"].set(True)
        ed._set("use_asia", True)
        ed.steppers["lock1_at"].set(96)
        pump()
        errs = ed.errors()
        check("stage 1 above the near-TP stage is refused inline", "lock1_at" in errs, errs.get("lock1_at", ""))
        check("Next does not pass with an error", wiz.pages[STEP_SETTINGS].on_next() is False)
        scroll_to(ed.lock_card)
        shot("wizard_settings_error")
        ed.steppers["lock1_at"].set(85)
        ed.stages.set("1")
        ed._stages()
        ed.adv.open(True)
        pump()
        scroll_shot("wizard_settings_advanced", 1.0)
        ed.stages.set("2")
        ed._stages()
        ed.lot_mode.set("same")
        ed._lot_mode()
        ed.use_vars["asia"].set(False)
        ed._set("use_asia", False)
        ed.steppers["lot"].set(0.03)
        pump()
        check("settings valid again", not ed.errors(), str(ed.errors()))
        wiz.next()
        pump()
        # ---- 5 MT5: install, refusals, ready, confirm + fake launch, Dobby already attached, manual steps
        mp = wiz.pages[STEP_MT5].panel
        check("step 5 reached", wiz.index == STEP_MT5)
        pump(until=lambda: not mp.busy, timeout=20)
        d1 = ui.cfg["app"]["mt5_data_dir"]
        ex5 = os.path.join(d1, "MQL5", "Experts", "Dobby", "Dobby3_v304.ex5")
        setf = core.preset_target(d1)
        check("newest EA Dobby3_v304.ex5 (not v303) downloaded into MQL5\\Experts\\Dobby", os.path.isfile(ex5) and
              not os.path.exists(os.path.join(d1, "MQL5", "Experts", "Dobby", "Dobby3_v303.ex5")))
        data = open(setf, "rb").read() if os.path.isfile(setf) else b""
        keys = [k for k, _ in core.parse_set(data)]
        check("Dobby3_v304_web.set: UTF-16LE BOM, every EA input exactly once",
              data[:2] == b"\xff\xfe" and keys == [k for k, _, _ in core.EA_INPUTS], "%d keys" % len(keys))
        procs[:] = [{"pid": 4242, "path": os.path.join(core.mt5_install_dir(d1), core.TERMINAL_EXE)}]
        mp.check_auto()
        pump()
        check("auto-start refused while this MT5 runs", [x["code"] for x in mp.check["problems"]] == ["mt5_running"]
              and not mp.start_btn.enabled)
        scroll_to(mp.auto_card)
        shot("wizard_mt5_running")
        procs[:] = []
        mp.check_auto()
        pump()
        check("auto-start allowed when MT5 is closed and no chart has Dobby", mp.check["ok"])
        scroll_shot("wizard_mt5_installed", 0.0)
        scroll_to(mp.auto_card)
        shot("wizard_mt5_ready")
        ui.dialog_hook = dialog_shot("wizard_mt5_confirm")
        mp.do_start()
        ui.dialog_hook = None
        pump()
        ini_path = os.path.join(app_dir, core.STARTUP_INI_NAME)
        ini = open(ini_path, "rb").read().decode("utf-16") if os.path.isfile(ini_path) else ""
        exe = os.path.join(core.mt5_install_dir(d1), core.TERMINAL_EXE)
        check("fake launcher got  \"terminal64.exe\" /config:\"<ini>\"",
              launched == [('"%s" /config:"%s"' % (exe, ini_path), core.mt5_install_dir(d1))], str(launched)[:120])
        check("startup ini: Dobby\\Dobby3_v304 + Dobby3_v304_web.set + XAUUSD M15 + Algo Trading on",
              ini == core.startup_ini_text("Dobby\\Dobby3_v304", core.WEB_PRESET_NAME, "XAUUSD"))
        check("the fake terminal64.exe lives in the temp folder", exe.startswith(data_dir))
        scroll_to(mp.auto_card)
        shot("wizard_mt5_launched")
        d2 = [t["data_dir"] for t in mp.terminals if t["data_dir"] != d1][0]
        mp.choose(d2)
        pump(until=lambda: not mp.busy, timeout=20)
        check("auto-start refused: Dobby already on a chart of MT5 #2",
              "dobby_attached" in [x["code"] for x in mp.check["problems"]] and not mp.start_btn.enabled)
        scroll_to(mp.auto_card)
        shot("wizard_mt5_dobby_attached")
        mp.choose(d1)
        pump(until=lambda: not mp.busy, timeout=20)
        mp.launched = launched[-1]
        ui.wiz["mt5_result"] = "launched"
        mp.man.open(True)
        pump()
        scroll_shot("wizard_mt5_manual", 1.0)
        wiz.next()
        pump()
        # ---- 6 safety
        sp = wiz.pages[STEP_SAFETY]
        lim, _ = sp.form.get()
        check("safety default: web controls everything, local max lots 0.06, cap 10",
              lim == {"allow_remote_control": True, "allow_remote_live": True, "allow_remote_params": True,
                      "max_lots": 0.06, "max_daily_cap_pct": 10.0}, str(lim))
        shot("wizard_safety")
        sp.form.exp.open(True)
        pump()
        shot("wizard_safety_custom")
        sp.form.exp.open(False)
        wiz.next()
        pump()
        # ---- 7 finish: create
        fp = wiz.pages[STEP_FINISH]
        shot("wizard_finish_new")
        nreg = len(server.registered)
        fp.do_save()
        pump(until=lambda: bool(ui.wiz.get("done")), timeout=20)
        reg = server.registered[nreg:]
        des = reg[0]["p_desired"] if reg else {}
        params = des.get("params") or {}
        check("register_bot once: live on, run, both sides, no blackouts",
              len(reg) == 1 and des.get("live") is True and des.get("control") == {
                  "mode": "run", "allow_long": True, "allow_short": True} and des.get("blackouts") == [])
        check("params = the full remote key set of the settings", list(params) == da.REMOTE_KEYS and
              params["InpLotsA"] == 0.03 and params["InpVirtualStart"] == 300.0 and params["InpLock1Enable"] is True)
        check("params pass the agent's own check with the chosen limits",
              not da.check_params(params, da.get_limits(ui.cfg))[1])
        check("config saved: bot, limits, wizard done", ui.cfg.get("bot_id") and ui.cfg["bot_name"] == "Dobby" and
              ui.cfg["app"]["wizard_done"] and da.get_limits(ui.cfg)["allow_remote_live"])
        shot("wizard_done")
        check("nothing written to the EA folder before Start",
              not os.path.exists(os.path.join(common, da.CONTROL_NAME)) and
              not os.path.exists(os.path.join(common, da.REMOTE_NAME)))
        # ---- main: stopped, running, waiting for MT5, Algo off, stop, lock conflict
        ui.show("main")
        pump()
        shot("main_stopped")
        demo_ea = core.DemoEA(common)
        demo_ea.start(every=1.0)
        ui.start_agent()
        bot_id = ui.cfg.get("bot_id")
        pump(until=lambda: ui.snap is not None and ui.snap.get("applied_version") == 1, timeout=40)
        ctl = da.read_text(os.path.join(common, da.CONTROL_NAME)) or ""
        rem = da.read_text(os.path.join(common, da.REMOTE_NAME)) or ""
        check("Start: control file mode=run", "mode=run" in ctl, ctl.split("\n")[0][:60])
        check("Start: remote file live=1 + the settings", "live=1" in rem and "InpLotsA=0.03" in rem and
              "InpLock1AtPct=85.0" in rem)
        pump(until=lambda: (ui.status or {}).get("remote", {}).get("live") is True, timeout=20)
        ms = ui.screens["main"]
        pump(until=lambda: ms.chart.points == 96 and ms.chart.offset is not None, timeout=20)
        pump(2.0)
        shot("main_running")
        bars_path = os.path.join(common, da.BARS_NAME)
        check("price line: 96 M15 bars from the TEMP dobby2_bars.csv, local times from the agent's offset",
              ms.chart.points == 96 and bars_path.startswith(data_dir) and ms.chart.offset == 120,
              "%d bars, offset %s" % (ms.chart.points, ms.chart.offset))
        check("hero stamp: gold plate, state เทรดจริง", (ms.stamp.tone, ms.stamp.state) == ("gold", "เทรดจริง"))
        sized_shot("main_running_large_window", 1280, 820)
        sized_shot("main_running_small_window", 880, 600)
        sized_shot("main_running_small_window_scrolled", 880, 600, 1.0)
        default_size()
        ms.scroll.to_top()
        hs = core.hero_state(ui.cfg, ui.status, ui.snap, time.time(), True)
        check("hero: Dobby กำลังเทรดจริง", hs["title"] == "Dobby กำลังเทรดจริง", hs["title"])
        demo_ea.stop()
        pump(1.5)
        st = dict(demo_ea.status())
        st["heartbeat_gmt_unix"] = int(time.time()) - 600
        da.write_json_atomic(os.path.join(common, da.STATUS_NAME), st)
        pump(until=lambda: core.heartbeat_age(ui.status, time.time()) and core.heartbeat_age(
            ui.status, time.time()) > 300, timeout=15)
        pump(1.2)
        shot("main_waiting_mt5")
        check("waiting for MT5: cinnabar ink stamp", ui.screens["main"].stamp.tone == "cinnabar",
              str((ui.screens["main"].stamp.tone, ui.screens["main"].stamp.state)))
        demo_ea = core.DemoEA(common)
        demo_ea.trade_permitted = False
        demo_ea.live = True                      # the same running Dobby: live stays on
        demo_ea.start(every=1.0)
        pump(until=lambda: (ui.status or {}).get("account", {}).get("trade_permitted") is False and
             core.heartbeat_age(ui.status, time.time()) < 30, timeout=15)
        pump(1.2)
        shot("main_algo_off")
        ui.dialog_hook = dialog_shot("algo_help_dialog")
        ui.algo_help()
        ui.dialog_hook = None
        demo_ea.trade_permitted = True
        pump(2.5)
        server.web_change(bot_id, lots=0.5)
        want = server.control[bot_id]["version"]
        pump(until=lambda: ui.snap and ui.snap.get("applied_version") == want, timeout=30)
        ctl = da.read_text(os.path.join(common, da.CONTROL_NAME)) or ""
        check("web lots 0.50 clamped to the local max 0.06", "lots=0.06" in ctl)
        # ---- SPEC 9: automatic blackouts (a synthetic ForexFactory week from the demo server), bars upload
        server.web_auto(bot_id)
        want = server.control[bot_id]["version"]
        pump(until=lambda: ui.snap and ui.snap.get("applied_version") == want and ui.snap.get("auto_blackouts"),
             timeout=30)
        ctl = da.read_text(os.path.join(common, da.CONTROL_NAME)) or ""
        auto = (ui.snap or {}).get("auto_blackouts") or []
        check("auto blackouts: news + Friday night reported and written to the control file",
              len(auto) >= 2 and any("CPI m/m" in w["reason"] for w in auto) and
              ctl.count("blackout=") == len(auto) and server.news_calls >= 1,
              "%d windows, %d lines, %d fetch(es)" % (len(auto), ctl.count("blackout="), server.news_calls))
        check("auto blackouts are never copied into desired.blackouts",
              server.control[bot_id]["desired"]["blackouts"] == [])
        check("bars uploaded from the TEMP dobby2_bars.csv (SPEC 9.1)", server.bars_rows >= 96, str(server.bars_rows))
        ms.scroll.to_top()
        pump(until=lambda: bool(ms.next_bo.winfo_manager()), timeout=10)
        check("main screen: the next automatic blackout is shown",
              "งดเข้าไม้อัตโนมัติ" in str(ms.next_bo.cget("text")),
              str(ms.next_bo.cget("text")).encode("unicode_escape").decode()[:80])
        check("activity feed: the automatic blackouts are listed",
              any("งดเข้าไม้อัตโนมัติ" in it["text"] for it in ui.activity))
        shot("main_auto_blackout")
        ui.stop_agent()
        pump(until=lambda: not ui.runner.running, timeout=30)
        m0 = os.stat(os.path.join(common, da.CONTROL_NAME)).st_mtime
        r0 = os.stat(os.path.join(common, da.REMOTE_NAME)).st_mtime
        server.web_change(bot_id, lots=0.02)
        pump(3.0)
        check("Stop: no EA file is written any more", os.stat(os.path.join(common, da.CONTROL_NAME)).st_mtime == m0
              and os.stat(os.path.join(common, da.REMOTE_NAME)).st_mtime == r0)
        check("lock released after Stop", not os.path.exists(os.path.join(common, da.COMMON_LOCK_NAME)) or
              not (da.CommonLock(common).read() or {}).get("pid"))
        other = da.CommonLock(common, program="dobby_agent.py run")
        other.acquire()
        started = ui.start_agent()
        pump(1.2)
        check("second agent refused while the CLI holds the EA-folder lock", not started and not ui.runner.running)
        shot("main_lock_conflict")
        other.release()
        ui.lock_problem = None
        # ---- MT5 screen, settings sections, log
        ui.show("mt5")
        pump(until=lambda: not ui.screens["mt5"].panel.busy, timeout=20)
        shot("mt5_screen")
        ui.show("settings")
        st_scr = ui.screen("settings")
        for key, _, _ in SettingsScreen.SECTIONS:
            st_scr.select(key)
            if key == "telegram":
                st_scr.tg_chat.set("42")
                st_scr.tg_token.set("123456:DEMO-TOKEN")
                st_scr.test_telegram()
                pump(until=lambda: st_scr.tg_btn.enabled and "กำลัง" not in st_scr.tg_result.cget("text"))
            if key == "startup":
                st_scr.with_windows.set(True)
                st_scr.save()
                check("start with Windows: launcher created in the (fake) Startup folder",
                      core.launcher_exists(ctx.startup_folder()))
            shot("settings_" + key)
        st_scr.with_windows.set(False)
        st_scr.save()
        check("start with Windows off: launcher removed", not core.launcher_exists(ctx.startup_folder()))
        ui.show("log")
        shot("log")
        # ---- close dialog while running
        ui.show("main")
        ui.start_agent()
        pump(until=lambda: ui.runner.running and ui.snap is not None, timeout=20)
        dlg = ChoiceDialog(ui, "Dobby กำลังทำงาน", "ถ้าปิดแอป Dobby จะหยุดส่งข้อมูลขึ้นเว็บและหยุดรับคำสั่งจากเว็บ "
                                                   "(Dobby ใน MT5 ยังทำงานต่อตามคำสั่งล่าสุด)", ui.close_choices())
        shot("close_dialog", dlg.top)
        dlg.close(None)
        ui.stop_agent()
        pump(until=lambda: not ui.runner.running, timeout=30)
        demo_ea.stop()
        # ---- link an existing bot (no new bot, its params untouched)
        core.unlink_pc(app_dir)
        ui.reload_cfg()
        before = {k: dict(v, desired=dict(v["desired"])) for k, v in server.control.items()}
        server.bots[0]["last_seen"] = core._iso(time.time() - 20)          # คอมหลัก is online on another PC
        nreg = len(server.registered)
        ui.start_wizard(STEP_BOT)
        wiz = ui.screen("wizard")
        pump(until=lambda: ui.wiz.get("bots") is not None)
        main_bot = [b for b in ui.wiz["bots"] if b["name"] == "คอมหลัก"][0]
        ui.dialog_hook = dialog_shot("wizard_link_online_confirm")
        wiz.pages[STEP_BOT].use_existing(main_bot)
        ui.dialog_hook = None
        pump(until=lambda: not wiz.pages[STEP_MT5].panel.busy, timeout=20)
        check("linking an existing bot skips step 4", wiz.index == STEP_MT5 and wiz.pages[STEP_SETTINGS].skip)
        shot("wizard_link_mt5")
        wiz.next()
        pump()
        lim, _ = wiz.pages[STEP_SAFETY].form.get()
        check("linking: local max lots from the bot's web lots (0.10 -> 0.20)", lim["max_lots"] == 0.2, str(lim))
        wiz.next()
        pump()
        shot("wizard_finish_link")
        wiz.pages[STEP_FINISH].do_save()
        pump(until=lambda: bool(ui.wiz.get("done")))
        check("linking: no register_bot call, this PC uses คอมหลัก",
              len(server.registered) == nreg and ui.cfg.get("bot_id") == main_bot["id"])
        check("linking: the bot's web state (params) is not touched",
              server.control[main_bot["id"]]["desired"] == before[main_bot["id"]]["desired"] and
              server.control[main_bot["id"]]["version"] == before[main_bot["id"]]["version"])
        shot("wizard_link_done")
        # ---- a new user without bots: straight to the catalog
        core.sign_out(app_dir, ui.client)
        ui.approved = None
        ui.reload_cfg()
        ui.start_wizard(STEP_SIGNIN)
        wiz = ui.screen("wizard")
        p = wiz.pages[STEP_SIGNIN]
        pump()
        p.email.delete(0, "end")
        p.email.insert(0, "new.friend@example.com")
        p.password.insert(0, "demo-password")
        p.do_sign_in()
        pump(until=lambda: not p.busy and ui.approved)
        wiz.next()
        pump(until=lambda: ui.wiz.get("bots") is not None)
        pump()
        check("new user without bots: the catalog (Dobby) is shown directly",
              ui.wiz["bots"] == [] and wiz.pages[STEP_BOT].view == "catalog")
        shot("wizard_new_user_catalog")
        # ---- the saved login is revoked elsewhere (2026-11-08: a website sign-out ended every session of the user)
        server.refresh.clear()
        server.access.clear()
        ui.client.access_token = None
        ui.approved = True                     # what the app still believed from the earlier sign-in
        ui.wiz["bots"] = None
        wiz.go(STEP_BOT)
        pump(until=lambda: wiz.index == STEP_SIGNIN)
        p = wiz.pages[STEP_SIGNIN]
        pump()
        check("revoked login: the bot list goes back to sign-in with the form, the dead token forgotten",
              wiz.index == STEP_SIGNIN and not ui.cfg.get("refresh_token") and p.form.winfo_ismapped())
        shot("wizard_session_revoked")
        p.email.delete(0, "end")
        p.email.insert(0, "owner@example.com")
        p.password.insert(0, "demo-password")
        p.do_sign_in()
        pump(until=lambda: not p.busy and ui.approved)
        server.refresh.clear()
        server.access.clear()
        ui.client.access_token = None
        ui.approved = True
        main = ui.screen("main")
        main.hero_action = "signin"
        main._hero_action()
        wiz = ui.screen("wizard")
        p = wiz.pages[STEP_SIGNIN]
        pump(until=lambda: not p.busy and ui.approved is None)
        pump()
        check("revoked login: the main screen's sign-in button shows the form, not 'signed in'",
              wiz.index == STEP_SIGNIN and not ui.cfg.get("refresh_token") and p.form.winfo_ismapped())
        real_common = core.default_common_dir(real_appdata)
        check("never touched the real EA folder or the real MT5 folders",
              os.path.normcase(common) != os.path.normcase(real_common) and common.startswith(data_dir) and
              ctx.appdata.startswith(data_dir))
        check("MT5 was never really started (fake launcher only)", all(c[0].count("terminal64.exe") == 1 and
                                                                         data_dir in c[0] for c in launched))
    except Exception:
        report.append("FAIL exception:\n" + traceback.format_exc())
        checks.append(False)
    finally:
        if demo_ea:
            demo_ea.stop()
        ui.shutdown(wait=6.0)
    sheet = core.contact_sheet(shots, out_png)
    if not sheet and shots:
        import shutil
        shutil.copyfile(shots[0], out_png)
    ok = bool(shots) and all(checks) and not any(r.startswith("FAIL") for r in report)
    text = "Dobby App %s self-test: %s (%d screenshots, %d checks, %.0f s)\nout: %s\ndata: %s\n\n%s\n" % (
        APP_VERSION, "OK" if ok else "FAILED", len(shots), len(checks), time.time() - t_start, out_png, data_dir,
        "\n".join(report))
    with open(stem + "_selftest.txt", "w", encoding="utf-8") as f:
        f.write(text)
    try:
        sys.stdout.write(text)
    except Exception:  # windowed exe: no console
        pass
    return 0 if ok else 1


# ---------------------------------------------------------------------------------------------------------------------
def main(argv=None):
    p = argparse.ArgumentParser(prog="DobbyApp", description="Dobby App %s" % APP_VERSION)
    p.add_argument("--autostart", action="store_true", help="started with Windows: minimized, start if set up")
    p.add_argument("--demo", action="store_true", help="the whole UI against fake data (no network)")
    p.add_argument("--selftest", metavar="OUT_PNG", help="render every screen with fake data and save screenshots")
    p.add_argument("--data-dir", help="data folder (default %%APPDATA%%\\DobbyApp)")
    p.add_argument("--make-icon", metavar="ICO", help="write the app icon and exit")
    args = p.parse_args(argv)
    if args.make_icon:
        core.write_icon(args.make_icon)
        return 0
    if args.selftest:
        return run_selftest(args.selftest, args.data_dir)
    return run_app(args.data_dir, autostart=args.autostart, demo=args.demo)


if __name__ == "__main__":
    sys.exit(main())
