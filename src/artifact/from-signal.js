// Signal → wi-content mapper.
// Calls `wicked-signals status <signal_id> --json` and maps the direct_outcome_payload
// to wi-content sections.

import { spawnSync } from 'node:child_process';

/**
 * Split free-form resolved_text into wi-content sections.
 * Uses heading lines (## ...) as section delimiters; everything else becomes a summary.
 */
function resolvedTextToSections(signalId, signalData, resolvedText) {
  const sections = [];

  // Header from signal metadata
  sections.push({
    type: 'header',
    content: {
      title: signalData.title || `Signal ${signalId}`,
      subtitle: signalData.outcome_type ? `Outcome type: ${signalData.outcome_type}` : 'Direct outcome',
      tags: [
        signalData.classification,
        signalData.confidence != null ? `confidence ${(Number(signalData.confidence) * 100).toFixed(0)}%` : null,
      ].filter(Boolean),
    },
  });

  if (!resolvedText || !resolvedText.trim()) {
    sections.push({
      type: 'summary',
      content: { text: 'No resolved text available for this signal.' },
    });
    return sections;
  }

  const lines = resolvedText.split('\n');
  let currentHeading = null;
  let currentBody = [];

  const flushSection = () => {
    const text = currentBody.join('\n').trim();
    if (!text) { currentBody = []; return; }
    if (!currentHeading) {
      sections.push({ type: 'summary', content: { text } });
    } else {
      const lh = currentHeading.toLowerCase();
      if (lh.includes('recommend')) {
        sections.push({ type: 'recommendation', content: { text, priority: 'medium', rationale: '' } });
      } else if (lh.includes('evidence') || lh.includes('source')) {
        // treat bullet list items as evidence items
        const items = text.split('\n')
          .map((l) => l.replace(/^[-*]\s*/, '').trim())
          .filter(Boolean)
          .map((l) => ({ label: l, value: '' }));
        sections.push({ type: 'evidence', content: { items } });
      } else {
        sections.push({ type: 'summary', content: { text } });
      }
    }
    currentBody = [];
  };

  for (const line of lines) {
    if (line.startsWith('## ')) {
      flushSection();
      currentHeading = line.slice(3).trim();
    } else {
      currentBody.push(line);
    }
  }
  flushSection();

  // Recommended action if present in signal payload
  if (signalData.recommended_action) {
    const ra = signalData.recommended_action;
    const actionText = typeof ra === 'string' ? ra : (ra.summary || JSON.stringify(ra));
    sections.push({
      type: 'recommendation',
      content: {
        text: actionText,
        priority: 'high',
        rationale: ra.type ? `Action type: ${ra.type}` : '',
      },
    });
  }

  return sections;
}

/**
 * Map a signal's direct outcome payload to a wi-content object.
 * @param {string} signalId
 * @returns {{ title: string, sections: object[], signalData: object }}
 * @throws {Error} if the signal is not a direct_outcome or wicked-signals is unavailable
 */
export async function signalToWiContent(signalId) {
  // SC-WI-065: WICKED_SIGNALS_PATH must be set before any subprocess is spawned.
  const signalsPath = process.env.WICKED_SIGNALS_PATH;
  if (!signalsPath) {
    process.stderr.write('Error: WICKED_SIGNALS_PATH is not set.\n');
    process.exit(1);
  }

  // Call wicked-signals status --json
  const result = spawnSync('wicked-signals', ['status', signalId, '--json'], {
    encoding: 'utf8',
    timeout: 15000,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        'wicked-signals is not installed or not in PATH. Install it with: npm install -g wicked-signals',
      );
    }
    throw new Error(`wicked-signals status ${signalId} failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `wicked-signals status ${signalId} failed (exit ${result.status})${stderr ? ': ' + stderr : ''}`,
    );
  }

  let signalData;
  try {
    signalData = JSON.parse(result.stdout);
  } catch (e) {
    throw new Error(`wicked-signals status ${signalId} returned non-JSON output: ${e.message}`);
  }

  // Validate route_target — SC-WI-038: absent or wrong value both fail.
  if (signalData.route_target !== 'direct_outcome') {
    throw new Error(
      `signal ${signalId} does not have route_target: direct_outcome — cannot render as interactive artifact`,
    );
  }

  // Validate direct_outcome_payload
  if (!signalData.direct_outcome_payload) {
    throw new Error(
      `Signal ${signalId} route_target is not 'direct_outcome'; cannot use --from-signal with this signal type`,
    );
  }

  const payload = signalData.direct_outcome_payload;
  const resolvedText = payload.resolved_text || '';

  const sections = resolvedTextToSections(signalId, { ...signalData, ...payload }, resolvedText);
  const title = payload.title || signalData.title || `Signal ${signalId} — Direct Outcome`;

  return { title, sections, signalData };
}
