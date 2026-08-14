import { RendererLoader } from './renderer-loader.js';

/**
 * History UI: lists saved run results, allows viewing details.
 */
export class HistoryUI {
  constructor() {
    this.tools = [];
    this.onViewResult = null;           // callback set by app
    this._pendingFilename = null;       // filename of the pending View-button fetch
    this._summaryPending = new Set();   // filenames currently being background-fetched
    this._summaryCache   = new Map();   // filename → { text, passed }
    this._summaryCells   = new Map();   // filename → td element (current render)
  }

  setTools(tools) {
    this.tools = tools;
    const filter = document.getElementById('history-tool-filter');
    if (!filter) return;
    while (filter.options.length > 1) filter.remove(1);
    for (const t of tools) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.displayName;
      filter.appendChild(opt);
    }
  }

  onResultsList(data) {
    this._summaryCells.clear();
    const tbody = document.getElementById('history-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!data.results || data.results.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted">No results found</td></tr>';
      return;
    }

    const toFetch = [];

    for (const r of data.results) {
      const cached       = this._summaryCache.get(r.filename);
      const summaryText  = cached?.text ?? '—';
      const relayDisplay = r.relayUrl ? _shortenUrl(r.relayUrl) : '—';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${_escapeHtml(r.tool)}</td>
        <td>${new Date(r.mtime).toLocaleString()}</td>
        <td class="history-relay" title="${_escapeAttr(r.relayUrl || '')}">${_escapeHtml(relayDisplay)}</td>
        <td class="history-summary-cell"></td>
        <td><button class="btn btn-small btn-view">View</button></td>
      `;

      const summaryTd = tr.querySelector('.history-summary-cell');
      summaryTd.textContent = summaryText;
      if (cached) {
        summaryTd.classList.add(cached.passed ? 'summary-passed' : 'summary-failed');
      }
      this._summaryCells.set(r.filename, summaryTd);

      tr.querySelector('.btn-view').addEventListener('click', () => {
        this._pendingFilename = r.filename;
        this._summaryPending.delete(r.filename); // modal takes priority
        if (this.onViewResult) this.onViewResult(r.tool, r.filename);
      });
      tbody.appendChild(tr);

      if (!cached && !this._summaryPending.has(r.filename)) {
        toFetch.push({ tool: r.tool, filename: r.filename });
      }
    }

    // Fire background summary fetches for all uncached rows
    for (const { tool, filename } of toFetch) {
      this._summaryPending.add(filename);
      if (this.onViewResult) this.onViewResult(tool, filename);
    }
  }

  onResultData(data) {
    if (!data.result) return;
    const r        = data.result;
    const filename = data.filename;

    const isView    = filename && filename === this._pendingFilename;
    const isSummary = filename && this._summaryPending.has(filename);

    if (isView) {
      this._pendingFilename = null;
      this._summaryPending.delete(filename);
      if (this._isSelfTest(r)) {
        this._openSelfTestModal(r, filename);
      } else {
        this._openModal(r, filename);
      }
    } else if (isSummary) {
      this._summaryPending.delete(filename);
      this._computeAndApplySummary(r, filename, null);
    }
    // else: stale/unexpected response — ignore
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  _isSelfTest(r) {
    return r.selfTestId != null;
  }

  _openSelfTestModal(r, filename) {
    const tools   = r.tools || [];
    const passed  = tools.filter(t => t.status === 'pass').length;
    const total   = tools.length;
    const allPass = passed === total && !r.aborted;
    const duration = r.startedAt && r.completedAt
      ? Math.round((new Date(r.completedAt) - new Date(r.startedAt)) / 1000) + 's'
      : 'N/A';
    const displaySummary = `${passed}/${total} passed`;
    const icon = s => ({ pass:'✓', fail:'✗', error:'⚠', aborted:'⊘' }[s] ?? '?');

    // Build combined debug output
    const debugText = tools.map(t =>
      `=== ${t.name} ===\n` + (t.output || []).map(o => o.line).join('\n')
    ).join('\n\n');

    const overlay = document.createElement('div');
    overlay.className = 'result-overlay';
    overlay.innerHTML = `
      <div class="result-modal">
        <div class="result-modal-header">
          <h3>Self-test — ${new Date(r.startedAt).toLocaleString()}</h3>
          <button class="btn btn-small btn-close-modal">&times;</button>
        </div>
        <div class="result-meta">
          <span class="result-summary-text ${allPass ? 'summary-passed' : 'summary-failed'}">${displaySummary}</span>
          <span>Duration: ${duration}</span>
          <span>Relay: ${_escapeHtml(r.relayUrl || '—')}</span>
        </div>
        <div class="result-tabs">
          <button class="result-tab-btn active" data-tab="result">Result</button>
          <button class="result-tab-btn" data-tab="debug">CLI output</button>
        </div>
        <div class="result-tab-panel" data-panel="result">
          <div class="st-history-tool-list"></div>
        </div>
        <div class="result-tab-panel hidden" data-panel="debug">
          <pre class="result-output">${_escapeHtml(debugText)}</pre>
        </div>
      </div>
    `;

    overlay.querySelectorAll('.result-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.result-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        overlay.querySelectorAll('.result-tab-panel').forEach(p => {
          p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab);
        });
      });
    });

    overlay.querySelector('.btn-close-modal').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    // Cache and update table cell
    this._summaryCache.set(filename, { text: displaySummary, passed: allPass });
    const cell = this._summaryCells.get(filename);
    if (cell) {
      cell.textContent = displaySummary;
      cell.classList.remove('summary-passed', 'summary-failed');
      cell.classList.add(allPass ? 'summary-passed' : 'summary-failed');
    }

    // Render per-tool rows
    const toolList = overlay.querySelector('.st-history-tool-list');
    for (const t of tools) {
      const details = document.createElement('details');
      details.className = `st-item status-${t.status}`;

      const summary = document.createElement('summary');
      summary.className = 'st-item-summary';
      summary.innerHTML = `
        <span class="st-status-icon">${icon(t.status)}</span>
        <span class="st-tool-name">${_escapeHtml(t.name)}</span>
        <span class="st-summary-text"></span>
        <span class="st-status-text">${t.status}</span>
      `;

      const panel = document.createElement('div');
      panel.className = 'st-renderer-panel';

      details.appendChild(summary);
      details.appendChild(panel);
      toolList.appendChild(details);

      // Lazy-load renderer when user expands the row
      let loaded = false;
      details.addEventListener('toggle', () => {
        if (!details.open || loaded) return;
        loaded = true;
        const loader = new RendererLoader();
        loader.load(t.tool, panel).then(() => {
          for (const o of (t.output || [])) loader.onLine(o.line);
          loader.onComplete(t.exitCode ?? (t.status === 'pass' ? 0 : 1));
          const s = loader.getSummary();
          if (s) summary.querySelector('.st-summary-text').textContent = s;
        });
      });
    }
  }

  _openModal(r, filename) {
    const duration = r.startedAt && r.completedAt
      ? Math.round((new Date(r.completedAt) - new Date(r.startedAt)) / 1000) + 's'
      : 'N/A';

    const overlay = document.createElement('div');
    overlay.className = 'result-overlay';
    overlay.innerHTML = `
      <div class="result-modal">
        <div class="result-modal-header">
          <h3>${_escapeHtml(r.tool)} — ${new Date(r.startedAt).toLocaleString()}</h3>
          <button class="btn btn-small btn-close-modal">&times;</button>
        </div>
        <div class="result-meta">
          <span class="result-summary-text">—</span>
          <span>Duration: ${duration}</span>
          <span>Params: ${_escapeHtml(JSON.stringify(r.params))}</span>
        </div>
        <div class="result-tabs">
          <button class="result-tab-btn active" data-tab="result">Show result</button>
          <button class="result-tab-btn" data-tab="debug">Debug output</button>
        </div>
        <div class="result-tab-panel" data-panel="result"></div>
        <div class="result-tab-panel hidden" data-panel="debug">
          <pre class="result-output">${_escapeHtml((r.output || []).map(o => o.line).join('\n'))}</pre>
        </div>
      </div>
    `;

    overlay.querySelectorAll('.result-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.result-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        overlay.querySelectorAll('.result-tab-panel').forEach(p => {
          p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab);
        });
      });
    });

    overlay.querySelector('.btn-close-modal').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const resultPanel = overlay.querySelector('[data-panel="result"]');
    this._computeAndApplySummary(r, filename, resultPanel).then(({ displaySummary, passed }) => {
      const summaryEl = overlay.querySelector('.result-summary-text');
      if (summaryEl) {
        summaryEl.textContent = displaySummary;
        summaryEl.classList.toggle('summary-passed', passed);
        summaryEl.classList.toggle('summary-failed', !passed);
      }
    });
  }

  async _computeAndApplySummary(r, filename, panel) {
    // Self-test: derive summary directly from tools array — no renderer needed
    if (this._isSelfTest(r)) {
      const tools   = r.tools || [];
      const passed  = tools.filter(t => t.status === 'pass').length;
      const total   = tools.length;
      const allPass = passed === total && !r.aborted;
      const displaySummary = `${passed}/${total} passed`;
      this._summaryCache.set(filename, { text: displaySummary, passed: allPass });
      const cell = this._summaryCells.get(filename);
      if (cell) {
        cell.textContent = displaySummary;
        cell.classList.remove('summary-passed', 'summary-failed');
        cell.classList.add(allPass ? 'summary-passed' : 'summary-failed');
      }
      return { displaySummary, passed: allPass };
    }

    const loader    = new RendererLoader();
    const container = panel || document.createElement('div');

    await loader.load(r.tool, container);
    for (const o of (r.output || [])) loader.onLine(o.line);
    loader.onComplete(r.exitCode);

    const passed = r.exitCode === 0;

    if (panel && loader.renderer === null) {
      // No renderer — fall back to raw output in the result panel
      panel.innerHTML = `<pre class="result-output">${_escapeHtml((r.output || []).map(o => o.line).join('\n'))}</pre>`;
    }

    const summary        = loader.getSummary();
    const displaySummary = summary || (passed ? 'Passed' : 'Failed');

    // Cache and update table cell
    this._summaryCache.set(filename, { text: displaySummary, passed });
    const cell = this._summaryCells.get(filename);
    if (cell) {
      cell.textContent = displaySummary;
      cell.classList.remove('summary-passed', 'summary-failed');
      cell.classList.add(passed ? 'summary-passed' : 'summary-failed');
    }

    return { displaySummary, passed };
  }
}

function _shortenUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function _escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

