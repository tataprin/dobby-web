# -*- coding: utf-8 -*-
"""Dobby App graphics without Pillow: a tiny anti-aliased rasteriser (signed distance fields, one sample per pixel)
that draws rounded-box corners, dots, rings, switch tracks and small marks as RGBA PNG bytes for Tk PhotoImages.

Shapes are functions sd(x, y) -> signed distance in pixels (negative inside). Coverage = clamp(0.5 - sd, 0, 1), which
gives a smooth one-pixel edge. Everything here is pure Python and testable without a window."""
import math

import dobby_app_core as core


def hex_rgb(c):
    c = c.lstrip("#")
    return (int(c[0:2], 16) / 255.0, int(c[2:4], 16) / 255.0, int(c[4:6], 16) / 255.0)


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


def knob_png(d, fill="#FFFFFF", shadow="#0F172A"):
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
