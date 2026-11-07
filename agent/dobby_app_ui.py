# -*- coding: utf-8 -*-
"""Dobby App look and widgets (Tkinter, no Pillow) in the website's "Hallmark" design (docs/DESIGN.md): porcelain
background, graphite text, fine gold for brand / primary / selection, jade = profit / running, cinnabar = loss /
danger / offline; hairlines instead of boxed cards; radius by hierarchy (hero sheet 22, panels 14, controls 10).
Anti-aliased shapes (corners, the hallmark stamp, the price line, the sheet shadow) are PNGs drawn by dobby_app_gfx.

Fonts: Anuphan (Thai and UI) and Chakra Petch (money, prices, lots, percentages), both SIL OFL 1.1, ship in
fonts/ next to this file (sys._MEIPASS/fonts in the exe) with their OFL.txt and are loaded for this process only
(gdi32.AddFontResourceExW with FR_PRIVATE: nothing is installed). Anuphan comes from Google Fonts as one variable
font; GDI misplaces Thai vowels and tone marks on a variable font's non-default weights, so the app loads static
Regular / Medium / SemiBold / Bold instances cut from it (fontTools instancer). Without them: Leelawadee UI / Tahoma.

Thai text: every label goes through wrap_text(), which keeps each drawn line under ~195 UTF-8 bytes and never starts a
line with a Thai combining mark (Tk on Windows draws long runs in pieces; a piece that starts with a mark shows it on
a dotted circle)."""
import base64
import os
import re
import sys
import time
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk

import dobby_app_gfx as gfx
from dobby_app_gfx import mix

# ---------------------------------------------------------------------------------------------------------------------
# Palette (DESIGN.md tokens, light theme). Tk has no alpha: the "slate at 18 %" kind of colours are mixed here once,
# over porcelain (bg) and over the white sheet (_s).
# ---------------------------------------------------------------------------------------------------------------------
_T = {"bg": "#F1F2EE", "sheet": "#FFFFFF", "ink": "#20262A", "slate": "#5E676D", "gold": "#D4AE52",
      "gold_ink": "#85621A", "gold_hi": "#EDD58F", "gold_lo": "#A8822C", "engrave": "#6B4E10", "jade": "#1E7656",
      "cinnabar": "#B83A2A", "white": "#FFFFFF"}
C = dict(_T)
C.update(
    hair=mix(_T["slate"], _T["bg"], .18), hair_s=mix(_T["slate"], _T["sheet"], .18),
    hair2=mix(_T["slate"], _T["bg"], .40), hair2_s=mix(_T["slate"], _T["sheet"], .40),
    well=mix(_T["slate"], _T["bg"], .08), well2=mix(_T["slate"], _T["bg"], .14),
    well_s=mix(_T["slate"], _T["sheet"], .06), well2_s=mix(_T["slate"], _T["sheet"], .12),
    gold_tint=mix(_T["gold"], _T["bg"], .16), gold_tint_s=mix(_T["gold"], _T["sheet"], .16),
    gold_soft=mix(_T["gold"], _T["bg"], .45),
    gold_hover=mix(_T["ink"], _T["gold"], .10), gold_edge=mix("#503808", _T["gold"], .22),
    gold_shine=mix("#FFF8E1", _T["gold"], .55),
    jade_tint=mix(_T["jade"], _T["bg"], .10), jade_soft=mix(_T["jade"], _T["sheet"], .55),
    cinnabar_tint=mix(_T["cinnabar"], _T["bg"], .09), cinnabar_soft=mix(_T["cinnabar"], _T["bg"], .40),
    faint=mix(_T["slate"], _T["bg"], .55), faint_s=mix(_T["slate"], _T["sheet"], .5),
    sheet_edge=mix(_T["slate"], _T["bg"], .13),
)
# older names some code still uses: all point at Hallmark colours (no blue anywhere)
C.update(surface=C["sheet"], surface2=C["well_s"], sunken=C["well2"], side=C["bg"], line=C["hair"], line2=C["hair2"],
         ink2=C["ink"], muted=C["slate"], accent=C["gold"], accent_hi=C["gold_ink"], accent_soft=C["gold_tint"],
         accent_soft2=C["gold_soft"], accent_line=C["gold_soft"], accent_dis=C["gold_soft"],
         good=C["jade"], good_dot=C["jade"], good_soft=C["jade_tint"], good_line=mix(_T["jade"], _T["bg"], .35),
         warn=C["gold_ink"], warn_dot=C["gold"], warn_soft=C["gold_tint"], warn_line=C["gold_soft"],
         bad=C["cinnabar"], bad_dot=C["cinnabar"], bad_soft=C["cinnabar_tint"], bad_line=C["cinnabar_soft"],
         idle_dot=C["hair2"])
TONE_INK = {"good": "jade", "ok": "jade", "warn": "gold_ink", "bad": "cinnabar", "info": "ink", "idle": "slate"}
TONE_DOT = {"good": "jade", "ok": "jade", "warn": "gold", "bad": "cinnabar", "info": "slate", "idle": "hair2"}
TONE_SOFT = {"good": "jade_tint", "ok": "jade_tint", "warn": "gold_tint", "bad": "cinnabar_tint", "info": "well2",
             "idle": "well"}
TONE_LINE = {"good": "good_line", "ok": "good_line", "warn": "gold_soft", "bad": "cinnabar_soft", "info": "hair2",
             "idle": "hair"}
F = {}
SCALE = [1.0]
ICON_FONT = [None]
GLYPH = {
    "settings": "\ue713", "globe": "\ue774", "help": "\ue9ce", "play": "\ue768", "stop": "\ue71a", "pause": "\ue769",
    "refresh": "\ue72c", "folder": "\ue8b7", "download": "\ue896", "lock": "\ue72e", "shield": "\uea18",
    "person": "\ue77b", "check": "\ue73e", "cancel": "\ue711", "warning": "\ue7ba", "info": "\ue946", "add": "\ue710",
    "robot": "\ue99a", "card": "\ue8c7", "chart": "\ue9d2", "pulse": "\ue9d9", "history": "\ue81c",
    "clock": "\ue823", "link": "\ue71b", "devices": "\ue977", "laptop": "\ue7f8", "power": "\ue7e8",
    "bolt": "\ue945", "edit": "\ue70f", "list": "\ue8bc", "open": "\ue8a7", "home": "\ue80f", "back": "\ue72b",
    "next": "\ue72a", "chev_r": "\ue76c", "chev_l": "\ue76b", "chev_d": "\ue70d", "chev_u": "\ue70e",
    "key": "\ue8d7", "signal": "\ue88a", "doc": "\ue7c3", "calc": "\ue8ef", "send": "\ue724", "gears": "\ue9f5",
    "flag": "\ue7c1", "report": "\ue9f9", "timer": "\ue916", "error": "\ue783",
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


# ---------------------------------------------------------------------------------------------------------------------
# Fonts
# ---------------------------------------------------------------------------------------------------------------------
FR_PRIVATE = 0x10
FONT_FILES = (("anuphan", "Anuphan-Regular.ttf"), ("anuphan", "Anuphan-Medium.ttf"),
              ("anuphan", "Anuphan-SemiBold.ttf"), ("anuphan", "Anuphan-Bold.ttf"),
              ("chakrapetch", "ChakraPetch-Regular.ttf"), ("chakrapetch", "ChakraPetch-Medium.ttf"),
              ("chakrapetch", "ChakraPetch-SemiBold.ttf"), ("chakrapetch", "ChakraPetch-Bold.ttf"))
FONTS = {"tried": False, "dir": None, "loaded": [], "failed": [], "ui": None, "num": None, "anuphan": False,
         "chakra": False}


def font_dir():
    """fonts/ next to this file, or inside the one-file exe (PyInstaller unpacks it to sys._MEIPASS)."""
    base = getattr(sys, "_MEIPASS", None) or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "fonts")


def load_private_fonts():
    """Make the bundled fonts available to this process only (Windows; call before the first Tk font). Returns the
    file names that loaded; a missing or refused file just means the fallback font is used."""
    if FONTS["tried"]:
        return FONTS["loaded"]
    FONTS["tried"] = True
    d = FONTS["dir"] = font_dir()
    if os.name != "nt":
        return FONTS["loaded"]
    try:
        import ctypes
        add = ctypes.windll.gdi32.AddFontResourceExW
        add.argtypes = (ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_void_p)
        add.restype = ctypes.c_int
    except Exception as e:  # pragma: no cover - not Windows / no gdi32
        FONTS["failed"].append("gdi32: %s" % e)
        return FONTS["loaded"]
    for sub, name in FONT_FILES:
        path = os.path.join(d, sub, name)
        try:
            n = add(path, FR_PRIVATE, None) if os.path.isfile(path) else 0
        except Exception:
            n = 0
        (FONTS["loaded"] if n else FONTS["failed"]).append(name)
    return FONTS["loaded"]


def _font(spec, size, *styles):
    """(family[, weight]) + pixel size -> a Tk font tuple (negative size = pixels, scaled with the screen)."""
    fam = spec[0]
    weight = spec[1] if len(spec) > 1 else "normal"
    return (fam, -px(size), weight) + tuple(styles)


def font(kind, size):
    """A font of one of the theme's faces at any pixel size: ui, med, semi, bold, num, nums (semibold numbers)."""
    return _font(FONTS["faces"][kind], size)


def setup_theme(root):
    SCALE[0] = max(1.0, root.winfo_fpixels("1i") / 96.0)
    IMG[0] = Images(root)
    load_private_fonts()
    fams = set(tkfont.families(root))
    anu = "Anuphan" in fams
    ui = "Anuphan" if anu else next((f for f in ("Leelawadee UI", "Tahoma") if f in fams), "TkDefaultFont")
    faces = {"ui": (ui,), "bold": (ui, "bold"),
             "med": ("Anuphan Medium",) if anu and "Anuphan Medium" in fams else (ui,),
             "semi": ("Anuphan SemiBold",) if anu and "Anuphan SemiBold" in fams else (ui, "bold")}
    chakra = "Chakra Petch Medium" in fams and "Chakra Petch SemiBold" in fams
    faces["num"] = ("Chakra Petch Medium",) if chakra else faces["semi"]
    faces["nums"] = ("Chakra Petch SemiBold",) if chakra else faces["semi"]
    FONTS.update(ui=ui, num=faces["nums"][0], anuphan=anu, chakra=chakra, faces=faces)
    ICON_FONT[0] = next((f for f in ("Segoe Fluent Icons", "Segoe MDL2 Assets") if f in fams), None)
    ifam = (ICON_FONT[0] or ui,)
    mono = next((f for f in ("Cascadia Mono", "Consolas") if f in fams), "Courier New")
    u, m, s, b, n, ns = (faces[k] for k in ("ui", "med", "semi", "bold", "num", "nums"))
    F.update(
        # Thai / UI text on the 13 / 15 / 17 / 21 / 28 / 40 scale (12 only inside charts)
        tiny=_font(u, 12), small=_font(u, 13), smed=_font(m, 13), sbold=_font(s, 13), tbold=_font(s, 12),
        base=_font(u, 15), med=_font(m, 15), bold=_font(s, 15), lead=_font(u, 17),
        h3=_font(s, 17), h2=_font(s, 21), h1=_font(s, 28), hero=_font(s, 28), brand=_font(s, 17),
        # money, prices, lots, percentages
        numT=_font(n, 12), numXS=_font(n, 13), numS=_font(n, 15), numB=_font(ns, 17), numM=_font(ns, 21),
        num=_font(ns, 28), numL=_font(ns, 40),
        btn=_font(m, 15), btnP=_font(s, 15), btnL=_font(s, 17), btnS=_font(m, 13), btnSP=_font(s, 13),
        entry=_font(u, 15), entryN=_font(ns, 17), entryL=_font(ns, 28),
        link=_font(u, 15, "underline"), slink=_font(u, 13, "underline"), mono=(mono, -px(13)),
        iconS=_font(ifam, 13), icon=_font(ifam, 16), iconM=_font(ifam, 18), iconL=_font(ifam, 22),
        iconXL=_font(ifam, 30), family=ui)
    for name in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont", "TkCaptionFont", "TkTooltipFont"):
        try:
            tkfont.nametofont(name).configure(family=ui, size=-px(14))
        except tk.TclError:
            pass
    st = ttk.Style(root)
    st.theme_use("clam")
    st.configure(".", background=C["bg"], foreground=C["ink"], font=F["base"], bordercolor=C["hair2"],
                 focuscolor=C["gold_tint"], troughcolor=C["well"])
    st.layout("Thin.Vertical.TScrollbar", [("Vertical.Scrollbar.trough", {"sticky": "ns", "children": [
        ("Vertical.Scrollbar.thumb", {"expand": "1", "sticky": "nswe"})]})])
    st.configure("Thin.Vertical.TScrollbar", troughcolor=C["bg"], background=C["hair2"], bordercolor=C["bg"],
                 lightcolor=C["hair2"], darkcolor=C["hair2"], arrowsize=px(8), gripcount=0, relief="flat")
    st.map("Thin.Vertical.TScrollbar", background=[("active", C["slate"])])
    st.configure("S.TCheckbutton", background=C["bg"], foreground=C["ink"], font=F["base"],
                 focuscolor=C["bg"], indicatorbackground=C["white"], indicatorforeground=C["jade"])
    st.map("S.TCheckbutton", background=[("active", C["bg"])], foreground=[("disabled", C["faint"])])
    return ui


def num_text(x, signed=False, digits=2):
    """Money / prices for display: thousands separators and a true minus sign (−)."""
    if x is None:
        return "-"
    t = format(x, ("+,.%df" if signed else ",.%df") % digits)
    return t.replace("-", "−")


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
        for tok in re.split(r"([^\S\u00a0]+)", para):
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


def on_sheet(widget):
    """True when the widget sits on the white sheet (hero, dialogs): hairlines and wells use the _s shades."""
    return str(_bg(widget)).upper() == C["sheet"]


def hair_for(widget, strong=False):
    if strong:
        return C["hair2_s"] if on_sheet(widget) else C["hair2"]
    return C["hair_s"] if on_sheet(widget) else C["hair"]


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
    """An underlined text link in graphite (hover: fine gold)."""

    def __init__(self, parent, text, command, font="link", fg="ink", **kw):
        L.__init__(self, parent, text=text, font=font, fg=fg, cursor="hand2", **kw)
        self._fg = col(fg)
        self.bind("<Button-1>", lambda e: command())
        self.bind("<Enter>", lambda e: tk.Label.configure(self, fg=C["gold_ink"]))
        self.bind("<Leave>", lambda e: tk.Label.configure(self, fg=self._fg))


def frame(parent, bg=None, **kw):
    return tk.Frame(parent, bg=col(bg) if bg else _bg(parent), bd=0, highlightthickness=0, **kw)


def glyph(parent, name, size="icon", fg="slate", bg=None, **kw):
    """An icon from Segoe Fluent Icons / MDL2 Assets (an empty label when Windows has neither font)."""
    text = GLYPH.get(name, "") if ICON_FONT[0] else ""
    return tk.Label(parent, text=text, font=F[size], fg=col(fg), bg=bg or _bg(parent), bd=0, padx=0, pady=0, **kw)


def bind_tree(widget, seq, fn, skip=()):
    """Bind an event on a widget and all its descendants (clickable rows)."""
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


SHADOW = {"sigma": 7.0, "alpha": 0.15, "dy": 6.0, "inset": 6.0, "color": "#28241A"}


def shadow_margins():
    """(side, top, bottom) px the sheet shadow needs around a sheet."""
    s = SHADOW
    ext = int(round(2.6 * px(s["sigma"])))
    side = max(0, ext - px(s["inset"]))
    return side, max(0, side - px(s["dy"])), side + px(s["dy"])


def sheet_box(cv, x1, y1, x2, y2, r, bg, fill="sheet", edge="sheet_edge", tag="box"):
    """The hero sheet / a dialog surface: a soft, low, warm-neutral shadow (painted opaque on the flat background
    `bg`), then the rounded white box with a barely visible edge."""
    s = SHADOW
    sig, a, dy, ins = px(s["sigma"]), s["alpha"], px(s["dy"]), px(s["inset"])
    ext = int(round(2.6 * sig))
    bg = col(bg)
    rs = max(2, r - ins)
    sx1, sy1, sx2, sy2 = x1 + ins, y1 + ins + dy, x2 - ins, y2 - ins + dy
    kw = {"width": 1, "tags": tag}
    for i in range(-rs, ext):          # straight edges: one opaque line per distance from the shadow's box
        c = mix(s["color"], bg, gfx.shadow_alpha(i + 0.5, sig, a))
        cv.create_line(sx1 + rs, sy1 - i - 1, sx2 - rs, sy1 - i - 1, fill=c, **kw)
        cv.create_line(sx1 + rs, sy2 + i, sx2 - rs, sy2 + i, fill=c, **kw)
        cv.create_line(sx1 - i - 1, sy1 + rs, sx1 - i - 1, sy2 - rs, fill=c, **kw)
        cv.create_line(sx2 + i, sy1 + rs, sx2 + i, sy2 - rs, fill=c, **kw)
    im = images()
    n = ext + rs
    for which, x, y in (("tl", sx1 - ext, sy1 - ext), ("tr", sx2 - rs, sy1 - ext), ("bl", sx1 - ext, sy2 - rs),
                        ("br", sx2 - rs, sy2 - rs)):
        img = im.get(("shadow", rs, ext, sig, a, which, bg),
                     lambda w=which: gfx.shadow_corner_png(rs, ext, sig, a, w, s["color"], bg))
        cv.create_image(x, y, image=img, anchor="nw", tags=tag)
    del n
    round_box(cv, x1, y1, x2, y2, r, fill, edge, 1, tag)


def dot_image(size, fill, ring=None, ring_w=None):
    ring_w = ring_w if ring_w is not None else max(1.2, SCALE[0] * 1.5)
    return images().get(("dot", size, col(fill), col(ring), ring_w),
                        lambda: gfx.dot_png(size, col(fill), col(ring), ring_w))


MARK_KIND = {"ok": "ok", "good": "ok", "bad": "bad", "warn": "warn", "idle": "idle", "info": "info"}


def mark_image(size, state, quiet=False):
    """Status marks. Solid: a coloured disc with a tick / cross / "!" / "i". Quiet (lists): a bare jade tick, a
    small cinnabar or gold disc, a slate ring."""
    kind = MARK_KIND.get(state, state)
    color = col(TONE_DOT.get(state, "slate"))
    if quiet:
        if kind == "ok":
            return images().get(("qtick", size), lambda: gfx.tick_png(size, C["jade"], max(1.6, size * 0.12)))
        if kind == "idle":
            return images().get(("qidle", size), lambda: _quiet_ring(size, C["hair2"]))
        if kind == "info":
            return images().get(("qinfo", size), lambda: _quiet_ring(size, C["slate"]))
    ink = C["ink"] if kind == "warn" else "#FFFFFF"
    return images().get(("mark", size, kind, color, quiet), lambda: _small_mark(size, kind, color, ink, quiet))


def _quiet_ring(size, color):
    img = gfx.Raster(size, size)
    c = size / 2.0
    img.draw(gfx.sd_ring(c, c, size * 0.28, max(1.3, size * 0.09)), color)
    return img.png()


def _small_mark(size, kind, color, ink, quiet):
    if not quiet:
        return gfx.mark_png(size, kind, color, ink)
    inner = max(10, int(round(size * 0.78)))       # quiet: a smaller disc centred in the same box
    img = gfx.Raster(size, size)
    c = size / 2.0
    img.draw(gfx.sd_circle(c, c, inner / 2.0 - 0.5), color)
    w = max(1.4, inner * 0.12)
    s = inner / 2.0
    if kind == "bad":
        img.draw(gfx.sd_polyline([(c - s * 0.32, c - s * 0.32), (c + s * 0.32, c + s * 0.32)], w), ink)
        img.draw(gfx.sd_polyline([(c + s * 0.32, c - s * 0.32), (c - s * 0.32, c + s * 0.32)], w), ink)
    elif kind == "warn":
        img.draw(gfx.sd_polyline([(c, c - s * 0.48), (c, c + s * 0.10)], w), ink)
        img.draw(gfx.sd_circle(c, c + s * 0.42, w * 0.62), ink)
    return img.png()


class Box(tk.Frame):
    """A rounded panel: a Frame with a background canvas that draws the box; put children into .body.
    shadow=True: the hero sheet (white, soft low shadow; the frame keeps room around it for the shadow)."""

    def __init__(self, parent, fill="surface", border="line", radius=14, pad=16, padx=None, pady=None, bw=1,
                 shadow=False):
        outer = _bg(parent)
        tk.Frame.__init__(self, parent, bg=outer, bd=0, highlightthickness=0)
        self.fill = col(fill)
        self.border = col(border) if border else None
        self.radius = px(radius)
        self.bw = max(1, px(bw)) if border else 0
        self.shadow = shadow
        self.m = shadow_margins() if shadow else (0, 0, 0)
        self.cv = tk.Canvas(self, bg=outer, highlightthickness=0, bd=0, width=1, height=1)
        self.cv.place(x=0, y=0, relwidth=1, relheight=1)
        self.body = tk.Frame(self, bg=self.fill, bd=0, highlightthickness=0)
        ppx, ppy = px(pad if padx is None else padx), px(pad if pady is None else pady)
        side, top, bottom = self.m
        self.body.pack(fill="both", expand=True, padx=ppx + side, pady=(ppy + top, ppy + bottom))
        self.bind("<Configure>", lambda e: self.redraw())

    def redraw(self):
        w, h = self.winfo_width(), self.winfo_height()
        self.cv.delete("all")
        if w > 2 and h > 2:
            side, top, bottom = self.m
            if self.shadow:
                sheet_box(self.cv, side, top, w - side, h - bottom, self.radius, _bg(self), self.fill)
            else:
                round_box(self.cv, 0, 0, w, h, self.radius, self.fill, self.border, self.bw)

    def set_border(self, border, bw=1):
        self.border = col(border) if border else None
        self.bw = max(1, px(bw)) if border else 0
        self.redraw()

    def set_fill(self, fill, border=None):
        """Change the panel colour (and every child that had the old one)."""
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


# ---------------------------------------------------------------------------------------------------------------------
# Controls
# ---------------------------------------------------------------------------------------------------------------------
class Btn(tk.Canvas):
    """A rounded button (radius 10). Styles: primary (gold, graphite text), secondary (white, hairline), ghost,
    quiet (ghost with slate text), soft (well), danger (cinnabar outline), good (jade). Sizes: lg, md, sm."""
    STYLES = {   # fill, hover fill, ink, border, hover border
        "primary": ("gold", "gold_hover", "ink", None, None),
        "secondary": ("sheet", "sheet", "ink", "hair2", "slate"),
        "ghost": (None, "well", "ink", None, None),
        "quiet": (None, "well", "slate", None, None),
        "soft": ("well2", "hair", "ink", None, None),
        "danger": ("sheet", "sheet", "cinnabar", "cinnabar_soft", "cinnabar"),
        "good": ("jade", "jade", "white", None, None),
    }
    SIZES = {"lg": (48, "btnL", 22, 10, "iconM"), "md": (40, "btn", 16, 10, "icon"), "sm": (34, "btnS", 12, 10, "iconS")}
    RIGHT_ICONS = ()

    def __init__(self, parent, text, command=None, style="primary", size="md", icon=None, width=None, font=None,
                 minw=None):
        h, bfont, padx, radius, ifont = self.SIZES[size]
        self.minw = px(minw) if minw else 0
        self.size = size
        self._font_key = font
        self.h, self.padx, self.radius, self.ifont = px(h), px(padx), px(radius), F[ifont]
        self.text, self.command, self.style, self.icon = text, command, style, icon
        self.font = self._pick_font()
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

    def _pick_font(self):
        if self._font_key:
            return F[self._font_key]
        if self.size == "lg":
            return F["btnL"]
        strong = self.style in ("primary", "good")
        if self.size == "sm":
            return F["btnSP" if strong else "btnS"]
        return F["btnP" if strong else "btn"]

    def natural_width(self):
        f = tkfont.Font(font=self.font)
        w = f.measure(self.text) if self.text else 0
        if self.icon and ICON_FONT[0]:
            w += tkfont.Font(font=self.ifont).measure(GLYPH.get(self.icon, "")) + (px(8) if self.text else 0)
        return max(self.minw, w + 2 * self.padx)

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
            self.font = self._pick_font()
            if not self.fixed_w and (old[0] != self.text or old[2] != self.icon or old[1] != self.style):
                self.configure(width=self.natural_width())
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
        fill, hov, ink, border, hborder = self.STYLES.get(self.style, self.STYLES["primary"])
        sheet = on_sheet(self.master)
        if fill == "well2" and sheet:
            fill = "well2_s"
        if hov == "well" and sheet:
            hov = "well_s"
        if not self.enabled:
            fill = ("well_s" if sheet else "well") if fill else None
            ink, border = "faint", ("hair" if border else None)
        elif self.hover:
            fill = hov if (fill or hov) else fill
            border = hborder or border
        if self.pressed and self.enabled and fill == "gold_hover":
            fill = "gold_edge"
        bw = 1
        if self.focused and self.enabled:
            border, bw = "gold_ink", max(2, px(2))
        if fill or border:
            round_box(self, 0, 0, w, h, self.radius, fill or _bg(self.master), border, bw)
        if self.style == "primary" and self.enabled and not self.focused:
            r = self.radius
            self.create_line(r, h - 1, w - r, h - 1, fill=C["gold_edge"])      # the struck bottom edge
            self.create_line(r, 1, w - r, 1, fill=C["gold_shine"] if not self.hover else C["gold"])
        f = tkfont.Font(font=self.font)
        tw = f.measure(self.text) if self.text else 0
        gw, gap = 0, 0
        g = GLYPH.get(self.icon, "") if (self.icon and ICON_FONT[0]) else ""
        if g:
            gw = tkfont.Font(font=self.ifont).measure(g)
            gap = px(8) if self.text else 0
        x = (w - tw - gw - gap) / 2.0
        cy = h / 2.0
        if g:
            self.create_text(x, cy + px(1), text=g, anchor="w", font=self.ifont, fill=col(ink))
        if self.text:
            self.create_text(x + gw + gap, cy, text=self.text, anchor="w", font=self.font, fill=col(ink))


class Toggle(tk.Canvas):
    """An on/off switch bound to a BooleanVar (on = jade, like the website)."""

    def __init__(self, parent, variable=None, command=None, enabled=True):
        self.w, self.h = px(44), px(26)
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
        sheet = on_sheet(self.master)
        if self.enabled:
            fill, border = ("jade", None) if on else (("well2_s" if sheet else "well2"), ("hair_s" if sheet else "hair"))
        else:
            fill, border = ("jade_soft", None) if on else (("well_s" if sheet else "well"), None)
        im = images()
        f, b = col(fill), col(border) if border else None
        track = im.get(("pill", self.w, self.h, f, b), lambda: gfx.pill_png(self.w, self.h, f, b, 1))
        self.create_image(0, 0, image=track, anchor="nw")
        d = self.h - px(6)
        knob = im.get(("knob", d), lambda: gfx.knob_png(d))
        x = self.w - d - px(3) - 1 if on else px(3) - 1
        self.create_image(x, px(3) - 1, image=knob, anchor="nw")


class Segmented(tk.Canvas):
    """A segmented control (one choice of a few) bound to a StringVar: a well track, the chosen part a small sheet."""

    def __init__(self, parent, options, variable, command=None, height=38, seg_min=0):
        self.options = list(options)
        self.var, self.command = variable, command
        self.font, self.bfont = F["med"], F["bold"]
        f = tkfont.Font(font=self.bfont)
        self.seg = max([f.measure(lbl) for _, lbl in self.options] + [px(seg_min)]) + 2 * px(14)
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
        sheet = on_sheet(self.master)
        round_box(self, 0, 0, w, self.h, px(10), "well2_s" if sheet else "well2")
        cur = self.var.get()
        for i, (value, label) in enumerate(self.options):
            x1 = px(3) + i * self.seg
            sel = value == cur
            if sel:
                round_box(self, x1, px(3) + 1, x1 + self.seg, self.h - px(3) + 1, px(7), "hair2")   # lift
                round_box(self, x1, px(3), x1 + self.seg, self.h - px(3), px(7), "sheet", "hair_s", 1)
            ink = ("ink" if sel else "slate") if self.enabled else "faint"
            self.create_text(x1 + self.seg / 2.0, self.h / 2.0, text=label, font=self.bfont if sel else self.font,
                             fill=col(ink))


class Field(Box):
    """A rounded text field (tk.Entry inside a white Box); the border turns fine gold on focus, cinnabar on error."""

    def __init__(self, parent, width=24, show=None, font="entry", justify="left", suffix=None, icon=None,
                 textvariable=None, pady=8, padx=12, radius=10, suffix_width=None):
        Box.__init__(self, parent, fill="sheet", border="hair2", radius=radius, padx=padx, pady=pady)
        self.var = textvariable if textvariable is not None else tk.StringVar()
        self.error = False
        self.focus_on = False
        if icon:
            glyph(self.body, icon, "icon", fg="slate").pack(side="left", padx=(0, px(8)))
        if font == "base":
            font = "entry"
        self.entry = tk.Entry(self.body, textvariable=self.var, width=width, show=show or "", font=F.get(font, font),
                              bd=0, relief="flat", highlightthickness=0, bg=C["sheet"], fg=C["ink"],
                              insertbackground=C["ink"], justify=justify, disabledbackground=C["sheet"],
                              disabledforeground=C["faint"], selectbackground=C["gold_soft"],
                              selectforeground=C["ink"])
        if suffix:
            kw = {"width": suffix_width, "anchor": "center"} if suffix_width else {}
            L(self.body, suffix, font="small", fg="slate", **kw).pack(side="right", padx=(px(6), 0))
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
            self.set_border("cinnabar", 2)
        elif self.focus_on:
            self.set_border("gold_ink", 2)
        else:
            self.set_border("hair2", 1)

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


class _StepKey(tk.Canvas):
    """The − / + ends of a Stepper."""

    def __init__(self, parent, text, command, size):
        tk.Canvas.__init__(self, parent, width=size, height=size, bg=_bg(parent), highlightthickness=0, bd=0,
                           cursor="hand2")
        self.text, self.command, self.enabled, self.hover = text, command, True, False
        self.bind("<Enter>", lambda e: self._hov(True))
        self.bind("<Leave>", lambda e: self._hov(False))
        self.bind("<ButtonRelease-1>", lambda e: self.enabled and self.command())
        self.bind("<Configure>", lambda e: self.redraw())

    def _hov(self, on):
        self.hover = on
        self.redraw()

    def set(self, enabled=None, **kw):
        if enabled is not None and bool(enabled) != self.enabled:
            self.enabled = bool(enabled)
            self.configure(cursor="hand2" if self.enabled else "arrow")
            self.redraw()

    def redraw(self):
        self.delete("all")
        w, h = self.winfo_width(), self.winfo_height()
        if w < 4:
            w, h = int(self.cget("width")), int(self.cget("height"))
        if self.hover and self.enabled:
            round_box(self, px(3), px(3), w - px(3), h - px(3), px(7), "well_s")
        self.create_text(w / 2.0, h / 2.0 - 1, text=self.text, font=font("ui", 21),
                         fill=C["ink"] if self.enabled else C["hair2_s"])


class _StepField(object):
    """What a Stepper's value part looks like to callers (var / get / set / set_error / set_enabled)."""

    def __init__(self, stepper, var, entry):
        self.stepper, self.var, self.entry = stepper, var, entry

    def get(self):
        return self.var.get()

    def set(self, v):
        self.var.set("" if v is None else str(v))

    def set_error(self, on):
        self.stepper.set_error(on)

    def set_enabled(self, on):
        self.entry.configure(state="normal" if on else "disabled")


class Stepper(Box):
    """[ − | 0.03 | + ] in one white control (website stepper): the value in Chakra Petch, the unit in slate."""

    def __init__(self, parent, value=None, lo=0.0, hi=1.0, step=0.01, fmt="%.2f", width=6, on_change=None,
                 suffix=None):
        Box.__init__(self, parent, fill="sheet", border="hair2", radius=10, pad=0, padx=1, pady=1)
        self.lo, self.hi, self.step, self.fmt, self.on_change = lo, hi, step, fmt, on_change
        self.error, self.focus_on = False, False
        k = px(40)
        b = self.body
        self.minus = _StepKey(b, "−", self.dec, k)
        self.minus.pack(side="left")
        frame(b, bg="hair_s", width=1).pack(side="left", fill="y")
        box = frame(b, width=px(52 + 9 * max(3, width - 1)), height=k)
        box.pack(side="left")
        box.pack_propagate(False)
        mid = frame(box)
        mid.place(relx=0.5, rely=0.5, anchor="center")
        var = tk.StringVar()
        entry = tk.Entry(mid, textvariable=var, width=max(3, width - 1), font=F["entryN"], justify="center", bd=0,
                         relief="flat", highlightthickness=0, bg=C["sheet"], fg=C["ink"], insertbackground=C["ink"],
                         disabledbackground=C["sheet"], disabledforeground=C["slate"],
                         selectbackground=C["gold_soft"], selectforeground=C["ink"])
        entry.pack(side="left", fill="y")
        unit = (suffix or "").strip()
        if unit:
            L(mid, unit, font="small", fg="slate").pack(side="left", padx=(px(2), 0))
        frame(b, bg="hair_s", width=1).pack(side="left", fill="y")
        self.plus = _StepKey(b, "+", self.inc, k)
        self.plus.pack(side="left")
        self.field = _StepField(self, var, entry)
        entry.bind("<FocusIn>", lambda e: self._focus(True), add="+")
        entry.bind("<FocusOut>", lambda e: self._focus(False), add="+")
        self._quiet = False
        if value is not None:
            self.set(value)
        var.trace_add("write", lambda *a: self._changed())

    def _focus(self, on):
        self.focus_on = on
        self._paint()

    def _paint(self):
        if self.error:
            self.set_border("cinnabar", 2)
        elif self.focus_on:
            self.set_border("gold_ink", 2)
        else:
            self.set_border("hair2", 1)

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
        if bool(on) != self.error:
            self.error = bool(on)
            self._paint()


class Mark(tk.Label):
    """A round status mark: ok (jade tick), bad (cinnabar cross), warn (gold !), idle (slate ring), info (slate i).
    quiet=True: the lighter list version."""

    def __init__(self, parent, state="idle", size=20, quiet=False):
        self.size = px(size)
        self.quiet = quiet
        self.state = None
        tk.Label.__init__(self, parent, bg=_bg(parent), bd=0, padx=0, pady=0)
        self.set(state)

    def set(self, state):
        if state != self.state:
            self.state = state
            self.configure(image=mark_image(self.size, state, self.quiet))


class IconBadge(tk.Canvas):
    """A quiet circle with an icon (or a number) in it."""

    def __init__(self, parent, icon=None, size=40, fill=None, ink="slate", text=None, font=None):
        self.size = px(size)
        tk.Canvas.__init__(self, parent, width=self.size, height=self.size, bg=_bg(parent), highlightthickness=0,
                           bd=0)
        self.icon, self.fill, self.ink, self.text = icon, fill or ("well2_s" if on_sheet(parent) else "well2"), ink, text
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
            self.create_text(c, c, text=self.text, font=F["numXS"], fill=col(self.ink))
        elif self.icon and ICON_FONT[0]:
            self.create_text(c, c + px(1), text=GLYPH.get(self.icon, ""), font=F[self.font], fill=col(self.ink))


class NumBadge(tk.Canvas):
    """A step number in a fine-gold ring (website "teach steps")."""

    def __init__(self, parent, n, size=28):
        self.size = px(size)
        tk.Canvas.__init__(self, parent, width=self.size, height=self.size, bg=_bg(parent), highlightthickness=0,
                           bd=0)
        bg = _bg(parent)
        self.create_image(0, 0, image=dot_image(self.size, bg, "gold", max(1.0, SCALE[0])), anchor="nw")
        self.create_text(self.size / 2.0, self.size / 2.0, text=str(n), font=F["numXS"], fill=C["gold_ink"])


class Bar(tk.Canvas):
    """A thin meter (0..1): a well track and a jade / gold / cinnabar fill."""

    def __init__(self, parent, height=4):
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
        round_box(self, 0, 0, w, h, h // 2, "well2_s" if on_sheet(self.master) else "well2")
        if self.frac:
            fw = max(h, int(w * max(0.0, min(1.0, self.frac))))
            round_box(self, 0, 0, fw, h, h // 2, TONE_DOT.get(self.tone, "slate"))


class StepBar(tk.Canvas):
    """The wizard progress, calm and quiet: small numbered circles on a hairline; done = a gold disc with a graphite
    tick, the current step = a fine-gold ring, the rest = slate."""

    def __init__(self, parent, labels, height=58):
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
        d = px(24)
        margin = px(52)
        cy = px(16)
        bg = _bg(self)
        xs = [margin + i * (w - 2 * margin) / float(n - 1) for i in range(n)]
        for i in range(n - 1):
            done = i < self.current
            self.create_line(xs[i] + d / 2 + px(5), cy, xs[i + 1] - d / 2 - px(5), cy,
                             fill=C["gold"] if done else C["hair2"], width=1)
        ring = max(1.2, SCALE[0] * 1.5)
        for i, (x, label) in enumerate(zip(xs, self.labels)):
            if i in self.skipped:
                img, txt, ink = dot_image(d, bg, "hair", ring), "–", "faint"
            elif i < self.current:
                img, txt, ink = dot_image(d, "gold"), None, "ink"
            elif i == self.current:
                img, txt, ink = dot_image(d, "sheet", "gold_ink", ring), str(i + 1), "gold_ink"
            else:
                img, txt, ink = dot_image(d, bg, "hair2", ring), str(i + 1), "slate"
            self.create_image(x - d / 2.0, cy - d / 2.0, image=img, anchor="nw")
            if txt is None:
                t = px(12)
                self.create_image(x - t / 2.0, cy - t / 2.0, anchor="nw", image=images().get(
                    ("tick", t), lambda: gfx.tick_png(t, C["ink"], max(1.5, t * 0.14))))
            else:
                self.create_text(x, cy, text=txt, font=F["numXS"], fill=col(ink))
            lab_ink = "ink" if i == self.current else "faint" if i in self.skipped else \
                "ink" if i < self.current else "slate"
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
    """A callout (info / good / warn / bad) that takes no space while hidden: a tinted panel, graphite text, the
    meaning in the coloured mark only (DESIGN.md: coloured text never sits on a coloured tint)."""

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
        fill = TONE_SOFT[kind]
        if on_sheet(self) and kind in ("info", "idle"):
            fill = "well_s"
        box = Box(self, fill=fill, border=None, radius=12, padx=14, pady=11)
        box.pack(fill="x", pady=self.pady)
        b = box.body
        Mark(b, {"good": "ok"}.get(kind, kind), size=18).pack(side="left", anchor="n", pady=(px(2), 0))
        c = frame(b)
        c.pack(side="left", fill="x", expand=True, padx=(px(10), 0))
        L(c, title, font="bold", fg="ink", wrap=True).pack(fill="x")
        if text:
            L(c, text, font="small", fg="ink", wrap=True).pack(fill="x", pady=(px(1), 0))
        if actions:
            row = frame(c)
            row.pack(fill="x", pady=(px(8), 0))
            for i, (label, cmd) in enumerate(actions):
                Btn(row, label, cmd, style="secondary", size="sm").pack(side="left", padx=(0, px(8)))
        self.box = box


class Expander(tk.Frame):
    """A quiet "title" row with a small chevron that shows / hides .body."""

    def __init__(self, parent, title, sub=None, opened=False, on_toggle=None, fg="ink"):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        self.on_toggle = on_toggle
        self.head = frame(self)
        self.head.pack(fill="x")
        self.chev = glyph(self.head, "chev_r", "iconS", fg="slate")
        self.chev.pack(side="left", padx=(0, px(8)))
        self.title = L(self.head, title, font="bold", fg=fg, cursor="hand2")
        self.title.pack(side="left")
        if sub:
            L(self.head, sub, font="small", fg="slate").pack(side="left", padx=(px(10), 0))
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
    """A group heading (17 semibold) with one plain sentence under it. No icon badges, no eyebrow labels."""
    head = frame(parent)
    head.pack(fill="x", pady=pady)
    c = frame(head)
    c.pack(side="left", fill="x", expand=True)
    L(c, title, font="h3").pack(fill="x")
    if why:
        L(c, why, font="small", fg="slate", wrap=True).pack(fill="x", pady=(px(2), 0))
    return head


def group(parent, title=None, why=None, rule=True, top=22, after=None):
    """A settings / wizard group on porcelain: a hairline, then the heading; returns the group's frame."""
    g = frame(parent)
    kw = {"fill": "x", "pady": (px(top) if rule else 0, 0)}
    if after is not None:
        kw["after"] = after
    g.pack(**kw)
    if rule:
        frame(g, bg=hair_for(g), height=1).pack(fill="x", pady=(0, px(18)))
    if title:
        section(g, title, why)
    return g


class Row(tk.Frame):
    """A grouped row: label (and one sentence) on the left, the control on the right (.ctl); hairline above."""

    def __init__(self, parent, title, sub=None, rule=True, pady=12, font="bold"):
        tk.Frame.__init__(self, parent, bg=_bg(parent), bd=0, highlightthickness=0)
        if rule:
            frame(self, bg=hair_for(self), height=1).pack(fill="x")
        inner = frame(self)
        inner.pack(fill="x", pady=px(pady))
        self.ctl = frame(inner)
        self.ctl.pack(side="right", anchor="center", padx=(px(16), 0))
        self.text = frame(inner)
        self.text.pack(side="left", fill="x", expand=True)
        self.title = L(self.text, title, font=font)
        self.title.pack(fill="x")
        self.sub = None
        if sub:
            self.sub = L(self.text, sub, font="small", fg="slate", wrap=True)
            self.sub.pack(fill="x", pady=(px(1), 0))


class Chip(Box):
    """A small tag. No tone: a hairline outline; a tone: its tint with graphite text and a coloured dot."""

    def __init__(self, parent, text, tone=None, dot=None, font="smed"):
        sheet = on_sheet(parent)
        if tone:
            fill = {"good": "jade_tint", "warn": "gold_tint", "bad": "cinnabar_tint", "gold": "gold_tint",
                    "info": "well2", "idle": "well2"}.get(tone, "well2")
            if sheet and fill == "gold_tint":
                fill = "gold_tint_s"
            if sheet and fill == "well2":
                fill = "well2_s"
            Box.__init__(self, parent, fill=fill, border=None, radius=6, padx=8, pady=1)
        else:
            Box.__init__(self, parent, fill=_bg(parent), border="hair_s" if sheet else "hair", radius=6, padx=8,
                         pady=1)
        dot = dot if dot is not None else (tone in ("good", "bad", "warn", "gold"))
        if dot and tone:
            c = {"good": "jade", "bad": "cinnabar", "warn": "gold_ink", "gold": "gold_ink"}.get(tone, "slate")
            tk.Label(self.body, image=dot_image(px(7), c), bg=self.fill, bd=0).pack(side="left", padx=(0, px(6)))
        self.label = L(self.body, text, font=font, fg="ink")
        self.label.pack(side="left")


def badge(parent, text, tone="info"):
    """A small chip ("แนะนำ", "ใช้อยู่ในเครื่องนี้")."""
    return Chip(parent, text, tone)


def hline(parent, pady=8):
    f = frame(parent, bg=hair_for(parent), height=1)
    f.pack(fill="x", pady=px(pady))
    return f


# ---------------------------------------------------------------------------------------------------------------------
# The hallmark
# ---------------------------------------------------------------------------------------------------------------------
STAMP_INK = {"gold": "engrave", "slate": "slate", "cinnabar": "cinnabar"}


class Hallmark(tk.Canvas):
    """The stamp struck into a gold bar: a rounded octagon with a double engraved outline, "Dobby" and the state.
    tone gold = trading live (a struck gold plate), slate = stopped / not live, cinnabar = waiting for MT5 / offline /
    error (both an ink impression, outline only)."""

    def __init__(self, parent, size=92, tone="gold", state="", label="Dobby"):
        self.n = px(size)
        tk.Canvas.__init__(self, parent, width=self.n, height=self.n, bg=_bg(parent), highlightthickness=0, bd=0)
        self.tone, self.state, self.label = None, None, label
        self.set(tone, state)

    def set(self, tone, state=""):
        tone = tone if tone in STAMP_INK else "slate"
        if (tone, state) == (self.tone, self.state):
            return
        self.tone, self.state = tone, state
        self.redraw()

    def redraw(self):
        self.delete("all")
        n, k = self.n, self.n / 120.0
        tone, state = self.tone, self.state
        ink = col(STAMP_INK[tone])
        img = images().get(("stamp", n, tone, bool(state)),
                           lambda: gfx.stamp_png(n, tone, None if tone == "gold" else ink, rule=bool(state)))
        self.create_image(0, 0, image=img, anchor="nw")
        wf = font("bold", max(9, 23 * k / SCALE[0]))
        wbase = (58 if state else 68) * k
        desc = tkfont.Font(font=wf).metrics("descent")
        if tone == "gold":
            self.create_text(n / 2.0, wbase + desc + max(1.0, 0.9 * k), text=self.label, font=wf,
                             fill=C["gold_shine"], anchor="s")
        self.create_text(n / 2.0, wbase + desc, text=self.label, font=wf, fill=ink, anchor="s")
        if state:
            sf = font("semi", max(8, 13.5 * k / SCALE[0]))
            sdesc = tkfont.Font(font=sf).metrics("descent")
            self.create_text(n / 2.0, 86 * k + sdesc, text=state, font=sf, fill=ink, anchor="s")


class BrandMark(tk.Canvas):
    """The small brand mark: the gold plate with one engraved ring and a "D" (header logo)."""

    def __init__(self, parent, size=26):
        n = self.n = px(size)
        tk.Canvas.__init__(self, parent, width=n, height=n, bg=_bg(parent), highlightthickness=0, bd=0)
        self.create_image(0, 0, anchor="nw", image=images().get(("brand", n), lambda: gfx.brand_png(n)))
        f = font("nums", max(8, 14 * n / 32.0 / SCALE[0]))
        desc = tkfont.Font(font=f).metrics("descent")
        self.create_text(n / 2.0, 21.3 * n / 32.0 + desc, text="D", font=f, fill=C["engrave"], anchor="s")


# ---------------------------------------------------------------------------------------------------------------------
# The 24 h gold price line (main screen hero)
# ---------------------------------------------------------------------------------------------------------------------
NICE_STEPS = (0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000)


def _nice_step(lo, hi, want=3):
    """The largest round step that still puts `want` grid lines between lo and hi."""
    import math
    for s in reversed(NICE_STEPS):
        if math.floor(hi / s) - math.floor(lo / s) >= want:
            return s
    return NICE_STEPS[0]


class PriceLine(tk.Canvas):
    """XAUUSD M15 closes of the last 24 h (from the EA's dobby2_bars.csv) as one graphite line with the VWAP dashed,
    the current price as a dot and a tag; the price grid on the right; local times and the broker's new day under it
    when the server offset is known (else no time axis). marks: open trades [(utc, price, "buy" | "sell")]."""

    def __init__(self, parent, height=150):
        self.full_h = px(height)
        tk.Canvas.__init__(self, parent, height=px(56), bg=_bg(parent), highlightthickness=0, bd=0)
        self.bars, self.offset, self.marks, self.empty_text = None, None, (), ""
        self._key = None
        self._after = None
        self.bind("<Configure>", lambda e: self._schedule())

    def _schedule(self):
        if self._after is not None:
            try:
                self.after_cancel(self._after)
            except tk.TclError:
                pass
        self._after = self.after(40, self.redraw)

    def set(self, bars, offset_min=None, marks=(), empty_text=""):
        self.bars, self.offset, self.marks, self.empty_text = bars, offset_min, tuple(marks), empty_text
        h = self.full_h if self.points >= 2 else px(56)
        if int(self.cget("height")) != h:
            self.configure(height=h)
        self.redraw()

    @property
    def points(self):
        return len((self.bars or {}).get("c") or [])

    def redraw(self):
        self._after = None
        w, h = self.winfo_width(), self.winfo_height()
        bars = self.bars or {}
        ts, cs = list(bars.get("t") or []), list(bars.get("c") or [])
        key = (w, h, tuple(ts[-2:]), tuple(cs[-2:]), len(cs), self.offset, self.marks, self.empty_text)
        if key == self._key:
            return
        self._key = key
        self.delete("all")
        if w < 80 or h < 30:
            return
        if len(cs) < 2:
            self.create_line(px(2), h / 2.0, w - px(2), h / 2.0, fill=C["hair_s"], dash=(2, 4))
            t = self.empty_text or "กราฟราคาทอง 24 ชั่วโมงจะขึ้นเมื่อ Dobby ใน MT5 เขียนไฟล์ราคา"
            tw = tkfont.Font(font=F["small"]).measure(t)
            self.create_rectangle(w / 2.0 - tw / 2.0 - px(12), h / 2.0 - px(12), w / 2.0 + tw / 2.0 + px(12),
                                  h / 2.0 + px(12), fill=_bg(self), outline="")
            self.create_text(w / 2.0, h / 2.0, text=t, font=F["small"], fill=C["slate"])
            return
        vw = [v for v in (bars.get("vwap") or []) if v]
        has_time = self.offset is not None
        right = px(70)
        top, bottom = px(22) if has_time else px(8), (px(26) if has_time else px(8))
        x0, x1, y0, y1 = px(2), w - right, top, h - bottom
        lo = min(cs + vw + [m[1] for m in self.marks])
        hi = max(cs + vw + [m[1] for m in self.marks])
        span = max(hi - lo, 1.0)
        lo, hi = lo - span * 0.08, hi + span * 0.08
        t0, t1 = ts[0], ts[-1]

        def X(t):
            return x0 + (x1 - x0) * (t - t0) / float(max(1, t1 - t0))

        def Y(p):
            return y1 - (p - lo) * (y1 - y0) / float(hi - lo)
        sheet = _bg(self)
        hair = C["hair_s"] if sheet.upper() == C["sheet"] else C["hair"]
        step = _nice_step(lo, hi)
        g = (int(lo / step) + 1) * step
        last_y = Y(cs[-1])
        while g < hi:
            y = Y(g)
            self.create_line(x0, y, x1, y, fill=hair)
            if abs(y - last_y) > px(14):
                lab = format(g, ",.0f") if step >= 1 else format(g, ",.1f")
                self.create_text(x1 + px(12), y, text=lab, anchor="w", font=F["numT"], fill=C["slate"])
            g += step
        if has_time:
            off = int(self.offset) * 60
            prev = None
            for t in ts:
                day = time.gmtime(t + off)[:3]
                if prev is not None and day != prev:
                    x = X(t)
                    self.create_line(x, y0 - px(6), x, y1, fill=C["hair2_s"], dash=(2, 4))
                    self.create_text(x + px(4), px(2), text="วันใหม่ของโบรก", anchor="nw", font=F["small"],
                                     fill=C["slate"])
                prev = day
            for t in ts:
                lt = time.localtime(t)
                if lt.tm_min == 0 and lt.tm_hour % 6 == 0 and x0 + px(16) < X(t) < x1 - px(16):
                    self.create_text(X(t), h - px(4), text="%02d:00" % lt.tm_hour, anchor="s", font=F["numT"],
                                     fill=C["slate"])
        runs, run, prev_day = [], [], None        # the EA's VWAP restarts each broker day: one dashed run per day
        steps = [abs(b - a) for a, b in zip(cs, cs[1:])]
        jump = 4.0 * (sorted(steps)[len(steps) // 2] if steps else 1.0) + 0.5
        for i, (t, v) in enumerate(zip(ts, bars.get("vwap") or [])):
            day = time.gmtime(t + int(self.offset) * 60)[:3] if has_time else None
            new_day = (day != prev_day) if has_time else (bool(run) and abs(v - run[-1][2]) > jump if v else False)
            if not v or (run and new_day):
                if len(run) > 1:
                    runs.append(run)
                run = []
            if v:
                run.append((X(t), Y(v), v))
            prev_day = day
        if len(run) > 1:
            runs.append(run)
        for run in runs:
            self.create_line(*[c for p in run for c in p[:2]], fill=mix(C["slate"], sheet, .45), width=1,
                             dash=(4, 4))
        pts = [(X(t) - x0 + px(2), Y(c) - y0 + px(2)) for t, c in zip(ts, cs)]
        lw, lh = int(x1 - x0) + px(4), int(y1 - y0) + px(4)
        img = images().get(("pline", lw, lh, tuple(ts), tuple(cs)),
                           lambda: gfx.polyline_png(lw, lh, pts, max(1.7, 1.7 * SCALE[0]), C["ink"]))
        if len(images().cache) > 400:
            images().cache = dict((k, v) for k, v in images().cache.items() if k[0] != "pline")
        self.create_image(x0 - px(2), y0 - px(2), image=img, anchor="nw")
        for t, price, side in self.marks:
            if t0 <= t <= t1:
                s = px(12)
                up = side == "buy"
                im = images().get(("tri", s, up), lambda: gfx.tri_png(s, up, C["jade"] if up else C["cinnabar"],
                                                                     sheet))
                self.create_image(X(t) - s / 2.0, Y(price) - s / 2.0, image=im, anchor="nw")
        lx, ly = X(ts[-1]), last_y
        halo = px(18)
        self.create_image(lx - halo / 2.0, ly - halo / 2.0, anchor="nw", image=dot_image(halo, mix(C["ink"], sheet, .1)))
        dot = px(9)
        self.create_image(lx - dot / 2.0, ly - dot / 2.0, anchor="nw", image=dot_image(dot, "ink", sheet, 1.5))
        tag = num_text(cs[-1])
        tf = F["numT"]
        tw = tkfont.Font(font=tf).measure(tag)
        bx1 = x1 + px(6)
        round_box(self, bx1, ly - px(11), bx1 + tw + px(14), ly + px(11), px(6), "ink")
        self.create_text(bx1 + px(7), ly, text=tag, anchor="w", font=font("nums", 12), fill=C["bg"])


# ---------------------------------------------------------------------------------------------------------------------
# The lock-stage ladder (settings): price levels from TP down to the original SL, like the website
# ---------------------------------------------------------------------------------------------------------------------
def pct_label(x):
    try:
        return ("%g" % float(x)) + "%"
    except (TypeError, ValueError):
        return "-"


class Ladder(tk.Canvas):
    """TP, the triggers and the new SLs of the profit lock, the entry and the original SL on one rail."""
    ROW = 30

    def __init__(self, parent):
        tk.Canvas.__init__(self, parent, height=px(self.ROW * 6), bg=_bg(parent), highlightthickness=0, bd=0)
        self.rows = []
        self.bind("<Configure>", lambda e: self.redraw())

    def set(self, stages, at, to, a1, t1):
        rows = [("100%", "tp", "TP", "ปิดไม้ที่กำไรเต็ม")]
        st = []
        if stages >= 1 and at is not None and to is not None:
            st.append((float(at), 1, ("%s" % pct_label(at), "at", "ชั้นใกล้ TP" if stages >= 2 else "ชั้นล็อก",
                                      "เมื่อกำไรวิ่งมาถึง %s" % pct_label(at))))
            st.append((float(to), 0, ("%s" % pct_label(to), "to", "SL ใหม่ %s" % pct_label(to),
                                      "ราคากลับลงมาก็ยังได้กำไรราวนี้")))
        if stages >= 2 and a1 is not None and t1 is not None:
            st.append((float(a1), 1, ("%s" % pct_label(a1), "at", "ชั้นแรก", "เมื่อกำไรวิ่งมาถึง %s" % pct_label(a1))))
            st.append((float(t1), 0, ("%s" % pct_label(t1), "to", "SL ใหม่ %s" % pct_label(t1),
                                      "ราคากลับลงมาก็ยังได้กำไรราวนี้")))
        rows += [r for _, _, r in sorted(st, key=lambda x: (-x[0], -x[1]))]
        rows.append(("", "gap", "", ""))
        rows.append(("0%", "entry", "ราคาเข้า", ""))
        rows.append(("SL", "sl", "SL เดิม", "ขาดทุนเต็มถ้าราคาไม่ถึงชั้นแรก" if st else
                     "ไม่ล็อก: ปล่อยให้ราคาถึง TP หรือ SL"))
        if rows != self.rows:
            self.rows = rows
            self.configure(height=self._height())
            self.redraw()

    def _height(self):
        return sum(px(14) if k == "gap" else px(self.ROW) for _, k, _, _ in self.rows) + px(8)

    def redraw(self):
        self.delete("all")
        if not self.rows:
            return
        bg = _bg(self)
        xr = px(70)                 # the rail
        y = px(4)
        ys = []
        for _, kind, _, _ in self.rows:
            hh = px(14) if kind == "gap" else px(self.ROW)
            ys.append((y, y + hh / 2.0, y + hh, kind))
            y += hh
        entry_i = [i for i, r in enumerate(self.rows) if r[1] == "entry"][0]
        gap_i = entry_i - 1
        safe, risk = mix(C["jade"], bg, .55), mix(C["cinnabar"], bg, .45)
        self.create_line(xr, ys[0][1], xr, ys[gap_i][0], fill=safe, width=2)
        self.create_line(xr, ys[gap_i][0], xr, ys[gap_i][2], fill=C["hair2"], width=2, dash=(3, 4))
        self.create_line(xr, ys[entry_i][1], xr, ys[-1][1], fill=risk, width=2)
        tf, sf, nf = F["small"], F["sbold"], F["numXS"]
        mf = tkfont.Font(font=sf)
        for (label, kind, strong, text), (ya, yc, yb, _) in zip(self.rows, ys):
            if kind == "gap":
                continue
            self.create_text(xr - px(22), yc, text=label, anchor="e", font=nf, fill=C["slate"])
            if kind in ("tp", "sl"):
                d = px(12)
                self.create_image(xr - d / 2.0, yc - d / 2.0, anchor="nw", image=dot_image(
                    d, "jade" if kind == "tp" else "cinnabar"))
            elif kind == "entry":
                self.create_rectangle(xr - px(7), yc - px(2), xr + px(7), yc + px(2), fill=C["ink"], outline="")
            elif kind == "at":
                d = px(12)
                self.create_image(xr - d / 2.0, yc - d / 2.0, anchor="nw", image=images().get(
                    ("diamond", d, bg), lambda: gfx.diamond_png(d, C["gold_ink"], bg, max(1.4, 1.6 * SCALE[0]))))
            elif kind == "to":
                round_box(self, xr - px(9), yc - px(3), xr + px(9), yc + px(3), px(3), "gold")
            x = xr + px(22)
            if strong:
                self.create_text(x, yc, text=strong, anchor="w", font=sf, fill=C["gold_ink"] if kind == "to"
                                 else C["ink"])
                x += mf.measure(strong) + px(6)
            if text:
                self.create_text(x, yc, text=text, anchor="w", font=tf, fill=C["slate"])


# ---------------------------------------------------------------------------------------------------------------------
# Small pictures for the manual MT5 steps
# ---------------------------------------------------------------------------------------------------------------------
def draw_picture(cv, key, w, h):
    """Simple pictograms: open, navigator, drag, load, allow, algo."""
    cv.delete("all")
    m = px(3)
    round_box(cv, m, m, w - m, h - m, px(8), "sheet", "hair2", 1)
    round_box(cv, m, m, w - m, m + px(10), px(8), "well2_s")
    cv.create_rectangle(m + 1, m + px(7), w - m - 1, m + px(10), fill=C["well2_s"], outline="", width=0)
    x0, y0, x1, y1 = m + px(6), m + px(15), w - m - px(6), h - m - px(6)
    if key == "open":
        pts = [x0, y1 - px(6), x0 + (x1 - x0) * 0.25, y1 - px(14), x0 + (x1 - x0) * 0.5, y1 - px(9),
               x0 + (x1 - x0) * 0.75, y1 - px(20), x1, y1 - px(16)]
        cv.create_line(*pts, fill=C["ink"], width=max(2, px(2)), smooth=True)
        cv.create_text(x0, y0 + px(4), text="MT5", anchor="w", font=F["tbold"], fill=C["ink"])
    elif key == "navigator":
        for i in range(3):
            cv.create_rectangle(x0, y0 + i * px(9), x0 + px(28) - i * px(4), y0 + i * px(9) + px(4),
                                fill=C["hair2_s"], outline="", width=0)
        if ICON_FONT[0]:
            cv.create_text(x1 - px(8), (y0 + y1) / 2.0, text=GLYPH["refresh"], font=F["iconM"], fill=C["gold_ink"])
    elif key == "drag":
        for i, (up, hh) in enumerate([(1, 12), (0, 16), (1, 10), (1, 18)]):
            cx = x0 + px(4) + i * px(8)
            cv.create_rectangle(cx, y1 - px(hh), cx + px(5), y1, fill=C["jade"] if up else C["cinnabar"],
                                outline="", width=0)
        if ICON_FONT[0]:
            cv.create_text(x1 - px(7), y0 + px(5), text=GLYPH["robot"], font=F["iconS"], fill=C["gold_ink"])
            cv.create_text(x1 - px(21), y0 + px(17), text=GLYPH["back"], font=F["iconS"], fill=C["ink"])
    elif key == "load":
        for i in range(2):
            cv.create_rectangle(x0, y0 + i * px(8), x1 - px(30), y0 + i * px(8) + px(4), fill=C["hair2_s"],
                                outline="", width=0)
        round_box(cv, x1 - px(30), y1 - px(14), x1, y1, px(5), "gold")
        cv.create_text(x1 - px(15), y1 - px(7), text="Load", font=F["tbold"], fill=C["ink"])
    elif key == "allow":
        cy = (y0 + y1) / 2.0
        sz = px(16)
        cv.create_image(x0, cy - sz / 2.0, image=images().get(("checkbox", sz), lambda: gfx.checkbox_png(
            sz, C["jade"])), anchor="nw")
        cv.create_rectangle(x0 + px(22), cy - px(2), x1, cy + px(2), fill=C["hair2_s"], outline="", width=0)
        cv.create_text(x0 + px(22), cy - px(9), text="Allow", anchor="w", font=F["tiny"], fill=C["ink"])
    elif key == "algo":
        round_box(cv, x0, y0 + px(2), x1, y1, px(8), "jade")
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
    """The illustrated "ทำเองใน MT5" list: gold step number, picture, title, detail; hairlines between steps."""
    box = frame(parent)
    for i, (key, title, text) in enumerate(steps):
        if i:
            frame(box, bg=hair_for(box), height=1).pack(fill="x")
        r = frame(box)
        r.pack(fill="x", pady=px(10))
        NumBadge(r, i + 1, size=26).pack(side="left", anchor="n", pady=(px(14), 0))
        Picture(r, key).pack(side="left", padx=(px(12), px(14)))
        c = frame(r)
        c.pack(side="left", fill="x", expand=True)
        L(c, title, font="bold").pack(fill="x", pady=(px(6), 0))
        L(c, text, font="small", fg="slate", wrap=True).pack(fill="x")
    return box


# ---------------------------------------------------------------------------------------------------------------------
# Dialogs
# ---------------------------------------------------------------------------------------------------------------------
class ChoiceDialog(object):
    """A modal question with clearly labelled buttons on the white sheet. choices: [(value, label, btn style)].
    extra(body) may add content (lists, pictures) under the text."""

    def __init__(self, ui, title, text, choices, kind="warn", extra=None, width=520):
        self.ui, self.value = ui, None
        top = self.top = tk.Toplevel(ui.root)
        top.withdraw()
        top.title(title)
        top.configure(bg=C["sheet"])
        top.resizable(False, False)
        top.transient(ui.root)
        try:
            top.iconphoto(False, ui.icon64)
        except tk.TclError:
            pass
        body = frame(top, bg="sheet")
        body.pack(fill="both", expand=True, padx=px(26), pady=(px(22), px(20)))
        head = frame(body)
        head.pack(fill="x")
        Mark(head, {"good": "ok"}.get(kind, kind), size=22).pack(side="left", anchor="n", pady=(px(5), 0))
        L(head, title, font="h2", wrap=width - 100).pack(side="left", fill="x", expand=True, padx=(px(12), 0))
        c = frame(body)
        c.pack(fill="x", padx=(px(34), 0))
        if text:
            L(c, text, font="base", fg="ink", wrap=width - 100).pack(fill="x", pady=(px(8), 0))
        if extra is not None:
            extra(c)
        frame(body, bg="hair_s", height=1).pack(fill="x", pady=(px(20), 0))
        row = frame(body)
        row.pack(fill="x", pady=(px(16), 0))
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
        r.pack(fill="x", pady=(0, px(6)))
        t = px(16)
        tk.Label(r, image=images().get(("tick", t, "jade"), lambda: gfx.tick_png(t, C["jade"])), bg=_bg(r),
                 bd=0).pack(side="left", anchor="n", pady=(px(4), 0))
        L(r, text, font="base", fg="ink", wrap=True).pack(side="left", fill="x", expand=True, padx=(px(10), 0))
    return box
