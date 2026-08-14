/**
 * Renderer for conformance tests: tracks test progress, shows pass/fail table,
 * and section summaries.
 */
export default class {
  constructor() {
    this.container = null;
    this.tests = [];
    this.currentTest = null;
    this.currentSection = null;
    this.sections = new Map();
    this.totalTests = 0;
    this.passed = 0;
    this.failed = 0;
  }

  init(containerEl) {
    this.container = containerEl;
    this.tests = [];
    this.currentTest = null;
    this.currentSection = null;
    this.sections = new Map();
    this.totalTests = 0;
    this.passed = 0;
    this.failed = 0;

    containerEl.innerHTML = `
      <div class="renderer-conformance">
        <h4>Conformance Test Progress</h4>
        <div class="conformance-summary" id="conformance-summary">
          <span class="summary-total">Tests: 0</span>
          <span class="summary-passed">Passed: 0</span>
          <span class="summary-failed">Failed: 0</span>
        </div>
        <div id="conformance-sections"></div>
        <table class="metrics-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Test Name</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="conformance-tbody"></tbody>
        </table>
      </div>
    `;
  }

  onLine(line) {
    const trimmed = line.trim();

    // Detect section headers: "=== SECTION 1: Basic Forwarding Preferences ==="
    const sectionMatch = trimmed.match(/^=== SECTION (\d+): (.+) ===$/);
    if (sectionMatch) {
      this.currentSection = { id: sectionMatch[1], name: sectionMatch[2], passed: 0, failed: 0 };
      this.sections.set(sectionMatch[1], this.currentSection);
      return;
    }

    // Detect test start: "[Test 1] Basic subscribe with default parameters"
    const testMatch = trimmed.match(/^\[Test (\d+)\] (.+)$/);
    if (testMatch) {
      this.currentTest = {
        num: parseInt(testMatch[1]),
        name: testMatch[2],
        status: 'running',
        section: this.currentSection?.id,
      };
      this.tests.push(this.currentTest);
      this.totalTests++;
      this.appendTestRow(this.currentTest);
      this.updateSummary();
      return;
    }

    // Detect pass: "  ✓ PASSED"
    if (trimmed.startsWith('✓ PASSED') || trimmed === '✓ PASSED') {
      if (this.currentTest) {
        this.currentTest.status = 'pass';
        this.passed++;
        if (this.currentSection) this.currentSection.passed++;
        this.updateTestRow(this.currentTest);
        this.updateSummary();
      }
      return;
    }

    // Detect fail: "  ✗ FAILED: reason"
    if (trimmed.startsWith('✗ FAILED')) {
      if (this.currentTest) {
        this.currentTest.status = 'fail';
        this.currentTest.reason = trimmed.replace('✗ FAILED:', '').trim();
        this.failed++;
        if (this.currentSection) this.currentSection.failed++;
        this.updateTestRow(this.currentTest);
        this.updateSummary();
      }
      return;
    }
  }

  appendTestRow(test) {
    const tbody = this.container?.querySelector('#conformance-tbody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.id = `test-row-${test.num}`;
    tr.className = 'status-running';
    tr.innerHTML = `
      <td>${test.num}</td>
      <td>${test.name}</td>
      <td class="test-status">◉ Running</td>
    `;
    tbody.appendChild(tr);
  }

  updateTestRow(test) {
    const tr = this.container?.querySelector(`#test-row-${test.num}`);
    if (!tr) return;
    tr.className = test.status === 'pass' ? 'status-pass' : 'status-fail';
    const statusCell = tr.querySelector('.test-status');
    if (test.status === 'pass') {
      statusCell.textContent = '✓ PASSED';
    } else {
      statusCell.textContent = `✗ FAILED${test.reason ? ': ' + test.reason : ''}`;
    }
  }

  updateSummary() {
    const el = this.container?.querySelector('#conformance-summary');
    if (!el) return;
    el.innerHTML = `
      <span class="summary-total">Tests: ${this.totalTests}</span>
      <span class="summary-passed">Passed: ${this.passed}</span>
      <span class="summary-failed">Failed: ${this.failed}</span>
    `;
  }

  getSummary() {
    if (this.totalTests === 0) return null;
    return `Tests: ${this.passed} pass / ${this.failed} fail`;
  }

  onComplete(exitCode) {
    if (!this.container) return;

    // Render section summary
    const sectionsEl = this.container.querySelector('#conformance-sections');
    if (sectionsEl && this.sections.size > 0) {
      let html = '<div class="section-summary"><h5>Results by Section</h5>';
      for (const [id, sec] of this.sections) {
        const total = sec.passed + sec.failed;
        const pct = total > 0 ? Math.round((sec.passed / total) * 100) : 0;
        const cls = sec.failed === 0 ? 'section-pass' : 'section-fail';
        html += `<div class="${cls}">Section ${id}: ${sec.name} — ${sec.passed}/${total} (${pct}%)</div>`;
      }
      html += '</div>';
      sectionsEl.innerHTML = html;
    }

    const summary = document.createElement('div');
    summary.className = `renderer-summary ${this.failed === 0 && exitCode === 0 ? 'success' : 'failure'}`;
    summary.textContent = this.getSummary() || 'Complete';
    this.container.appendChild(summary);
  }

  destroy() {
    this.container = null;
    this.tests = [];
    this.currentTest = null;
    this.currentSection = null;
    this.sections = new Map();
  }
}
