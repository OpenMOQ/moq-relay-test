/**
 * Renderer for moq-interop-runner output.
 * Parses TAP v14 lines from aiomoqt moq_interop_client and renders live test results.
 */
export default class {
  constructor() {
    this.container = null;
    this.tests = [];
    this.testMap = new Map();
    this.totalExpected = 0;
    this.target = '';
    this.version = '';
    this.startedAt = '';
    this.endedAt = '';
  }

  init(containerEl) {
    this.container = containerEl;
    this.tests = [];
    this.testMap = new Map();
    this.totalExpected = 0;
    this.target = '';
    this.version = '';
    this.startedAt = '';
    this.endedAt = '';

    containerEl.innerHTML = `
      <div class="renderer-interop-runner">
        <h4>MOQ Interop Runner (TAP)</h4>
        <div id="interop-meta" class="muted">Waiting for TAP output...</div>
        <div class="conformance-summary" id="interop-summary">
          <span class="summary-total">Tests: 0</span>
          <span class="summary-passed">Passed: 0</span>
          <span class="summary-failed">Failed: 0</span>
          <span class="summary-failed">Skipped: 0</span>
        </div>
        <table class="metrics-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Test Name</th>
              <th>Status</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody id="interop-tbody"></tbody>
        </table>
      </div>
    `;
  }

  onLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;

    // TAP metadata headers.
    if (trimmed.startsWith('# target:')) {
      this.target = trimmed.slice('# target:'.length).trim();
      this.updateMeta();
      return;
    }
    if (trimmed.startsWith('# version:')) {
      this.version = trimmed.slice('# version:'.length).trim();
      this.updateMeta();
      return;
    }
    if (trimmed.startsWith('# date:')) {
      this.startedAt = trimmed.slice('# date:'.length).trim();
      this.updateMeta();
      return;
    }
    if (trimmed.startsWith('# ended:')) {
      this.endedAt = trimmed.slice('# ended:'.length).trim();
      this.updateMeta();
      return;
    }

    // TAP plan line: 1..6
    const planMatch = trimmed.match(/^1\.\.(\d+)$/);
    if (planMatch) {
      this.totalExpected = parseInt(planMatch[1], 10) || 0;
      this.updateSummary();
      return;
    }

    // TAP result lines:
    // ok 1 - setup-only
    // not ok 2 - foo
    // ok 3 - bar # SKIP reason
    const resultMatch = trimmed.match(/^(ok|not ok)\s+(\d+)\s+-\s+([^#]+?)(?:\s+#\s+(.+))?$/i);
    if (resultMatch) {
      const ok = resultMatch[1].toLowerCase() === 'ok';
      const num = parseInt(resultMatch[2], 10);
      const name = resultMatch[3].trim();
      const directive = (resultMatch[4] || '').trim().toUpperCase();
      const skipped = directive.startsWith('SKIP');

      const existing = this.testMap.get(num) || {
        num,
        name,
        status: ok ? 'pass' : 'fail',
        skipped,
        message: '',
      };

      existing.name = name;
      existing.status = skipped ? 'skip' : (ok ? 'pass' : 'fail');
      existing.skipped = skipped;

      if (!this.testMap.has(num)) {
        this.tests.push(existing);
        this.testMap.set(num, existing);
      }

      this.renderRows();
      this.updateSummary();
      return;
    }

    // YAML diagnostic message line:
    // message: SERVER_SETUP received with compatible version
    const messageMatch = trimmed.match(/^message:\s*(.+)$/i);
    if (messageMatch && this.tests.length > 0) {
      const last = this.tests[this.tests.length - 1];
      last.message = messageMatch[1].trim();
      this.renderRows();
      return;
    }
  }

  updateMeta() {
    const meta = this.container?.querySelector('#interop-meta');
    if (!meta) return;

    const parts = [];
    if (this.target) parts.push(`Target: ${this.target}`);
    if (this.version) parts.push(`Version: ${this.version}`);
    if (this.startedAt) parts.push(`Started: ${this.startedAt}`);
    if (this.endedAt) parts.push(`Ended: ${this.endedAt}`);

    meta.textContent = parts.length ? parts.join(' | ') : 'Waiting for TAP output...';
  }

  renderRows() {
    const tbody = this.container?.querySelector('#interop-tbody');
    if (!tbody) return;

    const sorted = [...this.tests].sort((a, b) => a.num - b.num);
    tbody.innerHTML = sorted.map((t) => {
      const cls = t.status === 'pass' ? 'status-pass' : (t.status === 'skip' ? '' : 'status-fail');
      const label = t.status === 'pass' ? 'PASS' : (t.status === 'skip' ? 'SKIP' : 'FAIL');
      return `
        <tr class="${cls}">
          <td>${t.num}</td>
          <td>${this.escapeHtml(t.name)}</td>
          <td>${label}</td>
          <td>${this.escapeHtml(t.message || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  updateSummary() {
    const totalEl = this.container?.querySelector('#interop-summary');
    if (!totalEl) return;

    const total = this.totalExpected || this.tests.length;
    const passed = this.tests.filter((t) => t.status === 'pass').length;
    const failed = this.tests.filter((t) => t.status === 'fail').length;
    const skipped = this.tests.filter((t) => t.status === 'skip').length;

    totalEl.innerHTML = `
      <span class="summary-total">Tests: ${total}</span>
      <span class="summary-passed">Passed: ${passed}</span>
      <span class="summary-failed">Failed: ${failed}</span>
      <span class="summary-failed">Skipped: ${skipped}</span>
    `;
  }

  getSummary() {
    const total = this.totalExpected || this.tests.length;
    if (total === 0) return null;
    const passed = this.tests.filter((t) => t.status === 'pass').length;
    const failed = this.tests.filter((t) => t.status === 'fail').length;
    const skipped = this.tests.filter((t) => t.status === 'skip').length;
    return `Interop: ${passed} pass / ${failed} fail / ${skipped} skip`;
  }

  onComplete(exitCode) {
    if (!this.container) return;

    const summary = document.createElement('div');
    summary.className = `renderer-summary ${exitCode === 0 ? 'success' : 'failure'}`;
    summary.textContent = this.getSummary() || (exitCode === 0 ? 'Interop run complete' : 'Interop run failed');
    this.container.appendChild(summary);
  }

  destroy() {
    this.container = null;
    this.tests = [];
    this.testMap = new Map();
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
