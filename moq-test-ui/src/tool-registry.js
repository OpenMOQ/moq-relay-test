import fs from 'fs';
import path from 'path';

/**
 * Scans tools/ directory at startup, loads and validates each tool.json.
 * Exposes the tool definitions for the server and API.
 */
export class ToolRegistry {
  constructor(toolsDir) {
    this.toolsDir = toolsDir;
    this.tools = new Map();
  }

  load() {
    if (!fs.existsSync(this.toolsDir)) {
      console.warn(`Tools directory not found: ${this.toolsDir}`);
      return;
    }

    const entries = fs.readdirSync(this.toolsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const toolDir = path.join(this.toolsDir, entry.name);
      const manifestPath = path.join(toolDir, 'tool.json');

      if (!fs.existsSync(manifestPath)) {
        console.warn(`Skipping ${entry.name}: no tool.json found`);
        continue;
      }

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const tool = JSON.parse(raw);
        this.validate(tool, entry.name);
        tool._dir = toolDir;
        tool._hasRenderer = fs.existsSync(path.join(toolDir, tool.renderer || 'renderer.js'));
        this.tools.set(tool.name, tool);
        console.log(`Loaded tool: ${tool.name} (${tool.displayName})`);
      } catch (err) {
        console.error(`Error loading tool ${entry.name}:`, err.message);
      }
    }

    console.log(`Tool registry: ${this.tools.size} tool(s) loaded`);
  }

  validate(tool, dirName) {
    if (!tool.name) throw new Error('Missing required field: name');
    if (!tool.displayName) throw new Error('Missing required field: displayName');
    if (!tool.docker?.image) throw new Error('Missing required field: docker.image');
    if (!tool.docker?.command) throw new Error('Missing required field: docker.command');
    if (!Array.isArray(tool.parameters)) throw new Error('parameters must be an array');

    for (const param of tool.parameters) {
      if (!param.id || !param.label || !param.type) {
        throw new Error(`Invalid parameter: ${JSON.stringify(param)}`);
      }
    }
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values()).map(t => ({
      name: t.name,
      displayName: t.displayName,
      description: t.description,
      category: t.category,
      order: t.order ?? 999,
      parameters: t.parameters,
      filters: t.filters || [],
      hasRenderer: t._hasRenderer,
      renderer: t._hasRenderer ? t.renderer || 'renderer.js' : null,
      persistResults: t.persistResults,
      selfTest: t.selfTest || null,
      forceUrlScheme: t.forceUrlScheme || null,
    }));
  }

  getSelfTestTools() {
    const entries = [];
    for (const tool of this.tools.values()) {
      const st = tool.selfTest;
      if (!st) continue;

      // Support array of self-test configs or a single object
      const configs = Array.isArray(st) ? st : [st];
      for (const config of configs) {
        if (!config.enabled) continue;
        entries.push({
          ...tool,
          _selfTestEntry: config,
        });
      }
    }
    return entries.sort((a, b) => (a._selfTestEntry.order || 99) - (b._selfTestEntry.order || 99));
  }
}
