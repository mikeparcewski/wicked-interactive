// create subcommand — produce a self-contained HTML artifact from crew/signal/file input.
//
// Usage:
//   wicked-interactive create --from-crew <session_id> [--theme <t>] [--out <path>]
//   wicked-interactive create --from-signal <signal_id> [--theme <t>] [--out <path>]
//   wicked-interactive create --from-file <wi-content.json> [--out <path>]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { validateWiContent, computeIdempotencyKey } from './schema.js';
import { generateArtifactHTML } from './template.js';
import { crewToWiContent } from './from-crew.js';
import { signalToWiContent } from './from-signal.js';

const HELP = `
Usage: wicked-interactive create [options]

Options:
  --from-crew <session_id>    Create artifact from a wicked-crew session
  --from-signal <signal_id>   Create artifact from a wicked-signals direct outcome
  --from-file <path>          Create artifact from a wi-content JSON file
  --theme <theme-name>        Apply a named theme (optional)
  --out <output-path>         Output path for the HTML artifact (default: <title>.html)
  --help                      Show this help

Environment:
  WICKED_BUS_PATH             Path to wicked-bus DB (used to resolve crew session paths)
  WICKED_SIGNALS_PATH         Path to wicked-signals store directory

Exit codes:
  0  Success
  1  Validation error / missing source / signal wrong type
`.trimStart();

/**
 * Slugify a title for use as a filename.
 * @param {string} title
 * @returns {string}
 */
function titleToSlug(title) {
  return (title || 'artifact')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'artifact';
}

/**
 * Emit the artifact.created bus event (fire-and-forget).
 */
function emitCreatedEvent(artifactPath, sourceType, extra = {}) {
  const key = computeIdempotencyKey(sourceType, artifactPath);
  const payload = JSON.stringify({
    artifact_path: artifactPath,
    source_type: sourceType,
    signal_id: extra.signalId ?? null,
    crew_session_id: extra.sessionId ?? null,
    schema_version: '1.0',
    ...(extra.outcomeType ? { outcome_type: extra.outcomeType } : {}),
    ...(extra.sourcePath ? { source_path: extra.sourcePath } : {}),
    ...(extra.sectionCount != null ? { section_count: extra.sectionCount } : {}),
    created_at: new Date().toISOString(),
  });

  spawnSync(
    'npx',
    [
      'wicked-bus', 'emit',
      '--type', 'wicked.interactive.artifact.created',
      '--domain', 'wicked-interactive',
      '--subdomain', 'interactive.artifact',
      '--payload', payload,
      '--idempotency-key', key,
    ],
    { stdio: 'ignore', timeout: 8000 },
  );
  // Errors are intentionally swallowed — bus emission is fire-and-forget.
}

/**
 * Build the wi-content envelope around sections.
 */
function buildWiContent(title, sections, sourceType, extra = {}) {
  return {
    schema_version: '1.0',
    artifact_id: randomUUID(),
    created_at: new Date().toISOString(),
    source_type: sourceType,
    crew_session_id: extra.sessionId ?? null,
    signal_id: extra.signalId ?? null,
    title,
    sections,
  };
}

/**
 * Run the create command.
 * @param {object} args — parsed argv from bin/wicked-interactive.js
 * @returns {number} exit code
 */
export async function runCreate(args) {
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const fromCrew = args['from-crew'];
  const fromSignal = args['from-signal'];
  const fromFile = args['from-file'];

  const sourceCount = [fromCrew, fromSignal, fromFile].filter(Boolean).length;
  if (sourceCount === 0) {
    process.stderr.write('Error: one of --from-crew, --from-signal, or --from-file is required\n');
    process.stderr.write('Run: wicked-interactive create --help\n');
    return 1;
  }
  if (sourceCount > 1) {
    process.stderr.write('Error: only one of --from-crew, --from-signal, --from-file may be specified\n');
    return 1;
  }

  let wiContent;
  let extra = {};

  // ── --from-crew ────────────────────────────────────────────────────────────
  if (fromCrew) {
    let mapped;
    try {
      mapped = await crewToWiContent(fromCrew);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }

    if (!mapped.sessionFound) {
      process.stderr.write(
        `Warning: crew session "${fromCrew}" not found — producing a "content pending" artifact.\n`,
      );
    }

    wiContent = buildWiContent(mapped.title, mapped.sections, 'crew', { sessionId: fromCrew });
    extra = { sessionId: fromCrew, outcomeType: mapped.crewType };
  }

  // ── --from-signal ──────────────────────────────────────────────────────────
  if (fromSignal) {
    let mapped;
    try {
      mapped = await signalToWiContent(fromSignal);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }

    wiContent = buildWiContent(mapped.title, mapped.sections, 'signal', { signalId: fromSignal });
    extra = {
      signalId: fromSignal,
      // REQ-003 §2.4: outcome_type is required for signal-origin events.
      // Fall back to 'triage' if the signal pre-dates the field.
      outcomeType: mapped.signalData?.outcome_type || 'triage',
    };
  }

  // ── --from-file ────────────────────────────────────────────────────────────
  if (fromFile) {
    const absFile = resolve(fromFile);
    let rawData;
    try {
      rawData = JSON.parse(readFileSync(absFile, 'utf8'));
    } catch (e) {
      process.stderr.write(`Error: cannot read ${absFile}: ${e.message}\n`);
      return 1;
    }

    const { valid, errors } = validateWiContent(rawData);
    if (!valid) {
      process.stderr.write('Error: wi-content validation failed:\n');
      for (const err of errors) process.stderr.write(`  - ${err}\n`);
      return 1;
    }

    wiContent = rawData;
    extra = {
      sourcePath: absFile,
      sectionCount: Array.isArray(rawData.sections) ? rawData.sections.length : 0,
    };
  }

  // ── Resolve output path ────────────────────────────────────────────────────
  // --output is the spec-canonical flag; --out is the legacy alias (both accepted).
  const outFlag = args.output || args.out;
  const outPath = outFlag
    ? resolve(outFlag)
    : resolve(`${titleToSlug(wiContent.title)}.html`);

  // ── Generate HTML ──────────────────────────────────────────────────────────
  let html;
  try {
    html = generateArtifactHTML(wiContent);
  } catch (e) {
    process.stderr.write(`Error: HTML generation failed: ${e.message}\n`);
    return 1;
  }

  try {
    writeFileSync(outPath, html, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: cannot write ${outPath}: ${e.message}\n`);
    return 1;
  }

  // ── Emit bus event (fire-and-forget) ───────────────────────────────────────
  emitCreatedEvent(outPath, wiContent.source_type, extra);

  process.stdout.write(`Created: ${outPath}\n`);
  process.stdout.write(`  artifact_id: ${wiContent.artifact_id}\n`);
  process.stdout.write(`  source_type: ${wiContent.source_type}\n`);
  process.stdout.write(`  sections:    ${wiContent.sections.length}\n`);

  return 0;
}
