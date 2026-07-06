// wi-content schema validator — v1.0
// Validates the JSON structure embedded in every wicked-interactive artifact.

import { createHash } from 'node:crypto';

const VALID_SECTION_TYPES = new Set([
  'header', 'summary', 'card-grid', 'table', 'timeline',
  'callout', 'evidence', 'recommendation', 'diagram',
]);

const VALID_SOURCE_TYPES = new Set(['crew', 'signal', 'file']);

const IDEMPOTENCY_KEY_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9._-]*:[a-z0-9-]+:[a-z0-9-]*:[0-9]+$/;

/**
 * Validate a wi-content JSON object.
 * @param {unknown} data
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateWiContent(data) {
  const errors = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors: ['wi-content must be a JSON object'] };
  }

  if (data.schema_version !== '1.0') {
    errors.push(`schema_version must be "1.0", got "${data.schema_version}"`);
  }

  if (typeof data.artifact_id !== 'string' || !data.artifact_id.trim()) {
    errors.push('artifact_id must be a non-empty string');
  }

  if (typeof data.created_at !== 'string' || isNaN(Date.parse(data.created_at))) {
    errors.push('created_at must be a valid ISO 8601 datetime string');
  }

  if (!VALID_SOURCE_TYPES.has(data.source_type)) {
    errors.push(
      `source_type must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}, got "${data.source_type}"`,
    );
  }

  if (typeof data.title !== 'string' || !data.title.trim()) {
    errors.push('title must be a non-empty string');
  }

  if (!Array.isArray(data.sections)) {
    errors.push('sections must be an array');
  } else {
    for (let i = 0; i < data.sections.length; i++) {
      const section = data.sections[i];
      if (!section || typeof section !== 'object' || Array.isArray(section)) {
        errors.push(`sections[${i}] must be an object`);
        continue;
      }
      if (!VALID_SECTION_TYPES.has(section.type)) {
        errors.push(
          `sections[${i}].type must be one of: ${[...VALID_SECTION_TYPES].join(', ')}, got "${section.type}"`,
        );
      }
      if (section.content === undefined || section.content === null) {
        errors.push(`sections[${i}].content is required`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compute the wicked-bus idempotency key for an artifact.created event.
 * Format (REQ-003 §4 / SC-WI-043): interactive:artifact.created:{path_hash}:{source_type}:0
 * @param {string} sourceType — crew | signal | file
 * @param {string} artifactAbsPath — absolute path of the HTML artifact
 * @returns {string}
 */
export function computeIdempotencyKey(sourceType, artifactAbsPath) {
  const hash = createHash('sha256').update(artifactAbsPath).digest('hex').slice(0, 12);
  return `interactive:artifact.created:${hash}:${sourceType}:0`;
}

/**
 * Validate an idempotency key matches the 5-component DEC-00010 pattern.
 * @param {string} key
 * @returns {boolean}
 */
export function validateIdempotencyKey(key) {
  return typeof key === 'string' && IDEMPOTENCY_KEY_RE.test(key);
}
