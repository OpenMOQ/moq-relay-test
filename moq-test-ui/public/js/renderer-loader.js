/**
 * Dynamically loads per-tool renderer ES modules.
 */
export class RendererLoader {
  constructor() {
    this.renderer = null;
    this.containerEl = null;
    this._pending = null; // lines buffered while import is in-flight
    this._pendingComplete = null; // exitCode buffered while import is in-flight
  }

  async load(toolName, containerEl) {
    this.unload();
    this.containerEl = containerEl;
    containerEl.innerHTML = '';
    this.autoScroll = true;
    this._pending = []; // start buffering
    this._pendingComplete = null;

    // Auto-scroll detection for renderer container
    containerEl.addEventListener('scroll', () => {
      const { scrollTop, scrollHeight, clientHeight } = containerEl;
      this.autoScroll = (scrollHeight - scrollTop - clientHeight) < 50;
    });

    try {
      const module = await import(`/tools/${toolName}/renderer.js`);
      this.renderer = new module.default();
      if (this.renderer?.init) {
        this.renderer.init(containerEl);
      }
      // Replay any lines that arrived while the import was in-flight
      const buffered = this._pending;
      this._pending = null;
      for (const line of buffered) {
        this._dispatch(line);
      }
      if (this._pendingComplete !== null) {
        const exitCode = this._pendingComplete;
        this._pendingComplete = null;
        this.onComplete(exitCode);
      }
    } catch (err) {
      console.log(`No renderer for ${toolName}:`, err.message);
      this.renderer = null;
      this._pending = null;
      this._pendingComplete = null;
    }
  }

  onLine(line) {
    if (this._pending !== null) {
      this._pending.push(line);
    } else {
      this._dispatch(line);
    }
  }

  _dispatch(line) {
    if (this.renderer?.onLine) {
      try {
        this.renderer.onLine(line);
        this.scrollRendererToBottom();
      } catch (err) {
        console.error('Renderer onLine error:', err);
      }
    }
  }

  scrollRendererToBottom() {
    if (!this.autoScroll || !this.containerEl) return;
    requestAnimationFrame(() => {
      this.containerEl.scrollTop = this.containerEl.scrollHeight;
    });
  }

  onComplete(exitCode) {
    if (this._pending !== null) {
      // Renderer module is still loading; defer completion callback.
      this._pendingComplete = exitCode;
      return;
    }

    if (this.renderer?.onComplete) {
      try {
        this.renderer.onComplete(exitCode, {});
      } catch (err) {
        console.error('Renderer onComplete error:', err);
      }
    }
    // Always scroll to bottom so the summary is visible
    if (this.containerEl) {
      requestAnimationFrame(() => {
        this.containerEl.scrollTop = this.containerEl.scrollHeight;
      });
    }
  }

  getSummary() {
    return this.renderer?.getSummary?.() ?? null;
  }

  unload() {
    if (this.renderer?.destroy) {
      try {
        this.renderer.destroy();
      } catch (err) {
        console.error('Renderer destroy error:', err);
      }
    }
    this.renderer = null;
    this._pending = null;
    this._pendingComplete = null;
    if (this.containerEl) {
      this.containerEl.innerHTML = '';
    }
  }
}
