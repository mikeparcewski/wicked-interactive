// Garden council/jam → wi-content mapper.
// Reads a wicked-garden council TRANSCRIPT and maps it to wi-content sections.
//
// Why the transcript: garden's council is agent-orchestrated and prose-first. The
// structured {synthesized, raw_votes} envelope is returned to the parent agent
// in-memory and never persisted; the only reliably-written, id-addressable council
// artifact on disk is the transcript JSON (garden scripts/jam/save_transcript.py).
//
// Resolution protocol (v0.1) — garden persists transcripts under its DomainStore:
//   <root>/projects/<slug>/wicked-jam/transcripts/<session_id>.json
//   root = $WICKED_GARDEN_PATH or ~/.something-wicked/wicked-garden
//   slug = <cwd-basename lower, spaces→-, [:32]>-<sha256(realpath(cwd))[:8]>
// Because the artifact may be generated from a different cwd than the council run,
// resolution scans every project rather than trusting the local cwd's slug:
//   1. exact id  → first matching projects/*/wicked-jam/transcripts/<id>.json
//   2. no id / "latest" → newest transcripts/*.json by mtime across all projects
//   3. not found → graceful "content pending" stub (mirrors from-crew).

import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/** The council's 4-question scaffold labels (garden skills/jam-council/SKILL.md). */
const SCAFFOLD = [
  { key: 'recommendation', re: /^\s*(?:#+\s*|\**\s*)?(?:1[.)]\s*)?RECOMMENDATION\b[:\s]*/im },
  { key: 'topRisk', re: /^\s*(?:#+\s*|\**\s*)?(?:2[.)]\s*)?TOP RISK\b[:\s]*/im },
  { key: 'changeMind', re: /^\s*(?:#+\s*|\**\s*)?(?:3[.)]\s*)?WHAT WOULD CHANGE YOUR MIND\b[:\s]*/im },
  { key: 'disqualifier', re: /^\s*(?:#+\s*|\**\s*)?(?:4[.)]\s*)?DISQUALIFIER\b[:\s]*/im },
];

/** Garden's project-slug scheme (scripts/_paths.py::_get_project_slug). */
function projectSlug() {
  const cwd = process.env.CLAUDE_CWD || process.cwd();
  let resolved;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = resolve(cwd);
  }
  const base = (resolved.split(/[\\/]/).pop() || 'project')
    .toLowerCase().replace(/ /g, '-').slice(0, 32);
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/** Garden DomainStore data root. */
function gardenRoot() {
  const override = process.env.WICKED_GARDEN_PATH;
  if (override) {
    // Accept either the data root, the projects dir, or a transcripts dir directly.
    if (existsSync(join(override, 'projects'))) return override;
    return override;
  }
  return join(homedir(), '.something-wicked', 'wicked-garden');
}

/** List every projects/<slug>/wicked-jam/transcripts dir under the garden root. */
function transcriptDirs(root) {
  const dirs = [];
  // If WICKED_GARDEN_PATH points straight at a transcripts dir, use it as-is.
  if (existsSync(join(root, 'projects'))) {
    const projectsDir = join(root, 'projects');
    let slugs = [];
    try { slugs = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
    // Prefer the current cwd's slug first (fast path), then all others.
    const mine = projectSlug();
    const ordered = [mine, ...slugs.filter((s) => s !== mine)];
    for (const slug of ordered) {
      const t = join(projectsDir, slug, 'wicked-jam', 'transcripts');
      if (existsSync(t)) dirs.push(t);
    }
  } else {
    // root itself may be a transcripts dir (or a project dir).
    const asProject = join(root, 'wicked-jam', 'transcripts');
    if (existsSync(asProject)) dirs.push(asProject);
    else if (existsSync(root)) dirs.push(root);
  }
  return dirs;
}

/**
 * Locate a council transcript by session_id (or newest if id is falsy / "latest").
 * @param {string|undefined} sessionId
 * @returns {{ path: string, data: object } | null}
 */
function findTranscript(sessionId) {
  const root = gardenRoot();
  const dirs = transcriptDirs(root);
  const wantLatest = !sessionId || sessionId === 'latest';

  let newest = null; // { path, mtime }
  for (const dir of dirs) {
    if (!wantLatest) {
      const p = join(dir, `${sessionId}.json`);
      if (existsSync(p)) return readTranscript(p);
      continue;
    }
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      let mtime = 0;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
    }
  }
  return newest ? readTranscript(newest.path) : null;
}

function readTranscript(p) {
  const abs = resolve(p);
  try {
    return { path: abs, data: JSON.parse(readFileSync(abs, 'utf8')) };
  } catch (e) {
    throw new Error(`malformed council transcript — JSON parse failed at ${abs}: ${e.message}`);
  }
}

/** Pull the recommended-option / verdict line out of the synthesis prose. */
function extractVerdict(synthesisText) {
  if (!synthesisText) return null;
  // Prefer an explicit "## Verdict" section.
  const lines = synthesisText.split('\n');
  let inVerdict = false;
  const body = [];
  for (const line of lines) {
    if (/^#{1,6}\s*verdict\b/i.test(line)) { inVerdict = true; continue; }
    if (inVerdict && /^#{1,6}\s/.test(line)) break; // next heading ends the section
    if (inVerdict) body.push(line);
  }
  let text = body.join('\n').trim();
  if (!text) {
    // Fall back to the canonical verdict sentence anywhere in the prose.
    const m = synthesisText.match(/^.*\b(?:Council recommends|No consensus)\b.*$/im);
    text = m ? m[0].trim() : '';
  }
  return text || null;
}

/** Split a model's raw response into the 4 scaffold answers (best-effort). */
function extractModelAnswers(rawText) {
  if (!rawText) return {};
  const out = {};
  const hits = [];
  for (const { key, re } of SCAFFOLD) {
    const m = re.exec(rawText);
    if (m) hits.push({ key, start: m.index, contentStart: m.index + m[0].length });
  }
  hits.sort((a, b) => a.contentStart - b.contentStart);
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1].start : rawText.length;
    out[hits[i].key] = rawText.slice(hits[i].contentStart, end).trim();
  }
  return out;
}

/** First heading text from the synthesis prose, for the artifact title. */
function extractTitle(synthesisText, sessionId) {
  if (synthesisText) {
    const m = synthesisText.match(/^#{1,6}\s+(.*\S)\s*$/m);
    if (m) return m[1].replace(/^council evaluation:\s*/i, '').trim() || m[1].trim();
  }
  return `Council — ${sessionId}`;
}

/**
 * Map a garden council transcript to wi-content sections.
 * @param {object} transcript — { session_id, entries: [...] }
 * @returns {{ title: string, sections: object[] }}
 */
function transcriptToSections(transcript) {
  const entries = Array.isArray(transcript.entries) ? transcript.entries : [];
  const sessionId = transcript.session_id || transcript.id || 'session';
  const councilResponses = entries.filter((e) => e.entry_type === 'council_response');
  const synthesis = entries.find((e) => e.entry_type === 'synthesis');
  const synthText = synthesis ? synthesis.raw_text : '';

  const title = extractTitle(synthText, sessionId);
  const verdict = extractVerdict(synthText);
  const noConsensus = /no consensus/i.test(verdict || synthText || '');
  const sections = [];

  sections.push({
    type: 'header',
    content: {
      title,
      subtitle: 'Multi-model council verdict',
      tags: [
        `${councilResponses.length} model${councilResponses.length === 1 ? '' : 's'}`,
        noConsensus ? 'no consensus' : (verdict ? 'consensus' : null),
      ].filter(Boolean),
    },
  });

  if (noConsensus) {
    sections.push({
      type: 'callout',
      content: { level: 'warn', text: 'The council did not reach consensus — the models disagree; treat the options below as live alternatives.' },
    });
  }

  if (verdict) {
    sections.push({ type: 'recommendation', content: { text: verdict, priority: 'high', rationale: 'Synthesized from the council verdict.' } });
  }

  // Per-model panel — one card per model.
  if (councilResponses.length > 0) {
    sections.push({
      type: 'card-grid',
      content: {
        cards: councilResponses.map((e) => {
          const a = extractModelAnswers(e.raw_text);
          const bodyParts = [];
          if (a.recommendation) bodyParts.push(a.recommendation);
          if (a.topRisk) bodyParts.push(`Top risk: ${a.topRisk}`);
          const body = bodyParts.join('\n\n').trim() || (e.raw_text || '').trim().slice(0, 400);
          return {
            title: e.persona_name || 'model',
            body,
            badge: a.disqualifier ? 'has disqualifier' : '',
          };
        }),
      },
    });
  }

  // Drill-down: full synthesis prose as evidence.
  if (synthText) {
    sections.push({
      type: 'evidence',
      content: { items: [{ label: 'Council synthesis', value: synthText.trim() }] },
    });
  }

  if (sections.length === 1) {
    // Only a header — surface the raw material so the artifact isn't empty.
    sections.push({ type: 'summary', content: { text: 'The council transcript contained no synthesis or model responses to render.' } });
  }

  return { title, sections };
}

/** "Content pending" stub when no transcript resolves (mirrors from-crew). */
function pendingArtifact(sessionId) {
  const label = sessionId && sessionId !== 'latest' ? sessionId : '(latest)';
  return {
    title: `Council Session — ${label}`,
    sections: [
      { type: 'header', content: { title: `Council Session — ${label}`, subtitle: 'wicked-garden council', tags: ['pending'] } },
      {
        type: 'callout',
        content: {
          level: 'warn',
          text: `Content pending — no council transcript found for "${label}". Run a wicked-garden council (jam council) to completion, then re-generate this artifact.`,
        },
      },
      {
        type: 'summary',
        content: {
          text: 'This artifact was generated with no council output available. Transcripts are written under ~/.something-wicked/wicked-garden/projects/<slug>/wicked-jam/transcripts/. Re-run wicked-interactive create --from-garden <session_id> once the council has completed.',
        },
      },
    ],
  };
}

/**
 * Map a garden council session to a wi-content object.
 * @param {string} [sessionId] — the council session_id; falsy / "latest" → newest transcript.
 * @returns {{ title: string, sections: object[], sessionId: string, sessionFound: boolean }}
 */
export async function gardenCouncilToWiContent(sessionId) {
  const found = findTranscript(sessionId);

  if (!found) {
    const stub = pendingArtifact(sessionId);
    return { title: stub.title, sections: stub.sections, sessionId: sessionId || 'latest', sessionFound: false };
  }

  const mapped = transcriptToSections(found.data);
  const resolvedId = found.data.session_id || found.data.id || sessionId || 'latest';
  return { title: mapped.title, sections: mapped.sections, sessionId: resolvedId, sessionFound: true };
}
