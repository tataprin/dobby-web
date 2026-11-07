# -*- coding: utf-8 -*-
"""Dobby App look and widgets (Tkinter, no Pillow): one calm theme, anti-aliased rounded boxes (PNG corners drawn by
dobby_app_gfx), buttons, switches, segmented controls, steppers, banners, expanders, small pictures and dialogs.

Thai text: every label goes through wrap_text(), which keeps each drawn line under ~195 UTF-8 bytes and never starts a
line with a Thai combining mark (Tk on Windows draws long runs in pieces; a piece that starts with a mark shows it on
a dotted circle)."""
import base64
import re
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk

import dobby_app_gfx as gfx

# ---------------------------------------------------------------------------------------------------------------------
# Look
# ---------------------------------------------------------------------------------------------------------------------
C = {
    "bg": "#F3F5F9", "surface": "#FFFFFF", "surface2": "#F7F9FC", "sunken": "#EDF1F6", "side": "#EEF2F7",
    "line": "#E2E7EE", "line2": "#CDD5E0", "ink": "#0F172A", "ink2": "#334155", "muted": "#5B6778",
    "faint": "#94A3B8", "accent": "#2F5BEA", "accent_hi": "#2449C8", "accent_soft": "#ECF2FF",
    "accent_soft2": "#DCE7FF", "accent_line": "#C3D4FB", "accent_dis": "#AFC2F5",
    "good": "#137A3E", "good_dot": "#1FA155", "good_soft": "#EAF7EF", "good_line": "#BFE5CC",
    "warn": "#8A4B00", "warn_dot": "#F0A020", "warn_soft": "#FFF6E6", "warn_line": "#F5D9A6",
    "bad": "#B42323", "bad_dot": "#E0483F", "bad_soft": "#FDEFEE", "bad_line": "#F3C4C0",
    "idle_dot": "#C3CCD8", "white": "#FFFFFF", "gold": "#E8B64C",
}
TONE_INK = {"good": "good", "ok": "good", "warn": "warn", "bad": "bad", "info": "accent_hi", "idle": "muted"}
TONE_DOT = {"good": "good_dot", "ok": "good_dot", "warn": "warn_dot", "bad": "bad_dot", "info": "accent",
            "idle": "idle_dot"}
TONE_SOFT = {"good": "good_soft", "ok": "good_soft", "warn": "warn_soft", "bad": "bad_soft", "info": "accent_soft",
             "idle": "surface"}
TONE_LINE = {"good": "good_line", "ok": "good_line", "warn": "warn_line", "bad": "bad_line", "info": "accent_line",
             "idle": "line"}
F = {}
SCALE = [1.0]
ICON_FONT = [None]
GLYPH = {
    "settings": "", "globe": "", "help": "", "play": "", "stop": "", "pause": "",
    "refresh": "", "folder": "", "download": "", "lock": "", "shield": "",
    "person": "", "check": "", "cancel": "", "warning": "", "info": "", "add": "",
    "robot": "", "card": "", "chart": "", "pulse": "", "history": "",
    "clock": "", "link": "", "devices": "", "laptop": "", "power": "",
    "bolt": "", "edit": "", "list": "", "open": "", "home": "", "back": "",
    "next": "", "chev_r": "", "chev_l": "", "chev_d": "", "chev_u": "",
    "key": "", "signal": "", "doc": "", "calc": "", "send": "", "gears": "",
    "flag": "", "report": "", "timer": "", "error": "",
}
IMG = [None]


def px(n):
    return int(round(n * SCALE[0]))


def col(c):
    return C.get(c, c) if c else c


class Images(object):
    """PhotoImage cache (PNG bytes made on first use)."""

    def __init__(self, root):
        self.root = root
        self.cache = {}

    def get(self, key, make):
        img = self.cache.get(key)
        if img is None:
            img = tk.PhotoImage(master=self.root, data=base64.b64encode(make()).decode("ascii"))
            self.cache[key] = img
        return img


def images():
    return IMG[0]


def setup_theme(root):
    SCALE[0] = max(1.0, root.winfo_fpixels("1i") / 96.0)
    IMG[0] = Images(root)
    fams = set(tkfont.families(root))
    fam = next((f for f in ("Leelawadee UI", "Tahoma") if f in fams), "TkDefaultFont")
    ICON_FONT[0] = next((f for f in ("Segoe Fluent Icons", "Segoe MDL2 Assets") if f in fams), None)
    ifam = ICON_FONT[0] or fam
    F.update(base=(fam, 10), small=(fam, 9), tiny=(fam, 8), bold=(fam, 10, "bold"), sbold=(fam, 9, "bold"),
             tbold=(fam, 8, "bold"), h1=(fam, 19, "bold"), h2=(fam, 14, "bold"), h3=(fam, 11, "bold"),
             hero=(fam, 17, "bold"), num=(fam, 19, "bold"), numL=(fam, 24, "bold"), btn=(fam, 10, "bold"),
             btnL=(fam, 13, "bold"), entryL=(fam, 18, "bold"), link=(fam, 10, "underline"),
             slink=(fam, 9, "underline"), mono=("Consolas", 9), iconS=(ifam, 10), icon=(ifam, 12),
             iconM=(ifam, 14), iconL=(ifam, 17), iconXL=(ifam, 24), family=fam)
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont", "TkCaptionFont", "TkTooltipFont"):
        try:
            tkfont.nametofont(name).configure(family=fam, size=10)
        except tk.TclError:
            pass
    s = ttk.Style(root)
    s.theme_use("clam")
    s.configure(".", background=C["bg"], foreground=C["ink"], font=F["base"], bordercolor=C["line2"],
                focuscolor=C["accent_soft"], troughcolor=C["sunken"])
    s.layout("Thin.Vertical.TScrollbar", [("Vertical.Scrollbar.trough", {"sticky": "ns", "children": [
        ("Vertical.Scrollbar.thumb", {"expand": "1", "sticky": "nswe"})]})])
    s.configure("Thin.Vertical.TScrollbar", troughcolor=C["bg"], background=C["line2"], bordercolor=C["bg"],
                lightcolor=C["line2"], darkcolor=C["line2"], arrowsize=px(9), gripcount=0, relief="flat")
    s.map("Thin.Vertical.TScrollbar", background=[("active", C["faint"])])
    s.configure("S.TCheckbutton", background=C["surface"], foreground=C["ink"], font=F["base"],
                focuscolor=C["surface"], indicatorbackground=C["white"], indicatorforeground=C["accent"])
    s.map("S.TCheckbutton", background=[("active", C["surface"])], foreground=[("disabled", C["faint"])])
    return fam


# ---------------------------------------------------------------------------------------------------------------------
# Thai-safe labels
# ---------------------------------------------------------------------------------------------------------------------
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
    def fits(s):
        return len(s.encode("utf-8")) <= max_bytes and (width is None or measure(s) <= width)

    out = []
    for para in str(text).split("\n"):
        line = ""
        for tok in re.split(r"(\s+)", para):
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


def _bg(widget):
    try:
        return widget.cget("bg")
    except tk.TclError:
        return C["bg"]


class L(tk.Label):
    """Label that takes the parent's background. wrap=True (or an initial width): re-wraps to its width with
    wrap_text(), which is safe for Thai."""

    def __init__(self, parent, text="", font="base", fg="ink", bg=None, wrap=False, **kw):
        kw.setdefault("anchor", "w")
        kw.setdefault("justify", "left")
        self._text = str(text)
        self._font = tkfont.Font(font=F.get(font, font))
        self._width = px(wrap if isinstance(wrap, int) and wrap > 1 else 320) if wrap else None
        tk.Label.__init__(self, parent, text=self._layout(), font=F.get(font, font), fg=col(fg),
                          bg=bg or _bg(parent), bd=0, padx=0, pady=0, **kw)
        if wrap:
            self.bind("<Configure>", self._rewrap)

    def _layout(self):
        return wrap_text(self._text, self._font.measure, self._width)

    def configure(self, cnf=None, **kw):
        if isinstance(cnf, dict) and "text" in cnf:
            kw["text"] = cnf.pop("text")
        if "fg" in kw:
            kw["fg"] = col(kw["fg"])
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
    def __init__(self, parent, text, command, font="link", fg="accent_hi", **kw):
        L.__init__(self, parent, text=text, font=font, fg=fg, cursor="hand2", **kw)
        self.bind("<Button-1>", lambda e: command())


def frame(parent, bg=None, **kw):
    return tk.Frame(parent, bg=col(bg) if bg else _bg(parent), bd=0, highlightthickness=0, **kw)


def glyph(parent, name, size="icon", fg="accent_hi", bg=None, **kw):
    """An icon from Segoe Fluent Icons / MDL2 Assets (an empty label when Windows has neither font)."""
    text = GLYPH.get(name, "") if ICON_FONT[0] else ""
    return tk.Label(parent, text=text, font=F[size], fg=col(fg), bg=bg or _bg(parent), bd=0, padx=0, pady=0, **kw)


def bind_tree(widget, seq, fn, skip=()):
    """Bind an event on a widget and all its descendants (clickable cards)."""
    if not isinstance(widget, skip):
        widget.bind(seq, fn, add="+")
    for c in widget.winfo_children():
        bind_tree(c, seq, fn, skip)


# ---------------------------------------------------------------------------------------------------------------------
# Rounded shapes
# ---------------------------------------------------------------------------------------------------------------------
def round_box(cv, x1, y1, x2, y2, r, fill, border=None, bw=1, tag="box"):
    """A rounded rectangle on a canvas: straight parts as rectangles, the 4 corners as anti-aliased images."""
    fill, border = col(fill), col(border) if border else None
    x1, y1, x2, y2 = int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2))
    r = int(max(0, min(r, (x2 - x1) // 2, (y2 - y1) // 2)))
    bw = int(bw) if border else 0
    kw = {"outline": "", "width": 0, "tags": tag}
    if r < 2:
        if border:
            cv.create_rectangle(x1, y1, x2, y2, fill=border, **kw)
            cv.create_rectangle(x1 + bw, y1 + bw, x2 - bw, y2 - bw, fill=fill, **kw)
        else:
            cv.create_rectangle(x1, y1, x2, y2, fill=fill, **kw)
        return
    cv.create_rectangle(x1 + r, y1, x2 - r, y2, fill=fill, **kw)
    cv.create_rectangle(x1, y1 + r, x2, y2 - r, fill=fill, **kw)
    if bw:
        cv.create_rectangle(x1 + r, y1, x2 - r, y1 + bw, fill=border, **kw)
        cv.create_rectangle(x1 + r, y2 - bw, x2 - r, y2, fill=border, **kw)
        cv.create_rectangle(x1, y1 + r, x1 + bw, y2 - r, fill=border, **kw)
        cv.create_rectangle(x2 - bw, y1 + r, x2, y2 - r, fill=border, **kw)
    im = images()
    for which, x, y in (("tl", x1, y1), ("tr", x2 - r, y1), ("bl", x1, y2 - r), ("br", x2 - r, y2 - r)):
        img = im.get(("corner", r, fill, border, bw, which),
                     lambda w=which: gfx.corner_png(r, fill, border, bw, w))
        cv.create_image(x, y, image=img, anchor="nw", tags=tag)


def dot_image(size, fill, ring=None, ring_w=None):
    ring_w = ring_w if ring_w is not None else max(1.2, SCALE[0] * 1.5)
    return images().get(("dot", size, col(fill), col(ring), ring_w),
                        lambda: gfx.dot_png(size, col(fill), col(ring), ring_w))


def mark_image(size, state):
    kind = {"ok": "ok", "good": "ok", "bad": "bad", "warn": "warn", "idle": "idle", "info": "info"}.get(state, state)
    color = col(TONE_DOT.get(state, "accent"))
    return images().get(("mark", size, kind, color), lambda: gfx.mark_png(size, kind, color))


class Box(tk.Frame):
    """A rounded card: a Frame with a background canvas that draws the box; put children into .body."""

    def __init__(self, parent, fill="surface", border="line", radius=14, pad=16, padx=None, pady=None, bw=1):
        outer = _bg(parent)
        tk.Frame.__init__(self, parent, bg=outer, bd=0, highlightthickness=0)
        self.fill = col(fill)
        self.border = col(border) if border else None
        self.radius = px(radius)
        self.bw = max(1, px(bw)) if border else 0
        self.cv = tk.Canvas(self, bg=outer, highlightthickness=0, bd=0, width=1, height=1)
        self.cv.place(x=0, y=0, relwidth=1, relheight=1)
        self.body = tk.Frame(self, bg=self.fill, bd=0, highlightthickness=0)
        self.body.pack(fill="both", expand=True, padx=px(pad if padx is None else padx),
                       pady=px(pad if pady is None else pady))
        self.bind("<Configure>", lambda e: self.redraw())

    def redraw(self):
        w, h = self.winfo_width(), self.winfo_height()
        self.cv.delete("all")
        if w > 2 and h > 2:
            round_box(self.cv, 0, 0, w, h, self.radius, self.fill, self.border, self.bw)

    def set_border(self, border, bw=1):
        self.border = col(border) if border else None
        self.bw = max(1, px(bw)) if border else 0
        self.redraw()

    def set_fill(self, fill, border=None):
        """Change the card colour (and every child that had the old one)."""
        old, new = self.fill, col(fill)
        if border is not None:
            self.border = col(border) if border else None
        if old != new:
            self.fill = new

            def walk(w):
                try:
                    if str(w.cget("bg")).lower() == old.lower():
                        w.configure(bg=new)
                except tk.TclError:
                    pass
                for c in w.winfo_children():
                    walk(c)
                if hasattr(w, "redraw") and w is not self.body:
                    try:
                        w.redraw()
                    except tk.TclError:
                        pass
            walk(self.body)
        self.redraw()


class Btn(tk.Canvas):
    """A rounded button. Styles: primary, secondary, soft, ghost, danger, good. Sizes: lg, md, sm."""
    STYLES = {
        "primary": ("accent", "accent_hi", "white", None),
        "secondary": ("surface", "surface2", "ink", "line2"),
        "soft": ("accent_soft", "accent_soft2", "accent_hi", None),
        "ghost": (None, "sunken", "ink2", None),
        "danger": ("surface", "bad_soft", "bad", "bad_line"),
        "good": ("good_dot", "good", "white", None),
    }
    SIZES = {"lg": (54, "btnL", 28, 14, "iconM"), "md": (40, "btn", 18, 10, "icon"), "sm": (32, "sbold", 12, 8, "iconS")}

    RIGHT_ICONS = ("chev_r", "next")

    def __init__(self, parent, text, command=None, style="primary", size="md", icon=None, width=None, font=None):
        h, bfont, padx, radius, ifont = self.SIZES[size]
        self.h, self.font, self.padx, self.radius, self.ifont = px(h), F[font or bfont], px(padx), px(radius), F[ifont]
        self.text, self.command, self.style, self.icon = text, command, style, icon
        self.enabled, self.hover, self.pressed, self.focused = True, False, False, False
        self.fixed_w = px(width) if width else None
        tk.Canvas.__init__(self, parent, height=self.h, width=self.fixed_w or self.natural_width(), bg=_bg(parent),
                           highlightthickness=0, bd=0, cursor="hand2", takefocus=1)
        self.bind("<Configure>", lambda e: self.redraw())
        self.bind("<Enter>", lambda e: self._hov(True))
        self.bind("<Leave>", lambda e: self._hov(False))
        self.bind("<ButtonPress-1>", lambda e: self._press(True))
        self.bind("<ButtonRelease-1>", self._release)
        self.bind("<Return>", lambda e: self._click())
        self.bind("<space>", lambda e: self._click())
        self.bind("<FocusIn>", lambda e: self._foc(True))
        self.bind("<FocusOut>", lambda e: self._foc(False))

    def natural_width(self):
        f = tkfont.Font(font=self.font)
        w = f.measure(self.text) if self.text else 0
        if self.icon and ICON_FONT[0]:
            w += tkfont.Font(font=self.ifont).measure(GLYPH.get(self.icon, "")) + (px(8) if self.text else 0)
        return w + 2 * self.padx

    def set(self, text=None, style=None, icon=None, enabled=None, command=None):
        old = (self.text, self.style, self.icon, self.enabled)
        if text is not None:
            self.text = text
        if style is not None:
            self.style = style
        if icon is not None:
            self.icon = icon or None
        if enabled is not None:
            self.enabled = bool(enabled)
        if command is not None:
            self.command = command
        if old != (self.text, self.style, self.icon, self.enabled):
            if not self.fixed_w and old[0] != self.text or old[2] != self.icon:
                self.configure(width=self.fixed_w or self.natural_width())
            self.configure(cursor="hand2" if self.enabled else "arrow")
            self.redraw()

    def _hov(self, on):
        self.hover = on
        if not on:
            self.pressed = False
        self.redraw()

    def _press(self, on):
        self.pressed = on
        self.redraw()

    def _foc(self, on):
        self.focused = on
        self.redraw()

    def _release(self, e):
        inside = 0 <= e.x <= self.winfo_width() and 0 <= e.y <= self.winfo_height()
        self.pressed = False
        self.redraw()
        if inside:
            self._click()

    def _click(self):
        if self.enabled and self.command:
            self.command()

    def redraw(self):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 10:
            w, h = int(self.cget("width")), int(self.cget("height"))
        fill, hov, ink, border = self.STYLES.get(self.style, self.STYLES["primary"])
        if not self.enabled:
            fill = "sunken" if fill else None
            ink, border = "faint", ("line" if border else None)
        elif self.hover:
            fill = hov
        if self.pressed and self.enabled and fill:
            fill = {"accent": "accent_hi"}.get(fill, fill)
        if self.focused and self.enabled:
            border = "accent"
        if fill or border:
            round_box(self, 0, 0, w, h, self.radius, fill or _bg(self.master), border,
                      max(1, px(2 if self.focused and self.enabled else 1)))
        f = tkfont.Font(font=self.font)
        tw = f.measure(self.text) if self.text else 0
        gw, gap = 0, 0
        g = GLYPH.get(self.icon, "") if (self.icon and ICON_FONT[0]) else ""
        if g:
            gw = tkfont.Font(font=self.ifont).measure(g)
            gap = px(8) if self.text else 0
        x = (w - tw - gw - gap) / 2.0
        cy = h / 2.0
        right = self.icon in self.RIGHT_ICONS
        if g:
            self.create_text(x + (tw + gap if right else 0), cy + px(1), text=g, anchor="w", font=self.ifont,
                             fill=col(ink))
        if self.text:
            self.create_text(x + (0 if right else gw + gap), cy, text=self.text, anchor="w", font=self.font,
                             fill=col(ink))


class Toggle(tk.Canvas):
    """An on/off switch bound to a BooleanVar."""

    def __init__(self, parent, variable=None, command=None, enabled=True):
        self.w, self.h = px(44), px(24)
        tk.Canvas.__init__(self, parent, width=self.w, height=self.h, bg=_bg(parent), highlightthickness=0, bd=0,
                           cursor="hand2", takefocus=1)
        self.var = variable if variable is not None else tk.BooleanVar(value=False)
        self.command = command
        self.enabled = enabled
        self.var.trace_add("write", lambda *a: self.redraw())
        self.bind("<ButtonRelease-1>", lambda e: self.toggle())
        self.bind("<space>", lambda e: self.toggle())
        self.redraw()

    def toggle(self):
        if not self.enabled:
            return
        self.var.set(not self.var.get())
        if self.command:
            self.command()

    def set_enabled(self, on):
        self.enabled = bool(on)
        self.configure(cursor="hand2" if on else "arrow")
        self.redraw()

    def redraw(self):
        self.delete("all")
        on = bool(self.var.get())
        color = ("accent" if on else "line2") if self.enabled else ("accent_dis" if on else "line")
        im = images()
        track = im.get(("pill", self.w, self.h, col(color)), lambda: gfx.pill_png(self.w, self.h, col(color)))
        self.create_image(0, 0, image=track, anchor="nw")
        d = self.h - px(6)
        knob = im.get(("knob", d), lambda: gfx.knob_png(d))
        x = self.w - d - px(3) - 1 if on else px(3) - 1
        self.create_image(x, px(3) - 1, image=knob, anchor="nw")


class Segmented(tk.Canvas):
    """A segmented control (one choice of a few) bound to a StringVar."""

    def __init__(self, parent, options, variable, command=None, height=36, seg_min=0):
        self.options = list(options)
        self.var, self.command = variable, command
        self.font, self.bfont = F["small"], F["sbold"]
        f = tkfont.Font(font=self.bfont)
        self.seg = max([f.measure(lbl) for _, lbl in self.options] + [px(seg_min)]) + 2 * px(16)
        self.h = px(height)
        self.enabled = True
        tk.Canvas.__init__(self, parent, width=self.seg * len(self.options) + px(6), height=self.h, bg=_bg(parent),
                           highlightthickness=0, bd=0, cursor="hand2")
        self.var.trace_add("write", lambda *a: self.redraw())
        self.bind("<ButtonRelease-1>", self._click)
        self.bind("<Configure>", lambda e: self.redraw())
        self.redraw()

    def _click(self, e):
        if not self.enabled:
            return
        i = int((e.x - px(3)) // max(1, self.seg))
        if 0 <= i < len(self.options):
            self.var.set(self.options[i][0])
            if self.command:
                self.command()

    def set_enabled(self, on):
        self.enabled = bool(on)
        self.redraw()

    def redraw(self):
        self.delete("all")
        w = self.seg * len(self.options) + px(6)
        round_box(self, 0, 0, w, self.h, px(10), "sunken")
        cur = self.var.get()
        for i, (value, label) in enumerate(self.options):
            x1 = px(3) + i * self.seg
            sel = value == cur
            if sel:
                round_box(self, x1, px(3), x1 + self.seg, self.h - px(3), px(8), "surface", "line", 1)
            ink = ("accent_hi" if sel else "muted") if self.enabled else "faint"
            self.create_text(x1 + self.seg / 2.0, self.h / 2.0, text=label, font=self.bfont if sel else self.font,
                             fill=col(ink))


class Field(Box):
    """A rounded text field (tk.Entry inside a Box); the border turns blue on focus and red on error."""

    def __init__(self, parent, width=24, show=None, font="base", justify="left", suffix=None, icon=None,
                 textvariable=None, pady=7, padx=12, radius=10, suffix_width=None):
        Box.__init__(self, parent, fill="white", border="line2", radius=radius, padx=padx, pady=pady)
        self.var = textvariable if textvariable is not None else tk.StringVar()
        self.error = False
        self.focus_on = False
        if icon:
            glyph(self.body, icon, "icon", fg="faint").pack(side="left", padx=(0, px(8)))
        self.entry = tk.Entry(self.body, textvariable=self.var, width=width, show=show or "", font=F.get(font, font),
                              bd=0, relief="flat", highlightthickness=0, bg=C["white"], fg=C["ink"],
                              insertbackground=C["ink"], justify=justify, disabledbackground=C["white"],
                              disabledforeground=C["faint"])
        if suffix:
            kw = {"width": suffix_width, "anchor": "center"} if suffix_width else {}
            L(self.body, suffix, font="sbold", fg="muted", **kw).pack(side="right", padx=(px(4), 0))
        self.entry.pack(side="left", fill="x", expand=True)
        self.entry.bind("<FocusIn>", lambda e: self._focus(True), add="+")
        self.entry.bind("<FocusOut>", lambda e: self._focus(False), add="+")
        for w in (self, self.body):
            w.bind("<Button-1>", lambda e: self.entry.focus_set())

    def _focus(self, on):
        self.focus_on = on
        self._paint()

    def _paint(self):
        if self.error:
            self.set_border("bad_dot", 2)
        elif self.focus_on:
            self.set_border("accent", 2)
        else:
            self.set_border("line2", 1)

    def set_error(self, on):
        if bool(on) != self.error:
            self.error = bool(on)
            self._paint()

    def get(self):
        return self.var.get()

    def set(self, v):
        self.var.set("" if v is None else str(v))

    def set_enabled(self, on):
        self.entry.configure(state="normal" if on else "disabled")


class Stepper(tk.Frame):
    """[−] value [+] for numbers on a grid (lots 0.01, percent 0.5, ...)."""

    def __init__(self, parent, value=None, lo=0.0, hi=1.0, step=0.01, fmt="%.2f", width=6, on_change=None,
                 suffix=None):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.lo, self.hi, self.step, self.fmt, self.on_change = lo, hi, step, fmt, on_change
        self.minus = Btn(self, "−", self.dec, style="secondary", size="sm", width=34, font="h3")
        self.field = Field(self, width=width, justify="center", font="bold", suffix=suffix, pady=5, padx=8,
                           suffix_width=2)
        self.plus = Btn(self, "+", self.inc, style="secondary", size="sm", width=34, font="h3")
        self.minus.pack(side="left")
        self.field.pack(side="left", padx=px(6))
        self.plus.pack(side="left")
        self._quiet = False
        if value is not None:
            self.set(value)
        self.field.var.trace_add("write", lambda *a: self._changed())

    def _changed(self):
        if not self._quiet and self.on_change:
            self.on_change(self.value())

    def value(self):
        try:
            return float(self.field.get().replace(",", "").strip())
        except ValueError:
            return None

    def set(self, v, quiet=False):
        self._quiet = quiet
        try:
            self.field.set("" if v is None else self.fmt % v)
        finally:
            self._quiet = False

    def _snap(self, v):
        n = round((v - self.lo) / self.step)
        return max(self.lo, min(self.hi, round(self.lo + n * self.step, 6)))

    def dec(self):
        v = self.value()
        self.set(self._snap((v if v is not None else self.lo) - self.step))

    def inc(self):
        v = self.value()
        self.set(self._snap((v if v is not None else self.lo) + self.step))

    def set_enabled(self, on):
        self.minus.set(enabled=on)
        self.plus.set(enabled=on)
        self.field.set_enabled(on)

    def set_error(self, on):
        self.field.set_error(on)


class Mark(tk.Label):
    """A round status mark: ok (green tick), bad (red cross), warn (amber !), idle (grey ring), info (blue i)."""

    def __init__(self, parent, state="idle", size=20):
        self.size = px(size)
        self.state = None
        tk.Label.__init__(self, parent, bg=_bg(parent), bd=0, padx=0, pady=0)
        self.set(state)

    def set(self, state):
        if state != self.state:
            self.state = state
            self.configure(image=mark_image(self.size, state))


class IconBadge(tk.Canvas):
    """A soft circle with an icon (or a number) in it."""

    def __init__(self, parent, icon=None, size=40, fill="accent_soft", ink="accent_hi", text=None, font=None):
        self.size = px(size)
        tk.Canvas.__init__(self, parent, width=self.size, height=self.size, bg=_bg(parent), highlightthickness=0,
                           bd=0)
        self.icon, self.fill, self.ink, self.text = icon, fill, ink, text
        self.font = font or ("iconXL" if size >= 52 else "iconL" if size >= 40 else "icon" if size >= 28 else "iconS")
        self.redraw()

    def set(self, icon=None, fill=None, ink=None, text=None):
        if icon is not None:
            self.icon = icon
        if fill is not None:
            self.fill = fill
        if ink is not None:
            self.ink = ink
        if text is not None:
            self.text = text
        self.redraw()

    def redraw(self):
        self.delete("all")
        self.create_image(0, 0, image=dot_image(self.size, self.fill), anchor="nw")
        c = self.size / 2.0
        if self.text is not None:
            self.create_text(c, c, text=self.text, font=F["sbold"] if self.size < 34 else F["h3"], fill=col(self.ink))
        elif self.icon and ICON_FONT[0]:
            self.create_text(c, c + px(1), text=GLYPH.get(self.icon, ""), font=F[self.font], fill=col(self.ink))


class Bar(tk.Canvas):
    """A thin rounded progress bar (0..1)."""

    def __init__(self, parent, height=8):
        tk.Canvas.__init__(self, parent, height=px(height), bg=_bg(parent), highlightthickness=0, bd=0)
        self.frac, self.tone = None, "good"
        self.bind("<Configure>", lambda e: self.redraw())

    def set(self, frac, tone="good"):
        self.frac, self.tone = frac, tone
        self.redraw()

    def redraw(self):
        self.delete("all")
        w, h = self.winfo_width(), int(self.cget("height"))
        if w < 4:
            return
        round_box(self, 0, 0, w, h, h // 2, "sunken")
        if self.frac:
            fw = max(h, int(w * max(0.0, min(1.0, self.frac))))
            round_box(self, 0, 0, fw, h, h // 2, TONE_DOT.get(self.tone, "accent"))


class StepBar(tk.Canvas):
    """The wizard progress: numbered circles joined by a line, a short label under each."""

    def __init__(self, parent, labels, height=62):
        tk.Canvas.__init__(self, parent, height=px(height), bg=_bg(parent), highlightthickness=0, bd=0)
        self.labels = list(labels)
        self.current, self.skipped = 0, set()
        self.bind("<Configure>", lambda e: self.redraw())

    def set(self, current, skipped=()):
        self.current, self.skipped = current, set(skipped)
        self.redraw()

    def redraw(self):
        self.delete("all")
        w = self.winfo_width()
        n = len(self.labels)
        if w < 50 or n < 2:
            return
        d = px(28)
        margin = px(56)
        cy = px(16)
        xs = [margin + i * (w - 2 * margin) / float(n - 1) for i in range(n)]
        for i in range(n - 1):
            done = i < self.current
            self.create_line(xs[i] + d / 2 + px(4), cy, xs[i + 1] - d / 2 - px(4), cy,
                             fill=C["good_dot"] if done else C["line2"], width=max(1, px(2)))
        for i, (x, label) in enumerate(zip(xs, self.labels)):
            if i in self.skipped:
                img, txt, ink = dot_image(d, "sunken"), "–", "faint"
            elif i < self.current:
                img, txt, ink = dot_image(d, "good_dot"), None, "white"
            elif i == self.current:
                img, txt, ink = dot_image(d, "accent"), str(i + 1), "white"
            else:
                img, txt, ink = dot_image(d, "surface", "line2"), str(i + 1), "muted"
            self.create_image(x - d / 2.0, cy - d / 2.0, image=img, anchor="nw")
            if txt is None and ICON_FONT[0]:
                self.create_text(x, cy + px(1), text=GLYPH["check"], font=F["iconS"], fill=col(ink))
            else:
                self.create_text(x, cy, text=txt or "✓", font=F["sbold"], fill=col(ink))
            lab_ink = "accent_hi" if i == self.current else "faint" if i in self.skipped else \
                "ink2" if i < self.current else "muted"
            self.create_text(x, cy + d / 2.0 + px(13), text=label, font=F["sbold"] if i == self.current else F["small"],
                             fill=col(lab_ink))


class ScrollFrame(tk.Frame):
    """A vertical scroll area whose scrollbar only shows when the content is taller than the area."""

    def __init__(self, parent, bg=None, **kw):
        bg = col(bg) if bg else _bg(parent)
        tk.Frame.__init__(self, parent, bg=bg, bd=0, highlightthickness=0, **kw)
        self.canvas = tk.Canvas(self, bg=bg, highlightthickness=0, bd=0, yscrollincrement=px(24))
        self.vsb = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview, style="Thin.Vertical.TScrollbar")
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
            self.vsb.pack(side="right", fill="y", padx=(px(2), px(2)))
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

    def to_top(self):
        self.canvas.yview_moveto(0)


class Centered(tk.Frame):
    """A column of at most `maxw` px, centred in its parent (used inside scroll areas)."""

    def __init__(self, parent, maxw=720, pad=24):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.maxw, self.pad = px(maxw), px(pad)
        self.col = tk.Frame(self, bg=_bg(parent), bd=0, highlightthickness=0)
        self.col.pack(fill="both", expand=True, padx=self.pad)
        self.bind("<Configure>", self._fit)

    def _fit(self, e):
        p = max(self.pad, (e.width - self.maxw) // 2)
        if p != getattr(self, "_p", None):
            self._p = p
            self.col.pack_configure(padx=p)


class Banner(tk.Frame):
    """A coloured message box (info / good / warn / bad) that takes no space while hidden."""

    def __init__(self, parent, pady=(0, 0)):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.pady = tuple(px(p) for p in pady)
        self.box = None
        self.key = None

    def hide(self):
        if self.box is not None:
            self.box.destroy()
            self.box = None
            self.configure(height=1)        # a frame keeps its last size when its last child goes: shrink it
        self.key = None

    def show(self, kind, title, text="", actions=()):
        key = (kind, title, text, tuple(a[0] for a in actions))
        if key == self.key:
            return
        self.hide()
        self.key = key
        box = Box(self, fill=TONE_SOFT[kind], border=TONE_LINE[kind], radius=12, padx=14, pady=11)
        box.pack(fill="x", pady=self.pady)
        b = box.body
        Mark(b, {"good": "ok"}.get(kind, kind), size=20).pack(side="left", anchor="n", pady=(px(1), 0))
        c = frame(b)
        c.pack(side="left", fill="x", expand=True, padx=(px(10), 0))
        L(c, title, font="bold", fg=TONE_INK[kind], wrap=True).pack(fill="x")
        if text:
            L(c, text, font="small", fg="ink2", wrap=True).pack(fill="x", pady=(px(2), 0))
        if actions:
            row = frame(c)
            row.pack(fill="x", pady=(px(8), 0))
            for i, (label, cmd) in enumerate(actions):
                Btn(row, label, cmd, style="secondary", size="sm").pack(side="left", padx=(0, px(8)))
        self.box = box


class Expander(tk.Frame):
    """A "▸ title" row that shows / hides .body."""

    def __init__(self, parent, title, sub=None, opened=False, on_toggle=None, fg="accent_hi"):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.on_toggle = on_toggle
        self.head = frame(self)
        self.head.pack(fill="x")
        self.chev = glyph(self.head, "chev_r", "iconS", fg=fg)
        self.chev.pack(side="left", padx=(0, px(8)))
        self.title = L(self.head, title, font="sbold", fg=fg, cursor="hand2")
        self.title.pack(side="left")
        if sub:
            L(self.head, "  " + sub, font="small", fg="muted").pack(side="left")
        self.body = frame(self)
        self.opened = False
        for w in (self.head, self.chev, self.title):
            w.configure(cursor="hand2")
            w.bind("<Button-1>", lambda e: self.toggle())
        if opened:
            self.open(True)

    def toggle(self):
        self.open(not self.opened)
        if self.on_toggle:
            self.on_toggle(self.opened)

    def open(self, on):
        self.opened = bool(on)
        if ICON_FONT[0]:
            self.chev.configure(text=GLYPH["chev_d" if on else "chev_r"])
        if on:
            self.body.pack(fill="x", pady=(px(10), 0))
        else:
            self.body.pack_forget()


def section(parent, title, why=None, icon=None, pady=(0, 0)):
    """Card title + the short "ทำไม" line under it."""
    head = frame(parent)
    head.pack(fill="x", pady=pady)
    if icon:
        IconBadge(head, icon, size=30).pack(side="left", anchor="n", padx=(0, px(10)))
    c = frame(head)
    c.pack(side="left", fill="x", expand=True)
    L(c, title, font="h3").pack(fill="x")
    if why:
        L(c, why, font="small", fg="muted", wrap=True).pack(fill="x", pady=(px(1), 0))
    return head


def badge(parent, text, tone="info"):
    """A small rounded tag ("แนะนำ", "ใช้อยู่ในเครื่องนี้")."""
    b = Box(parent, fill=TONE_SOFT[tone], border=None, radius=9, padx=8, pady=2)
    L(b.body, text, font="tbold", fg=TONE_INK[tone]).pack()
    return b


def hline(parent, pady=8):
    f = frame(parent, bg="line", height=1)
    f.pack(fill="x", pady=px(pady))
    return f


# ---------------------------------------------------------------------------------------------------------------------
# Small pictures for the manual MT5 steps
# ---------------------------------------------------------------------------------------------------------------------
def draw_picture(cv, key, w, h):
    """Simple pictograms: open, navigator, drag, load, allow, algo."""
    cv.delete("all")
    m = px(3)
    round_box(cv, m, m, w - m, h - m, px(8), "surface", "line2", 1)
    round_box(cv, m, m, w - m, m + px(10), px(8), "sunken")
    cv.create_rectangle(m + 1, m + px(7), w - m - 1, m + px(10), fill=C["sunken"], outline="", width=0)
    x0, y0, x1, y1 = m + px(6), m + px(15), w - m - px(6), h - m - px(6)
    ic = F["icon"]
    if key == "open":
        pts = [x0, y1 - px(6), x0 + (x1 - x0) * 0.25, y1 - px(14), x0 + (x1 - x0) * 0.5, y1 - px(9),
               x0 + (x1 - x0) * 0.75, y1 - px(20), x1, y1 - px(16)]
        cv.create_line(*pts, fill=C["accent"], width=max(2, px(2)), smooth=True)
        cv.create_text(x0, y0 + px(4), text="MT5", anchor="w", font=F["tbold"], fill=C["ink2"])
    elif key == "navigator":
        for i in range(3):
            cv.create_rectangle(x0, y0 + i * px(9), x0 + px(28) - i * px(4), y0 + i * px(9) + px(4),
                                fill=C["line2"], outline="", width=0)
        if ICON_FONT[0]:
            cv.create_text(x1 - px(8), (y0 + y1) / 2.0, text=GLYPH["refresh"], font=F["iconM"], fill=C["accent"])
    elif key == "drag":
        for i, (up, hh) in enumerate([(1, 12), (0, 16), (1, 10), (1, 18)]):
            cx = x0 + px(4) + i * px(8)
            cv.create_rectangle(cx, y1 - px(hh), cx + px(5), y1, fill=C["good_dot"] if up else C["bad_dot"],
                                outline="", width=0)
        if ICON_FONT[0]:
            cv.create_text(x1 - px(7), y0 + px(5), text=GLYPH["robot"], font=F["iconS"], fill=C["accent"])
            cv.create_text(x1 - px(21), y0 + px(17), text=GLYPH["back"], font=F["iconS"], fill=C["accent_hi"])
    elif key == "load":
        for i in range(2):
            cv.create_rectangle(x0, y0 + i * px(8), x1 - px(30), y0 + i * px(8) + px(4), fill=C["line2"], outline="",
                                width=0)
        round_box(cv, x1 - px(30), y1 - px(14), x1, y1, px(5), "accent")
        cv.create_text(x1 - px(15), y1 - px(7), text="Load", font=F["tbold"], fill=C["white"])
    elif key == "allow":
        cy = (y0 + y1) / 2.0
        sz = px(16)
        cv.create_image(x0, cy - sz / 2.0, image=images().get(("checkbox", sz), lambda: gfx.checkbox_png(
            sz, C["accent"])), anchor="nw")
        cv.create_rectangle(x0 + px(22), cy - px(2), x1, cy + px(2), fill=C["line2"], outline="", width=0)
        cv.create_text(x0 + px(22), cy - px(9), text="Allow", anchor="w", font=F["tiny"], fill=C["ink2"])
    elif key == "algo":
        round_box(cv, x0, y0 + px(2), x1, y1, px(8), "good_dot")
        if ICON_FONT[0]:
            cv.create_text(x0 + px(10), (y0 + y1) / 2.0 + px(2), text=GLYPH["play"], font=F["iconS"],
                           fill=C["white"])
        cv.create_text((x0 + x1) / 2.0 + px(6), (y0 + y1) / 2.0 + px(1), text="Algo", font=F["tbold"],
                       fill=C["white"])


class Picture(tk.Canvas):
    def __init__(self, parent, key, width=84, height=56):
        tk.Canvas.__init__(self, parent, width=px(width), height=px(height), bg=_bg(parent), highlightthickness=0,
                           bd=0)
        self.key = key
        self.bind("<Configure>", lambda e: draw_picture(self, self.key, e.width, e.height))


def manual_steps(parent, steps):
    """The illustrated "ทำเองใน MT5" list: number, picture, title, detail."""
    box = frame(parent)
    for i, (key, title, text) in enumerate(steps):
        r = frame(box)
        r.pack(fill="x", pady=(0, px(10)))
        IconBadge(r, None, size=26, text=str(i + 1)).pack(side="left", anchor="n", pady=(px(14), 0))
        Picture(r, key).pack(side="left", padx=(px(10), px(12)))
        c = frame(r)
        c.pack(side="left", fill="x", expand=True)
        L(c, title, font="bold").pack(fill="x", pady=(px(8), 0))
        L(c, text, font="small", fg="muted", wrap=True).pack(fill="x")
    return box


# ---------------------------------------------------------------------------------------------------------------------
# Dialogs
# ---------------------------------------------------------------------------------------------------------------------
class ChoiceDialog(object):
    """A modal question with clearly labelled buttons. choices: [(value, label, btn style)]. extra(body) may add
    content (lists, pictures) under the text."""

    def __init__(self, ui, title, text, choices, kind="warn", extra=None, width=500):
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
        body = frame(top, bg="surface")
        body.pack(fill="both", expand=True, padx=px(24), pady=px(22))
        head = frame(body)
        head.pack(fill="x")
        Mark(head, {"good": "ok"}.get(kind, kind), size=30).pack(side="left", anchor="n")
        c = frame(head)
        c.pack(side="left", fill="x", expand=True, padx=(px(14), 0))
        L(c, title, font="h2").pack(fill="x")
        if text:
            L(c, text, font="base", fg="ink2", wrap=width - 90).pack(fill="x", pady=(px(6), 0))
        if extra is not None:
            extra(c)
        row = frame(body)
        row.pack(fill="x", pady=(px(20), 0))
        for value, label, style in reversed(choices):
            Btn(row, label, lambda v=value: self.close(v), style=style or "secondary").pack(side="right",
                                                                                         padx=(px(8), 0))
        top.protocol("WM_DELETE_WINDOW", lambda: self.close(None))
        top.update_idletasks()
        w, h = max(top.winfo_reqwidth(), px(width)), top.winfo_reqheight()
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


def bullet_list(parent, items, icon="check", tone="good"):
    box = frame(parent)
    box.pack(fill="x", pady=(px(10), 0))
    for text in items:
        r = frame(box)
        r.pack(fill="x", pady=(0, px(5)))
        glyph(r, icon, "iconS", fg=TONE_INK.get(tone, tone)).pack(side="left", anchor="n", pady=(px(2), 0))
        L(r, text, font="base", fg="ink2", wrap=True).pack(side="left", fill="x", expand=True, padx=(px(8), 0))
    return box
