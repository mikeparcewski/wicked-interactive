// Crew session → wi-content mapper.
// Reads crew session artifacts and produces a wi-content JSON object.
//
// Resolution protocol (v0.1):
//   1. Try ~/.wicked-crew/sessions/<id>/session.json
//   2. Try {cwd}/.wicked-crew/sessions/<id>/session.json
//   3. If WICKED_BUS_PATH is set, try its parent dir / .wicked-crew/sessions/<id>/session.json
//   4. Graceful degradation: if nothing found, produce a "content pending" minimal artifact.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Locate the session.json for a given session_id.
 * @param {string} sessionId
 * @returns {{ path: string, data: object } | null}
 */
function findSessionJson(sessionId) {
  const candidates = [
    join(homedir(), '.wicked-crew', 'sessions', sessionId, 'session.json'),
    join(process.cwd(), '.wicked-crew', 'sessions', sessionId, 'session.json'),
  ];

  if (process.env.WICKED_BUS_PATH) {
    // WICKED_BUS_PATH is typically the path to the bus DB file; walk up to find .wicked-crew
    const busDir = dirname(process.env.WICKED_BUS_PATH);
    candidates.push(join(busDir, '..', '.wicked-crew', 'sessions', sessionId, 'session.json'));
    candidates.push(join(busDir, '.wicked-crew', 'sessions', sessionId, 'session.json'));
  }

  for (const candidate of candidates) {
    const abs = resolve(candidate);
    if (existsSync(abs)) {
      try {
        const data = JSON.parse(readFileSync(abs, 'utf8'));
        return { path: abs, data };
      } catch (e) {
        throw new Error(`malformed session checkpoint — JSON parse failed at ${abs}: ${e.message}`);
      }
    }
  }
  return null;
}

/**
 * Try to read the crew output artifact (JSON or Markdown) from the output directory.
 * @param {string} sessionDir — directory containing the session
 * @returns {object | string | null}
 */
function readOutputArtifact(sessionDir) {
  const outputDir = join(sessionDir, 'output');
  const artifactsDir = join(sessionDir, 'artifacts');
  const dirs = [outputDir, artifactsDir];

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    // Try common output file names
    const candidates = [
      'convergence-report.json', 'convergence.json', 'output.json',
      'report.json', 'analysis.json', 'brief.json', 'debrief.json',
      'convergence-report.md', 'report.md', 'output.md', 'debrief.md',
    ];
    for (const name of candidates) {
      const p = join(dir, name);
      if (existsSync(p)) {
        const raw = readFileSync(p, 'utf8');
        if (name.endsWith('.json')) {
          try { return { format: 'json', data: JSON.parse(raw) }; } catch { /* skip */ }
        } else {
          return { format: 'markdown', data: raw };
        }
      }
    }
  }
  return null;
}

/**
 * Map a brainstorm convergence JSON to wi-content sections.
 */
function mapBrainstorm(session, output) {
  const d = output?.data || {};
  const sections = [];

  sections.push({
    type: 'header',
    content: {
      title: d.problem || `Brainstorm — ${session.brief_id || session.session_id || 'session'}`,
      subtitle: d.convergence_summary ? null : 'Brainstorm convergence output',
      tags: d.ccs_score != null ? [`CCS: ${(d.ccs_score * 100).toFixed(0)}%`] : [],
    },
  });

  if (d.convergence_summary) {
    sections.push({ type: 'summary', content: { text: d.convergence_summary } });
  }

  if (d.forced) {
    sections.push({
      type: 'callout',
      content: { level: 'warn', text: 'Convergence was forced after maximum iterations' },
    });
  }

  if (Array.isArray(d.ranked_ideas) && d.ranked_ideas.length > 0) {
    sections.push({
      type: 'card-grid',
      content: {
        cards: d.ranked_ideas.map((idea) => ({
          title: idea.title || '(untitled)',
          body: idea.rationale || '',
          badge: [
            idea.feasibility,
            idea.impact_score != null ? `impact ${(idea.impact_score * 100).toFixed(0)}%` : null,
          ].filter(Boolean).join(' · '),
        })),
      },
    });
  }

  if (d.top_recommendation) {
    sections.push({
      type: 'recommendation',
      content: {
        text: d.top_recommendation.title || d.top_recommendation,
        priority: 'high',
        rationale: d.top_recommendation.rationale || '',
      },
    });
  }

  return sections;
}

/**
 * Map an analysis Markdown report to wi-content sections.
 */
function mapAnalysis(markdownText) {
  const lines = markdownText.split('\n');
  const sections = [];
  let title = 'Analysis Report';
  let currentHeading = null;
  let currentBody = [];

  const flushSection = () => {
    if (!currentHeading) return;
    const text = currentBody.join('\n').trim();
    if (!text) return;
    const lh = currentHeading.toLowerCase();
    if (lh.includes('executive summary')) {
      sections.push({ type: 'summary', content: { text } });
    } else if (lh.includes('recommendation')) {
      sections.push({ type: 'recommendation', content: { text, priority: 'medium', rationale: '' } });
    } else if (lh.includes('evidence')) {
      sections.push({ type: 'evidence', content: { items: [{ label: currentHeading, value: text }] } });
    } else {
      sections.push({ type: 'summary', content: { text } });
    }
    currentBody = [];
  };

  for (const line of lines) {
    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
      sections.unshift({ type: 'header', content: { title, tags: [] } });
    } else if (line.startsWith('## ')) {
      flushSection();
      currentHeading = line.slice(3).trim();
    } else {
      if (currentHeading) currentBody.push(line);
    }
  }
  flushSection();

  if (!sections.some((s) => s.type === 'header')) {
    sections.unshift({ type: 'header', content: { title, tags: [] } });
  }

  return { title, sections };
}

/**
 * Produce a minimal "content pending" artifact for when the session cannot be resolved.
 */
function pendingArtifact(sessionId, crewType) {
  return {
    title: `Crew Session — ${sessionId}`,
    sections: [
      {
        type: 'header',
        content: {
          title: `Crew Session — ${sessionId}`,
          subtitle: crewType ? `Crew type: ${crewType}` : 'Interactive artifact',
          tags: ['pending'],
        },
      },
      {
        type: 'callout',
        content: {
          level: 'warn',
          text: `Content pending — crew session artifacts for "${sessionId}" were not found. Run the crew session to completion and re-generate this artifact.`,
        },
      },
      {
        type: 'summary',
        content: {
          text: 'This artifact was generated with no crew output available. The session_id and crew_type have been captured. Re-run wicked-interactive create --from-crew once the crew has completed.',
          bullets: [`session_id: ${sessionId}`, crewType ? `crew_type: ${crewType}` : ''].filter(Boolean),
        },
      },
    ],
  };
}

/**
 * Map a crew session to a wi-content object.
 * @param {string} sessionId
 * @returns {{ title: string, sections: object[], crewType: string | null, sessionFound: boolean }}
 */
export async function crewToWiContent(sessionId) {
  // SC-WI-015: WICKED_BUS_PATH is required — hard exit, not graceful degradation.
  const busPath = process.env.WICKED_BUS_PATH;
  if (!busPath) {
    process.stderr.write('Error: WICKED_BUS_PATH is not set. Set it to the path of your wicked-bus database file.\n');
    process.exit(1);
  }

  const found = findSessionJson(sessionId);

  if (!found) {
    // v0.1 graceful degradation
    const stub = pendingArtifact(sessionId, null);
    return {
      title: stub.title,
      sections: stub.sections,
      crewType: null,
      sessionFound: false,
    };
  }

  const { path: sessionPath, data: session } = found;
  const sessionDir = dirname(sessionPath);
  const crewType = session.crew_type || null;
  const output = readOutputArtifact(sessionDir);

  let title = `${crewType || 'Crew'} — ${sessionId}`;
  let sections = [];

  if (!output) {
    // Session found but no output artifact yet
    const stub = pendingArtifact(sessionId, crewType);
    return {
      title: stub.title,
      sections: stub.sections,
      crewType,
      sessionFound: true,
    };
  }

  if (crewType === 'brainstorm' || (output.format === 'json' && output.data?.crew_type === 'brainstorm')) {
    title = output.data?.problem || title;
    sections = mapBrainstorm(session, output);
  } else if (output.format === 'markdown') {
    const parsed = mapAnalysis(output.data);
    title = parsed.title || title;
    sections = parsed.sections;
  } else if (output.format === 'json') {
    // Generic JSON mapping — produce a summary section with key fields
    title = output.data?.title || output.data?.brief_id || title;
    sections = [
      {
        type: 'header',
        content: { title, tags: [crewType].filter(Boolean) },
      },
      {
        type: 'summary',
        content: {
          text: `Crew output for session ${sessionId}.`,
          bullets: Object.entries(output.data)
            .filter(([, v]) => typeof v === 'string' && v.length < 200)
            .slice(0, 6)
            .map(([k, v]) => `${k}: ${v}`),
        },
      },
    ];
  }

  return { title, sections, crewType, sessionFound: true };
}
