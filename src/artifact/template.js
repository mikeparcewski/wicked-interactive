// HTML template generator — wraps the IIFE renderer + wi-data into a full HTML document.
// The output is a single self-contained .html file that opens via file:// with no network requests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { RENDERER_IIFE, ARTIFACT_CSS } from './renderer.js';

// Package version — embedded as <meta name="wicked-interactive-version">
let _pkgVersion = null;
function pkgVersion() {
  if (_pkgVersion) return _pkgVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8'));
    _pkgVersion = pkg.version || '0.0.0';
  } catch {
    _pkgVersion = '0.0.0';
  }
  return _pkgVersion;
}

/**
 * Safely serialize wi-content JSON for embedding inside a <script> block.
 * Escapes </script to prevent premature tag close.
 */
function safeJson(obj) {
  return JSON.stringify(obj, null, 2)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--');
}

/**
 * Generate the full artifact HTML document.
 * @param {object} wiContent — validated wi-content JSON object
 * @returns {string} — complete HTML document as a string
 */
export function generateArtifactHTML(wiContent) {
  const title = wiContent.title || 'wicked-interactive artifact';
  const dataJson = safeJson(wiContent);
  const version = pkgVersion();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="wicked-interactive-version" content="${version}">
  <meta name="wi-content-schema" content="1.0">
  <meta name="wicked-source-type" content="${wiContent.source_type || 'file'}">
  <title>${escHtml(title)}</title>
  <style>
${ARTIFACT_CSS}
  </style>
</head>
<body>
  <script id="wi-data" type="application/json">
${dataJson}
  </script>
  <div id="wi-root"></div>
  <script>
${RENDERER_IIFE}
  </script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
