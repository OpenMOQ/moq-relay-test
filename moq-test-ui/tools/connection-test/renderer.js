/**
 * Renderer for the connection-test tool.
 *
 * Shows [check] progress lines live, then replaces them with a structured
 * 7-row results table once the JSON report arrives.
 */
export default class {
  constructor() {
    this.container = null;
    this.buffer    = [];
    this._report   = null;
    this._rows     = new Map();
    this._testsData = {};

    // Test metadata — defines display order, labels, and warn-ok semantics
    this.TESTS = [
      { key: 'dns',          label: 'DNS',                warnOk: false },
      { key: 'ping',         label: 'ICMP Ping',          warnOk: true  },
      { key: 'tcp',          label: 'TCP Connect',        warnOk: true  },
      { key: 'h3_insecure',  label: 'H3 (insecure)',      warnOk: false },
      { key: 'h3_secure',    label: 'H3 (TLS verified)',  warnOk: false },
      { key: 'quic_insecure',label: 'QUIC (insecure)',    warnOk: false },
      { key: 'quic_secure',  label: 'QUIC (TLS verified)', warnOk: false },
    ];
    this._labelToKey = new Map(this.TESTS.map(t => [t.label, t.key]));
  }

  init(containerEl) {
    this.container = containerEl;
    this.buffer    = [];
    this._report   = null;
    this._rows.clear();
    this._testsData = {};
    containerEl.innerHTML = `
      <div class="renderer-conn">
        <div id="conn-results"></div>
      </div>`;
    this._renderSkeleton();
  }

  onLine(line) {
    this.buffer.push(line);
    this._consumeCheckLine(line);
    this._tryParse();
  }

  _renderSkeleton() {
    const el = this.container?.querySelector('#conn-results');
    if (!el) return;

    let html = '<table class="metrics-table conn-checks-table">';
    html += '<thead><tr><th>#</th><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>';

    this.TESTS.forEach(({ key, label }, idx) => {
      html += `<tr class="status-running" data-test-key="${key}">
        <td class="conn-muted" style="width:2rem">${idx + 1}</td>
        <td>${label}</td>
        <td>${this._icon('running')} running</td>
        <td class="conn-detail">waiting…</td>
      </tr>`;
    });

    html += '</tbody></table>';
    el.innerHTML = html;

    this.TESTS.forEach(({ key }) => {
      const row = el.querySelector(`tr[data-test-key="${key}"]`);
      if (row) this._rows.set(key, row);
    });
  }

  _consumeCheckLine(line) {
    if (!line.startsWith('[check]')) return;
    const parsed = this._parseCheckLine(line);
    if (!parsed) return;

    const { key, status, detail, latency_ms } = parsed;
    const next = { status };
    if (detail) next.detail = detail;
    if (latency_ms !== null) next.latency_ms = latency_ms;

    const prev = this._testsData[key] || {};
    this._testsData[key] = { ...prev, ...next };
    this._updateRow(key, this._testsData[key]);
  }

  _parseCheckLine(line) {
    const m = line.match(/^\[check\]\s+([✓⚠✗—])\s+(.+)$/);
    if (!m) return null;

    const statusByIcon = { '✓': 'pass', '⚠': 'warn', '✗': 'fail', '—': 'skip' };
    const status = statusByIcon[m[1]] || 'skip';
    let tail = m[2].trim();

    let key = null;
    let label = null;
    for (const test of this.TESTS) {
      if (tail.startsWith(test.label)) {
        key = test.key;
        label = test.label;
        break;
      }
    }
    if (!key || !label) return null;

    tail = tail.slice(label.length).trim();
    let detail = '';
    let latency_ms = null;

    const latMatch = tail.match(/^(\d+(?:\.\d+)?)\s*ms\b/);
    if (latMatch) {
      latency_ms = Number(latMatch[1]);
      tail = tail.slice(latMatch[0].length).trim();
    }

    if (tail.startsWith(':')) {
      detail = tail.slice(1).trim();
    } else if (tail) {
      detail = tail;
    }

    return { key, status, detail, latency_ms };
  }

  _tryParse() {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const line = this.buffer[i].trim();
      if (!line.startsWith('{')) continue;
      try {
        const data = JSON.parse(line);
        if (data.tests && data.summary) {
          this._report = data;
          this._testsData = { ...this._testsData, ...(data.tests || {}) };
          this._render(data);
          return;
        }
      } catch (_) {}
    }
  }

  _icon(status) {
    const map = { pass: ['conn-pass','✓'], warn: ['conn-warn','⚠'],
                  fail: ['conn-fail','✗'], skip: ['conn-muted','—'], running: ['conn-muted','…'] };
    const [cls, glyph] = map[status] || ['conn-muted','?'];
    return `<span class="conn-icon ${cls}">${glyph}</span>`;
  }

  _render(data) {
    const t = data.tests || {};
    this.TESTS.forEach(({ key }) => {
      if (!t[key]) return;
      this._updateRow(key, t[key]);
    });
  }

  _updateRow(key, result) {
    const row = this._rows.get(key);
    if (!row || !result?.status) return;

    const meta = this.TESTS.find(t => t.key === key);
    const warnOk = Boolean(meta?.warnOk);
    const status = result.status;
    const rowOk = status === 'pass' || status === 'skip' || (warnOk && status === 'warn');
    row.className = rowOk ? 'status-pass' : 'status-fail';

    const statusCell = row.children[2];
    const detailCell = row.children[3];
    if (statusCell) statusCell.innerHTML = `${this._icon(status)} ${status}`;
    if (detailCell) detailCell.textContent = this._detail(result);
  }

  _detail(r) {
    const parts = [];
    if (r.ips)        parts.push(r.ips.join(', '));
    if (r.avg_ms)     parts.push(`avg ${r.avg_ms} ms`);
    if ('received' in r) parts.push(`${r.received}/${r.sent} replies`);
    if (r.latency_ms) parts.push(`${r.latency_ms} ms`);
    if (r.note)       parts.push(r.note);
    if (r.error)      parts.push(r.error);
    if (r.detail)     parts.push(r.detail);
    return parts.join(' — ') || '—';
  }

  getSummary() {
    const s = this._report?.summary || this._computeSummary();
    const parts = [];
    if (s.pass) parts.push(`${s.pass} passed`);
    if (s.warn) parts.push(`${s.warn} warned`);
    if (s.fail) parts.push(`${s.fail} failed`);
    if (s.skip) parts.push(`${s.skip} skipped`);
    return parts.join('  ·  ') || 'done';
  }

  _computeSummary() {
    const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
    for (const key of Object.keys(this._testsData)) {
      const status = this._testsData[key]?.status;
      if (!status || counts[status] === undefined) continue;
      counts[status] += 1;
    }
    return counts;
  }

  onComplete(exitCode) {
    if (!this.container) return;
    this._tryParse();
    const div = document.createElement('div');
    div.className = `renderer-summary ${exitCode === 0 ? 'success' : 'failure'}`;
    div.textContent = this.getSummary() || (exitCode === 0 ? 'Tests passed' : 'Tests failed');
    this.container.appendChild(div);
  }

  destroy() {
    this.container = null;
    this.buffer    = [];
    this._report   = null;
    this._rows.clear();
    this._testsData = {};
  }
}
