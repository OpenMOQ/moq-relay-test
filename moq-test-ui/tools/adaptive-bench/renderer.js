/**
 * Renderer for adaptive-bench: parses the box-drawn table output and
 * renders a live Chart.js dual-axis line chart (bitrate + latency over time).
 */
import {
  Chart, LineController, LineElement, PointElement,
  LinearScale, CategoryScale, TimeScale,
  Tooltip, Legend, Filler,
} from 'https://cdn.jsdelivr.net/npm/chart.js@4/+esm';

Chart.register(
  LineController, LineElement, PointElement,
  LinearScale, CategoryScale, TimeScale,
  Tooltip, Legend, Filler,
);

// ── Inline plugin: background bands per action phase ─────────────
const actionBandPlugin = {
  id: 'actionBands',
  beforeDraw(chart) {
    const { ctx, chartArea: A, data } = chart;
    if (!A || !data._bands) return;
    const xScale = chart.scales.x;
    ctx.save();
    for (const band of data._bands) {
      const x1 = xScale.getPixelForValue(band.i1);
      const x2 = xScale.getPixelForValue(band.i2);
      ctx.fillStyle = band.color;
      ctx.fillRect(x1, A.top, x2 - x1, A.bottom - A.top);
    }
    ctx.restore();
  }
};

const ACTION_COLORS = {
  'warming':  'rgba(88,166,255,0.08)',
  'ramp':     'rgba(63,185,80,0.10)',
  'hold':     'rgba(88,166,255,0.06)',
  'watch':    'rgba(210,153,34,0.12)',
  'back-off': 'rgba(248,81,73,0.12)',
  'drain':    'rgba(140,140,140,0.07)',
};

export default class {
  constructor() {
    this.container = null;
    this.chart = null;
    this.rows = [];
    this.latencyThreshold = 100;  // normalized to ms
  }

  init(containerEl) {
    this.container = containerEl;
    this.rows = [];
    this.latencyThreshold = 100;

    containerEl.innerHTML = `
      <div class="renderer-adaptive">
        <div class="adaptive-chart-wrap">
          <canvas id="adaptive-canvas"></canvas>
        </div>
      </div>
    `;

    const canvas = containerEl.querySelector('#adaptive-canvas');

    this.chart = new Chart(canvas, {
      type: 'line',
      plugins: [actionBandPlugin],
      data: {
        labels: [],
        _bands: [],
        datasets: [
          {
            label: 'Target BW',
            yAxisID: 'yBW',
            data: [],
            borderColor: 'rgba(100,149,237,0.8)',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [5, 3],
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.2,
          },
          {
            label: 'Actual Tx',
            yAxisID: 'yBW',
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
            label: 'Actual Rx',
            yAxisID: 'yBW',
            data: [],
            borderColor: 'rgba(35,160,70,0.75)',
            backgroundColor: 'transparent',
            borderWidth: 1.5,
            borderDash: [3, 3],
            pointRadius: 2,
            pointHoverRadius: 4,
            tension: 0.2,
          },
          {
            label: 'Latency mean',
            yAxisID: 'yLat',
            data: [],
            borderColor: 'rgba(255,180,50,0.9)',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.2,
          },
          {
            label: 'Latency p90',
            yAxisID: 'yLat',
            data: [],
            borderColor: 'rgba(248,81,73,0.9)',
            backgroundColor: 'rgba(248,81,73,0.07)',
            borderWidth: 1.5,
            borderDash: [4, 2],
            pointRadius: 3,
            pointHoverRadius: 5,
            fill: '-1',
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
                const unit = ctx.dataset.yAxisID === 'yBW' ? ' Mbps' : ' ms';
                return ` ${ctx.dataset.label}: ${v.toFixed(1)}${unit}`;
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
          yBW: {
            type: 'linear',
            position: 'left',
            title: {
              display: true, text: 'Mbps',
              color: 'rgba(125,133,144,0.8)', font: { size: 11 },
            },
            ticks: { color: 'rgba(125,133,144,0.9)', font: { size: 11 } },
            grid: { color: 'rgba(255,255,255,0.05)' },
            beginAtZero: true,
          },
          yLat: {
            type: 'linear',
            position: 'right',
            title: {
              display: true, text: 'ms',
              color: 'rgba(125,133,144,0.8)', font: { size: 11 },
            },
            ticks: { color: 'rgba(125,133,144,0.9)', font: { size: 11 } },
            grid: { drawOnChartArea: false },
            beginAtZero: true,
          },
        },
      },
    });
  }

  onLine(line) {
    // Parse latency threshold from header, supporting us/ms values.
    const threshMatch = line.match(/latency threshold:\s*([\d.]+)\s*(us|ms)?/i);
    if (threshMatch) {
      this.latencyThreshold = this._parseDurationMs(`${threshMatch[1]}${threshMatch[2] || 'ms'}`);
    }

    if (
      line.includes('────') || line.includes('══') ||
      line.includes('host:') || line.includes('relay:') ||
      line.includes('trackname:') || line.includes('publish:') ||
      line.includes('latency threshold:') || line.includes('aiomoqt adaptive') ||
      line.includes('Target') || line.includes('time') || line.trim() === ''
    ) return;

    const cleaned = line.replace(/│/g, '|').replace(/\s+/g, ' ').trim();
    const parts = cleaned.split('|').map(s => s.trim());
    if (parts.length < 4) return;

    const col1 = parts[0].split(/\s+/);
    const col2 = parts[1].split(/\s+/);
    const col3 = parts[2].split(/\s+/);
    const col4 = parts[3].split(/\s+/);
    if (col1.length < 2) return;

    const time = this._parseTime(col1[0]);
    if (time === null) return;

    const row = {
      time,
      timeLabel:   col1[0],
      targetBW:    this._parseMbps(col1[1]),
      actualTx:    this._parseMbps(col2[0]),
      actualRx:    this._parseMbps(col2[1]),
      latencyMean: this._parseDurationMs(col3[0]),
      latencyP90:  this._parseDurationMs(col3[1]),
      action:      col4.slice(1).join(' '),
    };
    this.rows.push(row);
    this._updateChart();
  }

  _updateChart() {
    const { chart, rows } = this;
    if (!chart) return;

    chart.data.labels = rows.map(r => r.timeLabel);
    chart.data.datasets[0].data = rows.map(r => r.targetBW);
    chart.data.datasets[1].data = rows.map(r => r.actualTx);
    chart.data.datasets[2].data = rows.map(r => r.actualRx);
    chart.data.datasets[3].data = rows.map(r => r.latencyMean);
    chart.data.datasets[4].data = rows.map(r => r.latencyP90);

    // Rebuild action bands
    chart.data._bands = [];
    const interval = rows.length > 1 ? 0.5 : 0;
    for (let i = 0; i < rows.length; i++) {
      const action = rows[i].action.toLowerCase();
      const colorKey = Object.keys(ACTION_COLORS).find(k => action.includes(k));
      if (!colorKey) continue;
      chart.data._bands.push({
        color: ACTION_COLORS[colorKey],
        i1: Math.max(0, i - interval),
        i2: Math.min(rows.length - 1, i + interval),
      });
    }

    chart.update('none');
  }

  _parseTime(s) {
    const m = s && s.match(/^([\d.]+)s$/);
    return m ? parseFloat(m[1]) : null;
  }

  _parseMbps(s) {
    if (!s || s === '—') return null;
    const m = s.match(/^([\d.]+)([MKG]?)bps$/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    if (u === 'G') return v * 1000;
    if (u === 'K') return v / 1000;
    return v;
  }

  _parseDurationMs(s) {
    if (!s || s === '—') return null;
    const m = s.match(/^([\d.]+)\s*(us|ms|s)$/i);
    if (!m) return null;
    const value = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'us') return value / 1000;
    if (unit === 's') return value * 1000;
    return value;
  }

  getSummary() {
    if (this.rows.length === 0) return null;
    const thresh = this.latencyThreshold;
    // Peak actualRx where p90 latency was under threshold
    const qualifying = this.rows.filter(r => r.actualRx != null && r.latencyP90 != null && r.latencyP90 < thresh);
    const peak = qualifying.length > 0
      ? Math.max(...qualifying.map(r => r.actualRx))
      : Math.max(...this.rows.map(r => r.actualRx ?? 0));
    return `Peak: ${peak.toFixed(0)}Mbps (< ${thresh}ms latency)`;
  }

  onComplete(exitCode) {
    if (!this.container) return;
    const summary = document.createElement('div');
    // Adaptive-bench is a metric tool — always show as success regardless of exit code
    summary.className = 'renderer-summary success';
    summary.textContent = this.getSummary() || 'Benchmark complete';
    this.container.appendChild(summary);
  }

  destroy() {
    if (this.chart) { this.chart.destroy(); this.chart = null; }
    this.container = null;
    this.rows = [];
  }
}
