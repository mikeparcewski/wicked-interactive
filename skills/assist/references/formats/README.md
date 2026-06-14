# Format craft references

One file per document style. Each file is the authoritative contract for that format — layout
anatomy, typography, animations policy, export constraints, and a quality gate checklist.

| File | Style | Orientation |
|------|-------|-------------|
| `web.md` | Rich scrollable HTML | Responsive |
| `ppt.md` | Slide deck (PPTX export) | Landscape 16:9 |
| `brochure.md` | Print-ready marketing | Landscape 16:9 |
| `doc.md` | Prose document (Word-like) | Portrait, single-column |

**Usage in Step 5:** read `formats/<style>.md` before generating any draft. Its quality gate
runs last — fix any failures before emitting the draft.
