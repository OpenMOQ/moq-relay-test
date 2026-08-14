/**
 * Renderer for interop tests: tracks test pass/fail, shows progress table.
 */
export default class {
  constructor() {
    this.container = null;
    this.tests = [];
    this.currentTest = null;
    this.totalExpected = 0;
    this.passed = 0;
    this.failed = 0;
  }

  init(containerEl) {
    this.container = containerEl;
    this.tests = [];
    this.currentTest = null;
    this.totalExpected = 0;
    this.passed = 0;
    this.failed = 0;

    containerEl.innerHTML = `
      <div class="renderer-interop">
        <h4>Interop Test Progress</h4>
        <div class="interop-summary" id="interop-summary">
          <span class="muted">Waiting for tests...</span>
        </div>
        <table class="metrics-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Test Name</th>
              <th>Description</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="interop-tbody"></tbody>
        </table>
      </div>
    `;
  }

  onLine(line) {
    const trimmed = line.trim();

    // "Found 10 test(s) to run"
    const countMatch = trimmed.match(/Found (\d+) test\(s\) to run/);
    if (countMatch) {
      this.totalExpected = parseInt(countMatch[1]);
      this.updateSummary();
      return;
    }

    // "=== Running Test: GoawayTest ==="
    const startMatch = trimmed.match(/^=== Running Test: (\S+) ===$/);
    if (startMatch) {
      this.currentTest = {
        num: this.tests.length + 1,
        name: startMatch[1],
        description: '',
        status: 'running',
      };
      this.tests.push(this.currentTest);
      this.appendTestRow(this.currentTest);
      this.updateSummary();
      return;
    }

    // "Description: ..."
    const descMatch = trimmed.match(/^Description: (.+)$/);
    if (descMatch && this.currentTest) {
      this.currentTest.description = descMatch[1];
      this.updateTestRow(this.currentTest);
      return;
    }

    // "[GoawayTest] Test PASSED" or "GoawayTest PASSED"
    const passMatch = trimmed.match(/^\[?(\S+?)\]?\s+Test\s+PASSED$/) || trimmed.match(/^(\S+)\s+PASSED$/);
    if (passMatch && this.currentTest && passMatch[1] === this.currentTest.name) {
      if (this.currentTest.status === 'running') {
        this.currentTest.status = 'pass';
        this.passed++;
        this.updateTestRow(this.currentTest);
        this.updateSummary();
      }
      return;
    }

    // "[GoawayTest] Test FAILED" or "GoawayTest FAILED" or "[TrackStatusTest] Test ERROR: ..."
    const failMatch = trimmed.match(/^\[?(\S+?)\]?\s+Test\s+(?:FAILED|ERROR)[:\s]*(.*)$/) || trimmed.match(/^(\S+)\s+(?:FAILED|ERROR)[:\s]*(.*)$/);
    if (failMatch && this.currentTest && failMatch[1] === this.currentTest.name) {
      if (this.currentTest.status === 'running') {
        this.currentTest.status = 'fail';
        this.currentTest.reason = failMatch[2]?.trim() || '';
        this.failed++;
        this.updateTestRow(this.currentTest);
        this.updateSummary();
      }
      return;
    }
  }

  appendTestRow(test) {
    const tbody = this.container?.querySelector('#interop-tbody');
    if (!tbody) return;
    const tr = document.createElement('tr');
    tr.id = `interop-row-${test.num}`;
    tr.className = 'status-running';
    tr.innerHTML = `
      <td>${test.num}</td>
      <td>${test.name}</td>
      <td class="test-desc">${test.description}</td>
      <td class="test-status">◉ Running</td>
    `;
    tbody.appendChild(tr);
  }

  updateTestRow(test) {
    const tr = this.container?.querySelector(`#interop-row-${test.num}`);
    if (!tr) return;
    tr.className = test.status === 'pass' ? 'status-pass' : (test.status === 'fail' ? 'status-fail' : 'status-running');
    const statusCell = tr.querySelector('.test-status');
    const descCell = tr.querySelector('.test-desc');
    if (descCell) descCell.textContent = test.description;
    if (test.status === 'pass') {
      statusCell.textContent = '✓ PASSED';
    } else if (test.status === 'fail') {
      statusCell.textContent = `✗ FAILED${test.reason ? ': ' + test.reason : ''}`;
    }
  }

  updateSummary() {
    const el = this.container?.querySelector('#interop-summary');
    if (!el) return;
    const running = this.tests.filter(t => t.status === 'running').length;
    el.innerHTML = `
      <span class="summary-total">Tests: ${this.tests.length}${this.totalExpected ? '/' + this.totalExpected : ''}</span>
      <span class="summary-passed">Passed: ${this.passed}</span>
      <span class="summary-failed">Failed: ${this.failed}</span>
      ${running > 0 ? `<span class="summary-running">Running: ${running}</span>` : ''}
    `;
  }

  getSummary() {
    if (this.tests.length === 0) return null;
    return `Tests: ${this.passed} pass / ${this.failed} fail`;
  }

  onComplete(exitCode) {
    if (!this.container) return;
    const summary = document.createElement('div');
    summary.className = `renderer-summary ${this.failed === 0 && exitCode === 0 ? 'success' : 'failure'}`;
    summary.textContent = this.getSummary() || 'Complete';
    this.container.appendChild(summary);
  }

  destroy() {
    this.container = null;
    this.tests = [];
    this.currentTest = null;
  }
}
