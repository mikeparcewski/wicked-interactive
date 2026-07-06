// publish subcommand — publish a wicked-interactive HTML artifact to wicked-reads.
//
// Usage:
//   wicked-interactive publish <artifact-path> [--api-key <key>]
//
// Requires WICKED_READS_API_KEY env var (or --api-key flag).
// v0.1: placeholder publish — real HTTP submission deferred.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

import { validateWiContent, computeIdempotencyKey } from './schema.js';

const HELP = `
Usage: wicked-interactive publish <artifact-path> [options]

Options:
  --api-key <key>    wicked-reads API key (overrides WICKED_READS_API_KEY env var)
  --help             Show this help

Environment:
  WICKED_READS_API_KEY    API key for wicked-reads publish endpoint

Exit codes:
  0  Success (or simulated success in v0.1)
  1  Missing API key / invalid artifact / publish error
`.trimStart();

/**
 * Emit artifact.published bus event (fire-and-forget).
 */
function emitPublishedEvent(artifactId, publishedUrl, sourceType) {
  const key = `interactive:artifact.published:${artifactId}:${sourceType || 'file'}:0`;
  const payload = JSON.stringify({ artifact_id: artifactId, published_url: publishedUrl, source_type: sourceType || 'file' });

  spawnSync(
    'npx',
    [
      'wicked-bus', 'emit',
      '--type', 'wicked.interactive.artifact.published',
      '--domain', 'wicked-interactive',
      '--subdomain', 'interactive.artifact',
      '--payload', payload,
      '--idempotency-key', key,
    ],
    { stdio: 'ignore', timeout: 8000 },
  );
}

/**
 * Extract the wi-data JSON from an HTML artifact string.
 * @param {string} html
 * @returns {object | null}
 */
function extractWiData(html) {
  const match = html.match(/<script[^>]+id=["']wi-data["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

/**
 * Run the publish command.
 * @param {object} args — parsed argv
 * @returns {number} exit code
 */
export async function runPublish(args) {
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const artifactArg = args._[1];
  if (!artifactArg) {
    process.stderr.write('Error: artifact path is required\n');
    process.stderr.write('Usage: wicked-interactive publish <artifact-path> [--api-key <key>]\n');
    return 1;
  }

  const apiKey = args['api-key'] || process.env.WICKED_READS_API_KEY;
  if (!apiKey) {
    process.stderr.write('Error: WICKED_READS_API_KEY is required for publish\n');
    process.stderr.write('  Set the environment variable or pass --api-key <key>\n');
    return 1;
  }

  const absPath = resolve(artifactArg);

  // Read and validate artifact
  let html;
  try {
    html = readFileSync(absPath, 'utf8');
  } catch (e) {
    process.stderr.write(`Error: cannot read ${absPath}: ${e.message}\n`);
    return 1;
  }

  const wiData = extractWiData(html);
  if (!wiData) {
    process.stderr.write(`Error: ${absPath} does not appear to be a valid wicked-interactive artifact (wi-data script block not found)\n`);
    return 1;
  }

  const { valid, errors } = validateWiContent(wiData);
  if (!valid) {
    process.stderr.write('Error: artifact wi-content validation failed:\n');
    for (const err of errors) process.stderr.write(`  - ${err}\n`);
    return 1;
  }

  // v0.1 placeholder — real publish via wicked-reads API deferred
  const title = wiData.title || 'artifact';
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  const placeholderUrl = `https://wicked-reads.app/i/${slug}`;
  const artifactId = wiData.artifact_id || randomUUID();

  process.stdout.write(`Publishing: ${absPath}\n`);
  process.stdout.write(`  [v0.1 placeholder — real wicked-reads submission deferred]\n`);
  process.stdout.write(`  artifact_id:  ${artifactId}\n`);
  process.stdout.write(`  title:        ${title}\n`);
  process.stdout.write(`  url:          ${placeholderUrl}\n`);

  // Emit bus event (fire-and-forget)
  emitPublishedEvent(artifactId, placeholderUrl, wiData.source_type);

  return 0;
}
