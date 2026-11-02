#!/usr/bin/env python3
"""生成 PWA 应用图标（与 favicon.svg 同款设计：玉青环点）。
运行：python3 tools/make-icons.py
"""
from PIL import Image, ImageDraw
import os

BG = (13, 21, 18, 255)       # #0d1512
GREEN = (55, 214, 160, 255)  # #37d6a0
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")


def draw_motif(d, s, scale=1.0):
    """在 s×s 画布上画"穴位环点"主图形，scale 控制占比。"""
    c = s / 2
    ring_r = 0.265 * s * scale
    ring_w = max(2, round(0.062 * s * scale))
    dot_r = 0.094 * s * scale
    hole_r = 0.037 * s * scale
    d.ellipse([c - ring_r, c - ring_r, c + ring_r, c + ring_r], outline=GREEN, width=ring_w)
    d.ellipse([c - dot_r, c - dot_r, c + dot_r, c + dot_r], fill=GREEN)
    d.ellipse([c - hole_r, c - hole_r, c + hole_r, c + hole_r], fill=BG)


def make(size, path, *, full_bleed=False, radius_ratio=0.22, motif_scale=1.0):
    SS = 4  # 超采样抗锯齿
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if full_bleed:
        d.rectangle([0, 0, S, S], fill=BG)
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=round(S * radius_ratio), fill=BG)
    draw_motif(d, S, motif_scale)
    img = img.resize((size, size), Image.LANCZOS)
    img.save(path)
    print("✓", os.path.basename(path), f"{size}x{size}")


os.makedirs(OUT, exist_ok=True)
make(192, os.path.join(OUT, "icon-192.png"))
make(512, os.path.join(OUT, "icon-512.png"))
make(512, os.path.join(OUT, "icon-maskable-512.png"), full_bleed=True, motif_scale=0.72)  # 安全区
make(180, os.path.join(OUT, "apple-touch-icon.png"), full_bleed=True, motif_scale=1.15)   # iOS 不透明
print("图标生成完毕 →", os.path.abspath(OUT))
