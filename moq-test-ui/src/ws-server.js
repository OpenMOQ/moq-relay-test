import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

/**
 * WebSocket server for real-time communication with browser clients.
 * Each connection gets a session ID. Handles start/stop runs, self-test, etc.
 */
export function createWSServer(server, toolRegistry, dockerExecutor, resultsStore, selfTestOrchestrator) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Track sessions: sessionId -> { ws, runs: Map<runId, outputBuffer[]> }
  const sessions = new Map();

  wss.on('connection', (ws) => {
    const sessionId = uuidv4();
    const session = { ws, runs: new Map() };
    sessions.set(sessionId, session);

    send(ws, 'session', { sessionId });
    console.log(`WS connected: ${sessionId}`);

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, 'error', { message: 'Invalid JSON' });
        return;
      }

      try {
        await handleMessage(msg, sessionId, session);
      } catch (err) {
        console.error(`Error handling ${msg.type}:`, err);
        send(ws, 'error', { message: err.message, type: msg.type });
      }
    });

    ws.on('close', () => {
      console.log(`WS disconnected: ${sessionId}`);
      // Stop all runs for this session
      for (const runId of session.runs.keys()) {
        dockerExecutor.stopRun(runId).catch(() => {});
      }
      sessions.delete(sessionId);
    });
  });

  async function handleMessage(msg, sessionId, session) {
    const { ws } = session;

    switch (msg.type) {
      case 'list-tools': {
        send(ws, 'tools-list', { tools: toolRegistry.list() });
        break;
      }

      case 'start-run': {
        const tool = toolRegistry.get(msg.toolId);
        if (!tool) {
          send(ws, 'run-error', { runId: null, error: `Unknown tool: ${msg.toolId}` });
          return;
        }

        // Validate required params
        for (const param of tool.parameters) {
          if (param.required && (msg.params[param.id] === undefined || msg.params[param.id] === '')) {
            send(ws, 'run-error', { runId: null, error: `Missing required parameter: ${param.label}` });
            return;
          }
        }

        const outputBuffer = [];

        const result = await dockerExecutor.startRun(
          tool,
          msg.params,
          (runId, line, ts) => {
            outputBuffer.push({ ts, line });
            send(ws, 'output', { runId, line, ts });
          },
          (runId, exitCode) => {
            // Save results
            resultsStore.save({
              tool: tool.name,
              params: msg.params,
              startedAt: session.runs.get(runId)?.startedAt || new Date().toISOString(),
              exitCode,
              sessionId,
              output: outputBuffer,
            });
            session.runs.delete(runId);
            send(ws, 'run-complete', { runId, exitCode });
          },
          (runId, error) => {
            session.runs.delete(runId);
            send(ws, 'run-error', { runId, error });
          },
        );

        // If startRun failed (e.g. image pull error, bad config), onError has
        // already sent run-error to the client — do not send run-started or the
        // client will enter a waiting-for-complete state that never resolves.
        if (result.error) return;

        const { runId } = result;
        session.runs.set(runId, { toolId: msg.toolId, startedAt: new Date().toISOString() });
        send(ws, 'run-started', { runId, toolId: msg.toolId });
        break;
      }

      case 'stop-run': {
        const stopped = await dockerExecutor.stopRun(msg.runId);
        send(ws, 'run-stopped', { runId: msg.runId, stopped });
        break;
      }

      case 'start-self-test': {
        selfTestOrchestrator.run(
          { relayUrl: msg.relayUrl, transport: msg.transport, draft: msg.draft },
          sessionId,
          (selfTestId, toolName, status, data) => {
            send(ws, 'self-test-progress', { selfTestId, toolName, status, ...data });
          },
          (selfTestId, results) => {
            send(ws, 'self-test-complete', { selfTestId, results });
          },
        );
        break;
      }

      case 'stop-self-test': {
        const aborted = await selfTestOrchestrator.abort(msg.selfTestId);
        send(ws, 'self-test-stopped', { selfTestId: msg.selfTestId, aborted });
        break;
      }

      case 'list-results': {
        const results = resultsStore.list(msg.tool || null);
        send(ws, 'results-list', { results });
        break;
      }

      case 'get-result': {
        const result = resultsStore.load(msg.tool, msg.filename);
        send(ws, 'result-data', { result, filename: msg.filename });
        break;
      }

      default:
        send(ws, 'error', { message: `Unknown message type: ${msg.type}` });
    }
  }

  function send(ws, type, data) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type, ...data }));
    }
  }

  return wss;
}
