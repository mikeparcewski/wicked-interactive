#!/usr/bin/env python3
"""html_to_pptx.py — build a native, editable PowerPoint from a wicked-interactive version's
HTML (ADR-0020, the absorbed prezzie export capability).

Structure-based, not pixel-based: each <section> becomes a slide; the first heading is the
slide title; paragraphs and list items become the body; cards/sub-headings become bold lead
lines. This is robust and dependency-light (stdlib html.parser + python-pptx only — no Chrome
geometry extraction, no BeautifulSoup), and produces a clean deck a user can edit in PowerPoint.

Usage:  python3 html_to_pptx.py <input.html> <output.pptx> [theme.json]
"""

import sys
import json
import re
from html.parser import HTMLParser
from html import unescape

from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR


HEADINGS = {"h1", "h2", "h3", "h4"}
# Block elements we turn into content. Inline tags (b/span/strong/em/a/code) are ignored for
# structure — their text simply flows into the enclosing block via handle_data.
BLOCKS = HEADINGS | {"p", "li"}


class SlideParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.slides = []        # [{"title": str|None, "blocks": [("head"|"para"|"bullet", text)]}]
        self.cur = None         # current slide dict
        self.cap_tag = None     # the block tag currently being captured
        self.cap_kind = None    # "head" | "para" | "bullet"
        self.buf = []           # text fragments for the current capture

    def _new_slide(self):
        self.cur = {"title": None, "blocks": []}
        self.slides.append(self.cur)

    def _ensure_slide(self):
        if self.cur is None:
            self._new_slide()

    def handle_starttag(self, tag, attrs):
        if tag == "section":
            self._finalize()
            self._new_slide()
            return
        if tag in BLOCKS and self.cap_tag is None:
            self._ensure_slide()
            self.cap_tag = tag
            self.cap_kind = "head" if tag in HEADINGS else ("bullet" if tag == "li" else "para")
            self.buf = []

    def handle_data(self, data):
        if self.cap_tag is not None:
            self.buf.append(data)

    def handle_endtag(self, tag):
        if tag == self.cap_tag:
            self._finalize()

    def _finalize(self):
        if self.cap_tag is None:
            return
        text = re.sub(r"\s+", " ", "".join(self.buf)).strip()
        self.buf = []
        kind, self.cap_tag, self.cap_kind = self.cap_kind, None, None
        if not text or self.cur is None:
            return
        if kind == "head" and self.cur["title"] is None:
            self.cur["title"] = unescape(text)
        else:
            self.cur["blocks"].append((kind, unescape(text)))

    def result(self):
        self._finalize()
        # Drop slides with no title AND no content (e.g. a stray wrapper section).
        return [s for s in self.slides if s["title"] or s["blocks"]]


def _rgb(hex_str, fallback):
    try:
        return RGBColor.from_string(str(hex_str).lstrip("#")[:6])
    except Exception:
        return RGBColor.from_string(fallback)


def load_theme(path):
    colors, fonts = {}, {}
    if path:
        try:
            with open(path, "r", encoding="utf-8") as f:
                t = json.load(f)
            colors = t.get("colors", {}) or {}
            fonts = t.get("fonts", {}) or {}
        except Exception:
            pass
    return {
        "bg": _rgb(colors.get("background", "#FFFFFF"), "FFFFFF"),
        "primary": _rgb(colors.get("primary", "#1E3A5F"), "1E3A5F"),
        "accent": _rgb(colors.get("accent", "#0891B2"), "0891B2"),
        "text": _rgb(colors.get("text_primary", "#1E293B"), "1E293B"),
        "heading_font": fonts.get("heading", "Calibri"),
        "body_font": fonts.get("body", "Calibri"),
    }


def build(html, out_path, theme):
    parser = SlideParser()
    parser.feed(html)
    slides = parser.result()
    if not slides:
        slides = [{"title": "Untitled", "blocks": []}]

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    blank = prs.slide_layouts[6]

    for slide in slides:
        s = prs.slides.add_slide(blank)
        s.background.fill.solid()
        s.background.fill.fore_color.rgb = theme["bg"]

        # Title
        title_box = s.shapes.add_textbox(Inches(0.6), Inches(0.45), Inches(12.13), Inches(1.2))
        tf = title_box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.text = slide["title"] or ""
        run = p.runs[0] if p.runs else p.add_run()
        run.font.size = Pt(34)
        run.font.bold = True
        run.font.color.rgb = theme["primary"]
        run.font.name = theme["heading_font"]

        # Body
        body_box = s.shapes.add_textbox(Inches(0.6), Inches(1.85), Inches(12.13), Inches(5.2))
        bf = body_box.text_frame
        bf.word_wrap = True
        bf.vertical_anchor = MSO_ANCHOR.TOP
        first = True
        for kind, text in slide["blocks"]:
            para = bf.paragraphs[0] if first else bf.add_paragraph()
            first = False
            if kind == "bullet":
                para.text = f"•  {text}"
                para.level = 1
            elif kind == "head":
                para.text = text
            else:
                para.text = text
            para.space_after = Pt(8)
            r = para.runs[0] if para.runs else para.add_run()
            r.font.name = theme["body_font"]
            if kind == "head":
                r.font.size = Pt(22)
                r.font.bold = True
                r.font.color.rgb = theme["accent"]
            else:
                r.font.size = Pt(18)
                r.font.color.rgb = theme["text"]

    prs.save(out_path)
    return len(slides)


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: html_to_pptx.py <input.html> <output.pptx> [theme.json]\n")
        return 2
    in_path, out_path = argv[1], argv[2]
    theme_path = argv[3] if len(argv) > 3 else None
    with open(in_path, "r", encoding="utf-8") as f:
        html = f.read()
    n = build(html, out_path, load_theme(theme_path))
    sys.stdout.write(json.dumps({"ok": True, "slides": n, "out": out_path}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
