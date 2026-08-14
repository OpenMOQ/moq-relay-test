/**
 * Renderer for multi-sub-bench.
 *
 * Live chart: active/complete subscriber count over time (from progress lines).
 * Results section: summary table parsed from the final results block.
 * Pass/fail: all subscribers ok AND avg latency < 100 ms.
 */
import {
  Chart, LineController, LineElement, PointElement,
  LinearScale, CategoryScale,
  Tooltip, Legend,
} from 'https://cdn.jsdelivr.net/npm/chart.js@4/+esm';

Chart.register(
  LineController, LineElement, PointElement,
  LinearScale, CategoryScale,
  Tooltip, Legend,
);

export default class {
  constructor() {
    this.container = null;
    this.chart = null;

    // Live progress tracking  [{ timeLabel, complete, active }]
    this._progress = [];
    this._totalSubs = null;

    // Final results
    this._summary = null;   // { ok, total, errors, resets, objects, objAvg, mbps, mbpsAvg, latency }
  }

  init(containerEl) {
    this.container = containerEl;
    this._progress = [];
    this._totalSubs = null;
    this._summary = null;

    containerEl.innerHTML = `
      <div class="renderer-adaptive">
        <div class="adaptive-chart-wrap">
          <canvas id="msb-canvas"></canvas>
        </div>
        <div id="msb-results"></div>
      </div>
    `;

    const canvas = containerEl.querySelector('#msb-canvas');
    this.chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Complete',
            data: [],
            borderColor: 'rgba(63,185,80,0.9)',
            backgroundColor: 'rgba(63,185,80,0.08)',
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
            fill: false,
            tension: 0.2,
          },
          {
            label: 'Active',
            data: [],
            borderColor: 'rgba(88,166,255,0.8)',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointRadius: 2,
            pointHoverRadius: 4,
            fill: false,
            tension: 0.2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'top',
            labels: {
              color: 'rgba(230,237,243,0.75)',
              boxWidth: 24,
              boxHeight: 2,
              padding: 16,
              font: { size: 11 },
            },
          },
          tooltip: {
            backgroundColor: '#161b22',
            borderColor: '#30363d',
            borderWidth: 1,
            titleColor: '#e6edf3',
            bodyColor: '#7d8590',
            callbacks: {
              label(ctx) {
                const v = ctx.parsed.y;
                if (v == null) return null;
                return ` ${ctx.dataset.label}: ${v}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'category',
            ticks: {
              color: 'rgba(125,133,144,0.9)',
              maxTicksLimit: 12,
              font: { size: 11 },
            },
            grid: { color: 'rgba(255,255,255,0.05)' },
          },
          y: {
            type: 'linear',
            title: {
              display: true,
              text: 'Subscribers',
              color: 'rgba(125,133,144,0.8)',
              font: { size: 11 },
            },
            ticks: { color: 'rgba(125,133,144,0.9)', font: { size: 11 }, precision: 0 },
            grid: { color: 'rgba(255,255,255,0.05)' },
            beginAtZero: true,
          },
        },
      },
    });
  }

  onLine(line) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!stripped) return;

    // "Subscribers:   81/100 ok  (0 errors, 19 resets)"  — check BEFORE subHeader
    const subLine = stripped.match(/^Subscribers:\s*(\d+)\/(\d+)\s+ok\s*\((\d+)\s+errors?,\s*(\d+)\s+resets?\)/i);
    if (subLine) {
      if (!this._summary) this._summary = {};
      this._summary.ok     = parseInt(subLine[1], 10);
      this._summary.total  = parseInt(subLine[2], 10);
      this._summary.errors = parseInt(subLine[3], 10);
      this._summary.resets = parseInt(subLine[4], 10);
      return;
    }

    // "  subscribers:  100" from header block → capture total (plain integer only)
    const subHeader = stripped.match(/^subscribers:\s*(\d+)\s*$/i);
    if (subHeader) { this._totalSubs = parseInt(subHeader[1], 10); return; }
    const prog = stripped.match(/^\[(\d+)s\]\s+(\d+)\/(\d+)\s+complete,\s+(\d+)\s+active/);
    if (prog) {
      const timeLabel  = prog[1] + 's';
      const complete   = parseInt(prog[2], 10);
      const total      = parseInt(prog[3], 10);
      const active     = parseInt(prog[4], 10);
      if (this._totalSubs === null) this._totalSubs = total;
      this._progress.push({ timeLabel, complete, active });
      this._updateChart();
      return;
    }

    // "Total objects: 163,568 (1,636 avg/sub)"
    const objLine = stripped.match(/^Total objects:\s*([\d,]+)\s+\(([\d,]+)\s+avg\/sub\)/i);
    if (objLine) {
      if (!this._summary) this._summary = {};
      this._summary.objects = objLine[1];
      this._summary.objAvg  = objLine[2];
      return;
    }

    // "Total output:  221.30 Mbps (2.21 Mbps/sub)"
    const bwLine = stripped.match(/^Total output:\s*([\d.]+)\s*Mbps\s+\(([\d.]+)\s*Mbps\/sub\)/i);
    if (bwLine) {
      if (!this._summary) this._summary = {};
      this._summary.mbps    = parseFloat(bwLine[1]);
      this._summary.mbpsAvg = parseFloat(bwLine[2]);
      return;
    }

    // "Avg latency:   2039.8 ms"
    const latLine = stripped.match(/^Avg latency:\s*([\d.]+)\s*ms/i);
    if (latLine) {
      if (!this._summary) this._summary = {};
      this._summary.latency = parseFloat(latLine[1]);
      return;
    }
  }

  _updateChart() {
    const { chart, _progress } = this;
    if (!chart) return;
    chart.data.labels              = _progress.map(p => p.timeLabel);
    chart.data.datasets[0].data    = _progress.map(p => p.complete);
    chart.data.datasets[1].data    = _progress.map(p => p.active);
    // Keep y-axis top fixed to totalSubs so drops are visible
    if (this._totalSubs) {
      chart.options.scales.y.max = this._totalSubs + Math.ceil(this._totalSubs * 0.05);
    }
    chart.update('none');
  }

  getSummary() {
    const s = this._summary;
    if (!s) return null;
    const parts = [];
    if (s.ok != null && s.total != null) parts.push(`${s.ok}/${s.total} ok`);
    if (s.mbps != null)    parts.push(`Output: ${s.mbps.toFixed(2)}Mbps`);
    if (s.latency != null) parts.push(`Latency: ${s.latency}ms`);
    return parts.join(', ');
  }

  _passed() {
    const s = this._summary;
    if (!s) return false;
    const allOk    = s.ok != null && s.total != null && s.ok === s.total;
    const lowLat   = s.latency != null && s.latency < 100;
    return allOk && lowLat;
  }

  onComplete(exitCode) {
    if (!this.container) return;
    const s = this._summary;
    const passed = exitCode === 0 && this._passed();
    const cls = passed ? 'success' : (s ? 'failure' : (exitCode === 0 ? 'success' : 'failure'));

    // Final chart update
    this._updateChart();

    // Render results table if we have summary data
    const resultsEl = this.container.querySelector('#msb-results');
    if (resultsEl && s) {
      const rows = [
        ['Subscribers', s.ok != null ? `${s.ok}/${s.total} ok  (${s.errors} errors, ${s.resets} resets)` : '—'],
        ['Total objects', s.objects != null ? `${s.objects} (${s.objAvg} avg/sub)` : '—'],
        ['Total output', s.mbps != null ? `${s.mbps.toFixed(2)} Mbps (${s.mbpsAvg} Mbps/sub)` : '—'],
        ['Avg latency', s.latency != null ? `${s.latency} ms` : '—'],
      ];
      let html = '<table class="metrics-table msb-results-table"><tbody>';
      for (const [k, v] of rows) {
        html += `<tr><td class="metrics-key">${k}</td><td>${v}</td></tr>`;
      }
      html += '</tbody></table>';
      resultsEl.innerHTML = html;
    }

    const summaryEl = document.createElement('div');
    summaryEl.className = `renderer-summary ${cls}`;
    summaryEl.textContent = this.getSummary() || 'Benchmark complete';
    this.container.appendChild(summaryEl);
  }

  destroy() {
    if (this.chart) { this.chart.destroy(); this.chart = null; }
    this.container = null;
    this._progress = [];
    this._summary = null;
  }
}
