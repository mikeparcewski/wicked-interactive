#!/usr/bin/env python3
"""html_to_pptx.py — build a native, editable PowerPoint from a wicked-interactive version's
HTML (ADR-0020, the absorbed prezzie export capability).

Structure-based, not pixel-based: each <section> becomes a slide; the first heading is the
slide title; paragraphs and list items become the body; cards/sub-headings become bold lead
lines. A slide's speaker notes (`<aside class="notes" data-notes-for>`, I-D1) go to the slide's notes
page, never onto the slide. This is robust and dependency-light (stdlib html.parser + python-pptx only — no Chrome
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
# Elements with no end tag: never pushed on the open-element stack.
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}


def is_slide_container(tag, attrs):
    """The engine's slide container (core/deck.js SLIDE_SELECTOR): `section`, `[data-slide]`, `.slide`."""
    a = dict(attrs)
    return tag == "section" or "data-slide" in a or "slide" in (a.get("class") or "").split()


class SlideParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.slides = []        # [{"title": str|None, "blocks": [("head"|"para"|"bullet", text)]}]
        self.cur = None         # current slide dict
        self.cap_tag = None     # the block tag currently being captured
        self.cap_kind = None    # "head" | "para" | "bullet"
        self.buf = []           # text fragments for the current capture
        self.notes = None       # text fragments of the speaker notes being read, or None
        self.stack = []         # open elements: (tag, starts_a_top_level_slide)
        self.depth = 0          # open slide containers (a slide is a TOP-LEVEL container only)
        self.notes_depth = 0    # stack depth at which the notes aside opened
        self.notes_owner = None # the slide the notes being read belong to (None: dropped)

    def _new_slide(self, explicit=False):
        # `explicit`: the deck's own slide container — kept even when empty (an inserted blank slide).
        self.cur = {"title": None, "blocks": [], "notes": "", "explicit": explicit}
        self.slides.append(self.cur)

    def _ensure_slide(self):
        if self.cur is None:
            self._new_slide()

    def handle_starttag(self, tag, attrs):
        if self.notes is not None:
            if tag not in VOID:
                self.stack.append((tag, False))
            return
        if tag == "aside" and "data-notes-for" in dict(attrs):
            # A notes aside is never a slide, whatever its class (core/deck.js agrees — codex r3).
            # Outside every slide it belongs to the slide being read, if any; with none it is
            # read and dropped (`notes_owner` None), so it never opens a slide of its own.
            self._finalize()
            self.notes_owner = self.cur
            self.notes = []
            self.stack.append((tag, False))
            self.notes_depth = len(self.stack)
            return
        # A void element is never a slide (it has no content; core/deck.js agrees — codex r2).
        slide = tag not in VOID and is_slide_container(tag, attrs)
        if tag not in VOID:
            self.stack.append((tag, slide))
        if slide:
            self.depth += 1
            if self.depth == 1:
                self._finalize()
                self._new_slide(explicit=True)
            return
        if tag in BLOCKS and self.cap_tag is None:
            self._ensure_slide()
            self.cap_tag = tag
            self.cap_kind = "head" if tag in HEADINGS else ("bullet" if tag == "li" else "para")
            self.buf = []

    def handle_data(self, data):
        if self.notes is not None:
            self.notes.append(data)
            return
        if self.cap_tag is not None:
            self.buf.append(data)

    def _close(self, tag):
        """Pop the open-element stack to `tag` (HTML lets end tags be omitted); False if it is not open."""
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                for _, slide in self.stack[i:]:
                    if slide:
                        self.depth -= 1
                del self.stack[i:]
                return True
        return False

    def handle_endtag(self, tag):
        if self.notes is not None:
            if self._close(tag) and len(self.stack) < self.notes_depth:
                self._end_notes()
            return
        self._close(tag)
        if tag == self.cap_tag:
            self._finalize()

    def _end_notes(self):
        if self.notes_owner is not None:
            self.notes_owner["notes"] = "".join(self.notes).strip()
        self.notes = None
        self.notes_owner = None

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
        if self.notes is not None:  # an aside that never closed: its text is still the notes
            self._end_notes()
        # The deck's own slides are all kept (an inserted slide is blank until it is written);
        # implicit ones (content outside any slide) only when they hold something.
        slides = [s for s in self.slides if s["explicit"] or s["title"] or s["blocks"] or s["notes"]]
        # Once the document has slide containers, the slide count is theirs (core/deck.js topSlides —
        # codex r5). Content after a slide already joins it (`cur` stays set); content BEFORE the first
        # one is the only implicit slide left, and it is folded into that first slide, never dropped.
        first = next((i for i, s in enumerate(slides) if s["explicit"]), None)
        if first:
            lead, e = slides[:first], slides[first]
            # Every heading in reading order; the first becomes the title, the rest stay headings.
            title, blocks = None, []
            for s in lead + [e]:
                if s["title"]:
                    if title is None:
                        title = s["title"]
                    else:
                        blocks.append(("head", s["title"]))
                blocks.extend(s["blocks"])
            e["title"], e["blocks"] = title, blocks
            e["notes"] = "\n".join(n for n in [s["notes"] for s in lead] + [e["notes"]] if n)
            slides = slides[first:]
        return slides


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

        if slide.get("notes"):
            s.notes_slide.notes_text_frame.text = slide["notes"]

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
