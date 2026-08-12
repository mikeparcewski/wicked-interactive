// create subcommand — produce a self-contained HTML artifact from crew/signal/file input.
//
// Usage:
//   wicked-interactive create --from-crew <session_id> [--theme <t>] [--out <path>]
//   wicked-interactive create --from-garden <session_id> [--theme <t>] [--out <path>]
//   wicked-interactive create --from-file <wi-content.json> [--out <path>]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { validateWiContent, computeIdempotencyKey } from './schema.js';
import { generateArtifactHTML } from './template.js';
import { crewToWiContent } from './from-crew.js';
import { gardenCouncilToWiContent } from './from-garden.js';

const HELP = `
Usage: wicked-interactive create [options]

Options:
  --from-crew <session_id>    Create artifact from a wicked-crew session
  --from-garden <session_id>  Create artifact from a wicked-garden council verdict
  --from-file <path>          Create artifact from a wi-content JSON file
  --theme <theme-name>        Apply a named theme (optional)
  --out <output-path>         Output path for the HTML artifact (default: <title>.html)
  --project <project-id>      File the result into a crew project as a WORKSPACE DOC under the
                              serve root (registers interactive.doc membership + writes the
                              project.json breadcrumb). Needs a reachable crew daemon — offline
                              this is a loud error, and nothing is created.
  --name <doc-name>           Doc dir name for --project (default: slug of the title)
  --root <docs-dir>           Serve root for --project (default: ~/wicked-interactive/docs)
  --crew-api <base-url>       Crew daemon base URL (default: WICKED_CREW_API or http://127.0.0.1:7701)
  --help                      Show this help

Environment:
  WICKED_CREW_API             Crew daemon base URL for --project
  WICKED_BUS_PATH             Path to wicked-bus DB (used to resolve crew session paths)
  WICKED_GARDEN_PATH          Path to the wicked-garden data root (default:
                              ~/.something-wicked/wicked-garden); council transcripts
                              resolve under it. Omit --from-garden's id for the latest.

Exit codes:
  0  Success
  1  Validation error / missing source
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
    council_session_id: extra.councilSessionId ?? null,
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
    council_session_id: extra.councilSessionId ?? null,
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
  const fromGarden = args['from-garden'];
  const fromFile = args['from-file'];

  const sourceCount = [fromCrew, fromGarden, fromFile].filter(Boolean).length;
  if (sourceCount === 0) {
    process.stderr.write('Error: one of --from-crew, --from-garden, or --from-file is required\n');
    process.stderr.write('Run: wicked-interactive create --help\n');
    return 1;
  }
  if (sourceCount > 1) {
    process.stderr.write('Error: only one of --from-crew, --from-garden, --from-file may be specified\n');
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

  // ── --from-garden ────────────────────────────────────────────────────────────
  if (fromGarden) {
    let mapped;
    try {
      // `--from-garden` with no id resolves the latest council transcript.
      mapped = await gardenCouncilToWiContent(fromGarden === true ? undefined : fromGarden);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }

    if (!mapped.sessionFound) {
      process.stderr.write(
        `Warning: garden council "${mapped.sessionId}" not found — producing a "content pending" artifact.\n`,
      );
    }

    wiContent = buildWiContent(mapped.title, mapped.sections, 'garden', { councilSessionId: mapped.sessionId });
    extra = { councilSessionId: mapped.sessionId, outcomeType: 'council' };
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

  // ── Optional crew-project binding (DES-PROJECT-001 §2.3) ──────────────────
  // The workspace-doc form needs STATIC, instrumentable HTML (the serve loop anchors
  // reviewable elements with data-wid) — the artifact template renders client-side from a
  // wi-data JSON block, which instrument() correctly finds nothing in. So the bound doc is
  // seeded from a plain static rendering of the same wi-content.
  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function sectionToStaticHtml(section) {
    const c = section.content;
    if (typeof c === 'string') {
      return section.type === 'header'
        ? `<section><h1>${esc(c)}</h1></section>`
        : `<section><p>${esc(c)}</p></section>`;
    }
    if (section.type === 'header') {
      return `<section><h1>${esc(c.title ?? '')}</h1>${c.subtitle ? `<p>${esc(c.subtitle)}</p>` : ''}</section>`;
    }
    if (section.type === 'summary') {
      const bullets = Array.isArray(c.bullets) ? `<ul>${c.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : '';
      return `<section>${c.text ? `<p>${esc(c.text)}</p>` : ''}${bullets}</section>`;
    }
    // Everything else keeps its data faithfully, readable and editable, without a bespoke
    // renderer per type: a heading + preformatted content block.
    return `<section><h2>${esc(section.type)}</h2><pre>${esc(JSON.stringify(c, null, 2))}</pre></section>`;
  }
  function wiContentToStaticHtml(content) {
    return `<h1>${esc(content.title)}</h1>\n${content.sections.map(sectionToStaticHtml).join('\n')}`;
  }

  // `--project <id>` files the artifact into a crew project as a WORKSPACE DOC (a dir under the
  // serve root with versions.json) — the doc-dir form is what `interactive.doc` membership refs
  // and what `serve` can continue iterating. Registration is the authority and it happens FIRST:
  // no crew daemon / unknown project / archived project is a LOUD error and NOTHING is written
  // (never a queued intent). Without --project this entire block is skipped — the offline
  // single-file artifact loop below is byte-for-byte untouched.
  if (args.project) {
    const projectId = String(args.project);
    const { bindDocToProject } = await import('../service/project.js');
    const { initWorkspace } = await import('../service/workspace.js');
    const { mkdirSync, existsSync, rmSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const root = args.root ? resolve(String(args.root)) : resolve(homedir(), 'wicked-interactive', 'docs');
    const docName = String(args.name || titleToSlug(wiContent.title));
    const dir = resolve(root, docName);
    if (existsSync(resolve(dir, 'versions.json'))) {
      process.stderr.write(`Error: doc "${docName}" already exists under ${root} — pick --name\n`);
      return 1;
    }
    try {
      // The dir exists for the breadcrumb's sake, but a refused bind removes it again (when it
      // did not pre-exist) — "offline this is a loud error and NOTHING is created" is literal.
      const dirExisted = existsSync(dir);
      mkdirSync(dir, { recursive: true });
      let crumb;
      try {
        crumb = await bindDocToProject({
          dir,
          docName,
          projectId,
          ...(args['crew-api'] ? { crewApi: String(args['crew-api']) } : {}),
          meta: { title: wiContent.title },
        });
      } catch (e) {
        if (!dirExisted) rmSync(dir, { recursive: true, force: true });
        throw e;
      }
      initWorkspace(dir, wiContentToStaticHtml(wiContent));
      // Announce the doc on the bus with its binding (best-effort — the membership and the doc
      // are already durable; a bus hiccup must not fail the create).
      try {
        const { emitEvent } = await import('../service/bus-client.js');
        const { PRODUCERS } = await import('../service/events.js');
        await emitEvent(
          'wicked.interactive.doc.created',
          { document_id: docName, kind: 'html', project_id: crumb.project_id },
          { producer: PRODUCERS.SERVICE },
        );
      } catch { /* bus optional on the CLI path */ }
      process.stdout.write(`Created doc: ${dir}\n`);
      process.stdout.write(`  project:   ${crumb.project_id} (${crumb.project_name})\n`);
      process.stdout.write(`  registered via ${crumb.crew_api}; breadcrumb: project.json\n`);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    // The bound doc-dir form REPLACES the bare-file artifact unless --output asked for one too.
    if (!outFlag) return 0;
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
