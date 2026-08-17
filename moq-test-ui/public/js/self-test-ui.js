import { RendererLoader } from './renderer-loader.js';

/**
 * Self-test UI.
 *
 * Each tool run maps directly to a RendererLoader — same lifecycle as a normal
 * tool run (load → onLine → onComplete).  No custom pass/fail parsing, no
 * tool-specific hacks.  To support a new tool in self-test, add selfTest to
 * its tool.json and write a renderer.js.  That's it.
 */
export class SelfTestUI {
  constructor() {
    this.tools      = [];        // { name, displayName, label, hasRenderer }
    this.rows       = new Map(); // label → { details, summary, loader, toolName, panel }
    this.selfTestId = null;
  }

  /** Called once when the tools list arrives from the server. */
  setTools(tools) {
    this.tools = [];
    for (const t of tools) {
      if (!t.selfTest) continue;
      const configs = Array.isArray(t.selfTest) ? t.selfTest : [t.selfTest];
      for (const cfg of configs) {
        if (!cfg.enabled) continue;
        this.tools.push({
          name:        t.name,
          displayName: cfg.label || t.displayName,
          label:       cfg.label || t.name,
          hasRenderer: t.hasRenderer,
          order:       cfg.order ?? Infinity,
        });
      }
    }
    this.tools.sort((a, b) => a.order - b.order);
  }

  /** Called when the user clicks Run — rebuild the list and create RendererLoaders. */
  start() {
    this.rows.clear();
    const container = document.getElementById('self-test-tool-list');
    if (!container) return;
    container.innerHTML = '';

    for (const tool of this.tools) {
      const details = document.createElement('details');
      details.className = 'st-item status-pending';

      const summary = document.createElement('summary');
      summary.className = 'st-item-summary';
      summary.innerHTML = `
        <span class="st-status-icon">○</span>
        <span class="st-tool-name">${tool.displayName}</span>
        <span class="st-summary-text"></span>
        <span class="st-status-text">pending</span>
      `;

      const panel = document.createElement('div');
      panel.className = 'st-renderer-panel';

      details.appendChild(summary);
      details.appendChild(panel);
      container.appendChild(details);

      const loader = new RendererLoader();
      let loaderReady = false;

      // Lazy-load renderer when user manually expands the row.
      details.addEventListener('toggle', () => {
        if (details.open && !loaderReady) {
          loaderReady = true;
          loader.load(tool.name, panel);
        }
      });

      this.rows.set(tool.label, {
        details,
        summary,
        loader,
        toolName: tool.name,
        panel,
        isReady:   () => loaderReady,
        markReady: () => { loaderReady = true; },
      });
    }
  }

  onProgress(data) {
    if (data.status === 'started') {
      this.selfTestId = data.selfTestId;
      const selected = new Set(data.tools || []);
      for (const [label, row] of this.rows.entries()) {
        if (!selected.has(label)) {
          row.details.remove();
          this.rows.delete(label);
        }
      }
      return;
    }

    const row = this.rows.get(data.toolName);
    if (!row) return;

    if (data.status === 'running') {
      this._setStatus(row, 'running');
      // Pre-load renderer so it receives live output even before expanding.
      if (!row.isReady()) {
        row.markReady();
        row.loader.load(row.toolName, row.panel);
      }
    } else if (data.status === 'output') {
      row.loader.onLine(data.line);
    } else if (data.status === 'pass' || data.status === 'fail' || data.status === 'error') {
      row.loader.onComplete(data.status === 'pass' ? 0 : 1);
      const s = row.loader.getSummary();
      this._setStatus(row, data.status, s);
    } else if (data.status === 'aborted') {
      this._setStatus(row, 'aborted');
    }
  }

  onComplete(data) {
    this.selfTestId = null;
    document.getElementById('btn-self-test-run').classList.remove('hidden');
    document.getElementById('btn-self-test-stop').classList.add('hidden');
    if (data.results) this._renderSummary(data.results);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _setStatus(row, status, summary) {
    row.details.className = `st-item status-${status}`;
    const icon = row.summary.querySelector('.st-status-icon');
    const text = row.summary.querySelector('.st-status-text');
    const sumEl = row.summary.querySelector('.st-summary-text');
    if (icon) icon.textContent = this._icon(status);
    if (text) text.textContent = summary ?? status;
    if (sumEl) sumEl.textContent = '';
  }

  _icon(status) {
    return { pending:'○', running:'◉', pass:'✓', fail:'✗', error:'⚠', aborted:'⊘' }[status] ?? '?';
  }

  _renderSummary(results) {
    const container = document.getElementById('self-test-tool-list');
    if (!container) return;
    const passed   = results.tools?.filter(t => t.status === 'pass').length ?? 0;
    const total    = results.tools?.length ?? 0;
    const ok       = passed === total;
    const duration = results.startedAt && results.completedAt
      ? this._duration(new Date(results.completedAt) - new Date(results.startedAt)) : '';
    const summary = document.createElement('div');
    summary.className = `self-test-summary ${ok ? 'summary-pass' : 'summary-fail'}`;
    summary.innerHTML = `
      <h4>Self-Test Complete</h4>
      <p>Relay: ${results.relayUrl || 'N/A'}</p>
      <p>Tools: <strong>${passed} / ${total} passed</strong></p>
      ${duration ? `<p>Duration: ${duration}</p>` : ''}
    `;
    container.appendChild(summary);
  }

  _duration(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) > 0 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  }
}
