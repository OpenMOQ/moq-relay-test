import fs from 'fs';
import path from 'path';

/**
 * Persists run results as structured JSON files.
 * Directory structure: results/<tool>/<timestamp>-<sessionId>.json
 */
export class ResultsStore {
  constructor(resultsDir) {
    this.resultsDir = resultsDir;
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  /**
   * Save a completed run's results.
   */
  save(run) {
    const toolDir = path.join(this.resultsDir, run.tool);
    fs.mkdirSync(toolDir, { recursive: true });

    const ts = new Date(run.startedAt).toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}-${run.sessionId.slice(0, 8)}.json`;
    const filepath = path.join(toolDir, filename);

    const result = {
      tool: run.tool,
      params: run.params,
      startedAt: run.startedAt,
      completedAt: new Date().toISOString(),
      exitCode: run.exitCode,
      sessionId: run.sessionId,
      output: run.output,
    };

    fs.writeFileSync(filepath, JSON.stringify(result, null, 2));
    return filepath;
  }

  /**
   * Save self-test aggregated results.
   */
  saveSelfTest(selfTestResult) {
    const dir = path.join(this.resultsDir, 'self-test');
    fs.mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}-${selfTestResult.sessionId.slice(0, 8)}.json`;
    const filepath = path.join(dir, filename);

    fs.writeFileSync(filepath, JSON.stringify(selfTestResult, null, 2));
    return filepath;
  }

  /**
   * List all results, optionally filtered by tool.
   */
  list(toolFilter = null) {
    const results = [];

    const dirs = toolFilter
      ? [path.join(this.resultsDir, toolFilter)]
      : fs.readdirSync(this.resultsDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => path.join(this.resultsDir, d.name));

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const toolName = path.basename(dir);
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();

      for (const file of files) {
        try {
          const filepath = path.join(dir, file);
          const stat = fs.statSync(filepath);
          const meta = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
          // Self-test results store exitCode/relayUrl differently
          const exitCode = meta.exitCode !== undefined
            ? meta.exitCode
            : (meta.tools?.every(t => t.status === 'pass') && !meta.aborted ? 0 : 1);
          const relayUrl = meta.params?.relay_url ?? meta.relayUrl;
          results.push({
            tool: toolName,
            filename: file,
            path: filepath,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            exitCode,
            relayUrl,
          });
        } catch (err) {
          // Skip unreadable files
        }
      }
    }

    return results.sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  /**
   * Load a specific result file.
   */
  load(tool, filename) {
    // Sanitize inputs
    const safeTool = path.basename(tool);
    const safeFile = path.basename(filename);
    const filepath = path.join(this.resultsDir, safeTool, safeFile);

    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  }
}
