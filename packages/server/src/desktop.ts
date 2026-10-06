import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import {
  adoptOsDataKey,
  CREDENTIAL_BROKER_TOKEN_ENV,
  config,
  createCredentialBrokerClient,
  setCredentialBrokerToken,
  setCredentialCommandApprover,
} from "@pulse-metric-studio/core";

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
  delete process.env[CREDENTIAL_BROKER_TOKEN_ENV];
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
        // Module state only: children spawned by this server must never inherit it.
        setCredentialBrokerToken(value.brokerToken);
        finish(undefined, { token: value.token, protocol: DESKTOP_PROTOCOL });
      } catch {
        finish(new Error("Incompatible desktop startup handshake."));
      }
    };
    process.stdin.on("data", receive);
    process.stdin.once("end", ended);
  });
  await acquireDesktopOwnership(config.dataDir);
  await useNativeCredentialServices();
  return startup;
}

/**
 * The native host keeps the local data key in the OS credential store and
 * approves credential commands. Both are wired before any request is served.
 */
async function useNativeCredentialServices(): Promise<void> {
  const broker = createCredentialBrokerClient();
  setCredentialCommandApprover((command) => broker.approveCredentialCommand(command));
  try {
    const outcome = await adoptOsDataKey(broker);
    if (outcome === "kept-file")
      console.warn("The OS credential store holds a different data key; the existing key file stays in use.");
  } catch (error) {
    // Saved secrets stay readable through the key file until the OS store is available again.
    console.warn(
      `The OS credential store could not provide the data key; using the key file. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
}

const REQUEST_SIGNATURE_WINDOW_MS = 120_000;

/**
 * Verifies the native transport's per-request signature: HMAC over method,
 * target, a one-time nonce and a timestamp. The launch token itself never
 * travels with a request, and each signature is accepted only once.
 */
export function createDesktopRequestVerifier(token: string, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return (method: string, target: string, headers: Record<string, string | string[] | undefined>): boolean => {
    const nonce = headers["x-pulse-nonce"];
    const timestamp = headers["x-pulse-timestamp"];
    const signature = headers["x-pulse-signature"];
    if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) return false;
    if (typeof timestamp !== "string" || !/^\d{1,16}$/.test(timestamp)) return false;
    if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return false;
    const current = now();
    if (Math.abs(current - Number(timestamp)) > REQUEST_SIGNATURE_WINDOW_MS) return false;
    const expected = crypto
      .createHmac("sha256", token)
      .update(`request:${method}\n${target}\n${nonce}\n${timestamp}`)
      .digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    for (const [entry, expiry] of seen) if (expiry < current) seen.delete(entry);
    if (seen.has(nonce)) return false;
    seen.set(nonce, current + 2 * REQUEST_SIGNATURE_WINDOW_MS);
    return true;
  };
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
