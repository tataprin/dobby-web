# -*- coding: utf-8 -*-
"""Dobby App - connects this PC's MT5 + Dobby EA to the Dobby website, without Python or a terminal.

Double-click DobbyApp.exe -> Thai setup wizard -> press "เริ่มทำงาน Dobby" -> done.

  DobbyApp.exe                                   normal start (data in %APPDATA%\\DobbyApp)
  DobbyApp.exe --autostart                       started by Windows: minimized, presses Start if the setup is complete
  DobbyApp.exe --demo                            the whole UI against fake data (no network, temp folders)
  DobbyApp.exe --selftest out.png --data-dir D   builds every screen with fake data, saves screenshots, exits 0
  python dobby_app.py --make-icon dobby.ico      writes the app icon (build step)

The agent loop is dobby_agent.Agent (same rules as the CLI: SPEC section 3). It runs in a background thread only after
Start, behind the EA-folder lock (one agent per MT5), and stops writing the EA files the moment Stop is pressed.
The app never starts MT5 and never talks to it: the MT5 steps (attach the EA, Algo Trading) stay manual, once.
"""
import argparse
import base64
import collections
import logging
import os
import queue
import socket
import sys
import tempfile
import threading
import time
import traceback

import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk

import dobby_agent as da
import dobby_app_core as core
from dobby_app_core import APP_NAME, APP_VERSION, WEB_URL, LOG

# ---------------------------------------------------------------------------------------------------------------------
# Look
# ---------------------------------------------------------------------------------------------------------------------
C = {
    "bg": "#F4F6F9", "surface": "#FFFFFF", "surface2": "#EEF1F5", "side": "#E9EDF3", "line": "#DDE2EA",
    "line2": "#C5CCD8", "ink": "#141A24", "ink2": "#3F4857", "muted": "#5D6676", "accent": "#2450C7",
    "accent_hi": "#1D43A8", "accent_soft": "#E6EDFC", "accent_dis": "#A9B9E6", "good": "#11703A",
    "good_dot": "#1A9E4B", "good_soft": "#E5F5E6", "warn": "#7A5000", "warn_dot": "#E09A0B", "warn_soft": "#FFF4D9",
    "bad": "#B42323", "bad_dot": "#D03B3B", "bad_soft": "#FDECEA", "idle_dot": "#B7BFCB", "white": "#FFFFFF",
}
TONE = {"good": "good", "ok": "good", "warn": "warn", "bad": "bad", "info": "accent", "idle": "muted", "": "ink"}
F = {}
SCALE = [1.0]


def px(n):
    return int(round(n * SCALE[0]))


def setup_theme(root):
    SCALE[0] = max(1.0, root.winfo_fpixels("1i") / 96.0)
    fams = set(tkfont.families(root))
    fam = next((f for f in ("Leelawadee UI", "Tahoma") if f in fams), "TkDefaultFont")
    F.update(base=(fam, 10), small=(fam, 9), tiny=(fam, 8), bold=(fam, 10, "bold"), sbold=(fam, 9, "bold"),
             h1=(fam, 16, "bold"), h2=(fam, 12, "bold"), h3=(fam, 11, "bold"), big=(fam, 14, "bold"),
             num=(fam, 15, "bold"), link=(fam, 10, "underline"), slink=(fam, 9, "underline"), mono=("Consolas", 9),
             family=fam)
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont", "TkCaptionFont", "TkTooltipFont"):
        try:
            tkfont.nametofont(name).configure(family=fam, size=10)
        except tk.TclError:
            pass
    s = ttk.Style(root)
    s.theme_use("clam")
    s.configure(".", background=C["bg"], foreground=C["ink"], font=F["base"], bordercolor=C["line2"],
                focuscolor=C["accent_soft"], troughcolor=C["surface2"])
    pad = (px(14), px(7))
    s.configure("TButton", font=F["bold"], padding=pad, background="#F8F9FB", foreground=C["ink"],
                bordercolor=C["line2"], lightcolor="#F8F9FB", darkcolor="#F8F9FB", relief="raised")
    s.map("TButton", background=[("disabled", C["surface2"]), ("pressed", C["surface2"]), ("active", "#EDF1F7")],
          lightcolor=[("disabled", C["surface2"]), ("pressed", C["surface2"]), ("active", "#EDF1F7")],
          darkcolor=[("disabled", C["surface2"]), ("pressed", C["surface2"]), ("active", "#EDF1F7")],
          foreground=[("disabled", C["muted"])], bordercolor=[("focus", C["accent"]), ("disabled", C["line"])],
          relief=[("pressed", "raised")])
    s.configure("Accent.TButton", background=C["accent"], foreground=C["white"], bordercolor=C["accent"],
                lightcolor=C["accent"], darkcolor=C["accent"])
    acc_states = [("disabled", C["accent_dis"]), ("pressed", C["accent_hi"]), ("active", C["accent_hi"])]
    s.map("Accent.TButton", background=acc_states, lightcolor=acc_states, darkcolor=acc_states,
          foreground=[("disabled", C["white"])], bordercolor=[("disabled", C["accent_dis"]),
                                                              ("focus", C["accent_hi"])])
    s.configure("Danger.TButton", background=C["surface"], foreground=C["bad"], bordercolor="#E5A3A3",
                lightcolor=C["surface"], darkcolor=C["surface"])
    bad_states = [("active", C["bad_soft"]), ("pressed", C["bad_soft"])]
    s.map("Danger.TButton", background=bad_states, lightcolor=bad_states, darkcolor=bad_states)
    s.configure("Small.TButton", font=F["sbold"], padding=(px(10), px(4)))
    s.configure("Head.TButton", font=F["sbold"], padding=(px(12), px(5)), background=C["surface2"],
                bordercolor=C["surface2"], lightcolor=C["surface2"], darkcolor=C["surface2"])
    head_states = [("pressed", C["line"]), ("active", C["line"])]
    s.map("Head.TButton", background=head_states, lightcolor=head_states, darkcolor=head_states,
          bordercolor=[("focus", C["accent"])] + head_states)
    # modern check box / radio indicators (images drawn at start-up)
    isz = px(18)
    imgs = {}
    for kind in ("check", "radio"):
        for on in (False, True):
            for dis in (False, True):
                png = core.indicator_png(isz, kind, on, dis)
                imgs[(kind, on, dis)] = tk.PhotoImage(master=root, data=base64.b64encode(png).decode("ascii"))
    root._dobby_indicator_images = imgs
    for kind, elem, base in (("check", "Dobby.Checkbutton.indicator", "Checkbutton"),
                             ("radio", "Dobby.Radiobutton.indicator", "Radiobutton")):
        s.element_create(elem, "image", imgs[(kind, False, False)],
                         ("disabled", "selected", imgs[(kind, True, True)]), ("disabled", imgs[(kind, False, True)]),
                         ("selected", imgs[(kind, True, False)]), width=isz + px(8), sticky="w")
        layout = [("%s.padding" % base, {"sticky": "nswe", "children": [
            (elem, {"side": "left", "sticky": ""}),
            ("%s.focus" % base, {"side": "left", "sticky": "w", "children": [
                ("%s.label" % base, {"sticky": "nswe"})]})]})]
        s.layout("T" + base, layout)
        s.layout("S.T" + base, layout)
    for name, bg in (("TCheckbutton", C["bg"]), ("S.TCheckbutton", C["surface"]), ("TRadiobutton", C["bg"]),
                     ("S.TRadiobutton", C["surface"])):
        s.configure(name, background=bg, foreground=C["ink"], font=F["bold"], padding=(0, px(2)),
                    focuscolor=bg)
        s.map(name, background=[("active", bg)], foreground=[("disabled", C["muted"])])
    for name in ("TEntry", "TSpinbox"):
        s.configure(name, fieldbackground=C["white"], foreground=C["ink"], bordercolor=C["line2"],
                    lightcolor=C["line2"], darkcolor=C["line2"], padding=(px(8), px(6)), insertcolor=C["ink"],
                    arrowsize=px(12), arrowcolor=C["ink2"], background=C["surface2"])
        s.map(name, bordercolor=[("focus", C["accent"])], lightcolor=[("focus", C["accent"])],
              fieldbackground=[("disabled", C["surface2"]), ("readonly", C["surface2"])])
    s.configure("TNotebook", background=C["bg"], borderwidth=0, tabmargins=(0, 0, 0, 0))
    s.configure("TNotebook.Tab", padding=(px(16), px(8)), font=F["bold"], background=C["side"],
                foreground=C["muted"], bordercolor=C["line"], lightcolor=C["side"])
    s.map("TNotebook.Tab", background=[("selected", C["surface"])], foreground=[("selected", C["accent"])],
          lightcolor=[("selected", C["surface"])], padding=[("selected", (px(16), px(8)))],
          expand=[("selected", (0, 0, 0, 0))])
    s.configure("Treeview", background=C["surface"], fieldbackground=C["surface"], foreground=C["ink"],
                rowheight=px(30), bordercolor=C["line"], font=F["base"])
    s.configure("Treeview.Heading", font=F["sbold"], background=C["surface2"], foreground=C["ink2"],
                relief="flat", bordercolor=C["line"], padding=(px(6), px(5)))
    s.map("Treeview", background=[("selected", C["accent_soft"])], foreground=[("selected", C["ink"])])
    s.map("Treeview.Heading", background=[("active", C["surface2"])])
    for tone, col in (("Good", C["good_dot"]), ("Warn", C["warn_dot"]), ("Bad", C["bad_dot"])):
        s.configure("%s.Horizontal.TProgressbar" % tone, troughcolor=C["surface2"], background=col,
                    bordercolor=C["surface2"], lightcolor=col, darkcolor=col, thickness=px(8))
    s.configure("Vertical.TScrollbar", background=C["line"], troughcolor=C["surface"], bordercolor=C["surface"],
                arrowcolor=C["muted"], lightcolor=C["line"], darkcolor=C["line"], gripcount=0, arrowsize=px(12))
    s.map("Vertical.TScrollbar", background=[("active", C["line2"])])
    return fam


# ---------------------------------------------------------------------------------------------------------------------
# Small widgets
# ---------------------------------------------------------------------------------------------------------------------
def _bg(widget):
    try:
        return widget.cget("bg")
    except tk.TclError:
        return C["bg"]


THAI_MARKS = set(chr(c) for c in [0x0E31, 0x0E33] + list(range(0x0E34, 0x0E3B)) + list(range(0x0E47, 0x0E4F)))
MAX_RUN_BYTES = 195   # Tk on Windows draws a text run in ~200-byte pieces: a piece that starts with a Thai mark
#                       shows it on a dotted circle, so no drawn line may be longer than this


def _hard_split(token, fits):
    """Longest prefix of `token` that fits and does not end right before a combining mark."""
    k = len(token)
    while k > 1 and not fits(token[:k]):
        k -= 1
    while 1 < k < len(token) and token[k] in THAI_MARKS:
        k -= 1
    return max(1, k)


def wrap_text(text, measure, width=None, max_bytes=MAX_RUN_BYTES):
    """Wrap like Tk (at spaces, a too-long word is cut) but also keep every line under `max_bytes` UTF-8 bytes
    and never start a line with a Thai combining mark."""
    import re as _re

    def fits(s):
        return len(s.encode("utf-8")) <= max_bytes and (width is None or measure(s) <= width)

    out = []
    for para in str(text).split("\n"):
        line = ""
        for tok in _re.split(r"(\s+)", para):
            if not tok:
                continue
            cand = line + tok
            if fits(cand.rstrip()):
                line = cand
                continue
            if line.strip():
                out.append(line.rstrip())
            line = tok.lstrip()
            while line and not fits(line):
                k = _hard_split(line, fits)
                out.append(line[:k])
                line = line[k:]
        out.append(line.rstrip())
    return "\n".join(out)


class L(tk.Label):
    """Label that takes the parent's background. wrap=True (or an initial width): re-wraps to its width with
    wrap_text(), which is safe for Thai."""

    def __init__(self, parent, text="", font="base", fg="ink", bg=None, wrap=False, **kw):
        kw.setdefault("anchor", "w")
        kw.setdefault("justify", "left")
        self._text = str(text)
        self._font = tkfont.Font(font=F.get(font, font))
        self._width = px(wrap if isinstance(wrap, int) and wrap > 1 else 320) if wrap else None
        tk.Label.__init__(self, parent, text=self._layout(), font=F.get(font, font), fg=C.get(fg, fg),
                          bg=bg or _bg(parent), bd=0, padx=0, pady=0, **kw)
        if wrap:
            self.bind("<Configure>", self._rewrap)

    def _layout(self):
        return wrap_text(self._text, self._font.measure, self._width)

    def configure(self, cnf=None, **kw):
        if isinstance(cnf, dict) and "text" in cnf:
            kw["text"] = cnf.pop("text")
        if "font" in kw:
            self._font = tkfont.Font(font=F.get(kw["font"], kw["font"]))
            kw["font"] = F.get(kw["font"], kw["font"])
        if "text" in kw or "font" in kw:
            if "text" in kw:
                self._text = str(kw["text"])
            kw["text"] = self._layout()
        return tk.Label.configure(self, cnf, **kw)

    config = configure

    def _rewrap(self, e):
        w = max(px(60), e.width - 2)
        if self._width is None or abs(w - self._width) > 3:
            self._width = w
            tk.Label.configure(self, text=self._layout())


def log_wrap(msg):
    """Log lines for tk.Text: long messages split into indented continuation lines (Thai-safe run length)."""
    return wrap_text(msg, None, None, 150).replace("\n", "\n            ")


class Link(L):
    def __init__(self, parent, text, command, font="link", **kw):
        L.__init__(self, parent, text=text, font=font, fg="accent", cursor="hand2", **kw)
        self.bind("<Button-1>", lambda e: command())


def frame(parent, bg=None, **kw):
    return tk.Frame(parent, bg=bg or _bg(parent), bd=0, highlightthickness=0, **kw)


class Card(tk.Frame):
    def __init__(self, parent, pad=14, bg=None, border=None, **kw):
        bg = bg or C["surface"]
        tk.Frame.__init__(self, parent, bg=bg, bd=0, highlightthickness=1, highlightbackground=border or C["line"],
                          highlightcolor=border or C["line"], **kw)
        self.body = frame(self, bg=bg)
        self.body.pack(fill="both", expand=True, padx=px(pad), pady=px(pad))


def round_rect(cv, x1, y1, x2, y2, r, **kw):
    pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2, x2 - r, y2, x1 + r, y2, x1, y2,
           x1, y2 - r, x1, y1 + r, x1, y1]
    return cv.create_polygon(pts, smooth=True, **kw)


class BigButton(tk.Canvas):
    """The big rounded Start / Stop button."""
    KINDS = {"accent": ("accent", "accent_hi", "white", "accent"), "stop": ("surface", "bad_soft", "bad", "bad_dot"),
             "disabled": ("surface2", "surface2", "muted", "line2")}

    def __init__(self, parent, text, command, kind="accent", icon="play", height=58):
        tk.Canvas.__init__(self, parent, height=px(height), width=px(240), bg=_bg(parent), highlightthickness=0,
                           bd=0, cursor="hand2", takefocus=1)
        self.text, self.command, self.kind, self.icon = text, command, kind, icon
        self.hover = False
        self.bind("<Configure>", lambda e: self.redraw())
        self.bind("<Enter>", lambda e: self._hover(True))
        self.bind("<Leave>", lambda e: self._hover(False))
        self.bind("<ButtonRelease-1>", lambda e: self._click())
        self.bind("<Return>", lambda e: self._click())
        self.bind("<space>", lambda e: self._click())

    def set(self, text=None, kind=None, icon=None):
        old = (self.text, self.kind, self.icon)
        if text is not None:
            self.text = text
        if kind is not None:
            self.kind = kind
        if icon is not None:
            self.icon = icon
        if old != (self.text, self.kind, self.icon):
            self.configure(cursor="arrow" if self.kind == "disabled" else "hand2")
            self.redraw()

    def _hover(self, on):
        self.hover = on
        self.redraw()

    def _click(self):
        if self.kind != "disabled" and self.command:
            self.command()

    def redraw(self):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 10:
            w, h = int(self.cget("width")), int(self.cget("height"))
        fill, hov, ink, border = (C[k] for k in self.KINDS.get(self.kind, self.KINDS["accent"]))
        round_rect(self, 1, 1, w - 2, h - 2, px(14), fill=hov if self.hover and self.kind != "disabled" else fill,
                   outline=border, width=max(1, px(1.5)))
        f = tkfont.Font(font=F["big"])
        tw = f.measure(self.text)
        isz = px(14)
        gap = px(10) if self.icon else 0
        x0 = (w - tw - isz - gap) / 2.0 if self.icon else (w - tw) / 2.0
        cy = h / 2.0
        if self.icon == "play":
            self.create_polygon(x0, cy - isz / 2.0, x0 + isz * 0.9, cy, x0, cy + isz / 2.0, fill=ink, outline=ink)
        elif self.icon == "stop":
            self.create_rectangle(x0, cy - isz / 2.0 + 1, x0 + isz - 2, cy + isz / 2.0 - 1, fill=ink, outline=ink)
        elif self.icon == "wait":
            self.create_oval(x0, cy - isz / 2.0, x0 + isz, cy + isz / 2.0, outline=ink, width=px(2))
        self.create_text(x0 + (isz + gap if self.icon else 0), cy, text=self.text, anchor="w", fill=ink,
                         font=F["big"])


class StatusIcon(tk.Canvas):
    """A round state icon: ok (green tick), bad (red cross), warn (amber !), idle (grey ring)."""
    COLORS = {"ok": "good_dot", "bad": "bad_dot", "warn": "warn_dot", "idle": "idle_dot", "info": "accent"}

    def __init__(self, parent, state="idle", size=22):
        tk.Canvas.__init__(self, parent, width=px(size), height=px(size), bg=_bg(parent), highlightthickness=0, bd=0)
        self.size = px(size)
        self.state = None
        self.set(state)

    def set(self, state):
        if state == self.state:
            return
        self.state = state
        self.delete("all")
        s = self.size
        col = C[self.COLORS.get(state, "idle_dot")]
        w = max(2, int(s * 0.11))
        if state == "idle":
            self.create_oval(2, 2, s - 2, s - 2, outline=col, width=max(2, px(2)))
            self.create_oval(s * 0.42, s * 0.42, s * 0.58, s * 0.58, fill=col, outline=col)
            return
        self.create_oval(1, 1, s - 1, s - 1, fill=col, outline=col)
        if state == "ok":
            self.create_line(s * 0.28, s * 0.52, s * 0.44, s * 0.67, s * 0.73, s * 0.35, fill="white", width=w,
                             capstyle="round", joinstyle="round")
        elif state == "bad":
            self.create_line(s * 0.33, s * 0.33, s * 0.67, s * 0.67, fill="white", width=w, capstyle="round")
            self.create_line(s * 0.67, s * 0.33, s * 0.33, s * 0.67, fill="white", width=w, capstyle="round")
        else:
            self.create_line(s * 0.5, s * 0.26, s * 0.5, s * 0.58, fill="white", width=w, capstyle="round")
            self.create_oval(s * 0.44, s * 0.68, s * 0.56, s * 0.8, fill="white", outline="white")


class NumberBadge(tk.Canvas):
    """Numbered circle: wizard steps (todo / current / done) and the MT5 how-to steps."""

    def __init__(self, parent, number, state="todo", size=26):
        tk.Canvas.__init__(self, parent, width=px(size), height=px(size), bg=_bg(parent), highlightthickness=0, bd=0)
        self.number, self.size = number, px(size)
        self.set(state)

    def set(self, state):
        self.delete("all")
        s = self.size
        if state == "done":
            self.create_oval(1, 1, s - 1, s - 1, fill=C["good_dot"], outline=C["good_dot"])
            w = max(2, int(s * 0.1))
            self.create_line(s * 0.28, s * 0.52, s * 0.44, s * 0.67, s * 0.73, s * 0.35, fill="white", width=w,
                             capstyle="round", joinstyle="round")
            return
        if state == "current":
            self.create_oval(1, 1, s - 1, s - 1, fill=C["accent"], outline=C["accent"])
            ink = "white"
        elif state == "soft":
            self.create_oval(1, 1, s - 1, s - 1, fill=C["accent_soft"], outline=C["accent_soft"])
            ink = C["accent_hi"]
        else:
            self.create_oval(2, 2, s - 2, s - 2, fill=C["surface"], outline=C["line2"], width=max(1, px(1.5)))
            ink = C["muted"]
        self.create_text(s / 2.0, s / 2.0, text=str(self.number), fill=ink, font=F["sbold"])


class ScrollFrame(tk.Frame):
    """A vertical scroll area whose scrollbar only shows when the content is taller than the area."""

    def __init__(self, parent, bg=None, **kw):
        bg = bg or _bg(parent)
        tk.Frame.__init__(self, parent, bg=bg, bd=0, highlightthickness=0, **kw)
        self.canvas = tk.Canvas(self, bg=bg, highlightthickness=0, bd=0, yscrollincrement=px(20))
        self.vsb = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.inner = tk.Frame(self.canvas, bg=bg, bd=0, highlightthickness=0)
        self.inner._scroll_inner = True
        self.win = self.canvas.create_window(0, 0, window=self.inner, anchor="nw")
        self.canvas.configure(yscrollcommand=self.vsb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self._shown = False
        self.inner.bind("<Configure>", lambda e: self._update())
        self.canvas.bind("<Configure>", self._on_canvas)
        self.bind("<Enter>", lambda e: self.canvas.bind_all("<MouseWheel>", self._wheel))
        self.bind("<Leave>", lambda e: self.canvas.unbind_all("<MouseWheel>"))

    def _on_canvas(self, e):
        self.canvas.itemconfigure(self.win, width=e.width)
        self._update()

    def _update(self):
        self.canvas.configure(scrollregion=(0, 0, self.inner.winfo_reqwidth(), self.inner.winfo_reqheight()))
        need = self.inner.winfo_reqheight() > self.canvas.winfo_height() + 1
        if need and not self._shown:
            self.vsb.pack(side="right", fill="y")
            self._shown = True
        elif not need and self._shown:
            self.vsb.pack_forget()
            self._shown = False
            self.canvas.yview_moveto(0)

    def _wheel(self, e):
        if self._shown:
            self.canvas.yview_scroll(int(-e.delta / 120), "units")

    def clear(self):
        for w in self.inner.winfo_children():
            w.destroy()
        self.canvas.yview_moveto(0)


class Banner(tk.Frame):
    """A coloured message box (info / good / warn / bad) that takes no space while hidden."""
    KINDS = {"info": ("accent_soft", "accent_hi", "accent"), "good": ("good_soft", "good", "good_dot"),
             "warn": ("warn_soft", "warn", "warn_dot"), "bad": ("bad_soft", "bad", "bad_dot")}

    def __init__(self, parent, pady=(0, 0)):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.pady = tuple(px(p) for p in pady)
        self.box = None
        self.key = None

    def hide(self):
        if self.box is not None:
            self.box.destroy()
            self.box = None
        self.key = None

    def show(self, kind, title, text="", actions=()):
        key = (kind, title, text, tuple(a[0] for a in actions))
        if key == self.key:
            return
        self.hide()
        self.key = key
        soft, ink, border = (C[k] for k in self.KINDS.get(kind, self.KINDS["info"]))
        box = tk.Frame(self, bg=soft, bd=0, highlightthickness=1, highlightbackground=border)
        box.pack(fill="x", pady=self.pady)
        inner = frame(box, bg=soft)
        inner.pack(fill="x", padx=px(12), pady=px(9))
        icon = StatusIcon(inner, {"good": "ok", "bad": "bad", "warn": "warn", "info": "info"}[kind], size=18)
        icon.configure(bg=soft)
        icon.pack(side="left", anchor="n", pady=(px(1), 0))
        col = frame(inner, bg=soft)
        col.pack(side="left", fill="x", expand=True, padx=(px(10), 0))
        L(col, title, font="bold", fg=ink, bg=soft, wrap=True).pack(fill="x")
        if text:
            L(col, text, font="small", fg="ink2", bg=soft, wrap=True).pack(fill="x", pady=(px(2), 0))
        if actions:
            row = frame(col, bg=soft)
            row.pack(fill="x", pady=(px(8), 0))
            for label, cmd in actions:
                ttk.Button(row, text=label, command=cmd, style="Small.TButton").pack(side="left", padx=(0, px(8)))
        self.box = box


def section_title(parent, text, sub=None):
    L(parent, text, font="h3").pack(fill="x")
    if sub:
        L(parent, sub, font="small", fg="muted", wrap=True).pack(fill="x", pady=(px(2), 0))


def entry_row(parent, label, width=42, show=None, hint=None):
    L(parent, label, font="sbold", fg="ink2").pack(fill="x", pady=(px(8), px(3)))
    e = ttk.Entry(parent, width=width, show=show or "", font=F["base"])
    e.pack(anchor="w", fill="x" if width is None else None)
    if hint:
        L(parent, hint, font="small", fg="muted", wrap=True).pack(fill="x", pady=(px(3), 0))
    return e


# ---------------------------------------------------------------------------------------------------------------------
# Dialogs
# ---------------------------------------------------------------------------------------------------------------------
class ChoiceDialog(object):
    """A modal question with clearly labelled buttons. choices: [(value, label, style)]."""

    def __init__(self, ui, title, text, choices, kind="warn"):
        self.ui, self.value = ui, None
        top = self.top = tk.Toplevel(ui.root)
        top.withdraw()
        top.title(title)
        top.configure(bg=C["surface"])
        top.resizable(False, False)
        top.transient(ui.root)
        try:
            top.iconphoto(False, ui.icon64)
        except tk.TclError:
            pass
        body = frame(top, bg=C["surface"])
        body.pack(fill="both", expand=True, padx=px(22), pady=px(20))
        head = frame(body)
        head.pack(fill="x")
        StatusIcon(head, {"warn": "warn", "bad": "bad", "info": "info", "good": "ok"}.get(kind, "warn"),
                   size=26).pack(side="left", anchor="n")
        col = frame(head)
        col.pack(side="left", fill="x", expand=True, padx=(px(12), 0))
        L(col, title, font="h2").pack(fill="x")
        L(col, text, font="base", fg="ink2", wrap=380).pack(fill="x", pady=(px(6), 0))
        row = frame(body)
        row.pack(fill="x", pady=(px(18), 0))
        for value, label, style in reversed(choices):
            ttk.Button(row, text=label, style=style or "TButton",
                       command=lambda v=value: self.close(v)).pack(side="right", padx=(px(8), 0))
        top.protocol("WM_DELETE_WINDOW", lambda: self.close(None))
        top.update_idletasks()
        w, h = max(top.winfo_reqwidth(), px(460)), top.winfo_reqheight()
        rx, ry = ui.root.winfo_rootx(), ui.root.winfo_rooty()
        rw, rh = ui.root.winfo_width(), ui.root.winfo_height()
        top.geometry("%dx%d+%d+%d" % (w, h, rx + max(0, (rw - w) // 2), ry + max(0, (rh - h) // 3)))
        top.deiconify()

    def close(self, value):
        self.value = value
        try:
            self.top.grab_release()
        except tk.TclError:
            pass
        self.top.destroy()

    def run(self):
        self.top.grab_set()
        self.top.focus_set()
        self.ui.root.wait_window(self.top)
        return self.value


# ---------------------------------------------------------------------------------------------------------------------
# Shared forms
# ---------------------------------------------------------------------------------------------------------------------
class LimitsForm(tk.Frame):
    """The local safety limits (wizard step 5 and Settings). Saved on this PC only; the web can never change them."""
    CHECKS = [
        ("allow_remote_control", "ให้เว็บควบคุมบอทได้",
         "เว็บสั่งหยุดชั่วคราว / ทำงานต่อ ลด lot และตั้งช่วงงดเทรดข่าวได้ ถ้าปิด แอปจะไม่เขียนไฟล์ควบคุมให้ EA เลย"),
        ("allow_remote_live", "ให้เว็บเปิดเทรดจริงได้",
         "ปิดไว้ (แนะนำ) = เว็บ \"ปิด\" เทรดจริงได้เสมอ แต่ \"เปิด\" ไม่ได้ ถ้าเปิดไว้ เว็บจะขอรหัสผ่านซ้ำทุกครั้งก่อนเปิดเทรดจริง"),
        ("allow_remote_params", "ให้เว็บส่งพรีเซ็ตให้ EA ได้",
         "ใช้ได้กับ EA v3.04 เท่านั้น และต้องตั้ง InpRemoteParams = true ใน EA ด้วย พรีเซ็ตที่เกินเพดานด้านล่างจะถูกปฏิเสธทั้งชุด"),
    ]

    def __init__(self, parent):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.vars = {}
        for key, title, text in self.CHECKS:
            v = tk.BooleanVar(value=da.DEFAULT_LIMITS[key])
            self.vars[key] = v
            row = frame(self)
            row.pack(fill="x", pady=(0, px(10)))
            ttk.Checkbutton(row, text=title, variable=v, style="S.TCheckbutton").pack(anchor="w")
            L(row, text, font="small", fg="muted", wrap=True).pack(fill="x", padx=(px(26), 0))
        nums = frame(self)
        nums.pack(fill="x", pady=(px(2), 0))
        nums.columnconfigure(1, weight=1)
        self.max_lots = tk.StringVar(value="0.10")
        self.max_cap = tk.StringVar(value="10")
        for r, (var, title, text, lo, hi, step) in enumerate([
                (self.max_lots, "lot สูงสุดที่เว็บสั่งได้", "lot จากเว็บที่เกินนี้จะถูกลดลงเหลือเท่านี้", 0.01, 100, 0.01),
                (self.max_cap, "เพดานขาดทุนรายวันสูงสุด (%)", "พรีเซ็ตจากเว็บที่ตั้งจุดหยุดรายวัน (InpDailyCapPct) เกินนี้จะถูกปฏิเสธ",
                 1, 100, 0.5)]):
            sp = ttk.Spinbox(nums, textvariable=var, from_=lo, to=hi, increment=step, width=7, font=F["base"],
                             justify="right")
            sp.grid(row=r, column=0, sticky="w", pady=(0, px(8)))
            col = frame(nums)
            col.grid(row=r, column=1, sticky="ew", padx=(px(12), 0), pady=(0, px(8)))
            L(col, title, font="bold").pack(fill="x")
            L(col, text, font="small", fg="muted", wrap=True).pack(fill="x")
        L(self, "ค่าเหล่านี้เก็บไว้ในเครื่องนี้เท่านั้น เว็บเปลี่ยนไม่ได้ และเว็บสั่งเกินค่านี้ไม่ได้", font="small",
          fg="accent_hi", wrap=True).pack(fill="x", pady=(px(4), 0))

    def set(self, limits):
        for k, v in self.vars.items():
            v.set(bool(limits.get(k)))
        self.max_lots.set("%.2f" % limits["max_lots"])
        self.max_cap.set("%g" % limits["max_daily_cap_pct"])

    def get(self):
        """(limits dict, None) or (None, Thai error)."""
        out = dict((k, bool(v.get())) for k, v in self.vars.items())
        lots, cap = da.to_num(self.max_lots.get()), da.to_num(self.max_cap.get())
        if lots is None or not (0 < lots <= 100):
            return None, "lot สูงสุดต้องเป็นตัวเลขมากกว่า 0 เช่น 0.10"
        if cap is None or not (0 < cap <= 100):
            return None, "เพดานขาดทุนรายวันต้องอยู่ระหว่าง 1 ถึง 100"
        out["max_lots"] = round(lots, 2) if lots >= 0.01 else 0.01
        out["max_daily_cap_pct"] = float(cap)
        return out, None


# ---------------------------------------------------------------------------------------------------------------------
# Screens
# ---------------------------------------------------------------------------------------------------------------------
class Screen(tk.Frame):
    def __init__(self, ui):
        tk.Frame.__init__(self, ui.container, bg=C["bg"], bd=0, highlightthickness=0)
        self.ui = ui

    def on_show(self, **kw):
        pass

    def refresh(self):
        pass


def app_header(screen, title, back=None, right=None):
    bar = frame(screen, bg=C["surface"])
    bar.pack(fill="x")
    inner = frame(bar)
    inner.pack(fill="x", padx=px(18), pady=px(10))
    if back:
        ttk.Button(inner, text="‹  กลับ", command=back, style="Head.TButton").pack(side="left", padx=(0, px(12)))
    tk.Label(inner, image=screen.ui.icon28, bg=C["surface"], bd=0).pack(side="left")
    L(inner, "Dobby", font="h2").pack(side="left", padx=(px(8), 0))
    L(inner, "  |  " + title, font="base", fg="muted").pack(side="left")
    if right:
        right(inner)
    frame(screen, bg=C["line"], height=1).pack(fill="x")
    return inner


# -- wizard -------------------------------------------------------------------------------------------------------------
class Page(tk.Frame):
    title = ""
    subtitle = ""

    def __init__(self, wiz):
        tk.Frame.__init__(self, wiz.card.body, bg=C["surface"], bd=0, highlightthickness=0)
        self.wiz, self.ui = wiz, wiz.ui
        self.busy = False
        L(self, self.title, font="h1").pack(fill="x")
        L(self, self.subtitle, font="base", fg="muted", wrap=True).pack(fill="x", pady=(px(3), px(12)))
        self.build()

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


class SignInPage(Page):
    title = "เข้าสู่ระบบด้วยบัญชีเว็บ Dobby"
    subtitle = "ใช้อีเมลและรหัสผ่านเดียวกับที่ใช้บนเว็บ แอปไม่เก็บรหัสผ่าน เก็บไว้แค่กุญแจเข้าระบบ (token) ในเครื่องนี้"

    def build(self):
        self.done_box = frame(self)
        self.form = frame(self)
        f = self.form
        self.email = entry_row(f, "อีเมล", width=44)
        self.password = entry_row(f, "รหัสผ่าน", width=44, show="•")
        self.password.bind("<Return>", lambda e: self.do_sign_in())
        self.email.bind("<Return>", lambda e: self.password.focus_set())
        row = frame(f)
        row.pack(fill="x", pady=(px(14), 0))
        self.btn = ttk.Button(row, text="เข้าสู่ระบบ", style="Accent.TButton", command=self.do_sign_in)
        self.btn.pack(side="left")
        Link(row, "ยังไม่มีบัญชี? สมัครบนเว็บ", lambda: self.ui.ctx.open_url(WEB_URL)).pack(side="left",
                                                                                         padx=(px(16), 0))
        self.banner = Banner(self, pady=(px(14), 0))
        self.banner.pack(fill="x")
        self.adv_link = Link(self, "ขั้นสูง: ที่อยู่เซิร์ฟเวอร์", self.toggle_adv, font="slink")
        self.adv_link.pack(anchor="w", side="bottom", pady=(px(10), 0))
        self.adv = frame(self)
        self.url = entry_row(self.adv, "Supabase URL", width=52)
        self.key = entry_row(self.adv, "Publishable key (คีย์สาธารณะ)", width=52,
                             hint="ปกติไม่ต้องแก้ ค่าเริ่มต้นคือเว็บ Dobby ของผู้ดูแล")
        self.adv_open = False

    def toggle_adv(self):
        self.adv_open = not self.adv_open
        if self.adv_open:
            cfg = self.ui.cfg
            self.url.delete(0, "end")
            self.url.insert(0, cfg.get("supabase_url") or "")
            self.key.delete(0, "end")
            self.key.insert(0, cfg.get("anon_key") or "")
            self.adv.pack(fill="x", side="bottom", before=self.adv_link)
        else:
            self.adv.pack_forget()

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
            self.banner.show("bad", "ตรวจบัญชีไม่ได้: เชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ตแล้วลองใหม่",
                             [("ลองใหม่", self.on_enter)])
        self.show_state()

    def show_state(self):
        cfg = self.ui.cfg
        for w in self.done_box.winfo_children():
            w.destroy()
        if cfg.get("refresh_token") and self.ui.approved is not False:
            self.form.pack_forget()
            self.adv_link.pack_forget()
            if self.adv_open:
                self.toggle_adv()
            self.done_box.pack(fill="x", before=self.banner)
            card = Card(self.done_box, bg=C["good_soft"], border="#BFE3C6", pad=14)
            card.pack(fill="x")
            row = frame(card.body)
            row.pack(fill="x")
            StatusIcon(row, "ok" if self.ui.approved else "idle", size=26).pack(side="left")
            col = frame(row)
            col.pack(side="left", fill="x", expand=True, padx=(px(12), 0))
            L(col, "เข้าสู่ระบบแล้ว" if self.ui.approved else "กำลังตรวจบัญชี…", font="bold", fg="good").pack(fill="x")
            L(col, cfg.get("email") or "", font="base", fg="ink2").pack(fill="x")
            ttk.Button(row, text="ใช้บัญชีอื่น", command=self.use_other, style="Small.TButton").pack(side="right")
            if self.ui.approved:
                self.banner.hide()
        else:
            self.done_box.pack_forget()
            self.form.pack(fill="x", before=self.banner)
            if not self.adv_link.winfo_manager():
                self.adv_link.pack(anchor="w", side="bottom", pady=(px(10), 0))
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
        self.banner.hide()
        self.show_state()
        self.email.focus_set()

    def _save_advanced(self):
        if not self.adv_open:
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
        if "@" not in email or " " in email:
            self.banner.show("bad", "ใส่อีเมลให้ถูกต้อง", "เช่น name@gmail.com")
            self.email.focus_set()
            return
        if not pw:
            self.banner.show("bad", "ใส่รหัสผ่าน")
            self.password.focus_set()
            return
        if not self._save_advanced():
            return
        self.password.delete(0, "end")
        self.set_busy(True)
        self.btn.configure(state="disabled")
        self.banner.show("info", "กำลังเข้าสู่ระบบ…")
        client = self.ui.client
        self.ui.bg(lambda: core.sign_in(client, email, pw), lambda ok: self._signed(email, ok), self._failed)
        pw = None  # noqa: F841 - drop the reference

    def _signed(self, email, approved):
        self.set_busy(False)
        self.btn.configure(state="normal")
        core.update_app_config(self.ui.ctx.data_dir, lambda c: c.__setitem__("email", email))
        self.ui.reload_cfg()
        self.ui.approved = bool(approved)
        if approved:
            self.banner.show("good", "เข้าสู่ระบบสำเร็จ", "กด ถัดไป เพื่อเลือก MT5")
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
        self.btn.configure(state="normal")
        if isinstance(exc, da.AuthError):
            self.banner.show("bad", core.AUTH_TH[core.auth_problem(exc)],
                             "" if core.auth_problem(exc) != "other" else da.redact(str(exc)))
        elif isinstance(exc, da.NetworkError):
            self.banner.show("bad", "เชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ตแล้วลองใหม่")
        else:
            self.banner.show("bad", "เข้าสู่ระบบไม่สำเร็จ", da.redact(str(exc)))
        self.password.focus_set()
        self.show_state()

    def can_next(self):
        return not self.busy and bool(self.ui.cfg.get("refresh_token")) and self.ui.approved is True


class MT5Page(Page):
    title = "เลือก MT5 ที่จะใช้กับ Dobby"
    subtitle = "แอปพบโปรแกรม MT5 ในเครื่องนี้ตามรายการด้านล่าง เลือกตัวที่ล็อกอินบัญชีที่จะให้ Dobby เทรด"

    def build(self):
        self.var = tk.StringVar()
        self.common = Card(self, bg=C["surface2"], border=C["line"], pad=12)
        self.common.pack(side="bottom", fill="x", pady=(px(12), 0))
        row = frame(self)
        row.pack(side="bottom", fill="x", pady=(px(10), 0))
        ttk.Button(row, text="ค้นหาอีกครั้ง", style="Small.TButton", command=self.scan).pack(side="left")
        ttk.Button(row, text="เลือกโฟลเดอร์เอง…", style="Small.TButton", command=self.pick).pack(side="left",
                                                                                             padx=(px(8), 0))
        self.list = ScrollFrame(self, bg=C["surface"], height=px(150))
        self.list.pack(fill="both", expand=True)
        self.terminals = []
        self.rows = {}

    def on_enter(self):
        self.scan()

    def scan(self):
        cfg = self.ui.cfg
        found = core.detect_terminals(self.ui.ctx.appdata)
        chosen = (cfg.get("app") or {}).get("mt5_data_dir") or ""
        if chosen and core.is_data_dir(chosen) and not any(os.path.normcase(t["data_dir"]) == os.path.normcase(chosen)
                                                         for t in found):
            found.insert(0, core.describe_terminal(chosen))
        self.terminals = found
        self.list.clear()
        self.rows = {}
        if not found:
            box = frame(self.list.inner)
            box.pack(fill="x", pady=px(6))
            L(box, "ไม่พบ MT5 ในเครื่องนี้", font="bold").pack(fill="x")
            L(box, "ติดตั้ง MT5 จากเว็บโบรกเกอร์ของคุณ เปิดและล็อกอินบัญชีหนึ่งครั้ง แล้วกด ค้นหาอีกครั้ง "
                   "(หรือกด ถัดไป เพื่อข้ามไปก่อน)", font="small", fg="muted", wrap=True).pack(fill="x")
        for t in found:
            self._row(t)
        if chosen and any(t["data_dir"] == chosen for t in found):
            self.var.set(chosen)
        elif found:
            self.var.set(found[0]["data_dir"])
        else:
            self.var.set("")
        self._mark()
        self._common()

    def _row(self, t):
        box = tk.Frame(self.list.inner, bg=C["surface"], highlightthickness=1, highlightbackground=C["line"], bd=0)
        box.pack(fill="x", pady=(0, px(8)), padx=(0, px(4)))
        inner = frame(box)
        inner.pack(fill="x", padx=px(12), pady=px(9))
        top = frame(inner)
        top.pack(fill="x")
        rb = ttk.Radiobutton(top, text=t["name"], value=t["data_dir"], variable=self.var, style="S.TRadiobutton",
                             command=self._mark)
        rb.pack(side="left")
        if t["ea_files"]:
            L(top, "  มี EA Dobby แล้ว", font="sbold", fg="good").pack(side="left")
        bits = []
        if t["servers"]:
            bits.append("เซิร์ฟเวอร์ " + ", ".join(t["servers"][:3]))
        if t["last_used"]:
            bits.append("ใช้ล่าสุด " + time.strftime("%d/%m/%Y %H:%M", time.localtime(t["last_used"])))
        L(inner, "   ".join(bits) or "MetaTrader 5", font="small", fg="ink2").pack(fill="x", padx=(px(26), 0))
        L(inner, t["install_dir"] or t["data_dir"], font="small", fg="muted").pack(fill="x", padx=(px(26), 0))
        for w in [box, inner, top] + list(inner.winfo_children()):
            if not isinstance(w, ttk.Radiobutton):
                w.bind("<Button-1>", lambda e, v=t["data_dir"]: (self.var.set(v), self._mark()))
        self.rows[t["data_dir"]] = box

    def _mark(self):
        for d, box in self.rows.items():
            box.configure(highlightbackground=C["accent"] if d == self.var.get() else C["line"])

    def _common(self):
        b = self.common.body
        for w in b.winfo_children():
            w.destroy()
        info = core.common_dir_info(self.ui.ctx.common_dir(self.ui.cfg))
        L(b, "โฟลเดอร์ไฟล์ของ EA (ใช้ร่วมกันทุก MT5)", font="sbold", bg=C["surface2"]).pack(fill="x")
        L(b, info["path"], font="small", fg="ink2", bg=C["surface2"], wrap=True).pack(fill="x", pady=(px(2), px(4)))
        if info["age"] is not None and info["age"] < core.EA_ONLINE_S:
            text, fg = "พบแล้ว: EA Dobby กำลังทำงานอยู่", "good"
        elif info["exists"]:
            text, fg = "พบแล้ว: EA เคยทำงานในเครื่องนี้", "good"
        else:
            text, fg = "ยังไม่มี (ปกติสำหรับเครื่องใหม่): MT5 จะสร้างให้เองเมื่อ EA ทำงานครั้งแรก", "muted"
        L(b, text, font="small", fg=fg, bg=C["surface2"], wrap=True).pack(fill="x")

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
        core.update_app_config(self.ui.ctx.data_dir, lambda c: c["app"].__setitem__("mt5_data_dir", d))
        self.ui.reload_cfg()
        self.scan()

    def on_next(self):
        d = self.var.get()
        if not d:
            if not self.ui.ask_yes_no("ยังไม่ได้เลือก MT5", "ข้ามขั้นติดตั้ง EA ไปก่อนไหม?\n"
                                                           "(ติดตั้ง EA เองภายหลังได้)"):
                return False
            return 3
        core.update_app_config(self.ui.ctx.data_dir, lambda c: c["app"].__setitem__("mt5_data_dir", d))
        self.ui.reload_cfg()
        return True


class EAPage(Page):
    title = "ติดตั้ง EA และพรีเซ็ต"
    subtitle = "แอปดาวน์โหลดไฟล์จากเว็บ Dobby แล้วคัดลอกไปไว้ใน MT5 ที่เลือก ไฟล์อื่นใน MT5 จะไม่ถูกแตะ"

    def build(self):
        self.where = frame(self)
        self.where.pack(fill="x")
        self.banner = Banner(self, pady=(px(10), 0))
        self.banner.pack(side="bottom", fill="x")
        row = frame(self)
        row.pack(side="bottom", fill="x", pady=(px(10), 0))
        self.btn = ttk.Button(row, text="ติดตั้งไฟล์ที่เลือก", style="Accent.TButton", command=self.install)
        self.btn.pack(side="left")
        ttk.Button(row, text="ติดตั้งเองแล้ว ข้ามขั้นนี้", command=self.wiz.next).pack(side="left", padx=(px(10), 0))
        self.list = ScrollFrame(self, bg=C["surface"], height=px(120))
        self.list.pack(fill="both", expand=True, pady=(px(10), 0))
        self.files, self.vars, self.results = [], {}, {}
        self.loaded_for = None

    def data_dir(self):
        return (self.ui.cfg.get("app") or {}).get("mt5_data_dir") or ""

    def on_enter(self):
        d = self.data_dir()
        for w in self.where.winfo_children():
            w.destroy()
        if not d:
            self.banner.show("warn", "ยังไม่ได้เลือก MT5", "ย้อนกลับไปเลือก MT5 ก่อน หรือกด ข้ามขั้นนี้")
            self.btn.configure(state="disabled")
            return
        L(self.where, "MT5: " + d, font="small", fg="muted", wrap=True).pack(fill="x", pady=(0, px(4)))
        for kind, sub in (("EA (.ex5)", "MQL5\\Experts\\Dobby"), ("พรีเซ็ต (.set)", "MQL5\\Presets")):
            r = frame(self.where)
            r.pack(fill="x")
            L(r, kind, font="sbold", fg="ink2", width=13).pack(side="left")
            L(r, "→  ไปที่โฟลเดอร์ " + sub, font="small", fg="ink2").pack(side="left", fill="x", expand=True)
        if self.loaded_for != d:
            self.load()

    def load(self):
        self.list.clear()
        L(self.list.inner, "กำลังโหลดรายการไฟล์จากเว็บ…", font="base", fg="muted").pack(fill="x", pady=px(8))
        self.set_busy(True)
        self.btn.configure(state="disabled")
        self.banner.hide()
        self.ui.bg(self.ui.client.list_files, self._loaded, self._load_failed)

    def _load_failed(self, exc):
        self.set_busy(False)
        self.list.clear()
        if isinstance(exc, da.NetworkError):
            title = "เชื่อมต่อเว็บไม่ได้"
        elif isinstance(exc, da.AuthError):
            title = "ต้องเข้าสู่ระบบใหม่"
        else:
            title = "โหลดรายการไฟล์ไม่ได้ (บัญชีได้รับอนุมัติหรือยัง?)"
        self.banner.show("bad", title, da.redact(str(exc))[:200], [("ลองใหม่", self.load)])

    def _loaded(self, rows):
        self.set_busy(False)
        self.loaded_for = self.data_dir()
        self.files = core.storage_files(rows)
        self.list.clear()
        self.vars, self.results = {}, {}
        if not self.files:
            L(self.list.inner, "ผู้ดูแลยังไม่ได้อัปโหลดไฟล์ EA บนเว็บ: ติดตั้ง EA เองแล้วกด ข้ามขั้นนี้", font="base",
              fg="muted", wrap=True).pack(fill="x", pady=px(8))
            return
        for f in self.files:
            box = frame(self.list.inner)
            box.pack(fill="x", pady=(0, px(2)))
            v = tk.BooleanVar(value=bool(f["kind"]))
            self.vars[f["name"]] = v
            cb = ttk.Checkbutton(box, text=f["name"], variable=v, style="S.TCheckbutton")
            cb.pack(side="left")
            if not f["kind"]:
                cb.state(["disabled"])
            kind = {"ea": "EA", "preset": "พรีเซ็ต"}.get(f["kind"], "ดาวน์โหลดจากเว็บ (ไม่ต้องติดตั้งใน MT5)")
            L(box, "  %s  %s" % (kind, core.fmt_size(f["size"])), font="small", fg="muted").pack(side="left")
            res = L(box, "", font="sbold", fg="good")
            res.pack(side="right", padx=(0, px(6)))
            self.results[f["name"]] = res
        self.btn.configure(state="normal")

    def install(self):
        d = self.data_dir()
        names = [f["name"] for f in self.files if f["kind"] and self.vars.get(f["name"]) and
                 self.vars[f["name"]].get()]
        if not names:
            self.banner.show("warn", "ยังไม่ได้เลือกไฟล์", "ติ๊กไฟล์ที่ต้องการติดตั้ง หรือกด ข้ามขั้นนี้")
            return
        self.set_busy(True)
        self.btn.configure(state="disabled")
        self.banner.show("info", "กำลังดาวน์โหลด %d ไฟล์…" % len(names))
        client = self.ui.client
        self.ui.bg(lambda: [(n, client.download_file(n)) for n in names], lambda got: self._write(d, got),
                   self._install_failed)

    def _install_failed(self, exc):
        self.set_busy(False)
        self.btn.configure(state="normal")
        self.banner.show("bad", "ดาวน์โหลดไม่สำเร็จ", da.redact(str(exc))[:200])

    def _write(self, d, got):
        done, kept, failed = 0, 0, []
        for name, data in got:
            target = core.install_target(d, name)
            if target is None:
                continue
            overwrite = False
            if core.file_state(target, data) == "different":
                overwrite = self.ui.ask_yes_no(
                    "มีไฟล์ชื่อนี้อยู่แล้ว", "%s\nมีอยู่แล้วใน MT5 และไม่เหมือนไฟล์ใหม่\n\nแทนที่ด้วยไฟล์จากเว็บไหม?\n"
                    "(ถ้า EA ตัวนี้ติดกราฟอยู่ MT5 จะโหลด EA ใหม่เอง)" % target)
            try:
                res = core.install_file(target, data, overwrite=overwrite)
            except OSError as e:
                failed.append("%s: %s" % (name, e))
                self.results[name].configure(text="ไม่สำเร็จ", fg=C["bad"])
                continue
            text = {"installed": "ติดตั้งแล้ว", "same": "มีอยู่แล้ว (เหมือนกัน)", "kept": "เก็บไฟล์เดิมไว้"}[res]
            self.results[name].configure(text=text, fg=C["good"] if res != "kept" else C["muted"])
            done += res in ("installed", "same")
            kept += res == "kept"
            LOG.info("EA install: %s -> %s (%s)", name, target, res)
        self.set_busy(False)
        self.btn.configure(state="normal")
        if failed:
            self.banner.show("bad", "ติดตั้งบางไฟล์ไม่สำเร็จ", "; ".join(failed)[:300])
        else:
            self.banner.show("good", "ติดตั้งเสร็จแล้ว (%d ไฟล์)" % done,
                             "ใน MT5 ให้คลิกขวาที่ Expert Advisors ในหน้าต่าง Navigator แล้วกด Refresh จะเห็น EA Dobby")


class LinkPage(Page):
    title = "ตั้งชื่อเครื่องนี้และเชื่อมกับบอท"
    subtitle = "บอท 1 ตัวบนเว็บ = MT5 1 เครื่อง สร้างบอทใหม่ หรือใช้บอทเดิมที่เคยตั้งไว้"

    def build(self):
        self.mode = tk.StringVar(value="new")
        self.banner = Banner(self, pady=(px(10), 0))
        self.banner.pack(side="bottom", fill="x")
        row = frame(self)
        row.pack(side="bottom", fill="x", pady=(px(10), 0))
        self.btn = ttk.Button(row, text="เชื่อมเครื่องนี้", style="Accent.TButton", command=self.do_link)
        self.btn.pack(side="left")
        ttk.Radiobutton(self, text="สร้างบอทใหม่บนเว็บสำหรับเครื่องนี้", value="new", variable=self.mode,
                        style="S.TRadiobutton", command=self._mode).pack(anchor="w")
        self.new_box = frame(self)
        self.new_box.pack(fill="x", padx=(px(26), 0))
        r = frame(self.new_box)
        r.pack(fill="x", pady=(px(4), 0))
        L(r, "ชื่อเครื่อง (แสดงบนเว็บ)", font="sbold", fg="ink2").pack(side="left")
        self.name = ttk.Entry(r, width=30, font=F["base"])
        self.name.pack(side="left", padx=(px(10), 0))
        self.note = L(self.new_box, "", font="small", fg="muted", wrap=True)
        self.note.pack(fill="x", pady=(px(4), 0))
        ttk.Radiobutton(self, text="ใช้บอทที่มีอยู่แล้วในบัญชีนี้", value="existing", variable=self.mode,
                        style="S.TRadiobutton", command=self._mode).pack(anchor="w", pady=(px(12), 0))
        self.old_box = frame(self)
        self.old_box.pack(fill="both", expand=True, padx=(px(26), 0))
        self.tree = ttk.Treeview(self.old_box, columns=("name", "ea", "seen"), show="headings", height=3,
                                 selectmode="browse")
        for col, text, w in (("name", "ชื่อบอท", 200), ("ea", "EA", 70), ("seen", "ออนไลน์ล่าสุด", 150)):
            self.tree.heading(col, text=text, anchor="w")
            self.tree.column(col, width=px(w), anchor="w", stretch=col == "name")
        L(self.old_box, "ค่าบนเว็บของบอทนั้น (หยุด/ทำงาน, lot, ช่วงงดเทรด) จะใช้กับ MT5 เครื่องนี้เมื่อกดเริ่มทำงาน",
          font="small", fg="muted", wrap=True).pack(side="bottom", fill="x", pady=(px(4), 0))
        self.tree.pack(fill="both", expand=True, pady=(px(4), 0))
        self.tree.bind("<<TreeviewSelect>>", lambda e: self.mode.set("existing"))
        self.bots = {}

    def _mode(self):
        pass

    def ea_online(self):
        info = core.common_dir_info(self.ui.ctx.common_dir(self.ui.cfg))
        return info["age"] is not None and info["age"] < core.EA_ONLINE_S

    def on_enter(self):
        cfg = self.ui.cfg
        if not self.name.get():
            self.name.insert(0, (cfg.get("bot_name") or (cfg.get("app") or {}).get("pending_bot_name") or
                                 socket.gethostname() or "คอมของฉัน")[:100])
        if self.ea_online():
            self.note.configure(text="พบ EA กำลังทำงาน: แอปจะอ่านสถานะปัจจุบันของ EA (เปิด/ปิดเทรดจริง, lot, ช่วงงดเทรด) "
                                     "ไปตั้งต้นบนเว็บ ใช้เวลาประมาณ 6 วินาที")
        else:
            self.note.configure(text="ยังไม่พบ EA ทำงานใน MT5: ไม่เป็นไร แอปจะสร้างบอทบนเว็บให้เอง เมื่อ EA เริ่มทำงาน"
                                     "ครั้งแรกหลังกดเริ่ม (ตั้งต้นจากสถานะของ EA)")
        self.show_linked()
        self.load_bots()

    def show_linked(self):
        cfg = self.ui.cfg
        pending = (cfg.get("app") or {}).get("pending_bot_name")
        if cfg.get("bot_id"):
            self.banner.show("good", "เครื่องนี้เชื่อมกับบอท \"%s\" แล้ว" % (cfg.get("bot_name") or "Dobby"),
                             "กด ถัดไป หรือเลือกใหม่แล้วกด เชื่อมเครื่องนี้ อีกครั้ง")
        elif pending:
            self.banner.show("good", "พร้อมแล้ว: จะสร้างบอท \"%s\" บนเว็บให้เอง" % pending,
                             "สร้างให้อัตโนมัติเมื่อกดเริ่มทำงานและ EA ทำงานใน MT5")
        self.wiz.update_nav()

    def load_bots(self):
        self.tree.delete(*self.tree.get_children())
        self.tree.insert("", "end", iid="_loading", values=("กำลังโหลด…", "", ""))
        self.ui.bg(self.ui.client.list_bots, self._bots, self._bots_failed)

    def _bots(self, rows):
        self.tree.delete(*self.tree.get_children())
        self.bots = {}
        for b in rows:
            seen = da.parse_utc(b.get("last_seen"))
            self.bots[b["id"]] = b
            self.tree.insert("", "end", iid=b["id"], values=(
                b.get("name") or "-", b.get("ea_version") or "-",
                time.strftime("%d/%m/%Y %H:%M", time.localtime(seen)) if seen else "ยังไม่เคย"))
        if not rows:
            self.tree.insert("", "end", iid="_none", values=("ยังไม่มีบอทในบัญชีนี้", "", ""))
        if self.ui.cfg.get("bot_id") in self.bots:
            self.tree.selection_set(self.ui.cfg["bot_id"])
            self.mode.set("existing")

    def _bots_failed(self, exc):
        self.tree.delete(*self.tree.get_children())
        self.tree.insert("", "end", iid="_err", values=("โหลดรายการบอทไม่ได้", "", ""))

    def do_link(self):
        if self.busy:
            return
        if self.ui.runner.running:
            self.banner.show("bad", "หยุดการทำงานก่อน", "กดหยุดทำงานที่หน้าหลักก่อนเปลี่ยนบอท")
            return
        ui, cfg = self.ui, self.ui.cfg
        common = ui.ctx.common_dir(cfg)
        if self.mode.get() == "existing":
            sel = [s for s in self.tree.selection() if s in self.bots]
            if not sel:
                self.banner.show("warn", "เลือกบอทจากรายการก่อน")
                return
            core.link_existing_bot(ui.ctx.data_dir, common, self.bots[sel[0]])
            ui.reload_cfg()
            self.show_linked()
            return
        name = " ".join(self.name.get().split())[:100]
        if not name:
            self.banner.show("warn", "ตั้งชื่อเครื่องก่อน", "เช่น คอมที่บ้าน")
            return
        if cfg.get("bot_id") and not ui.ask_yes_no("สร้างบอทใหม่?", "เครื่องนี้เชื่อมกับบอท \"%s\" อยู่แล้ว\n"
                                                                  "สร้างบอทใหม่แทนไหม? (บอทเดิมยังอยู่บนเว็บ)"
                                                   % (cfg.get("bot_name") or "")):
            return
        if not self.ea_online():
            core.set_pending_bot(ui.ctx.data_dir, name)
            ui.reload_cfg()
            self.show_linked()
            return
        self.set_busy(True)
        self.btn.configure(state="disabled")
        self.banner.show("info", "กำลังอ่านสถานะ EA และสร้างบอท \"%s\"…" % name, "ประมาณ 6 วินาที")
        wait = ui.ctx.register_wait_s
        client, data_dir, cfg_now = ui.client, ui.ctx.data_dir, dict(cfg)
        ui.bg(lambda: core.register_new_bot(client, data_dir, common, name, cfg_now, wait_s=wait),
              self._registered, self._register_failed)

    def _registered(self, res):
        self.set_busy(False)
        self.btn.configure(state="normal")
        self.ui.reload_cfg()
        seed = res[1]
        self.banner.show("good", "สร้างบอท \"%s\" บนเว็บแล้ว" % self.ui.cfg.get("bot_name"),
                         "สถานะเริ่มต้นจาก EA: เทรดจริง %s" % ("เปิด" if seed["desired"]["live"] else "ปิด"))
        self.load_bots()
        self.wiz.update_nav()

    def _register_failed(self, exc):
        self.set_busy(False)
        self.btn.configure(state="normal")
        if isinstance(exc, core.NoEaStatus):
            self.banner.show("warn", "ไม่พบสถานะ EA", "ลองใหม่อีกครั้ง")
        elif "not_approved" in str(exc):
            self.banner.show("bad", "บัญชียังไม่ได้รับอนุมัติ", "ใส่รหัสเชิญบนเว็บ Dobby ก่อน")
        elif isinstance(exc, da.NetworkError):
            self.banner.show("bad", "เชื่อมต่อเว็บไม่ได้", "ตรวจอินเทอร์เน็ตแล้วลองใหม่")
        else:
            self.banner.show("bad", "สร้างบอทไม่สำเร็จ", da.redact(str(exc))[:200])

    def can_next(self):
        cfg = self.ui.cfg
        return not self.busy and bool(cfg.get("bot_id") or (cfg.get("app") or {}).get("pending_bot_name"))


class LimitsPage(Page):
    title = "ความปลอดภัยของเครื่องนี้"
    subtitle = "กำหนดว่าเว็บสั่งอะไรกับ MT5 เครื่องนี้ได้บ้าง ค่าเริ่มต้นปลอดภัย เปลี่ยนภายหลังได้ที่ ตั้งค่า"

    def build(self):
        self.form = LimitsForm(self)
        self.form.pack(fill="x")
        self.banner = Banner(self, pady=(px(8), 0))
        self.banner.pack(fill="x")

    def on_enter(self):
        self.form.set(da.get_limits(self.ui.cfg))

    def on_next(self):
        lim, err = self.form.get()
        if err:
            self.banner.show("bad", err)
            return False
        core.update_app_config(self.ui.ctx.data_dir, lambda c: c.__setitem__("limits", lim))
        self.ui.reload_cfg()
        return True


class WizardScreen(Screen):
    STEPS = [("เข้าสู่ระบบ", "บัญชีเว็บ Dobby"), ("เลือก MT5", "โปรแกรมเทรดในเครื่องนี้"),
             ("ติดตั้ง EA", "ไฟล์ EA และพรีเซ็ต"), ("ตั้งชื่อเครื่อง", "เชื่อมกับบอทบนเว็บ"),
             ("ความปลอดภัย", "ขีดจำกัดของเครื่องนี้")]

    def __init__(self, ui):
        Screen.__init__(self, ui)
        self.head = app_header(self, "ตั้งค่าครั้งแรก", right=self._head_right)
        body = frame(self)
        body.pack(fill="both", expand=True)
        side = frame(body, bg=C["side"], width=px(232))
        side.pack(side="left", fill="y")
        side.pack_propagate(False)
        L(side, "ตัวช่วยตั้งค่า", font="sbold", fg="muted").pack(fill="x", padx=px(20), pady=(px(20), px(10)))
        self.badges = []
        for i, (title, sub) in enumerate(self.STEPS):
            r = frame(side)
            r.pack(fill="x", padx=px(18), pady=(0, px(12)))
            b = NumberBadge(r, i + 1)
            b.pack(side="left", anchor="n")
            col = frame(r)
            col.pack(side="left", fill="x", padx=(px(10), 0))
            t = L(col, title, font="bold")
            t.pack(fill="x")
            L(col, sub, font="small", fg="muted").pack(fill="x")
            self.badges.append((b, t))
        L(side, "ทำครั้งเดียว ประมาณ 5 นาที\nต่อจากนี้แค่เปิดแอปแล้วกดเริ่ม", font="small", fg="muted").pack(
            side="bottom", fill="x", padx=px(20), pady=px(18))
        main = frame(body)
        main.pack(side="left", fill="both", expand=True)
        nav = frame(main)
        nav.pack(side="bottom", fill="x", padx=px(20), pady=(0, px(14)))
        self.card = Card(main, pad=20)
        self.card.pack(fill="both", expand=True, padx=px(20), pady=(px(16), px(10)))
        self.back_btn = ttk.Button(nav, text="‹  ย้อนกลับ", command=self.back)
        self.back_btn.pack(side="left")
        self.next_btn = ttk.Button(nav, text="ถัดไป  ›", style="Accent.TButton", command=self.next)
        self.next_btn.pack(side="right")
        self.step_lbl = L(nav, "", font="small", fg="muted")
        self.step_lbl.pack(side="right", padx=px(14))
        self.index = -1
        self.pages = [SignInPage(self), MT5Page(self), EAPage(self), LinkPage(self), LimitsPage(self)]

    def _head_right(self, inner):
        self.home_btn = ttk.Button(inner, text="กลับหน้าหลัก", style="Head.TButton", command=self.home)

    def home(self):
        self.ui.show("main")

    def on_show(self, step=0, **kw):
        if (self.ui.cfg.get("app") or {}).get("wizard_done"):
            self.home_btn.pack(side="right")
        else:
            self.home_btn.pack_forget()
        self.go(step)

    def go(self, i):
        i = max(0, min(len(self.pages) - 1, i))
        if 0 <= self.index < len(self.pages):
            self.pages[self.index].pack_forget()
        self.index = i
        page = self.pages[i]
        page.pack(fill="both", expand=True)
        for j, (b, t) in enumerate(self.badges):
            b.set("done" if j < i else "current" if j == i else "todo")
            t.configure(fg=C["accent_hi"] if j == i else C["ink"] if j < i else C["muted"])
        page.on_enter()
        self.update_nav()

    def update_nav(self):
        if not (0 <= self.index < len(self.pages)):
            return
        page = self.pages[self.index]
        last = self.index == len(self.pages) - 1
        self.next_btn.configure(text="เสร็จสิ้น  ✓" if last else "ถัดไป  ›",
                                state="normal" if page.can_next() else "disabled")
        self.back_btn.configure(state="normal" if self.index > 0 else "disabled")
        self.step_lbl.configure(text="ขั้นที่ %d จาก %d" % (self.index + 1, len(self.pages)))

    def back(self):
        if self.index > 0:
            self.go(self.index - 1)

    def next(self):
        page = self.pages[self.index]
        if not page.can_next():
            return
        res = page.on_next()
        if res is False:
            return
        if self.index == len(self.pages) - 1:
            self.finish()
        elif isinstance(res, int) and not isinstance(res, bool):
            self.go(res)
        else:
            self.go(self.index + 1)

    def finish(self):
        core.update_app_config(self.ui.ctx.data_dir, lambda c: c["app"].__setitem__("wizard_done", True))
        self.ui.reload_cfg()
        LOG.info("setup wizard finished")
        self.ui.show("main")


# -- main screen --------------------------------------------------------------------------------------------------------
class StatCard(Card):
    def __init__(self, parent, title):
        Card.__init__(self, parent, pad=12)
        b = self.body
        L(b, title, font="small", fg="muted").pack(fill="x")
        self.value = L(b, "-", font="num", wrap=True)
        self.value.pack(fill="x", pady=(px(2), 0))
        self.bar = None
        self.sub = L(b, "", font="small", fg="ink2", wrap=True)
        self.sub.pack(fill="x")

    def set(self, value, sub="", tone="", font="num"):
        self.value.configure(text=value, fg=C[TONE.get(tone, tone) if TONE.get(tone, tone) in C else "ink"],
                             font=F[font])
        self.sub.configure(text=sub)

    def progress(self, frac, tone="Good"):
        if self.bar is None:
            self.bar = ttk.Progressbar(self.body, maximum=1000, style="Good.Horizontal.TProgressbar")
            self.bar.pack(fill="x", pady=(px(5), px(3)), before=self.sub)
        if frac is None:
            self.bar.pack_forget()
            return
        if not self.bar.winfo_ismapped():
            self.bar.pack(fill="x", pady=(px(5), px(3)), before=self.sub)
        self.bar.configure(value=int(frac * 1000), style="%s.Horizontal.TProgressbar" % tone)


class MainScreen(Screen):
    def __init__(self, ui):
        Screen.__init__(self, ui)
        self.head = app_header(self, "หน้าหลัก", right=self._head_right)
        self.banner = Banner(self, pady=(px(12), 0))
        self.banner.pack(fill="x", padx=px(18))
        body = frame(self)
        body.pack(fill="both", expand=True, padx=px(18), pady=(px(12), px(14)))
        left = frame(body, width=px(318))
        left.pack(side="left", fill="y")
        left.pack_propagate(False)
        right = frame(body)
        right.pack(side="left", fill="both", expand=True, padx=(px(14), 0))
        # left: start/stop + checklist
        self.big = BigButton(left, "เริ่มทำงาน Dobby", self.toggle)
        self.big.pack(fill="x")
        self.run_note = L(left, "", font="small", fg="muted", wrap=300)
        self.run_note.pack(fill="x", pady=(px(6), px(10)))
        chk = Card(left, pad=0)
        chk.pack(fill="both", expand=True)
        L(chk.body, "ความพร้อม", font="h3").pack(fill="x", padx=px(14), pady=(px(12), px(4)))
        self.scroll = ScrollFrame(chk.body, bg=C["surface"])
        self.scroll.pack(fill="both", expand=True, padx=(px(14), px(4)), pady=(0, px(8)))
        self.rows = {}
        for key in ("signin", "linked", "ea", "steps", "algo", "live", "web"):
            if key == "steps":
                self.steps = self._mt5_steps(self.scroll.inner)
                continue
            r = frame(self.scroll.inner)
            r.pack(fill="x", pady=(px(5), px(5)))
            ic = StatusIcon(r, "idle", size=20)
            ic.pack(side="left", anchor="n", pady=(px(1), 0))
            col = frame(r)
            col.pack(side="left", fill="x", expand=True, padx=(px(10), px(6)))
            t = L(col, "", font="bold")
            t.pack(fill="x")
            d = L(col, "", font="small", fg="muted", wrap=240)
            d.pack(fill="x")
            self.rows[key] = (r, ic, t, d)
        # right: status cards + log
        grid = frame(right)
        grid.pack(fill="x")
        for c in (0, 1):
            grid.columnconfigure(c, weight=1, uniform="cards")
        self.c_balance = StatCard(grid, "ยอดเงินในบัญชี")
        self.c_virtual = StatCard(grid, "เงินเสมือนของบอท (virtual)")
        self.c_today = StatCard(grid, "กำไร/ขาดทุนวันนี้")
        self.c_pos = StatCard(grid, "ไม้ที่เปิดอยู่")
        self.c_web = StatCard(grid, "การเชื่อมต่อเว็บ")
        self.c_event = StatCard(grid, "เหตุการณ์ล่าสุดจาก EA")
        for i, card in enumerate((self.c_balance, self.c_virtual, self.c_today, self.c_pos, self.c_web,
                                  self.c_event)):
            card.grid(row=i // 2, column=i % 2, sticky="nsew", padx=(0 if i % 2 == 0 else px(6), 0 if i % 2 else px(6)),
                      pady=(0, px(12)))
        self.c_problems = Card(right, pad=12)
        self.c_problems.pack(fill="x", pady=(0, px(12)))
        self.problems_key = None
        logc = Card(right, pad=0)
        logc.pack(fill="both", expand=True)
        lh = frame(logc.body)
        lh.pack(fill="x", padx=px(12), pady=(px(8), px(2)))
        L(lh, "บันทึกล่าสุด", font="sbold", fg="muted").pack(side="left")
        Link(lh, "ดูทั้งหมด", lambda: self.ui.show("log"), font="slink").pack(side="right")
        self.log = tk.Text(logc.body, height=4, bd=0, highlightthickness=0, bg=C["surface"], fg=C["ink2"],
                           font=F["small"], wrap="word", padx=px(12), pady=px(2), state="disabled", cursor="arrow")
        self.log.pack(fill="both", expand=True, pady=(0, px(8)))
        self.log.tag_configure("warn", foreground=C["warn"])
        self.log.tag_configure("error", foreground=C["bad"])
        self.log.tag_configure("time", foreground=C["muted"])
        for line in list(ui.log_lines):
            self.add_log(line)

    def _head_right(self, inner):
        for text, cmd in (("ดูบันทึก", lambda: self.ui.show("log")), ("ตั้งค่า", lambda: self.ui.show("settings")),
                          ("เปิดเว็บ Dobby", lambda: self.ui.ctx.open_url(WEB_URL))):
            ttk.Button(inner, text=text, command=cmd, style="Head.TButton").pack(side="right", padx=(px(8), 0))
        self.chip = L(inner, "", font="sbold", fg="muted")
        self.chip.pack(side="right", padx=(0, px(14)))
        self.bot_lbl = L(inner, "", font="base", fg="ink2")
        self.bot_lbl.pack(side="left", padx=(px(14), 0))

    def _mt5_steps(self, parent):
        box = tk.Frame(parent, bg=C["accent_soft"], bd=0, highlightthickness=0)
        L(box, "เปิด EA ใน MT5 (ทำครั้งเดียว)", font="sbold", fg="accent_hi", bg=C["accent_soft"]).pack(
            fill="x", padx=px(12), pady=(px(10), px(6)))
        for i, (title, text) in enumerate(core.MT5_STEPS):
            r = frame(box, bg=C["accent_soft"])
            r.pack(fill="x", padx=px(12), pady=(0, px(7)))
            b = NumberBadge(r, i + 1, state="current", size=20)
            b.configure(bg=C["accent_soft"])
            b.pack(side="left", anchor="n")
            col = frame(r, bg=C["accent_soft"])
            col.pack(side="left", fill="x", expand=True, padx=(px(8), 0))
            L(col, title, font="sbold", bg=C["accent_soft"]).pack(fill="x")
            L(col, text, font="small", fg="ink2", bg=C["accent_soft"], wrap=220).pack(fill="x")
        frame(box, bg=C["accent_soft"], height=px(4)).pack()
        return box

    def on_show(self, **kw):
        self.refresh()

    def add_log(self, line):
        t, level, msg = line
        self.log.configure(state="normal")
        self.log.insert("end", t + "  ", "time")
        msg = log_wrap(msg)
        self.log.insert("end", msg + "\n", "error" if level >= logging.ERROR else "warn" if level >= logging.WARNING
                        else "")
        n = int(self.log.index("end-1c").split(".")[0])
        if n > 200:
            self.log.delete("1.0", "%d.0" % (n - 200))
        self.log.see("end")
        self.log.configure(state="disabled")

    def toggle(self):
        ui = self.ui
        if ui.runner.running:
            if not ui.runner.stopping:
                ui.stop_agent()
        elif not core.config_complete(ui.cfg):
            ui.show("wizard", step=0 if not ui.cfg.get("refresh_token") else 3)
        else:
            ui.start_agent()
        self.refresh()

    def refresh(self):
        ui = self.ui
        cfg = ui.cfg
        now = time.time()
        running, stopping = ui.runner.running, ui.runner.stopping
        snap = ui.snap if running else None
        status = ui.status
        # header
        self.bot_lbl.configure(text=("บอท: " + cfg.get("bot_name")) if cfg.get("bot_name") else "")
        if stopping:
            self.chip.configure(text="●  กำลังหยุด…", fg=C["warn"])
        elif running and ui.phase in ("waiting_ea", "registering"):
            self.chip.configure(text="●  รอ EA ใน MT5", fg=C["warn"])
        elif running:
            self.chip.configure(text="●  กำลังทำงาน", fg=C["good"])
        else:
            self.chip.configure(text="●  หยุดอยู่", fg=C["muted"])
        # big button
        if stopping:
            self.big.set("กำลังหยุด…", "disabled", "wait")
            note = "รอให้รอบสุดท้ายจบ (ไม่เขียนไฟล์ของ EA แล้ว)"
        elif running:
            self.big.set("หยุดทำงาน", "stop", "stop")
            note = "ทำงานมาแล้ว %s  ·  กดหยุดได้ทุกเมื่อ (EA ใน MT5 ยังทำงานต่อตามไฟล์ล่าสุด)" % core.duration_th(
                now - (ui.runner.started_at or now))
        elif core.config_complete(cfg):
            self.big.set("เริ่มทำงาน Dobby", "accent", "play")
            note = "กดเพื่อเชื่อม MT5 กับเว็บ Dobby  ·  ก่อนกดเริ่ม แอปไม่เขียนไฟล์ใดให้ EA"
        else:
            self.big.set("ตั้งค่าให้เสร็จก่อน", "accent", "")
            note = "ยังตั้งค่าไม่ครบ กดเพื่อเปิดตัวช่วยตั้งค่า"
        self.run_note.configure(text=note)
        # banner: lock / start problems
        if ui.lock_problem and not running:
            lp = ui.lock_problem
            if lp.get("holder") is not None:
                self.banner.show("bad", "มี Dobby อีกตัวกำลังทำงานกับ MT5 นี้อยู่แล้ว",
                                 "%s\nปิดหน้าต่าง Dobby agent (run_agent.bat) หรือแอป Dobby อีกตัวก่อน แล้วกดเริ่มอีกครั้ง"
                                 % da.lock_holder_text(lp["holder"]))
            else:
                self.banner.show("bad", "เริ่มทำงานไม่ได้", "สร้างไฟล์ล็อกในโฟลเดอร์ EA ไม่ได้: %s" % lp.get("error"))
        else:
            self.banner.hide()
        # checklist
        items = core.build_checklist(cfg, status, snap, now, running)
        for it in items:
            r, ic, t, d = self.rows[it["key"]]
            ic.set(it["state"])
            t.configure(text=it["title"], fg=C["ink"] if it["state"] != "idle" else C["muted"])
            d.configure(text=it["detail"])
        ea_ok = items[2]["state"] == "ok"
        if ea_ok and self.steps.winfo_manager():
            self.steps.pack_forget()
        elif not ea_ok and not self.steps.winfo_manager():
            self.steps.pack(fill="x", pady=(px(2), px(8)), after=self.rows["ea"][0])
        # status cards
        s = core.summarize_status(status, now)
        cur = s["currency"]
        if s["has_status"]:
            self.c_balance.set(core.money(s["balance"]), "Equity %s %s  ·  บัญชี%s" % (
                core.money(s["equity"]), cur, {"REAL": "จริง", "DEMO": "ทดลอง"}.get(s["mode"], " " + s["mode"])))
            gain = (s["v_balance"] - s["v_start"]) if s["v_balance"] is not None and s["v_start"] else None
            self.c_virtual.set(core.money(s["v_balance"]), "เริ่มต้น %s  ·  กำไรสะสม %s" % (
                core.money(s["v_start"]), core.money(gain, True)))
            pnl = s["day_pnl"]
            tone = "good" if (pnl or 0) > 0 else "bad" if (pnl or 0) < 0 else ""
            if s["cap_hit"]:
                sub = "ถึงเพดานขาดทุนวันนี้แล้ว: บอทหยุดเข้าออเดอร์ใหม่จนถึงวันใหม่"
            elif s["cap_amount"]:
                sub = "เพดานขาดทุนวันนี้ %s (%g%%)  ·  ใช้ไป %d%%" % (core.money(s["cap_amount"]), s["cap_pct"],
                                                                 round((s["cap_used"] or 0) * 100))
            else:
                sub = ""
            self.c_today.set(core.money(pnl, True), sub, tone)
            used = s["cap_used"]
            self.c_today.progress(used, "Bad" if s["cap_hit"] or (used or 0) >= 0.8 else
                                  "Warn" if (used or 0) >= 0.5 else "Good")
            if s["positions"]:
                p = s["positions"][0]
                prof = da.to_num(p.get("profit"))
                more = "  (+%d ไม้)" % (len(s["positions"]) - 1) if len(s["positions"]) > 1 else ""
                self.c_pos.set(core.money(prof, True) if prof is not None else "-", "%s %s lot @ %s%s\nSL %s  ·  TP %s" % (
                    p.get("side") or "", da._f2(da.to_num(p.get("lots"))), da._f2(da.to_num(p.get("open_price"))),
                    more, da._f2(da.to_num(p.get("sl"))), da._f2(da.to_num(p.get("tp")))),
                    "good" if (prof or 0) > 0 else "bad" if (prof or 0) < 0 else "")
            else:
                self.c_pos.set("ไม่มี", "ไม่มีไม้เปิดอยู่ตอนนี้", "", font="h2")
            ev = s["last_event"]
            self.c_event.set(ev[20:].strip()[:90] if len(ev) > 20 else ev or "-",
                             ("เวลาเซิร์ฟเวอร์ " + ev[:19]) if len(ev) > 20 else "", "", font="sbold")
        else:
            for c in (self.c_balance, self.c_virtual, self.c_today, self.c_pos):
                c.set("-", "รอข้อมูลจาก EA", "", font="h2")
            self.c_today.progress(None)
            self.c_event.set("-", "ยังไม่มีข้อมูลจาก EA", "", font="sbold")
        # website connection
        if not running:
            self.c_web.set("ยังไม่เริ่ม", "กดเริ่มทำงาน Dobby เพื่อเชื่อมต่อ", "idle", font="h2")
        elif ui.phase in ("waiting_ea", "registering"):
            self.c_web.set("รอ EA", "จะสร้างบอทบนเว็บเมื่อ EA เริ่มทำงาน", "warn", font="h2")
        elif snap is None:
            self.c_web.set("กำลังเชื่อมต่อ…", "", "info", font="h2")
        elif snap.get("fail_count"):
            title, detail = core.explain_error(snap.get("last_error"))
            self.c_web.set("เชื่อมต่อไม่ได้", "%s  ·  ลองใหม่ใน %d วินาที" % (title, snap.get("backoff") or 0), "bad",
                           font="h2")
        else:
            self.c_web.set("เชื่อมต่อแล้ว", "ส่งข้อมูลล่าสุด %s  ·  คำสั่งเว็บ v%s" % (
                core.ago_th(now - (snap.get("last_ok_at") or now)), snap.get("web_version") or "-"), "good", font="h2")
        self._problems(snap, s, running)

    def _problems(self, snap, s, running):
        probs = []
        err = (snap or {}).get("last_error") or (self.ui.agent_error if not running else "")
        if err:
            t, d = core.explain_error(err)
            probs.append(("bad", t, d))
        for code in (snap or {}).get("rejected") or []:
            t, d = core.explain_reject(code)
            probs.append(("warn", t, d))
        for code in (snap or {}).get("warnings") or []:
            if code != "offset_unconfirmed":
                t, d = core.explain_reject(code)
                probs.append(("warn", t, d))
        if s.get("ea_error"):
            probs.append(("idle", "ข้อผิดพลาดล่าสุดจาก EA", s["ea_error"][:160]))
        key = tuple(probs)
        if key == self.problems_key:
            return
        self.problems_key = key
        b = self.c_problems.body
        for w in b.winfo_children():
            w.destroy()
        if not probs:
            r = frame(b)
            r.pack(fill="x")
            StatusIcon(r, "ok", size=18).pack(side="left")
            L(r, "ไม่มีปัญหาหรือคำสั่งที่ถูกปฏิเสธ", font="sbold", fg="good").pack(side="left", padx=(px(8), 0))
            return
        L(b, "ปัญหาและคำสั่งที่เครื่องนี้ไม่ทำ", font="small", fg="muted").pack(fill="x", pady=(0, px(4)))
        for state, title, detail in probs[:3]:
            r = frame(b)
            r.pack(fill="x", pady=(0, px(4)))
            StatusIcon(r, state, size=18).pack(side="left", anchor="n", pady=(px(1), 0))
            col = frame(r)
            col.pack(side="left", fill="x", expand=True, padx=(px(8), 0))
            L(col, title, font="sbold").pack(fill="x")
            if detail:
                L(col, detail, font="small", fg="muted", wrap=True).pack(fill="x")


# -- settings -----------------------------------------------------------------------------------------------------------
class SettingsScreen(Screen):
    TABS = [("safety", "ความปลอดภัย"), ("telegram", "Telegram"), ("startup", "เริ่มอัตโนมัติ"),
            ("account", "บัญชีและเครื่อง"), ("advanced", "ขั้นสูง")]

    def __init__(self, ui):
        Screen.__init__(self, ui)
        app_header(self, "ตั้งค่า", back=self.close)
        self.banner = Banner(self, pady=(px(12), 0))
        self.banner.pack(fill="x", padx=px(18))
        bottom = frame(self)
        bottom.pack(side="bottom", fill="x", padx=px(18), pady=(px(6), px(14)))
        ttk.Button(bottom, text="บันทึกการตั้งค่า", style="Accent.TButton", command=self.save).pack(side="right")
        ttk.Button(bottom, text="ยกเลิก", command=self.close).pack(side="right", padx=(0, px(8)))
        self.saved_lbl = L(bottom, "", font="small", fg="good")
        self.saved_lbl.pack(side="left")
        self.nb = ttk.Notebook(self)
        self.nb.pack(fill="both", expand=True, padx=px(18), pady=(px(12), 0))
        self.tabs = {}
        for key, title in self.TABS:
            outer = frame(self.nb, bg=C["surface"])
            sf = ScrollFrame(outer, bg=C["surface"])
            sf.pack(fill="both", expand=True, padx=px(20), pady=px(16))
            self.nb.add(outer, text=title)
            self.tabs[key] = sf.inner
            getattr(self, "_build_" + key)(sf.inner)

    # tabs
    def _build_safety(self, p):
        section_title(p, "ขีดจำกัดของเครื่องนี้", "เว็บสั่งเกินค่าเหล่านี้ไม่ได้ เปลี่ยนแล้วมีผลในรอบถัดไป (ไม่กี่วินาที)")
        frame(p, height=px(10)).pack()
        self.limits = LimitsForm(p)
        self.limits.pack(fill="x")

    def _build_telegram(self, p):
        section_title(p, "แจ้งเตือนทาง Telegram (ไม่บังคับ)",
                      "แจ้งเมื่อเปิด/ปิดออเดอร์ ล็อกกำไร ถึงเพดานขาดทุน EA ออฟไลน์ และสรุปรายวัน")
        self.tg_token = entry_row(p, "Bot token (จาก @BotFather)", width=52, show="•")
        self.tg_show = tk.BooleanVar(value=False)
        ttk.Checkbutton(p, text="แสดง token", variable=self.tg_show, style="S.TCheckbutton",
                        command=lambda: self.tg_token.configure(show="" if self.tg_show.get() else "•")).pack(
            anchor="w", pady=(px(4), 0))
        self.tg_chat = entry_row(p, "Chat id", width=24,
                                 hint="ใน Telegram: คุยกับ @BotFather แล้วพิมพ์ /newbot จะได้ token จากนั้นส่งข้อความหาบอทของคุณ "
                                      "1 ครั้ง และถาม @userinfobot เพื่อดูตัวเลข chat id")
        row = frame(p)
        row.pack(fill="x", pady=(px(12), 0))
        self.tg_btn = ttk.Button(row, text="ส่งข้อความทดสอบ", command=self.test_telegram)
        self.tg_btn.pack(side="left")
        self.tg_result = L(row, "", font="small", fg="muted")
        self.tg_result.pack(side="left", padx=(px(12), 0))

    def _build_startup(self, p):
        section_title(p, "การเริ่มทำงาน")
        self.with_windows = tk.BooleanVar()
        self.auto_start = tk.BooleanVar()
        for var, title, text in (
                (self.with_windows, "เปิดพร้อม Windows",
                 "เปิดแอปเองหลังเปิดเครื่อง (ย่อไว้ที่แถบงาน) และเริ่มทำงานให้เลยถ้าตั้งค่าครบ: สร้างไฟล์เล็ก ๆ หนึ่งไฟล์ "
                 "ในโฟลเดอร์ Startup ของผู้ใช้นี้เท่านั้น เอาติ๊กออกเมื่อไรก็ลบไฟล์นั้นให้"),
                (self.auto_start, "เริ่มทำงานอัตโนมัติเมื่อเปิดแอป",
                 "ไม่ต้องกดปุ่ม เริ่มทำงาน Dobby ทุกครั้งที่เปิดแอป")):
            row = frame(p)
            row.pack(fill="x", pady=(px(12), 0))
            ttk.Checkbutton(row, text=title, variable=var, style="S.TCheckbutton").pack(anchor="w")
            L(row, text, font="small", fg="muted", wrap=True).pack(fill="x", padx=(px(26), 0))
        self.launcher_lbl = L(p, "", font="small", fg="muted", wrap=True)
        self.launcher_lbl.pack(fill="x", pady=(px(14), 0))

    def _build_account(self, p):
        section_title(p, "บัญชี")
        r = frame(p)
        r.pack(fill="x", pady=(px(6), px(14)))
        self.acc_lbl = L(r, "", font="base", fg="ink2")
        self.acc_lbl.pack(side="left")
        self.acc_btn = ttk.Button(r, text="ออกจากระบบ", style="Small.TButton", command=self.sign_out)
        self.acc_btn.pack(side="right")
        section_title(p, "เครื่องนี้")
        r = frame(p)
        r.pack(fill="x", pady=(px(6), px(4)))
        self.bot_lbl = L(r, "", font="base", fg="ink2", wrap=True)
        self.bot_lbl.pack(side="left", fill="x", expand=True)
        self.unlink_btn = ttk.Button(r, text="ยกเลิกการเชื่อมเครื่องนี้", style="Small.TButton", command=self.unlink)
        self.unlink_btn.pack(side="right")
        self.mt5_lbl = L(p, "", font="small", fg="muted", wrap=True)
        self.mt5_lbl.pack(fill="x", pady=(0, px(14)))
        ttk.Button(p, text="เปิดตัวช่วยตั้งค่าอีกครั้ง", command=lambda: self.ui.show("wizard", step=0)).pack(anchor="w")
        L(p, "ใช้เมื่อต้องการเปลี่ยนบัญชี เลือก MT5 ใหม่ ติดตั้ง EA เวอร์ชันใหม่ หรือเชื่อมกับบอทอื่น", font="small",
          fg="muted", wrap=True).pack(fill="x", pady=(px(4), 0))

    def _build_advanced(self, p):
        section_title(p, "เซิร์ฟเวอร์", "ปกติไม่ต้องแก้ ถ้าเปลี่ยน ต้องเข้าสู่ระบบใหม่")
        self.adv_url = entry_row(p, "Supabase URL", width=56)
        self.adv_key = entry_row(p, "Publishable key (คีย์สาธารณะ)", width=56)
        frame(p, height=px(12)).pack()
        section_title(p, "โฟลเดอร์ไฟล์ของ EA", "ว่างไว้ = ค่าเริ่มต้นของ MT5 (Common\\Files\\Dobby) มีผลตอนกดเริ่มครั้งถัดไป")
        r = frame(p)
        r.pack(fill="x", pady=(px(6), 0))
        self.adv_common = ttk.Entry(r, width=56, font=F["base"])
        self.adv_common.pack(side="left", fill="x", expand=True)
        ttk.Button(r, text="เลือก…", style="Small.TButton", command=self.pick_common).pack(side="left",
                                                                                          padx=(px(8), 0))
        frame(p, height=px(12)).pack()
        section_title(p, "ข้อมูลของแอป")
        r = frame(p)
        r.pack(fill="x", pady=(px(6), 0))
        L(r, self.ui.ctx.data_dir, font="small", fg="ink2").pack(side="left")
        ttk.Button(r, text="เปิดโฟลเดอร์", style="Small.TButton",
                   command=lambda: self.ui.ctx.open_path(self.ui.ctx.data_dir)).pack(side="right")
        L(p, "Dobby App %s  ·  agent %s" % (APP_VERSION, da.AGENT_VERSION), font="small", fg="muted").pack(
            fill="x", pady=(px(12), 0))

    # behaviour
    def on_show(self, tab=None, **kw):
        cfg = self.ui.cfg
        self.banner.hide()
        self.saved_lbl.configure(text="")
        self.limits.set(da.get_limits(cfg))
        tg = cfg.get("telegram") or {}
        for e, v in ((self.tg_token, tg.get("token") or ""), (self.tg_chat, str(tg.get("chat_id") or "")),
                     (self.adv_url, cfg.get("supabase_url") or ""), (self.adv_key, cfg.get("anon_key") or ""),
                     (self.adv_common, cfg.get("common_dir") or "")):
            e.delete(0, "end")
            e.insert(0, v)
        self.tg_result.configure(text="")
        app = cfg.get("app") or {}
        folder = self.ui.ctx.startup_folder()
        self.with_windows.set(core.launcher_exists(folder))
        self.auto_start.set(bool(app.get("auto_start")))
        self.launcher_lbl.configure(text="ไฟล์เปิดพร้อม Windows: %s" % core.launcher_path(folder))
        self.refresh_account()
        if tab:
            self.nb.select([k for k, _ in self.TABS].index(tab))

    def refresh_account(self):
        cfg = self.ui.cfg
        if cfg.get("refresh_token"):
            self.acc_lbl.configure(text="เข้าสู่ระบบเป็น  %s" % (cfg.get("email") or "-"))
            self.acc_btn.configure(text="ออกจากระบบ", command=self.sign_out)
        else:
            self.acc_lbl.configure(text="ยังไม่ได้เข้าสู่ระบบ")
            self.acc_btn.configure(text="เข้าสู่ระบบ", command=lambda: self.ui.show("wizard", step=0))
        pending = (cfg.get("app") or {}).get("pending_bot_name")
        if cfg.get("bot_id"):
            self.bot_lbl.configure(text="เชื่อมกับบอท \"%s\"  (id %s…)" % (cfg.get("bot_name"), cfg["bot_id"][:8]))
            self.unlink_btn.state(["!disabled"])
        elif pending:
            self.bot_lbl.configure(text="รอสร้างบอท \"%s\" เมื่อ EA ทำงาน" % pending)
            self.unlink_btn.state(["!disabled"])
        else:
            self.bot_lbl.configure(text="ยังไม่ได้เชื่อมกับบอท")
            self.unlink_btn.state(["disabled"])
        mt5 = (cfg.get("app") or {}).get("mt5_data_dir")
        self.mt5_lbl.configure(text="MT5 ที่เลือก: %s" % (mt5 or "-"))

    def close(self):
        self.ui.show("main" if (self.ui.cfg.get("app") or {}).get("wizard_done") else "wizard")

    def pick_common(self):
        d = filedialog.askdirectory(parent=self.ui.root, title="เลือกโฟลเดอร์ไฟล์ของ EA (Common\\Files\\Dobby)")
        if d:
            self.adv_common.delete(0, "end")
            self.adv_common.insert(0, os.path.normpath(d))

    def save(self):
        ui = self.ui
        lim, err = self.limits.get()
        if err:
            self.nb.select(0)
            self.banner.show("bad", err)
            return
        url, key = self.adv_url.get().strip().rstrip("/"), self.adv_key.get().strip()
        if not da._valid_url(url) or not key:
            self.nb.select(4)
            self.banner.show("bad", "ที่อยู่เซิร์ฟเวอร์ไม่ถูกต้อง", "URL ต้องขึ้นต้นด้วย https:// และต้องมีคีย์")
            return
        server_changed = url != ui.cfg.get("supabase_url") or key != ui.cfg.get("anon_key")
        if server_changed and ui.runner.running:
            self.nb.select(4)
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
        self.saved_lbl.configure(text="✓  บันทึกแล้ว" + ("  (เข้าสู่ระบบใหม่ในตัวช่วยตั้งค่า)" if server_changed else ""))

    def test_telegram(self):
        token, chat = self.tg_token.get().strip(), self.tg_chat.get().strip()
        if not token or not chat:
            self.tg_result.configure(text="ใส่ token และ chat id ก่อน", fg=C["bad"])
            return
        self.tg_btn.state(["disabled"])
        self.tg_result.configure(text="กำลังส่ง…", fg=C["muted"])
        tg = da.Telegram(self.ui.ctx.transport(), token, chat)
        name = self.ui.cfg.get("bot_name") or "Dobby"
        self.ui.bg(lambda: tg.send_now(da.msg_test(name)), self._tg_done, lambda e: self._tg_done((False, str(e))))

    def _tg_done(self, res):
        ok, info = res
        self.tg_btn.state(["!disabled"])
        self.tg_result.configure(text="ส่งแล้ว ดูใน Telegram ของคุณ" if ok else "ส่งไม่สำเร็จ: ตรวจ token และ chat id",
                                 fg=C["good"] if ok else C["bad"])

    def sign_out(self):
        ui = self.ui
        if not ui.ask_yes_no("ออกจากระบบ?", "แอปจะลืมการเข้าสู่ระบบของเครื่องนี้ และหยุดทำงาน (ถ้ากำลังทำงานอยู่)\n"
                                             "เข้าสู่ระบบใหม่ได้ในตัวช่วยตั้งค่า"):
            return
        ui.stop_agent()
        core.sign_out(ui.ctx.data_dir, ui.client)
        ui.approved = None
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
        self.banner.show("good", "ยกเลิกการเชื่อมแล้ว", "เปิดตัวช่วยตั้งค่าเพื่อเชื่อมกับบอทใหม่")


# -- log ----------------------------------------------------------------------------------------------------------------
class LogScreen(Screen):
    def __init__(self, ui):
        Screen.__init__(self, ui)
        app_header(self, "บันทึกการทำงาน", back=lambda: ui.show("main" if (ui.cfg.get("app") or {}).get(
            "wizard_done") else "wizard"))
        bottom = frame(self)
        bottom.pack(side="bottom", fill="x", padx=px(18), pady=(px(6), px(14)))
        ttk.Button(bottom, text="เปิดไฟล์บันทึก (agent.log)",
                   command=lambda: ui.ctx.open_path(os.path.join(ui.ctx.data_dir, da.LOG_NAME))).pack(side="left")
        ttk.Button(bottom, text="เปิดโฟลเดอร์ข้อมูล", command=lambda: ui.ctx.open_path(ui.ctx.data_dir)).pack(
            side="left", padx=(px(8), 0))
        L(bottom, "ไม่มีรหัสผ่านหรือ token ในบันทึก", font="small", fg="muted").pack(side="right")
        card = Card(self, pad=0)
        card.pack(fill="both", expand=True, padx=px(18), pady=(px(14), 0))
        self.text = tk.Text(card.body, bd=0, highlightthickness=0, bg=C["surface"], fg=C["ink2"], font=F["small"],
                            wrap="word", padx=px(14), pady=px(10), cursor="arrow")
        vsb = ttk.Scrollbar(card.body, orient="vertical", command=self.text.yview)
        self.text.configure(yscrollcommand=vsb.set)
        vsb.pack(side="right", fill="y")
        self.text.pack(fill="both", expand=True)
        self.text.tag_configure("warn", foreground=C["warn"])
        self.text.tag_configure("error", foreground=C["bad"])
        self.text.tag_configure("time", foreground=C["muted"])

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
            self.q.put(("log", (time.strftime("%H:%M:%S", time.localtime(record.created)), record.levelno,
                                core.friendly_log(record.getMessage()))))
        except Exception:  # pragma: no cover
            pass


class DobbyUI(object):
    SCREENS = {"wizard": WizardScreen, "main": MainScreen, "settings": SettingsScreen, "log": LogScreen}

    def __init__(self, root, ctx):
        self.root, self.ctx = root, ctx
        self.q = queue.Queue()
        self.cfg = core.load_app_config(ctx.data_dir)
        self.approved = None
        self.status, self.snap, self.phase = None, None, None
        self.lock_problem = None
        self.agent_error = None
        self.log_lines = collections.deque(maxlen=500)
        self.client = None
        self.rebuild_client()
        self.runner = core.AgentRunner(ctx, self.client, self.q.put)
        self.watcher = core.StatusWatcher(lambda: ctx.common_dir(self.cfg), self.q.put)
        self.watcher.start()
        self.log_handler = GuiLogHandler(self.q)
        LOG.addHandler(self.log_handler)
        self.icon64 = tk.PhotoImage(data=base64.b64encode(core.icon_png(64)).decode("ascii"))
        self.icon28 = tk.PhotoImage(data=base64.b64encode(core.icon_png(28)).decode("ascii"))
        root.iconphoto(True, self.icon64)
        root.title(APP_NAME + (" (โหมดตัวอย่าง)" if ctx.demo else ""))
        root.configure(bg=C["bg"])
        w, h = px(900), px(620)
        x = max(0, (root.winfo_screenwidth() - w) // 2)
        y = max(0, (root.winfo_screenheight() - h) // 3)
        root.geometry("%dx%d+%d+%d" % (w, h, x, y))
        root.minsize(px(820), px(560))
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

    def _dispatch(self, item):
        kind = item[0]
        if kind == "log":
            self.log_lines.append(item[1])
            for name in ("main", "log"):
                s = self.screens.get(name)
                if s is not None:
                    s.add_log(item[1])
        elif kind == "status":
            self.status = item[1]
        elif kind == "agent":
            self.snap = item[1]
            self.phase = "running"
            if item[1].get("status") is not None:
                self.status = item[1]["status"]
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

    # -- questions
    def alert(self, title, text, kind="warning"):
        LOG.info("message: %s | %s", title, text.replace("\n", " "))
        if self.ctx.auto_answer is not None:
            return
        getattr(messagebox, "showwarning" if kind == "warning" else "showinfo")(title, text, parent=self.root)

    def ask_yes_no(self, title, text):
        if self.ctx.auto_answer is not None:
            return bool(self.ctx.auto_answer)
        return messagebox.askyesno(title, text, parent=self.root)

    # -- agent
    def start_agent(self, quiet=False):
        self.reload_cfg()
        if not core.config_complete(self.cfg):
            self.show("wizard")
            return False
        ok, info = self.runner.start()
        if not ok:
            if info.get("error") == "still stopping":
                return False
            self.lock_problem = info
            LOG.warning("start refused: %s", "EA folder lock held by " + da.lock_holder_text(info["holder"])
                        if info.get("holder") is not None else info.get("error"))
            if info.get("holder") is not None and not quiet:
                self.alert("มี Dobby อีกตัวกำลังทำงานอยู่",
                           "มีโปรแกรม Dobby อีกตัวทำงานกับ MT5 นี้อยู่แล้ว:\n%s\n\nปิดตัวนั้นก่อน แล้วกดเริ่มอีกครั้ง\n"
                           "(สองโปรแกรมเขียนไฟล์ควบคุมของ EA พร้อมกันไม่ได้)" % da.lock_holder_text(info["holder"]))
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

    def on_close(self):
        if self.runner.running and not self.runner.stopping:
            choice = ChoiceDialog(self, "Dobby กำลังทำงาน",
                                  "ถ้าปิดแอป Dobby จะหยุดส่งข้อมูลขึ้นเว็บและหยุดรับคำสั่งจากเว็บ "
                                  "(EA ใน MT5 ยังทำงานต่อตามปกติ)",
                                  [("minimize", "ย่อหน้าต่างไว้ (ทำงานต่อ)", "Accent.TButton"),
                                   ("stop", "หยุดและปิดแอป", "Danger.TButton"), (None, "ยกเลิก", "TButton")]).run()
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
    root = tk.Tk()
    root.withdraw()
    setup_theme(root)
    return root


def first_screen(ui):
    cfg = ui.cfg
    if (cfg.get("app") or {}).get("wizard_done") and core.config_complete(cfg):
        return "main"
    return "wizard"


def run_app(data_dir, autostart=False, demo=False):
    ctx_kw = {}
    demo_ea = None
    if demo:
        base = data_dir or tempfile.mkdtemp(prefix="dobby-demo-")
        fake = core.build_demo_appdata(os.path.join(base, "fake-appdata"))
        ctx_kw = dict(environ={"APPDATA": fake}, transport=core.DemoServer(latency=0.25), demo=True,
                      startup_folder=os.path.join(base, "fake-startup"))
        data_dir = os.path.join(base, "app")
    data_dir = data_dir or core.app_data_dir()
    os.makedirs(data_dir, exist_ok=True)
    da.setup_logging(data_dir)
    single = da.InstanceLock(os.path.join(data_dir, core.APP_LOCK_NAME))
    if not single.acquire():
        if not autostart:
            r = tk.Tk()
            r.withdraw()
            messagebox.showinfo(APP_NAME, "Dobby App เปิดอยู่แล้ว ดูที่แถบงาน (taskbar) ด้านล่างของจอ")
            r.destroy()
        return 0
    ctx = core.AppContext(data_dir, **ctx_kw)
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
    if demo:
        demo_ea = core.DemoEA(ctx.common_dir(cfg))

        def demo_hook():
            if ui.runner.running and demo_ea.thread is None:
                root.after(4000, demo_ea.start)
            elif demo_ea.thread is None:
                root.after(1000, demo_hook)
        root.after(1000, demo_hook)
    if autostart:
        root.iconify()
    if core.config_complete(cfg) and (cfg.get("app") or {}).get("wizard_done") and (
            autostart or (cfg.get("app") or {}).get("auto_start")):
        root.after(800, lambda: ui.start_agent(quiet=autostart))
    try:
        root.mainloop()
    finally:
        if demo_ea:
            demo_ea.stop()
        single.release()
    return 0


# ---------------------------------------------------------------------------------------------------------------------
# Self-test: every screen with fake data, screenshots, no network, no real folders
# ---------------------------------------------------------------------------------------------------------------------
def layout_issues(win):
    """Texts cut off (a label narrower than its text) and widgets outside the window."""
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
                if isinstance(c, (tk.Label, ttk.Label, ttk.Button, ttk.Checkbutton, ttk.Radiobutton)):
                    text = str(c.cget("text") or "")
                    wrap = int(str(c.cget("wraplength") or 0) or 0) if isinstance(c, tk.Label) else 0
                    if text and not wrap and c.winfo_reqwidth() > c.winfo_width() + 2:
                        issues.append("clipped (%d<%d px): %s" % (c.winfo_width(), c.winfo_reqwidth(), text[:60]))
                    if text and wrap and c.winfo_reqheight() > c.winfo_height() + 2:
                        issues.append("clipped height: %s" % text[:60])
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
    fake = core.build_demo_appdata(os.path.join(data_dir, "fake-appdata"))
    app_dir = os.path.join(data_dir, "app")
    os.makedirs(app_dir, exist_ok=True)
    server = core.DemoServer()
    ctx = core.AppContext(app_dir, environ={"APPDATA": fake}, transport=server, demo=True, external=False,
                          startup_folder=os.path.join(data_dir, "fake-startup"), register_wait_s=1, auto_answer=True)
    da.setup_logging(app_dir)
    root = make_root()
    ui = DobbyUI(root, ctx)
    root.geometry("+30+30")
    ui.show(first_screen(ui))
    root.deiconify()
    root.attributes("-topmost", True)
    report, shots, checks = [], [], []
    common = ctx.common_dir(ui.cfg)

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
            report.append("FAIL %-28s capture: %s" % (name, e))
            return
        issues = layout_issues(win)
        shots.append(path)
        report.append("ok   %-28s %s (%s)%s" % (name, path, method, "".join("\n       - " + i for i in issues)))

    def check(name, ok, detail=""):
        checks.append(ok)
        report.append("%s %s%s" % ("PASS" if ok else "FAIL", name, (": " + detail) if detail else ""))

    wiz = ui.screen("wizard")
    try:
        # 1-4 sign in: empty, wrong password, not approved, ok
        shot("wizard_signin")
        p = wiz.pages[0]
        p.email.insert(0, "friend@example.com")
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
        p.email.insert(0, "friend@example.com")
        p.password.insert(0, "demo-password")
        p.do_sign_in()
        pump(until=lambda: not p.busy and ui.approved)
        shot("wizard_signed_in")
        cfg_text = open(core.config_path(app_dir), encoding="utf-8").read()
        check("password never stored, refresh token stored", "demo-password" not in cfg_text and
              bool(ui.cfg.get("refresh_token")))
        # 5 MT5
        wiz.next()
        pump()
        shot("wizard_mt5")
        check("two fake MT5 folders detected", len(wiz.pages[1].terminals) == 2)
        # 6-7 EA install
        wiz.next()
        ea = wiz.pages[2]
        pump(until=lambda: ea.loaded_for is not None)
        shot("wizard_ea_files")
        ea.install()
        pump(until=lambda: not ea.busy)
        shot("wizard_ea_installed")
        mt5 = ui.cfg["app"]["mt5_data_dir"]
        check("EA copied to MQL5\\Experts\\Dobby, preset to MQL5\\Presets",
              os.path.isfile(os.path.join(mt5, "MQL5", "Experts", "Dobby", "Dobby3_v304.ex5")) and
              os.path.isfile(os.path.join(mt5, "MQL5", "Presets", "Dobby3_usd280_0.03each.set")) and
              not os.path.exists(os.path.join(mt5, "MQL5", "Experts", "Dobby", "DobbyApp.exe")))
        # 8-9 link
        wiz.next()
        lk = wiz.pages[3]
        pump(until=lambda: bool(lk.bots))
        shot("wizard_link")
        lk.name.delete(0, "end")
        lk.name.insert(0, "คอมทดสอบ")
        lk.mode.set("new")
        lk.do_link()
        pump()
        shot("wizard_link_pending")
        check("no EA yet: bot creation deferred to the first Start", ui.cfg["app"]["pending_bot_name"] == "คอมทดสอบ")
        # 10 limits
        wiz.next()
        pump()
        shot("wizard_limits")
        wiz.next()
        pump()
        # 11 main, EA not running
        check("nothing written to the EA folder before Start", not os.path.exists(os.path.join(
            common, da.CONTROL_NAME)))
        shot("main_ea_not_running")
        # 12 running
        demo_ea = core.DemoEA(common)
        demo_ea.start(every=1.0)
        ui.start_agent()
        pump(until=lambda: bool(ui.cfg.get("bot_id")) and ui.snap is not None and ui.snap.get("web_version"),
             timeout=40)
        bot_id = ui.cfg.get("bot_id")
        check("bot created from the EA state when the EA appeared", bool(bot_id))
        if bot_id:
            server.web_change(bot_id, lots=0.5)
            want = server.control[bot_id]["version"]
            pump(until=lambda: ui.snap and ui.snap.get("applied_version") == want, timeout=30)
        ctl = da.read_text(os.path.join(common, da.CONTROL_NAME)) or ""
        check("control file written after Start, web lots 0.50 clamped to 0.10", "lots=0.10" in ctl, ctl.split(
            "\n")[0][:60])
        shot("main_running")
        # stop: no more writes
        ui.stop_agent()
        pump(until=lambda: not ui.runner.running, timeout=30)
        m0 = os.stat(os.path.join(common, da.CONTROL_NAME)).st_mtime
        if bot_id:
            server.web_change(bot_id, lots=0.02)
        pump(3.0)
        check("Stop: the control file is not written any more",
              os.stat(os.path.join(common, da.CONTROL_NAME)).st_mtime == m0)
        check("lock released after Stop", not os.path.exists(os.path.join(common, da.COMMON_LOCK_NAME)) or
              not (da.CommonLock(common).read() or {}).get("pid"))
        # 13 lock conflict
        other = da.CommonLock(common, program="dobby_agent.py run")
        other.acquire()
        started = ui.start_agent()
        pump(0.5)
        check("second agent refused while the CLI holds the EA-folder lock", not started and not ui.runner.running)
        shot("main_lock_conflict")
        other.release()
        ui.lock_problem = None
        # 14-18 settings
        ui.show("settings")
        st = ui.screen("settings")
        for i, (key, _) in enumerate(SettingsScreen.TABS):
            st.nb.select(i)
            if key == "telegram":
                st.tg_chat.delete(0, "end")
                st.tg_chat.insert(0, "42")
                st.tg_token.delete(0, "end")
                st.tg_token.insert(0, "123456:DEMO-TOKEN")
                st.test_telegram()
                pump(until=lambda: str(st.tg_btn.cget("state")) != "disabled" and "กำลัง" not in st.tg_result.cget(
                    "text"))
            if key == "startup":
                st.with_windows.set(True)
                st.save()
                check("start with Windows: launcher created in the (fake) Startup folder",
                      core.launcher_exists(ctx.startup_folder()))
            shot("settings_" + key)
        st.with_windows.set(False)
        st.save()
        check("start with Windows off: launcher removed", not core.launcher_exists(ctx.startup_folder()))
        # 19 log
        ui.show("log")
        shot("log")
        # 20 close dialog (while running)
        ui.show("main")
        ui.start_agent()
        pump(until=lambda: ui.runner.running and ui.snap is not None, timeout=20)
        dlg = ChoiceDialog(ui, "Dobby กำลังทำงาน", "ถ้าปิดแอป Dobby จะหยุดส่งข้อมูลขึ้นเว็บและหยุดรับคำสั่งจากเว็บ "
                                                   "(EA ใน MT5 ยังทำงานต่อตามปกติ)",
                           [("minimize", "ย่อหน้าต่างไว้ (ทำงานต่อ)", "Accent.TButton"),
                            ("stop", "หยุดและปิดแอป", "Danger.TButton"), (None, "ยกเลิก", "TButton")])
        dlg.top.attributes("-topmost", True)
        shot("close_dialog", dlg.top)
        dlg.close(None)
        demo_ea.stop()
        real_common = core.default_common_dir(os.environ.get("APPDATA") or "")
        check("never touched the real EA folder", os.path.normcase(common) != os.path.normcase(real_common))
    except Exception:
        report.append("FAIL exception:\n" + traceback.format_exc())
        checks.append(False)
    finally:
        ui.shutdown(wait=6.0)
    sheet = core.contact_sheet(shots, out_png)
    if not sheet and shots:
        import shutil
        shutil.copyfile(shots[-3] if len(shots) >= 3 else shots[0], out_png)
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
