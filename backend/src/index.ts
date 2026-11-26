/**
 * Agent Console backend — WebSocket server.
 *
 * One Session + one Agent per connection. Speaks the same wire protocol the
 * frontend's protocol/ layer expects, so the real agent is a drop-in for the
 * mock socket: TOKEN / TOOL_CALL / TOOL_STATUS / TOOL_RESULT / CONTEXT_SNAPSHOT / STREAM_END /
 * PING / ERROR out; USER_MESSAGE / RESUME / PONG / TOOL_ACK in.
 *
 * Env: see .env.example. Load it however you like (e.g. `node --env-file=.env`).
 */
import { WebSocketServer, WebSocket } from "ws";
import { Session, parseClientMessage, type ServerEvent } from "./protocol.js";
import { Agent } from "./agent.js";
import { createProvider } from "./providers/index.js";
import { TOOLS } from "./tools.js";
import {
  createToolPolicy,
  policyConfigFromEnv,
  type PolicyConfig,
} from "./policy/index.js";

const PORT = Number(process.env.PORT ?? 8787);
const HEARTBEAT_MS = 15000;

let provider;
let policyConfig: PolicyConfig;
try {
  provider = createProvider();
  policyConfig = policyConfigFromEnv(process.env);
} catch (err) {
  console.error(
    `[fatal] ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}

const wss = new WebSocketServer({ port: PORT });

console.log(
  `[agent-console] WebSocket server on ws://localhost:${PORT} (provider: ${provider.name})`,
);
console.log(
  `[agent-console] tool policy: max ${policyConfig.maxCalls} calls/turn, ` +
    `${policyConfig.maxCallsPerTool}/tool, args ≤ ${policyConfig.maxArgChars} chars` +
    (policyConfig.deny.length ? `, disabled: ${policyConfig.deny.join(", ")}` : ""),
);

wss.on("connection", (socket: WebSocket) => {
  const session = new Session();
  // One policy engine per connection: turn counters are per session.
  const agent = new Agent(
    session,
    provider,
    createToolPolicy(TOOLS, policyConfig),
  );
  let nonce = 0;
  let busy = false;

  const send = (event: ServerEvent): void => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(event));
    }
  };
  session.bind(send);

  // Greet with an initial context snapshot + intro message.
  session.snapshotContext({ status: "ready" });
  const introId = `m-intro-${Date.now()}`;
  session.emit({
    type: "TOKEN",
    messageId: introId,
    role: "assistant",
    token: `Connected to the live agent (${provider.name}). Ask me anything — I can do math and look things up.`,
    index: 0,
  });
  session.emit({ type: "STREAM_END", messageId: introId, reason: "complete" });

  const heartbeat = setInterval(() => {
    nonce += 1;
    session.emit({ type: "PING", nonce: `n${nonce}` });
  }, HEARTBEAT_MS);

  socket.on("message", (data) => {
    const msg = parseClientMessage(data.toString());
    if (!msg) return;

    switch (msg.type) {
      case "USER_MESSAGE": {
        if (busy) {
          session.emit({
            type: "ERROR",
            code: "busy",
            message: "The agent is still answering the previous message.",
            fatal: false,
          });
          return;
        }
        busy = true;
        agent
          .handleUserMessage(msg.text)
          .catch((err: unknown) => {
            session.emit({
              type: "ERROR",
              code: "internal",
              message: err instanceof Error ? err.message : String(err),
              fatal: false,
            });
          })
          .finally(() => {
            busy = false;
          });
        break;
      }
      case "RESUME":
        session.replayAfter(msg.lastSeq);
        break;
      case "PONG":
      case "TOOL_ACK":
        // Liveness / delivery acks — no action needed server-side.
        break;
    }
  });

  socket.on("close", () => clearInterval(heartbeat));
  socket.on("error", () => clearInterval(heartbeat));
});

process.on("SIGINT", () => {
  console.log("\n[agent-console] shutting down");
  wss.close(() => process.exit(0));
});
