# -*- coding: utf-8 -*-
"""Dobby App graphics without Pillow: a tiny anti-aliased rasteriser (signed distance fields, one sample per pixel)
that draws rounded-box corners, dots, rings, switch tracks, small marks, the hallmark stamp, soft sheet shadows and
the price line as RGBA PNG bytes for Tk PhotoImages.

Shapes are functions sd(x, y) -> signed distance in pixels (negative inside). Coverage = clamp(0.5 - sd, 0, 1), which
gives a smooth one-pixel edge. Everything here is pure Python and testable without a window."""
import math

import dobby_app_core as core


def hex_rgb(c):
    c = c.lstrip("#")
    return (int(c[0:2], 16) / 255.0, int(c[2:4], 16) / 255.0, int(c[4:6], 16) / 255.0)


def mix(a, b, t):
    """Colour a over b at opacity t ("#rrggbb" in and out): the opaque colour a translucent paint gives on b."""
    ra, ga, ba = hex_rgb(a)
    rb, gb, bb = hex_rgb(b)
    return "#%02X%02X%02X" % tuple(int(round((y + (x - y) * t) * 255)) for x, y in ((ra, rb), (ga, gb), (ba, bb)))


# -- signed distance functions ----------------------------------------------------------------------------------------
def sd_circle(cx, cy, r):
    return lambda x, y: math.hypot(x - cx, y - cy) - r


def sd_ring(cx, cy, r, w):
    return lambda x, y: abs(math.hypot(x - cx, y - cy) - r) - w / 2.0


def _seg(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def sd_polyline(points, w):
    segs = list(zip(points[:-1], points[1:]))

    def f(x, y):
        return min(_seg(x, y, a[0], a[1], b[0], b[1]) for a, b in segs) - w / 2.0
    return f


def sd_rrect(x1, y1, x2, y2, r):
    cx, cy, hw, hh = (x1 + x2) / 2.0, (y1 + y2) / 2.0, (x2 - x1) / 2.0, (y2 - y1) / 2.0
    r = max(0.0, min(r, hw, hh))

    def f(x, y):
        qx = abs(x - cx) - (hw - r)
        qy = abs(y - cy) - (hh - r)
        return math.hypot(max(qx, 0.0), max(qy, 0.0)) + min(max(qx, qy), 0.0) - r
    return f


_OK = (-0.9238795325, 0.3826834323, 0.4142135623)


def sd_octagon(cx, cy, s, r):
    """The hallmark plate: a regular octagon with flat sides, inside a square of side s, corners rounded by r."""
    a = s / 2.0 - r                       # apothem of the inner (sharp) octagon
    kx, ky, kz = _OK

    def f(x, y):
        px_, py_ = abs(x - cx), abs(y - cy)
        d = min(kx * px_ + ky * py_, 0.0)
        px_, py_ = px_ - 2.0 * d * kx, py_ - 2.0 * d * ky
        d = min(-kx * px_ + ky * py_, 0.0)
        px_, py_ = px_ + 2.0 * d * kx, py_ - 2.0 * d * ky
        qx = px_ - max(-kz * a, min(kz * a, px_))
        qy = py_ - a
        return math.hypot(qx, qy) * (1.0 if qy >= 0 else -1.0) - r
    return f


def sd_outline(sd, w):
    """A stroke of width w along the edge of another shape."""
    return lambda x, y: abs(sd(x, y)) - w / 2.0


def sd_poly(points):
    n = len(points)

    def f(x, y):
        inside = False
        d = 1e9
        j = n - 1
        for i in range(n):
            xi, yi = points[i]
            xj, yj = points[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / float(yj - yi) + xi:
                inside = not inside
            d = min(d, _seg(x, y, xi, yi, xj, yj))
            j = i
        return -d if inside else d
    return f


class Raster(object):
    """Premultiplied RGBA float buffer; draw() composites a shape "over" what is there."""

    def __init__(self, w, h):
        self.w, self.h = int(w), int(h)
        self.buf = [0.0] * (self.w * self.h * 4)

    def draw(self, sd, color, bbox=None, opacity=1.0):
        """Composite a shape. color: "#rrggbb", an (r, g, b) tuple of 0..1 floats, or a function (x, y) -> such a
        tuple (gradients)."""
        shade = color if callable(color) else None
        if shade is None:
            r, g, b = hex_rgb(color) if isinstance(color, str) else color
        x0, y0, x1, y1 = bbox or (0, 0, self.w, self.h)
        x0, y0 = max(0, int(math.floor(x0))), max(0, int(math.floor(y0)))
        x1, y1 = min(self.w, int(math.ceil(x1))), min(self.h, int(math.ceil(y1)))
        buf, w = self.buf, self.w
        for y in range(y0, y1):
            py = y + 0.5
            row = y * w
            for x in range(x0, x1):
                a = 0.5 - sd(x + 0.5, py)
                if a <= 0.0:
                    continue
                if a > 1.0:
                    a = 1.0
                a *= opacity
                if shade is not None:
                    r, g, b = shade(x + 0.5, py)
                k = (row + x) * 4
                ia = 1.0 - a
                buf[k] = r * a + buf[k] * ia
                buf[k + 1] = g * a + buf[k + 1] * ia
                buf[k + 2] = b * a + buf[k + 2] * ia
                buf[k + 3] = a + buf[k + 3] * ia
        return self

    def rgba(self):
        out = bytearray(self.w * self.h * 4)
        buf = self.buf
        for i in range(self.w * self.h):
            k = i * 4
            a = buf[k + 3]
            if a <= 0.0:
                continue
            out[k] = min(255, int(round(buf[k] / a * 255)))
            out[k + 1] = min(255, int(round(buf[k + 1] / a * 255)))
            out[k + 2] = min(255, int(round(buf[k + 2] / a * 255)))
            out[k + 3] = min(255, int(round(a * 255)))
        return bytes(out)

    def png(self):
        return core.png_bytes(self.w, self.h, self.rgba())


# -- the images the UI uses ---------------------------------------------------------------------------------------------
def corner_png(r, fill, border=None, bw=1, which="tl"):
    """One r x r corner of a rounded box (transparent outside the curve)."""
    r = int(r)
    cx, cy = {"tl": (r, r), "tr": (0, r), "bl": (r, 0), "br": (0, 0)}[which]
    img = Raster(r, r)
    if border and bw > 0:
        img.draw(sd_circle(cx, cy, r), border)
        img.draw(sd_circle(cx, cy, r - bw), fill)
    else:
        img.draw(sd_circle(cx, cy, r), fill)
    return img.png()


def dot_png(size, fill, ring=None, ring_w=1.5):
    """A filled circle (optionally with a ring in another colour)."""
    img = Raster(size, size)
    c = size / 2.0
    if ring:
        img.draw(sd_circle(c, c, c - 0.5), ring)
        img.draw(sd_circle(c, c, c - 0.5 - ring_w), fill)
    else:
        img.draw(sd_circle(c, c, c - 0.5), fill)
    return img.png()


def pill_png(w, h, fill, border=None, bw=1):
    img = Raster(w, h)
    if border and bw > 0:
        img.draw(sd_rrect(0, 0, w, h, h / 2.0), border)
        img.draw(sd_rrect(bw, bw, w - bw, h - bw, h / 2.0 - bw), fill)
    else:
        img.draw(sd_rrect(0, 0, w, h, h / 2.0), fill)
    return img.png()


def knob_png(d, fill="#FFFFFF", shadow="#28241A"):
    """Switch knob with a soft shadow below it."""
    img = Raster(d + 2, d + 3)
    c = d / 2.0 + 1
    img.draw(sd_circle(c, c + 1.2, d / 2.0 - 0.3), shadow, opacity=0.18)
    img.draw(sd_circle(c, c, d / 2.0 - 0.5), fill)
    return img.png()


def mark_png(size, kind, fill, ink="#FFFFFF"):
    """Status mark: a filled circle with a tick (ok), a cross (bad), "!" (warn), a dot (idle) or "i" (info)."""
    img = Raster(size, size)
    s = float(size)
    c = s / 2.0
    w = max(1.6, s * 0.11)
    if kind == "idle":
        img.draw(sd_ring(c, c, c - 0.5 - w / 2.0, w), fill)
        img.draw(sd_circle(c, c, s * 0.12), fill)
        return img.png()
    img.draw(sd_circle(c, c, c - 0.5), fill)
    if kind == "ok":
        img.draw(sd_polyline([(s * 0.29, s * 0.52), (s * 0.44, s * 0.66), (s * 0.71, s * 0.37)], w), ink)
    elif kind == "bad":
        img.draw(sd_polyline([(s * 0.35, s * 0.35), (s * 0.65, s * 0.65)], w), ink)
        img.draw(sd_polyline([(s * 0.65, s * 0.35), (s * 0.35, s * 0.65)], w), ink)
    elif kind == "warn":
        img.draw(sd_polyline([(c, s * 0.27), (c, s * 0.56)], w), ink)
        img.draw(sd_circle(c, s * 0.72, w * 0.62), ink)
    elif kind == "info":
        img.draw(sd_circle(c, s * 0.30, w * 0.62), ink)
        img.draw(sd_polyline([(c, s * 0.45), (c, s * 0.73)], w), ink)
    elif kind == "play":
        img.draw(sd_poly([(s * 0.39, s * 0.30), (s * 0.72, s * 0.5), (s * 0.39, s * 0.70)]), ink)
    elif kind == "stop":
        img.draw(sd_rrect(s * 0.34, s * 0.34, s * 0.66, s * 0.66, s * 0.04), ink)
    elif kind == "pause":
        img.draw(sd_rrect(s * 0.35, s * 0.31, s * 0.45, s * 0.69, s * 0.02), ink)
        img.draw(sd_rrect(s * 0.55, s * 0.31, s * 0.65, s * 0.69, s * 0.02), ink)
    elif kind == "dot":
        img.draw(sd_circle(c, c, s * 0.16), ink)
    return img.png()


def checkbox_png(size, fill, ink="#FFFFFF"):
    """A ticked check box (rounded square with a white tick)."""
    img = Raster(size, size)
    s = float(size)
    img.draw(sd_rrect(0.5, 0.5, s - 0.5, s - 0.5, s * 0.22), fill)
    img.draw(sd_polyline([(s * 0.27, s * 0.52), (s * 0.43, s * 0.68), (s * 0.73, s * 0.34)], max(1.6, s * 0.12)), ink)
    return img.png()


def rrect_png(w, h, r, fill, border=None, bw=1):
    """A whole small rounded box (for tiny fixed-size items such as segmented-control thumbs)."""
    img = Raster(w, h)
    if border and bw > 0:
        img.draw(sd_rrect(0, 0, w, h, r), border)
        img.draw(sd_rrect(bw, bw, w - bw, h - bw, r - bw), fill)
    else:
        img.draw(sd_rrect(0, 0, w, h, r), fill)
    return img.png()


# -- the hallmark (DESIGN.md "Hallmark"; geometry of docs/js/hallmark.js, viewBox 120) -----------------------------------
GOLD_STOPS = ((0.0, "#EDD58F"), (0.48, "#D4AE52"), (1.0, "#A8822C"))   # gold-hi, gold, gold-lo
ENGRAVE = "#6B4E10"
_TAN = math.tan(math.pi / 8)       # a corner cut r along each edge = a circular corner of radius r / tan(22.5 deg)


def _gradient(stops, x0, y0, size):
    cols = [(t, hex_rgb(c)) for t, c in stops]

    def shade(x, y):
        t = max(0.0, min(1.0, ((x - x0) + (y - y0)) / (2.0 * size)))
        for (ta, ca), (tb, cb) in zip(cols, cols[1:]):
            if t <= tb:
                u = (t - ta) / (tb - ta) if tb > ta else 0.0
                return tuple(ca[i] + (cb[i] - ca[i]) * u for i in range(3))
        return cols[-1][1]
    return shade


def stamp_png(size, tone="gold", ink=None, rule=True):
    """The hallmark plate at `size` px: a rounded octagon with a double engraved outline (and the short rule between
    the word and the state). tone gold = a struck gold plate with the faint sheen (trading live); any other tone = an
    ink impression, outline only, in the colour `ink` (slate: stopped, cinnabar: waiting / offline / error).
    The words are drawn by Tk on top (Anuphan)."""
    n = int(size)
    k = n / 120.0
    img = Raster(n, n)
    c = n / 2.0
    gold = tone == "gold"
    outer = sd_octagon(c, c, 114 * k, 13 * k / _TAN)
    ring1 = sd_octagon(c, c, 101 * k, 10 * k / _TAN)
    ring2 = sd_octagon(c, c, 92 * k, 8.5 * k / _TAN)
    if gold:
        drop = max(1.0, n / 92.0)
        img.draw(sd_octagon(c, c + drop, 114 * k, 13 * k / _TAN), "#5A400A", opacity=0.25)
        img.draw(outer, _gradient(GOLD_STOPS, 3 * k, 3 * k, 114 * k))
        line = ENGRAVE
        img.draw(sd_outline(ring1, max(0.9, 1.6 * k)), line, opacity=0.62)
        img.draw(sd_outline(ring2, max(0.7, 0.9 * k)), line, opacity=0.62)
        if rule:
            img.draw(sd_rrect(44 * k, 68 * k, 76 * k, 68 * k + max(1.0, k), 0), line, opacity=0.45)
    else:
        line = ink or "#5E676D"
        img.draw(outer, line, opacity=0.07 if tone != "cinnabar" else 0.06)
        img.draw(sd_outline(ring1, max(1.2, 2.2 * k)), line)
        img.draw(sd_outline(ring2, max(0.8, 1.1 * k)), line, opacity=0.55)
        if rule:
            img.draw(sd_rrect(44 * k, 68 * k, 76 * k, 68 * k + max(1.0, k), 0), line)
    return img.png()


def brand_png(size, fill="#D4AE52"):
    """The small brand mark (header, window icon): the gold plate with one engraved ring; the "D" is Tk text."""
    n = int(size)
    k = n / 32.0
    img = Raster(n, n)
    c = n / 2.0
    img.draw(sd_octagon(c, c, 28 * k, 4.2 * k / _TAN), _gradient(GOLD_STOPS, 2 * k, 2 * k, 28 * k)
             if n >= 40 else fill)
    img.draw(sd_outline(sd_octagon(c, c, 22.8 * k, 3.2 * k / _TAN), max(0.8, 1.1 * k)), ENGRAVE, opacity=0.8)
    return img.png()


# -- the hero sheet's soft, low shadow --------------------------------------------------------------------------------
def shadow_alpha(d, sigma, alpha):
    """Opacity of a blurred box shadow at signed distance d (px, positive outside the shadow's box)."""
    return alpha * 0.5 * math.erfc(d / (sigma * 1.4142135623))


def shadow_corner_png(rs, ext, sigma, alpha, which, shadow, bg):
    """One opaque corner piece (ext + rs square, the background `bg` baked in) of a blurred rounded-box shadow whose
    corner radius is rs; `ext` is how far the shadow reaches outside its box."""
    s = int(ext + rs)
    img = Raster(s, s)
    sr, sg, sb = hex_rgb(shadow)
    br, bg_, bb = hex_rgb(bg)
    cx = float(s) if which in ("tl", "bl") else 0.0          # the corner circle's centre in piece coordinates
    cy = float(s) if which in ("tl", "tr") else 0.0
    buf = img.buf
    for y in range(s):
        for x in range(s):
            qx = (cx - x - 0.5) if which in ("tl", "bl") else (x + 0.5 - cx)
            qy = (cy - y - 0.5) if which in ("tl", "tr") else (y + 0.5 - cy)
            d = math.hypot(max(qx, 0.0), max(qy, 0.0)) - rs
            a = shadow_alpha(d, sigma, alpha)
            k = (y * s + x) * 4
            buf[k], buf[k + 1], buf[k + 2], buf[k + 3] = br + (sr - br) * a, bg_ + (sg - bg_) * a, bb + (sb - bb) * a, 1.0
    return img.png()


# -- the price line ---------------------------------------------------------------------------------------------------
def polyline_png(w, h, points, width, color):
    """An anti-aliased polyline (round joins) as a w x h PNG, transparent elsewhere. Coverage is the max over the
    segments (no darker joints); each segment only visits its own bounding box, so long lines stay fast."""
    w, h = int(w), int(h)
    cov = [0.0] * (w * h)
    half = width / 2.0
    for (ax, ay), (bx, by) in zip(points[:-1], points[1:]):
        x0 = max(0, int(math.floor(min(ax, bx) - half - 1)))
        x1 = min(w, int(math.ceil(max(ax, bx) + half + 1)))
        y0 = max(0, int(math.floor(min(ay, by) - half - 1)))
        y1 = min(h, int(math.ceil(max(ay, by) + half + 1)))
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        for y in range(y0, y1):
            py = y + 0.5
            row = y * w
            for x in range(x0, x1):
                pxx = x + 0.5
                t = 0.0 if L == 0 else ((pxx - ax) * dx + (py - ay) * dy) / L
                t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
                a = 0.5 + half - math.hypot(pxx - (ax + t * dx), py - (ay + t * dy))
                if a > 0.0:
                    if a > 1.0:
                        a = 1.0
                    if a > cov[row + x]:
                        cov[row + x] = a
    r, g, b = (int(v * 255) for v in hex_rgb(color))
    out = bytearray(w * h * 4)
    for i, a in enumerate(cov):
        if a > 0.0:
            k = i * 4
            out[k], out[k + 1], out[k + 2], out[k + 3] = r, g, b, int(a * 255 + 0.5)
    return core.png_bytes(w, h, bytes(out))


def tri_png(size, up, fill, ring="#FFFFFF"):
    """A trade mark on the price line: a small triangle (up = buy, down = sell) with a thin halo."""
    img = Raster(size, size)
    s = float(size)
    pts = [(s * 0.5, s * 0.16), (s * 0.88, s * 0.80), (s * 0.12, s * 0.80)] if up else \
        [(s * 0.12, s * 0.20), (s * 0.88, s * 0.20), (s * 0.5, s * 0.84)]
    tri = sd_poly(pts)
    img.draw(lambda x, y: tri(x, y) - 1.4, ring)
    img.draw(tri, fill)
    return img.png()


def diamond_png(size, color, fill="#FFFFFF", bw=1.6):
    """The ladder's trigger mark: a small diamond outline."""
    img = Raster(size, size)
    c = size / 2.0
    r = c - 1.0
    dia = sd_poly([(c, c - r), (c + r, c), (c, c + r), (c - r, c)])
    img.draw(dia, color)
    img.draw(lambda x, y: dia(x, y) + bw, fill)
    return img.png()


def tick_png(size, color, w=None):
    """A bare tick (the quiet "ok" mark of lists)."""
    img = Raster(size, size)
    s = float(size)
    img.draw(sd_polyline([(s * 0.18, s * 0.53), (s * 0.40, s * 0.74), (s * 0.82, s * 0.30)], w or max(1.6, s * 0.13)),
             color)
    return img.png()
