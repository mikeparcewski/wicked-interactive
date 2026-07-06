// validate subcommand — validate a wicked-interactive HTML artifact.
//
// Usage:
//   wicked-interactive validate <artifact-path>
//
// Checks:
//   1. The file is readable HTML
//   2. A <script id="wi-data" type="application/json"> block exists
//   3. The JSON parses correctly
//   4. The JSON validates against the wi-content schema (v1.0)
//   5. The computed idempotency key for the artifact matches the 5-component pattern
//
// Exit codes:
//   0  Valid
//   1  Invalid (structured error written to stdout as JSON)

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { validateWiContent, computeIdempotencyKey, validateIdempotencyKey } from './schema.js';

const HELP = `
Usage: wicked-interactive validate <artifact-path>

Validates a wicked-interactive HTML artifact against the wi-content schema v1.0.

Exit codes:
  0  Valid — artifact conforms to the wi-content schema
  1  Invalid — structured error report written to stderr

`.trimStart();

/**
 * Extract the wi-data JSON from an HTML artifact string.
 * Returns { data, error } where error is a string on failure.
 */
function extractWiData(html) {
  // Match <script id="wi-data" ...> or <script ... id="wi-data" ...>
  const match = html.match(/<script[^>]+id=["']wi-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) {
    return { data: null, error: 'wi-data script block not found in HTML artifact' };
  }
  try {
    const data = JSON.parse(match[1]);
    return { data, error: null };
  } catch (e) {
    return { data: null, error: `wi-data JSON parse failed: ${e.message}` };
  }
}

/**
 * Emit a validation_failed bus event (fire-and-forget).
 */
function emitValidationFailedEvent(absPath, violations, sourceType) {
  const key = computeIdempotencyKey(sourceType || 'file', absPath);
  // Use separate key prefix for validation_failed
  const failKey = key.replace('artifact.created', 'artifact.validation_failed');
  const payload = JSON.stringify({
    artifact_path: absPath,
    violation_count: violations.length,
    violations: violations.slice(0, 20), // cap payload size
    source_type: sourceType || 'file',
  });
  spawnSync(
    'npx',
    [
      'wicked-bus', 'emit',
      '--type', 'wicked.interactive.artifact.validation_failed',
      '--domain', 'wicked-interactive',
      '--subdomain', 'interactive.artifact',
      '--payload', payload,
      '--idempotency-key', failKey,
    ],
    { stdio: 'ignore', timeout: 8000 },
  );
}

/**
 * Run the validate command.
 * @param {object} args — parsed argv
 * @returns {number} exit code
 */
export async function runValidate(args) {
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const artifactArg = args._[1] || args.file;
  if (!artifactArg) {
    process.stderr.write('Error: artifact path is required\n');
    process.stderr.write('Usage: wicked-interactive validate <artifact-path>\n');
    return 1;
  }

  const absPath = resolve(artifactArg);
  const violations = [];

  // ── Read file ──────────────────────────────────────────────────────────────
  let html;
  try {
    html = readFileSync(absPath, 'utf8');
  } catch (e) {
    const report = { valid: false, artifact: absPath, violations: [`Cannot read file: ${e.message}`] };
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');
    return 1;
  }

  // ── Check wicked-interactive-version meta tag ──────────────────────────────
  if (!html.includes('wicked-interactive-version')) {
    violations.push('Missing <meta name="wicked-interactive-version"> — this may not be a wicked-interactive artifact');
  }

  // ── Extract wi-data ────────────────────────────────────────────────────────
  const { data: wiData, error: extractError } = extractWiData(html);
  if (extractError) {
    const report = { valid: false, artifact: absPath, violations: [extractError] };
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');
    return 1;
  }

  // ── Schema validation ──────────────────────────────────────────────────────
  const { valid: schemaValid, errors: schemaErrors } = validateWiContent(wiData);
  if (!schemaValid) {
    violations.push(...schemaErrors.map((e) => `schema: ${e}`));
  }

  // ── Idempotency key validation ─────────────────────────────────────────────
  const sourceType = (schemaValid && wiData.source_type) ? wiData.source_type : 'file';
  const ikey = computeIdempotencyKey(sourceType, absPath);
  if (!validateIdempotencyKey(ikey)) {
    violations.push(
      `idempotency key format invalid: "${ikey}" — must match ^[a-z][a-z0-9-]*:[a-z][a-z0-9._-]*:[a-z0-9-]+:[a-z0-9-]*:[0-9]+$`,
    );
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  if (violations.length > 0) {
    const report = {
      valid: false,
      artifact: absPath,
      violation_count: violations.length,
      violations,
      idempotency_key: ikey,
    };
    process.stderr.write(JSON.stringify(report, null, 2) + '\n');

    // Emit validation_failed event (fire-and-forget)
    emitValidationFailedEvent(absPath, violations, sourceType);

    return 1;
  }

  // All good
  const report = {
    valid: true,
    artifact: absPath,
    artifact_id: wiData.artifact_id,
    title: wiData.title,
    source_type: wiData.source_type,
    schema_version: wiData.schema_version,
    section_count: Array.isArray(wiData.sections) ? wiData.sections.length : 0,
    idempotency_key: ikey,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}
