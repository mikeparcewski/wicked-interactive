// IIFE renderer source — the JavaScript that gets inlined into every artifact HTML.
// This module exports a string; nothing here runs in Node.js at generation time.
//
// Section content shapes handled:
//   header       { title, subtitle?, tags? }
//   summary      { text, bullets? }
//   card-grid    { cards: [{ title, body, badge? }] }
//   table        { columns, rows[][] }
//   timeline     { events: [{ date?, title, description? }] }
//   callout      { level: 'info|warn|error', text }
//   evidence     { items: [{ label, value, link? }] }
//   recommendation { text, priority: 'high|medium|low', rationale? }
//   diagram      { mermaid } — v0.1: rendered as <pre> block

export const RENDERER_IIFE = `(function () {
  var dataEl = document.getElementById('wi-data');
  if (!dataEl) { document.body.innerHTML = '<p style="color:red">wi-data script block not found</p>'; return; }
  var data;
  try { data = JSON.parse(dataEl.textContent); }
  catch (e) { document.body.innerHTML = '<p style="color:red">Failed to parse wi-data JSON: ' + e.message + '</p>'; return; }

  var root = document.getElementById('wi-root');
  if (!root) return;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var renderers = {
    header: function (c) {
      var h = '<div class="wi-header">';
      h += '<h1>' + esc(c.title) + '</h1>';
      if (c.subtitle) h += '<p class="wi-subtitle">' + esc(c.subtitle) + '</p>';
      if (Array.isArray(c.tags) && c.tags.length) {
        h += '<div class="wi-tags">';
        for (var i = 0; i < c.tags.length; i++) {
          h += '<span class="wi-tag">' + esc(c.tags[i]) + '</span>';
        }
        h += '</div>';
      }
      h += '</div>';
      return h;
    },

    summary: function (c) {
      var h = '<div class="wi-summary">';
      if (c.text) h += '<p>' + esc(c.text) + '</p>';
      if (Array.isArray(c.bullets) && c.bullets.length) {
        h += '<ul>';
        for (var i = 0; i < c.bullets.length; i++) {
          h += '<li>' + esc(c.bullets[i]) + '</li>';
        }
        h += '</ul>';
      }
      h += '</div>';
      return h;
    },

    'card-grid': function (c) {
      var cards = Array.isArray(c.cards) ? c.cards : [];
      var h = '<div class="wi-card-grid">';
      for (var i = 0; i < cards.length; i++) {
        var card = cards[i];
        h += '<div class="wi-card">';
        h += '<h3>' + esc(card.title) + '</h3>';
        if (card.body) h += '<p class="wi-card-body">' + esc(card.body) + '</p>';
        if (card.badge) h += '<span class="wi-badge">' + esc(card.badge) + '</span>';
        h += '</div>';
      }
      h += '</div>';
      return h;
    },

    table: function (c) {
      var cols = Array.isArray(c.columns) ? c.columns : [];
      var rows = Array.isArray(c.rows) ? c.rows : [];
      var h = '<div class="wi-table-wrap"><table>';
      if (cols.length) {
        h += '<thead><tr>';
        for (var i = 0; i < cols.length; i++) h += '<th>' + esc(cols[i]) + '</th>';
        h += '</tr></thead>';
      }
      h += '<tbody>';
      for (var r = 0; r < rows.length; r++) {
        h += '<tr>';
        var row = Array.isArray(rows[r]) ? rows[r] : [];
        for (var i = 0; i < row.length; i++) h += '<td>' + esc(row[i]) + '</td>';
        h += '</tr>';
      }
      h += '</tbody></table></div>';
      return h;
    },

    timeline: function (c) {
      var events = Array.isArray(c.events) ? c.events : [];
      var h = '<div class="wi-timeline">';
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        h += '<div class="wi-timeline-item">';
        if (ev.date) h += '<div class="wi-timeline-date">' + esc(ev.date) + '</div>';
        h += '<div class="wi-timeline-title">' + esc(ev.title) + '</div>';
        if (ev.description) h += '<div class="wi-timeline-desc">' + esc(ev.description) + '</div>';
        h += '</div>';
      }
      h += '</div>';
      return h;
    },

    callout: function (c) {
      var level = c.level === 'warn' ? 'warn' : c.level === 'error' ? 'error' : 'info';
      return '<div class="wi-callout wi-callout-' + level + '">' + esc(c.text) + '</div>';
    },

    evidence: function (c) {
      var items = Array.isArray(c.items) ? c.items : [];
      var h = '<ul class="wi-evidence-list">';
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        h += '<li class="wi-evidence-item">';
        h += '<span class="wi-evidence-label">' + esc(item.label) + '</span>';
        if (item.link) {
          h += '<a class="wi-evidence-link" href="' + esc(item.link) + '" target="_blank" rel="noopener">' + esc(item.value || item.link) + '</a>';
        } else if (item.value) {
          h += '<span class="wi-evidence-value">' + esc(item.value) + '</span>';
        }
        h += '</li>';
      }
      h += '</ul>';
      return h;
    },

    recommendation: function (c) {
      var pri = c.priority === 'medium' ? 'medium' : c.priority === 'low' ? 'low' : 'high';
      var h = '<div class="wi-recommendation wi-rec-' + pri + '">';
      h += '<div class="wi-rec-priority">' + esc(pri) + ' priority</div>';
      h += '<div class="wi-rec-text">' + esc(c.text) + '</div>';
      if (c.rationale) h += '<div class="wi-rec-rationale">' + esc(c.rationale) + '</div>';
      h += '</div>';
      return h;
    },

    diagram: function (c) {
      var h = '<div class="wi-diagram">';
      h += '<p class="wi-diagram-note"><em>Diagram source (Mermaid — full rendering deferred to v1)</em></p>';
      h += '<pre>' + esc(c.mermaid) + '</pre>';
      h += '</div>';
      return h;
    },
  };

  var sections = Array.isArray(data.sections) ? data.sections : [];
  for (var s = 0; s < sections.length; s++) {
    var section = sections[s];
    var wrapper = document.createElement('div');
    wrapper.className = 'wi-section wi-section-' + (section.type || 'unknown');
    var fn = renderers[section.type];
    if (fn && section.content) {
      try { wrapper.innerHTML = fn(section.content); }
      catch (e) { wrapper.innerHTML = '<p class="wi-render-error">Render error in ' + esc(section.type) + ': ' + esc(e.message) + '</p>'; }
    } else if (!fn) {
      wrapper.innerHTML = '<p class="wi-unknown">Unknown section type: ' + esc(section.type) + '</p>';
    }
    root.appendChild(wrapper);
  }
})();`;

export const ARTIFACT_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  max-width: 900px; margin: 0 auto; padding: 2rem;
  color: #1a1a2e; background: #f8f9fa; line-height: 1.6;
}
.wi-section { margin-bottom: 2.5rem; }

/* Header */
.wi-header h1 { font-size: 2rem; margin: 0 0 0.5rem; color: #1a1a2e; font-weight: 700; }
.wi-subtitle { color: #555; font-size: 1.1rem; margin: 0 0 1rem; }
.wi-tags { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
.wi-tag { background: #e8f0fe; color: #1967d2; padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.875rem; font-weight: 500; }

/* Summary */
.wi-summary p { color: #333; margin: 0 0 0.75rem; }
.wi-summary ul { padding-left: 1.5rem; color: #333; }
.wi-summary li { margin-bottom: 0.35rem; }

/* Card Grid */
.wi-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; }
.wi-card { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
.wi-card h3 { margin: 0 0 0.5rem; font-size: 1rem; color: #1a1a2e; }
.wi-card-body { font-size: 0.9rem; color: #444; margin: 0; }
.wi-badge { display: inline-block; margin-top: 0.75rem; background: #e8f0fe; color: #1967d2; font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 12px; }

/* Table */
.wi-table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; background: #fff; border-radius: 8px; overflow: hidden; }
th { background: #f0f4ff; text-align: left; padding: 0.75rem 1rem; border-bottom: 2px solid #c5d2ff; font-weight: 600; color: #1a1a2e; }
td { padding: 0.65rem 1rem; border-bottom: 1px solid #eee; color: #333; }
tr:last-child td { border-bottom: none; }
tr:hover td { background: #f8f9ff; }

/* Timeline */
.wi-timeline { position: relative; padding-left: 2rem; }
.wi-timeline::before { content: ''; position: absolute; left: 0.45rem; top: 0.5rem; bottom: 0.5rem; width: 2px; background: #c5d2ff; }
.wi-timeline-item { position: relative; margin-bottom: 1.75rem; }
.wi-timeline-item::before { content: ''; position: absolute; left: -1.625rem; top: 0.35rem; width: 10px; height: 10px; border-radius: 50%; background: #1967d2; box-shadow: 0 0 0 3px #fff, 0 0 0 5px #c5d2ff; }
.wi-timeline-date { font-size: 0.8rem; color: #888; margin-bottom: 0.2rem; }
.wi-timeline-title { font-weight: 600; color: #1a1a2e; margin-bottom: 0.25rem; }
.wi-timeline-desc { font-size: 0.9rem; color: #555; }

/* Callout */
.wi-callout { border-left: 4px solid; padding: 0.875rem 1.25rem; border-radius: 0 6px 6px 0; margin: 0; }
.wi-callout-info { border-color: #1967d2; background: #e8f0fe; color: #1a1a2e; }
.wi-callout-warn { border-color: #f9ab00; background: #fef7e0; color: #3d2c00; }
.wi-callout-error { border-color: #d93025; background: #fce8e6; color: #3c0f0f; }

/* Evidence */
.wi-evidence-list { list-style: none; padding: 0; margin: 0; background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden; }
.wi-evidence-item { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 0.75rem 1rem; border-bottom: 1px solid #eee; }
.wi-evidence-item:last-child { border-bottom: none; }
.wi-evidence-label { font-weight: 600; color: #1a1a2e; flex-shrink: 0; }
.wi-evidence-value { color: #555; font-size: 0.9rem; text-align: right; }
.wi-evidence-link { color: #1967d2; text-decoration: none; font-size: 0.875rem; }
.wi-evidence-link:hover { text-decoration: underline; }

/* Recommendation */
.wi-recommendation { border: 2px solid; border-radius: 8px; padding: 1.25rem; }
.wi-rec-high { border-color: #d93025; background: #fff5f5; }
.wi-rec-medium { border-color: #f9ab00; background: #fffde7; }
.wi-rec-low { border-color: #34a853; background: #f0fdf4; }
.wi-rec-priority { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #666; margin-bottom: 0.5rem; }
.wi-rec-text { font-size: 1.05rem; font-weight: 600; color: #1a1a2e; margin-bottom: 0.5rem; }
.wi-rec-rationale { font-size: 0.9rem; color: #555; }

/* Diagram */
.wi-diagram pre { background: #f4f4f4; border: 1px solid #ddd; border-radius: 6px; padding: 1rem 1.25rem; overflow-x: auto; font-family: 'SFMono-Regular', 'Consolas', 'Liberation Mono', monospace; font-size: 0.85rem; white-space: pre-wrap; word-break: break-all; color: #333; }
.wi-diagram-note { font-size: 0.8rem; color: #888; margin: 0 0 0.5rem; font-style: normal; }

/* Error states */
.wi-render-error, .wi-unknown { color: #d93025; font-size: 0.9rem; }
`;
