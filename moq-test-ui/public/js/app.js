import { WsClient } from './ws-client.js';
import { ParamForm } from './param-form.js';
import { OutputPanel } from './output-panel.js';
import { RendererLoader } from './renderer-loader.js';
import { SelfTestUI } from './self-test-ui.js';
import { HistoryUI } from './history-ui.js';

class App {
  constructor() {
    this.tools = [];
    this.selectedTool = null;
    this.currentRunId = null;
    this.runStateByTool = new Map(); // toolName -> { runId, status, lines, exitCode }
    this.toolByRunId = new Map();    // runId -> toolName
    this.paramForm = new ParamForm();
    this.outputPanel = new OutputPanel();
    this.rendererLoader = new RendererLoader();
    this.selfTestUI = new SelfTestUI();
    this.historyUI = new HistoryUI();

    this.ws = new WsClient();
    this.ws.on('session', (data) => this.onSession(data));
    this.ws.on('tools-list', (data) => this.onToolsList(data));
    this.ws.on('run-started', (data) => this.onRunStarted(data));
    this.ws.on('output', (data) => this.onOutput(data));
    this.ws.on('run-complete', (data) => this.onRunComplete(data));
    this.ws.on('run-error', (data) => this.onRunError(data));
    this.ws.on('run-stopped', (data) => this.onRunStopped(data));
    this.ws.on('self-test-progress', (data) => this.selfTestUI.onProgress(data));
    this.ws.on('self-test-complete', (data) => this.selfTestUI.onComplete(data));
    this.ws.on('results-list', (data) => this.historyUI.onResultsList(data));
    this.ws.on('result-data', (data) => this.historyUI.onResultData(data));
    this.ws.on('connected', () => this.onConnected());
    this.ws.on('disconnected', () => this.onDisconnected());

    this.bindUI();
    this.ws.connect();
  }

  bindUI() {
    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchView(btn.dataset.view));
    });

    // Show CLI output toggle
    document.getElementById('show-cli-output').addEventListener('change', () => this.applyCliOutputVisibility());

    // Run / Stop
    document.getElementById('btn-run').addEventListener('click', () => this.startRun());
    document.getElementById('btn-stop').addEventListener('click', () => this.stopRun());
    document.getElementById('btn-clear-output').addEventListener('click', () => this.clearSelectedOutput());

    // Self-test
    document.getElementById('self-test-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.startSelfTest();
    });
    document.getElementById('btn-self-test-stop').addEventListener('click', () => this.stopSelfTest());

    // History
    document.getElementById('btn-refresh-history').addEventListener('click', () => {
      this.ws.send('list-results', { tool: document.getElementById('history-tool-filter').value || undefined });
    });
    document.getElementById('history-tool-filter').addEventListener('change', () => {
      this.ws.send('list-results', { tool: document.getElementById('history-tool-filter').value || undefined });
    });
    this.historyUI.onViewResult = (tool, filename) => {
      this.ws.send('get-result', { tool, filename });
    };
  }

  switchView(view) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.nav-btn[data-view="${view}"]`).classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById(`view-${view}`).classList.remove('hidden');

    if (view === 'history') {
      this.ws.send('list-results', {});
    }
  }

  onConnected() {
    const dot = document.getElementById('connection-status');
    dot.classList.remove('disconnected');
    dot.classList.add('connected');
    dot.title = 'Connected';
    this.ws.send('list-tools', {});
  }

  onDisconnected() {
    const dot = document.getElementById('connection-status');
    dot.classList.remove('connected');
    dot.classList.add('disconnected');
    dot.title = 'Disconnected';
  }

  onSession(data) {
    this.sessionId = data.sessionId;
  }

  onToolsList(data) {
    this.tools = data.tools;
    this.renderToolList();
    this.selfTestUI.setTools(this.tools);
    this.historyUI.setTools(this.tools);
  }

  renderToolList() {
    const container = document.getElementById('tool-list');
    container.innerHTML = '';

    const CATEGORY_ORDER = ['diagnostics', 'conformance', 'performance'];
    const grouped = {};
    for (const tool of this.tools) {
      const cat = (tool.category || 'other').toLowerCase();
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(tool);
    }

    // Sort tools within each category by their declared order, then alphabetically
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.displayName.localeCompare(b.displayName));
    }

    const order = [
      ...CATEGORY_ORDER.filter(c => grouped[c]),
      ...Object.keys(grouped).filter(c => !CATEGORY_ORDER.includes(c)),
    ];

    for (const cat of order) {
      const header = document.createElement('div');
      header.className = 'tool-list-section';
      header.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
      container.appendChild(header);

      for (const tool of grouped[cat]) {
        const card = document.createElement('div');
        card.className = 'tool-card';
        card.dataset.tool = tool.name;
        card.innerHTML = `<div class="tool-card-name">${tool.displayName}</div>`;
        card.addEventListener('click', () => this.selectTool(tool.name));
        container.appendChild(card);
      }
    }
  }

  selectTool(name) {
    this.selectedTool = this.tools.find(t => t.name === name);
    if (!this.selectedTool) return;

    // Highlight selected card
    document.querySelectorAll('.tool-card').forEach(c => c.classList.remove('selected'));
    document.querySelector(`.tool-card[data-tool="${name}"]`)?.classList.add('selected');

    // Show tool panel
    document.getElementById('no-tool-selected').classList.add('hidden');
    const panel = document.getElementById('tool-panel');
    panel.classList.remove('hidden');

    document.getElementById('tool-title').textContent = this.selectedTool.displayName;
    document.getElementById('tool-description').textContent = this.selectedTool.description || '';

    this.paramForm.render(this.selectedTool.parameters, document.getElementById('param-form'));
    this.outputPanel.setFilters(this.selectedTool.filters);
    this.rendererLoader.unload();

    document.getElementById('show-cli-output').checked = false;
    this.restoreSelectedToolView();
    this.applyCliOutputVisibility();
  }

  startRun() {
    if (!this.selectedTool) return;
    const params = this.paramForm.getValues();
    if (!params) return; // Validation failed

    const state = this.getOrCreateToolState(this.selectedTool.name);
    state.lines = [];
    state.runId = null;
    state.status = 'starting';
    state.exitCode = null;

    this.ws.send('start-run', { toolId: this.selectedTool.name, params });
    document.getElementById('output-section').classList.remove('hidden');
    this.outputPanel.clear();
    this.updateRunButtonsForSelectedTool();
    this.updateActiveRuns();
  }

  stopRun() {
    if (!this.selectedTool) return;
    const state = this.runStateByTool.get(this.selectedTool.name);
    if (!state?.runId) return;
    if (state.status === 'stopping' || state.status === 'starting') return;

    state.status = 'stopping';
    this.updateRunButtonsForSelectedTool();
    this.updateActiveRuns();
    this.ws.send('stop-run', { runId: state.runId });
  }

  onRunStarted(data) {
    const toolName = data.toolId;
    if (!toolName) return;

    const state = this.getOrCreateToolState(toolName);
    state.runId = data.runId;
    state.status = 'running';
    state.exitCode = null;
    this.toolByRunId.set(data.runId, toolName);

    if (this.selectedTool?.name === toolName) {
      this.currentRunId = data.runId;
      document.getElementById('output-section').classList.remove('hidden');

      // Load renderer if selected tool has one
      if (this.selectedTool.hasRenderer) {
        this.rendererLoader.load(this.selectedTool.name, document.getElementById('renderer-container'));
        document.getElementById('renderer-container').classList.remove('hidden');
      }

      this.updateRunButtonsForSelectedTool();
    }

    this.updateActiveRuns();
  }

  onOutput(data) {
    const toolName = this.toolByRunId.get(data.runId);
    if (!toolName) return;

    const state = this.getOrCreateToolState(toolName);
    state.lines.push({ type: 'line', line: data.line, ts: data.ts });

    if (this.selectedTool?.name === toolName) {
      this.outputPanel.appendLine(data.line, data.ts);
      this.rendererLoader.onLine(data.line);
    }
  }

  onRunComplete(data) {
    this.finalizeRunState(data.runId, {
      status: 'complete',
      exitCode: data.exitCode,
      systemText: `\n--- Run complete (exit code: ${data.exitCode}) ---`,
    });

    if (data.runId && this.selectedTool && this.currentRunId === data.runId) {
      this.outputPanel.appendSystem(`\n--- Run complete (exit code: ${data.exitCode}) ---`);
      this.rendererLoader.onComplete(data.exitCode);
      this.currentRunId = null;
      this.updateRunButtonsForSelectedTool();
    }

    this.updateActiveRuns();
  }

  onRunError(data) {
    if (!data.runId) {
      if (this.selectedTool) {
        const state = this.getOrCreateToolState(this.selectedTool.name);
        state.status = 'idle';
        state.exitCode = null;
        state.lines.push({ type: 'system', text: `\n--- Error: ${data.error} ---` });
        this.restoreSelectedToolView();
      }
      this.updateActiveRuns();
      return;
    }

    this.finalizeRunState(data.runId, {
      status: 'error',
      exitCode: null,
      systemText: `\n--- Error: ${data.error} ---`,
    });

    if (this.selectedTool && data.runId && this.currentRunId === data.runId) {
      this.outputPanel.appendSystem(`\n--- Error: ${data.error} ---`);
      this.currentRunId = null;
      this.updateRunButtonsForSelectedTool();
    }

    this.updateActiveRuns();
  }

  onRunStopped(data) {
    this.finalizeRunState(data.runId, {
      status: 'stopped',
      exitCode: null,
      systemText: '\n--- Run stopped ---',
    });

    if (data.runId && this.selectedTool && this.currentRunId === data.runId) {
      this.outputPanel.appendSystem('\n--- Run stopped ---');
      this.currentRunId = null;
      this.updateRunButtonsForSelectedTool();
    }

    this.updateActiveRuns();
  }

  updateActiveRuns() {
    const list = document.getElementById('active-runs-list');
    const runs = [];
    for (const [tool, state] of this.runStateByTool.entries()) {
      if (state.status === 'starting' || state.status === 'running' || state.status === 'stopping') {
        runs.push({ runId: state.runId, tool, status: state.status });
      }
    }
    if (runs.length === 0) {
      list.innerHTML = '<p class="muted">No active runs</p>';
    } else {
      list.innerHTML = runs.map(r => {
        const runLabel = r.runId ? r.runId.slice(0, 8) : 'starting';
        const title = `Switch to ${r.tool}`;
        return `<button type="button" class="active-run" data-tool="${r.tool}" title="${title}">${r.tool} <span class="run-id">${runLabel}</span></button>`;
      }).join('');

      list.querySelectorAll('.active-run[data-tool]').forEach((el) => {
        el.addEventListener('click', () => {
          const tool = el.dataset.tool;
          if (tool) this.selectTool(tool);
        });
      });
    }
  }

  getOrCreateToolState(toolName) {
    if (!this.runStateByTool.has(toolName)) {
      this.runStateByTool.set(toolName, {
        runId: null,
        status: 'idle',
        lines: [],
        exitCode: null,
      });
    }
    return this.runStateByTool.get(toolName);
  }

  finalizeRunState(runId, { status, exitCode, systemText }) {
    if (!runId) return;
    const toolName = this.toolByRunId.get(runId);
    if (!toolName) return;

    const state = this.getOrCreateToolState(toolName);
    state.status = status;
    state.exitCode = exitCode;
    if (systemText) {
      state.lines.push({ type: 'system', text: systemText });
    }

    this.toolByRunId.delete(runId);
  }

  applyCliOutputVisibility() {
    const show = document.getElementById('show-cli-output').checked;
    document.getElementById('terminal-container').classList.toggle('hidden', !show);
    document.getElementById('cli-debug-controls').classList.toggle('hidden', !show);
  }

  clearSelectedOutput() {
    if (!this.selectedTool) return;
    const state = this.getOrCreateToolState(this.selectedTool.name);
    state.lines = [];
    this.outputPanel.clear();
  }

  restoreSelectedToolView() {
    if (!this.selectedTool) return;

    const state = this.runStateByTool.get(this.selectedTool.name);
    const hasLines = Boolean(state && state.lines.length > 0);
    const isRunning = Boolean(state && (state.status === 'starting' || state.status === 'running' || state.status === 'stopping'));

    document.getElementById('output-section').classList.toggle('hidden', !hasLines && !isRunning);
    this.updateRunButtonsForSelectedTool();

    this.currentRunId = isRunning ? state.runId : null;

    this.outputPanel.clear();
    this.rendererLoader.unload();

    const rendererContainer = document.getElementById('renderer-container');
    rendererContainer.classList.add('hidden');

    if (!state) return;

    if (this.selectedTool.hasRenderer) {
      this.rendererLoader.load(this.selectedTool.name, rendererContainer).then(() => {
        for (const entry of state.lines) {
          if (entry.type === 'line') {
            this.rendererLoader.onLine(entry.line);
          }
        }
        if (state.status !== 'starting' && state.status !== 'running' && state.exitCode !== null) {
          this.rendererLoader.onComplete(state.exitCode);
        }
      });
      rendererContainer.classList.remove('hidden');
    }

    for (const entry of state.lines) {
      if (entry.type === 'line') {
        this.outputPanel.appendLine(entry.line, entry.ts);
      } else if (entry.type === 'system') {
        this.outputPanel.appendSystem(entry.text);
      }
    }
  }

  updateRunButtonsForSelectedTool() {
    const runBtn = document.getElementById('btn-run');
    const stopBtn = document.getElementById('btn-stop');
    if (!runBtn || !stopBtn) return;

    const state = this.selectedTool ? this.runStateByTool.get(this.selectedTool.name) : null;
    const isBusy = Boolean(state && (state.status === 'starting' || state.status === 'running' || state.status === 'stopping'));
    const isStopping = Boolean(state && state.status === 'stopping');

    runBtn.classList.toggle('hidden', isBusy);
    stopBtn.classList.toggle('hidden', !isBusy);
    stopBtn.disabled = isStopping;
    stopBtn.textContent = isStopping ? 'Stopping...' : 'Stop';
  }

  startSelfTest() {
    const relayUrl = document.getElementById('st-relay-url').value;
    const transport = document.getElementById('st-transport').value;
    const draft = document.getElementById('st-draft').value;
    this.ws.send('start-self-test', { relayUrl, transport, draft });
    document.getElementById('btn-self-test-run').classList.add('hidden');
    document.getElementById('btn-self-test-stop').classList.remove('hidden');
    this.selfTestUI.start();
  }

  stopSelfTest() {
    if (this.selfTestUI.selfTestId) {
      this.ws.send('stop-self-test', { selfTestId: this.selfTestUI.selfTestId });
    }
    document.getElementById('btn-self-test-run').classList.remove('hidden');
    document.getElementById('btn-self-test-stop').classList.add('hidden');
  }
}

// Boot
new App();
