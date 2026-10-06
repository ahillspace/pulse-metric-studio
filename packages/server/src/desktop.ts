import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { config } from "@pulse-metric-studio/core";

export const DESKTOP_PROTOCOL = 1;
export const DESKTOP_BODY_LIMIT = 16 * 1024 * 1024;
export type DesktopStartup = { token: string; protocol: number };

/** The child owns this OS socket until exit, including graceful drain after parent failure. */
export async function acquireDesktopOwnership(
  dataDir: string,
): Promise<net.Server> {
  fs.mkdirSync(dataDir, { recursive: true });
  const canonical = fs.realpathSync(dataDir);
  const identity =
    process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const port =
    15000 +
    (crypto.createHash("sha256").update(identity).digest().readUInt32BE(0) %
      30000);
  const owner = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    owner.once("error", () =>
      reject(
        new Error(
          `Pulse cannot acquire exclusive ownership of its data directory. Another app process or local service holds ownership port ${port}. Close the earlier process and restart Pulse.`,
        ),
      ),
    );
    owner.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return owner;
}

/** The parent owns stdin for this process. Secrets never enter argv or HTTP bootstrap responses. */
export async function readDesktopStartup(): Promise<
  DesktopStartup | undefined
> {
  if (process.env.PULSE_METRIC_STUDIO_DESKTOP_IDENTIFIER !== "com.ahillspace.pulsemetricstudio")
    return undefined;
  if (process.env.PULSE_METRIC_STUDIO_DESKTOP_PIPE !== "1")
    throw new Error("Pulse desktop requires its native launcher.");
  const startup = await new Promise<DesktopStartup>((resolve, reject) => {
    let input = "";
    const timer = setTimeout(
      () => finish(new Error("Desktop startup handshake timed out.")),
      5000,
    );
    const finish = (error?: Error, startup?: DesktopStartup) => {
      clearTimeout(timer);
      process.stdin.off("data", receive);
      process.stdin.off("end", ended);
      if (error) reject(error);
      else resolve(startup!);
    };
    const ended = () =>
      finish(new Error("Desktop launcher disconnected during startup."));
    const receive = (chunk: Buffer) => {
      input += chunk.toString("utf8");
      if (Buffer.byteLength(input) > 4096)
        return finish(new Error("Invalid desktop startup handshake."));
      if (!input.includes("\n")) return;
      try {
        const value = JSON.parse(input.trim()) as Record<string, unknown>;
        if (
          value.protocol !== DESKTOP_PROTOCOL ||
          typeof value.token !== "string" ||
          !/^[a-f0-9]{64}$/.test(value.token) ||
          typeof value.brokerToken !== "string" ||
          value.brokerToken.length < 20
        )
          throw new Error();
        process.env.PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_TOKEN = value.brokerToken;
        finish(undefined, { token: value.token, protocol: DESKTOP_PROTOCOL });
      } catch {
        finish(new Error("Incompatible desktop startup handshake."));
      }
    };
    process.stdin.on("data", receive);
    process.stdin.once("end", ended);
  });
  await acquireDesktopOwnership(config.dataDir);
  return startup;
}

export function superviseDesktop(
  app: FastifyInstance,
  startup: DesktopStartup | undefined,
): void {
  if (!startup) return;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    void app.close().then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      () => process.exit(1),
    );
  };
  process.stdin.once("end", stop);
  process.stdin.on("data", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  if (process.stdin.readableEnded) stop();
}
