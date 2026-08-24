import Docker from 'dockerode';
import { PassThrough } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import os from 'os';
import path from 'path';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const DEBUG = process.env.DOCKER_EXECUTOR_DEBUG === '1';

function debug(...args) {
  if (DEBUG) console.debug('[docker-executor]', ...args);
}

// Strip ANSI escape codes from a string
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[\??\d*[a-zA-Z]/g, '');
}

/**
 * Manages Docker container lifecycle for tool runs.
 * Spawns containers, attaches to streams, handles stop/kill.
 */
export class DockerExecutor {
  constructor(debugMode = false) {
    this.runs = new Map(); // runId -> { container, tool, params, startedAt }
    if (debugMode) process.env.DOCKER_EXECUTOR_DEBUG = '1';
  }

  /**
   * Generate any prepareFiles entries into a temp dir, return bind mounts and cleanup fn.
   * prepareFiles: [{ containerPath, template }]
   * template supports {param} substitution.
   */
  /**
   * Built-in file content generators referenced by name in prepareFiles entries.
   */
  runGenerator(name, params) {
    if (name === 'relay-probe-endpoints') {
      return this._genRelayProbeEndpoints(params);
    }
    throw new Error(`Unknown prepareFiles generator: ${name}`);
  }

  _genRelayProbeEndpoints({ relay_url, transport = 'both' }) {
    const endpoints = [];
    if (transport === 'both' || transport === 'quic') {
      endpoints.push({ url: this.rewriteRelayUrlScheme(relay_url, 'quic') });
    }
    if (transport === 'both' || transport === 'wt') {
      endpoints.push({ url: this.rewriteRelayUrlScheme(relay_url, 'wt') });
    }
    return JSON.stringify([{ id: 'target', name: 'Target Relay', endpoints }], null, 2);
  }

  /**
   * Canonical relay_url scheme rewrite shared by every tool that lets a user
   * pick 'quic' or 'wt' as the transport. Strips any existing scheme and
   * re-adds moqt:// (QUIC) or https:// (WebTransport/H3).
   */
  rewriteRelayUrlScheme(url, transport) {
    const bare = String(url || '').replace(/^(https?|moqt):\/\//, '');
    if (transport === 'quic') return `moqt://${bare}`;
    if (transport === 'wt') return `https://${bare}`;
    return url;
  }

  /**
   * Applies any transport-parameter-driven transforms (URL scheme rewrite,
   * flag remapping) declared on a tool's `transport` parameter, plus any
   * fixed-scheme requirement (`forceUrlScheme`) declared on the tool itself,
   * without mutating the caller's params.
   */
  _applyTransportTransforms(tool, params) {
    let effective = params;

    // Tools whose underlying binary only accepts one scheme regardless of the
    // transport it actually uses (e.g. conformance's --url= flag always wants
    // https://, transport is picked separately via --quic_transport).
    if (tool.forceUrlScheme && params.relay_url) {
      const bare = String(params.relay_url).replace(/^(https?|moqt):\/\//, '');
      effective = { ...effective, relay_url: `${tool.forceUrlScheme}://${bare}` };
    }

    const transportParam = tool.parameters?.find(p => p.id === 'transport');
    if (!transportParam || params.transport === undefined) return effective;

    if (transportParam.rewriteUrlScheme && effective.relay_url) {
      effective = { ...effective, relay_url: this.rewriteRelayUrlScheme(effective.relay_url, params.transport) };
    }
    if (transportParam.transportFlagMap && Object.prototype.hasOwnProperty.call(transportParam.transportFlagMap, params.transport)) {
      effective = { ...effective, transport: transportParam.transportFlagMap[params.transport] };
    }
    return effective;
  }

  prepareTempFiles(tool, params, runId, onOutput) {
    if (!tool.prepareFiles?.length) return { binds: [], cleanup: () => {} };

    // When the server itself runs in Docker, os.tmpdir() is inside the container
    // filesystem which the Docker daemon (running on the host) cannot see for
    // bind mounts into sibling containers.  Use a path that is bind-mounted from
    // the host (see docker-compose.yml) so the daemon can reach it.
    const baseDir = fs.existsSync('/tmp/generic-runner')
      ? '/tmp/generic-runner'
      : os.tmpdir();
    const tmpDir = fs.mkdtempSync(path.join(baseDir, `runner-${runId.slice(0, 8)}-`));
    const binds = [];

    for (const entry of tool.prepareFiles) {
      let content;
      if (entry.generator) {
        content = this.runGenerator(entry.generator, params);
      } else if (entry.file) {
        // Read a file from the tool's own directory and mount it as-is
        content = fs.readFileSync(path.join(tool._dir, entry.file), 'utf-8');
      } else {
        content = entry.template.replace(/\{(\w+)\}/g, (_, key) =>
          params[key] !== undefined ? String(params[key]) : ''
        );
      }
      const filename = path.basename(entry.containerPath);
      const hostPath = path.join(tmpDir, filename);
      fs.writeFileSync(hostPath, content, 'utf-8');
      binds.push(`${hostPath}:${entry.containerPath}:ro`);
      debug(`prepareFile: ${hostPath} -> ${entry.containerPath}`);
      if (entry.silent) {
        onOutput(runId, `[runner] mounted ${entry.containerPath} (${content.length} bytes)`, Date.now());
      } else {
        onOutput(runId, `[runner] input file ${entry.containerPath}: ${content}`, Date.now());
      }
    }

    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    };

    return { binds, cleanup };
  }

  /**
   * Build CLI args from tool definition and user-supplied params.
   */
  buildArgs(tool, params) {
    if (!tool.buildCommand) return [];

    const effectiveParams = this._applyTransportTransforms(tool, params);
    const cmd = tool.buildCommand.replace(/\{(\w+)\}/g, (_, key) => {
      return effectiveParams[key] !== undefined ? String(effectiveParams[key]) : '';
    });
    // Split on whitespace; drop empty tokens AND --flag= tokens where the
    // value was empty after substitution (e.g. "--tests=" when tests is blank).
    return cmd.split(/\s+/).filter(t => t && !/^--?[\w-]+=$/.test(t));
  }

  /**
   * Ensure an image is present locally, pulling it if necessary.
   * Pull progress is streamed to onOutput so the user sees feedback.
   */
  async _ensureImage(imageName, runId, onOutput) {
    try {
      await docker.getImage(imageName).inspect();
      debug(`image already present: ${imageName}`);
      return; // already local
    } catch (err) {
      if (err.statusCode !== 404) throw err; // unexpected error
    }

    onOutput(runId, `[runner] image not found locally — pulling ${imageName} …`, Date.now());

    await new Promise((resolve, reject) => {
      docker.pull(imageName, (pullErr, stream) => {
        if (pullErr) return reject(pullErr);
        docker.modem.followProgress(
          stream,
          (err) => (err ? reject(err) : resolve()),
          (event) => {
            const msg = event.status
              ? event.id ? `${event.status} ${event.id}` : event.status
              : JSON.stringify(event);
            onOutput(runId, `[pull] ${msg}`, Date.now());
          },
        );
      });
    });

    onOutput(runId, `[runner] pull complete`, Date.now());
  }

  /**
   * Start a Docker container for the given tool with parameters.
   * Returns { runId, stream } where stream emits 'data' events with output lines.
   */
  async startRun(tool, params, onOutput, onComplete, onError) {
    const runId = uuidv4();
    const args = this.buildArgs(tool, params);
    const rawCommand = Array.isArray(tool.docker.command) ? tool.docker.command : [];
    const argsString = args.join(' ').trim();
    const hasBuildArgsPlaceholder = rawCommand.some(part => typeof part === 'string' && part.includes('{build_args}'));
    const commandWithBuildArgs = rawCommand.map(part => {
      if (typeof part !== 'string') return part;
      return part.replace(/\{build_args\}/g, argsString);
    });
    const cmd = hasBuildArgsPlaceholder ? commandWithBuildArgs : [...commandWithBuildArgs, ...args];

    const containerName = `runner-${tool.name}-${runId.slice(0, 8)}`;

    // Generate any input files the tool needs and get bind mounts
    const { binds: fileBinds, cleanup: cleanupFiles } = this.prepareTempFiles(tool, params, runId, onOutput);

    const createOpts = {
      Image: tool.docker.image,
      Cmd: cmd,
      name: containerName,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        AutoRemove: true,
        NetworkMode: tool.docker.network || 'host',
        Binds: fileBinds.length ? fileBinds : undefined,
      },
    };

    // Add extra hosts if specified
    if (tool.docker.extraHosts) {
      createOpts.HostConfig.ExtraHosts = tool.docker.extraHosts;
    }

    // Add entrypoint override if specified
    if (tool.docker.entrypoint) {
      createOpts.Entrypoint = tool.docker.entrypoint;
    }

    // Add environment variables if specified
    if (tool.docker.env) {
      createOpts.Env = Object.entries(tool.docker.env).map(([k, v]) => `${k}=${v}`);
    }

    // Build and log the equivalent docker run command
    const dockerRunCmd = [
      'docker run --rm',
      `--name ${containerName}`,
      `--network ${createOpts.HostConfig.NetworkMode}`,
      ...(createOpts.HostConfig.ExtraHosts || []).map(h => `--add-host ${h}`),
      ...fileBinds.map(b => `-v ${b}`),
      ...(createOpts.Entrypoint ? [`--entrypoint ${createOpts.Entrypoint[0]}`] : []),
      ...(createOpts.Env || []).map(e => `-e ${e}`),
      createOpts.Image,
      ...(createOpts.Entrypoint?.slice(1) || []),
      ...cmd,
    ].join(' ');

    debug(`run [${runId.slice(0, 8)}]: ${dockerRunCmd}`);
    onOutput(runId, `[runner] ${dockerRunCmd}`, Date.now());
    console.log(`[docker-executor] ${dockerRunCmd}`);

    try {
      // Pull the image if it is not already present locally.
      // docker.createContainer() maps to POST /containers/create which returns
      // 404 immediately when the image is missing — it never auto-pulls.
      await this._ensureImage(tool.docker.image, runId, onOutput);

      const container = await docker.createContainer(createOpts);

      this.runs.set(runId, {
        container,
        tool: tool.name,
        params,
        startedAt: new Date().toISOString(),
        containerName,
      });

      // Attach to stdout/stderr and demux the Docker multiplexed stream
      const stream = await container.attach({ stream: true, stdout: true, stderr: true });

      const stdout = new PassThrough();
      const stderr = new PassThrough();
      docker.modem.demuxStream(stream, stdout, stderr);

      let lineBuffer = '';
      function processChunk(chunk) {
        lineBuffer += chunk.toString('utf-8');
        // Split on \r\n, \r, or \n so \r-terminated progress lines are emitted live
        const lines = lineBuffer.split(/\r\n|\r|\n/);
        lineBuffer = lines.pop(); // keep any incomplete trailing segment
        for (const line of lines) {
          const cleaned = stripAnsi(line);
          if (cleaned.length > 0) onOutput(runId, cleaned, Date.now());
        }
      }

      stdout.on('data', processChunk);
      stderr.on('data', processChunk);

      stream.on('end', () => {
        // Flush any remaining partial line (e.g. no trailing newline)
        if (lineBuffer.length > 0) {
          const cleaned = stripAnsi(lineBuffer);
          if (cleaned.length > 0) onOutput(runId, cleaned, Date.now());
          lineBuffer = '';
        }
      });

      // Start the container
      await container.start();

      // Optional run-time limit: if the tool declares runTimeoutParam, stop
      // the container after that many seconds (graceful SIGTERM, then force-kill).
      let durationTimer = null;
      const durationSec = tool.runTimeoutParam ? parseFloat(params[tool.runTimeoutParam]) : 0;
      if (durationSec > 0) {
        onOutput(runId, `[runner] duration limit: ${durationSec}s`, Date.now());
        durationTimer = setTimeout(async () => {
          const run = this.runs.get(runId);
          if (!run) return;
          onOutput(runId, `[runner] duration limit reached — stopping container`, Date.now());
          try { await run.container.stop({ t: 5 }); } catch (_) {}
        }, durationSec * 1000);
      }

      // container.wait fires when the container process exits
      container.wait((err, data) => {
        if (durationTimer) clearTimeout(durationTimer);
        const exitCode = data?.StatusCode ?? -1;
        this.runs.delete(runId);
        cleanupFiles();
        onComplete(runId, exitCode);
      });

      return { runId, containerName };
    } catch (err) {
      this.runs.delete(runId);
      onError(runId, err.message);
      return { runId, error: err.message };
    }
  }

  /**
   * Stop a running container.
   */
  async stopRun(runId) {
    const run = this.runs.get(runId);
    if (!run) return false;

    try {
      await run.container.stop({ t: 5 });
    } catch (err) {
      // Container may have already exited
      if (err.statusCode !== 304 && err.statusCode !== 404) {
        console.error(`Error stopping run ${runId}:`, err.message);
      }
    }
    this.runs.delete(runId);
    return true;
  }

  /**
   * Get info about a running container.
   */
  getRunInfo(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return { runId, tool: run.tool, params: run.params, startedAt: run.startedAt };
  }

  /**
   * Get all active runs.
   */
  getActiveRuns() {
    return Array.from(this.runs.entries()).map(([runId, run]) => ({
      runId, tool: run.tool, params: run.params, startedAt: run.startedAt,
    }));
  }

  /**
   * Stop all running containers (for graceful shutdown).
   */
  async stopAll() {
    const promises = Array.from(this.runs.keys()).map(runId => this.stopRun(runId));
    await Promise.allSettled(promises);
  }
}
