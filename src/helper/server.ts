import http from "node:http";
import { presencePayloadSchema, type PresencePayload } from "../shared/types.js";
import { defaultConfig, type PresenceConfig } from "../shared/config.js";

export function createPresenceServer(
  onPresence: (payload: PresencePayload) => Promise<void>,
  onClear: () => Promise<void> = async () => {},
  config: Pick<PresenceConfig, "serverHost" | "serverPort"> = defaultConfig,
  onRetire: (sessionId: string) => Promise<void> = async () => {}
) {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(204).end();
      return;
    }

    if (req.method === "POST" && req.url === "/clear") {
      void onClear().then(() => {
        res.writeHead(204).end();
      }).catch((error) => {
        console.error("[pi-discord-activity] Failed to process clear request", error);
        res.writeHead(500).end("Internal Server Error");
      });
      return;
    }

    if (req.method === "POST" && req.url === "/retire") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}") as { sessionId?: unknown };
          const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
          await onRetire(sessionId);
          res.writeHead(204).end();
        } catch (error) {
          console.error("[pi-discord-activity] Failed to process retire request", error);
          res.writeHead(400).end("Bad Request");
        }
      });
      return;
    }

    if (req.method !== "POST" || req.url !== "/presence") {
      res.writeHead(404).end("Not Found");
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const parsed = presencePayloadSchema.parse(JSON.parse(body));
        await onPresence(parsed);
        res.writeHead(204).end();
      } catch (error) {
        console.error("[pi-discord-activity] Failed to process presence update", error);
        res.writeHead(400).end("Bad Request");
      }
    });
  }).listen(config.serverPort, config.serverHost, () => {
    if (defaultConfig.debugLogging) {
      console.log(`Presence server listening at http://${config.serverHost}:${config.serverPort}`);
    }
  });
}
