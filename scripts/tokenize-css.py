#!/usr/bin/env python3
"""One-shot refactor: replace literal colors in globals.css with design tokens.

Run once. Every literal that was scattered through the stylesheet becomes a
`var(--token)`, so a theme is a block of custom-property overrides rather than a
copy of the stylesheet.
"""
import re
import sys
from pathlib import Path

CSS = Path("app/globals.css")
text = CSS.read_text()

# --- literal hex -> token -------------------------------------------------
HEX = {
    "#f4f1ea": "var(--paper)",
    "#fcfbf8": "var(--surface-2)",
    "#f7f6f2": "var(--surface-3)",
    "#eef3f5": "var(--surface-4)",
    "#e6e7e4": "var(--surface-5)",
    "#fff0eb": "var(--red-soft)",
    "#842f21": "var(--red-ink)",
    "#44a766": "var(--ok)",
    "#3b444c": "var(--ink-soft)",
    "#98a0a8": "var(--muted-2)",
    "#9da6af": "var(--muted-2)",
    "#a7aaa9": "var(--line-strong)",
    "#9aa0a4": "var(--line-strong)",
    "#cfd5d8": "var(--line-soft)",
    "#b8bcc0": "var(--shadow-flat)",
    "#667079": "var(--muted)",
    "#202832": "var(--panel-3)",
    "#303a44": "var(--panel-4)",
    "#252e38": "var(--panel-5)",
    "#35404c": "var(--panel-line)",
    "#37414c": "var(--panel-line)",
    "#2f3944": "var(--panel-line-2)",
    "#18212a": "var(--panel-2)",
    "#7b8691": "var(--panel-muted)",
    "#909aa4": "var(--panel-muted)",
    "#8e99a4": "var(--panel-muted)",
    "#79838d": "var(--panel-muted)",
    "#a1aab3": "var(--panel-muted-2)",
    "#27313b": "var(--lens-1)",
    "#141c24": "var(--lens-2)",
}

# --- literal rgba -> color-mix on a token --------------------------------
RGBA = {
    "rgba(17, 24, 32, 0.027)": "color-mix(in srgb, var(--ink) 2.7%, transparent)",
    "rgba(17, 24, 32, 0.017)": "color-mix(in srgb, var(--ink) 1.7%, transparent)",
    "rgba(17, 24, 32, 0.72)": "color-mix(in srgb, var(--ink) 72%, transparent)",
    "rgba(255, 255, 255, 0.55)": "color-mix(in srgb, var(--surface) 55%, transparent)",
    "rgba(255, 255, 255, 0.92)": "color-mix(in srgb, var(--surface) 92%, transparent)",
    "rgba(255, 255, 255, 0.035)": "color-mix(in srgb, var(--panel-fg) 3.5%, transparent)",
    "rgba(255, 255, 255, 0.35)": "color-mix(in srgb, var(--panel-fg) 35%, transparent)",
    "rgba(231, 255, 84, 0.35)": "color-mix(in srgb, var(--signal) 35%, transparent)",
    "rgba(231, 255, 84, 0.2)": "color-mix(in srgb, var(--signal) 20%, transparent)",
    "rgba(231, 255, 84, 0.18)": "color-mix(in srgb, var(--signal) 18%, transparent)",
    "rgba(231, 255, 84, 0.15)": "color-mix(in srgb, var(--signal) 15%, transparent)",
    "rgba(231, 255, 84, 0.12)": "color-mix(in srgb, var(--signal) 12%, transparent)",
    "rgba(231, 255, 84, 0)": "color-mix(in srgb, var(--signal) 0%, transparent)",
    "rgba(68, 167, 102, 0.13)": "color-mix(in srgb, var(--ok) 13%, transparent)",
    "rgba(47, 109, 255, 0.07)": "color-mix(in srgb, var(--blue) 7%, transparent)",
}

lines = text.split("\n")
out = []
for i, line in enumerate(lines, start=1):
    # Leave the :root token declarations themselves alone (lines up to the
    # closing brace of the first :root block) — they are rewritten wholesale.
    if i < 40:
        out.append(line)
        continue
    for lit, tok in RGBA.items():
        line = line.replace(lit, tok)
    # #111820 is both the ink colour and a dark panel background.
    line = line.replace("background: #111820", "background: var(--panel)")
    line = line.replace("#111820", "var(--ink)")
    for lit, tok in HEX.items():
        line = line.replace(lit, tok)
        line = line.replace(lit.upper(), tok)
    out.append(line)

text = "\n".join(out)

# Dark text on the bright accent must stay dark in every theme.
text = text.replace(
    """.primary-action {
  color: var(--ink);""",
    """.primary-action {
  color: var(--on-signal);""",
)

leftovers = [
    (n, l)
    for n, l in enumerate(text.split("\n"), start=1)
    if n > 40 and re.search(r"#[0-9a-fA-F]{3,6}\b|rgba\(", l)
]
CSS.write_text(text)
print(f"rewrote {CSS}")
if leftovers:
    print("REMAINING LITERALS:")
    for n, l in leftovers:
        print(f"  {n}: {l.strip()}")
    sys.exit(1)
print("no literal colours left outside the token block")
