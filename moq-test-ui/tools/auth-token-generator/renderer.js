/**
 * Renderer for auth-token-generator.
 *
 * Watches stdout for the generated token, displays it in a read-only field,
 * and provides a clipboard copy action.
 */
export default class {
  constructor() {
    this.container = null;
    this.buffer = [];
    this._token = null;
    this._statusEl = null;
    this._tokenEl = null;
    this._copyBtn = null;
    this._liveEl = null;
    this._copyResetTimer = null;
  }

  init(containerEl) {
    this.container = containerEl;
    this.buffer = [];
    this._token = null;
    this._clearCopyTimer();

    containerEl.innerHTML = `
      <div class="renderer-auth-token">
        <div class="auth-token-card">
          <div class="auth-token-card__header">
            <div>
              <div class="auth-token-title">Generated Token</div>
              <div class="auth-token-subtitle" id="auth-token-status">Waiting for output…</div>
            </div>
            <button class="btn btn-small btn-primary" id="auth-token-copy" type="button" disabled>Copy token</button>
          </div>
          <textarea id="auth-token-value" class="auth-token-value" rows="5" readonly placeholder="Token will appear here"></textarea>
        </div>
        <div class="auth-token-live" id="auth-token-live"></div>
      </div>`;

    this._statusEl = containerEl.querySelector('#auth-token-status');
    this._tokenEl = containerEl.querySelector('#auth-token-value');
    this._copyBtn = containerEl.querySelector('#auth-token-copy');
    this._liveEl = containerEl.querySelector('#auth-token-live');

    if (this._copyBtn) {
      this._copyBtn.addEventListener('click', () => this._copyToken());
    }
  }

  onLine(line) {
    this.buffer.push(line);
    if (this._liveEl && !this._token && line.trim()) {
      const row = document.createElement('div');
      row.className = 'auth-token-live-line';
      row.textContent = line;
      this._liveEl.appendChild(row);
    }

    if (!this._token) {
      const token = this._extractToken(line);
      if (token) {
        this._setToken(token);
      }
    }
  }

  _extractToken(line) {
    const trimmed = String(line).trim();
    const tokenMatch = trimmed.match(/^(base64:[A-Za-z0-9+/=]+)$/);
    if (tokenMatch) return tokenMatch[1];

    if (trimmed && /[A-Za-z0-9+/=]{40,}$/.test(trimmed) && !trimmed.includes(' ')) {
      return trimmed;
    }

    return null;
  }

  _setToken(token) {
    this._token = token;
    if (this._tokenEl) {
      this._tokenEl.value = token;
      this._tokenEl.setSelectionRange(0, 0);
    }
    if (this._liveEl) {
      this._liveEl.innerHTML = '';
      this._liveEl.style.display = 'none';
    }
    if (this._copyBtn) this._copyBtn.disabled = false;
    if (this._statusEl) this._statusEl.textContent = 'Token ready';
  }

  async _copyToken() {
    if (!this._token) return;
    try {
      await navigator.clipboard.writeText(this._token);
      if (this._copyBtn) this._copyBtn.textContent = 'Copied';
      if (this._statusEl) this._statusEl.textContent = 'Token copied to clipboard';
      this._clearCopyTimer();
      this._copyResetTimer = setTimeout(() => {
        if (this._copyBtn) this._copyBtn.textContent = 'Copy token';
      }, 1500);
    } catch (err) {
      if (this._statusEl) this._statusEl.textContent = `Copy failed: ${err.message}`;
    }
  }

  _clearCopyTimer() {
    if (this._copyResetTimer) {
      clearTimeout(this._copyResetTimer);
      this._copyResetTimer = null;
    }
  }

  getSummary() {
    if (!this._token) return null;
    return `Token generated (${this._token.length} chars)`;
  }

  onComplete(exitCode) {
    if (!this.container) return;

    if (!this._token) {
      const lastToken = [...this.buffer].reverse().map(line => this._extractToken(line)).find(Boolean);
      if (lastToken) this._setToken(lastToken);
    }

    if (this._statusEl && !this._token) {
      this._statusEl.textContent = exitCode === 0 ? 'Command finished without a token' : 'Token generation failed';
    }

    const summary = document.createElement('div');
    summary.className = `renderer-summary ${exitCode === 0 && this._token ? 'success' : 'failure'}`;
    summary.textContent = this.getSummary() || (exitCode === 0 ? 'No token found in output' : 'Token generation failed');
    this.container.appendChild(summary);
  }

  destroy() {
    this._clearCopyTimer();
    this.container = null;
    this.buffer = [];
    this._token = null;
    this._statusEl = null;
    this._tokenEl = null;
    this._copyBtn = null;
    this._liveEl = null;
  }
}
