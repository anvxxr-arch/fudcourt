// Gateway client — the Discord WebSocket (v10) driver, hand-rolled.
//
// Zero dependencies: it uses the runtime's global `WebSocket`. The socket
// factory is injectable so the opcode state machine can be unit-tested with a
// fake socket, exactly the way Sapphire's gateway is tested without a live
// connection.
//
// Handled opcodes:
//   0  DISPATCH          → emit the event named by `t`
//   1  HEARTBEAT         → the server asks for one; send immediately
//   7  RECONNECT         → close and reconnect (resume when a session exists)
//   9  INVALID_SESSION   → resume if `d` is true, else re-IDENTIFY
//   10 HELLO             → start the heartbeat loop, then IDENTIFY / RESUME
//   11 HEARTBEAT_ACK     → the loop is healthy again

import type { ReadyPayload } from "./types.ts";

export const GatewayOp = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  PresenceUpdate: 3,
  Resume: 6,
  Reconnect: 7,
  RequestGuildMembers: 8,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

/** GUILDS is the only intent the slash-command path needs. */
export const INTENTS_GUILDS = 1 << 0;
/** GUILD_MEMBERS — join/leave events (AutoMod new-account + raid detection). */
export const INTENTS_GUILD_MEMBERS = 1 << 1;
/** GUILD_MESSAGES — message events (AutoMod content rules + anti-spam). */
export const INTENTS_GUILD_MESSAGES = 1 << 9;
/** GUILD_VOICE_STATES — voice join/leave/move (voice activity logs). */
export const INTENTS_GUILD_VOICE_STATES = 1 << 7;
/** MESSAGE_CONTENT — privileged; required to read message text. Enable it in the app. */
export const INTENTS_MESSAGE_CONTENT = 1 << 15;

/**
 * INTENTS_BOT is the full intent set the live bot requests: guilds + members +
 * messages + message content + voice states. MESSAGE_CONTENT is privileged — if it
 * is not enabled in the Discord developer portal the gateway closes with 4014
 * (documented in the ops runbook).
 */
export const INTENTS_BOT =
  INTENTS_GUILDS |
  INTENTS_GUILD_MEMBERS |
  INTENTS_GUILD_MESSAGES |
  INTENTS_GUILD_VOICE_STATES |
  INTENTS_MESSAGE_CONTENT;

type Handler = (data: unknown) => void;

export interface GatewayOptions {
  token: string;
  intents?: number;
  /** Injectable WebSocket constructor (tests pass a fake). */
  wsFactory?: (url: string) => WebSocket;
  /** Base gateway URL without query — tests pass a stub. */
  gatewayUrl?: string;
  log?: (msg: string) => void;
}

interface GatewayFrame {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
}

export class Gateway {
  private readonly opts: Required<Pick<GatewayOptions, "token" | "intents">> & GatewayOptions;
  private readonly wsFactory: (url: string) => WebSocket;
  private readonly log: (msg: string) => void;
  private handlers = new Map<string, Handler[]>();

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private acked = true;
  private closedByUs = false;
  private reconnectAttempts = 0;
  private ready = false;

  constructor(opts: GatewayOptions) {
    this.opts = { intents: INTENTS_GUILDS, ...opts };
    this.wsFactory = opts.wsFactory ?? ((url: string) => new WebSocket(url));
    this.log = opts.log ?? (() => {});
  }

  on(event: string, cb: Handler): this {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
    return this;
  }

  private emit(event: string, data: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) {
      try {
        cb(data);
      } catch (err) {
        this.log(`handler for ${event} threw: ${String(err)}`);
      }
    }
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** connect opens the socket and wires the state machine. */
  connect(): void {
    this.closedByUs = false;
    const base = this.resumeUrl ?? this.opts.gatewayUrl ?? "wss://gateway.discord.gg";
    const url = `${base.replace(/\/+$/, "")}/?v=10&encoding=json`;
    this.log(`gateway: connecting ${url}`);
    const ws = this.wsFactory(url);
    this.ws = ws;
    ws.onopen = () => this.log("gateway: socket open");
    ws.onmessage = (ev: MessageEvent) => this.handleFrame(String(ev.data));
    ws.onerror = () => this.emit("error", new Error("gateway socket error"));
    ws.onclose = (ev: CloseEvent) => this.onClose(ev?.code ?? 0);
  }

  /** handleFrame is the pure state machine — the unit under test. */
  handleFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      this.log("gateway: non-JSON frame ignored");
      return;
    }
    if (typeof frame.s === "number") this.seq = frame.s;

    switch (frame.op) {
      case GatewayOp.Hello: {
        const d = frame.d as { heartbeat_interval: number };
        this.startHeartbeat(d.heartbeat_interval);
        if (this.sessionId && this.seq !== null) this.sendResume();
        else this.sendIdentify();
        return;
      }
      case GatewayOp.Heartbeat:
        this.sendHeartbeat();
        return;
      case GatewayOp.HeartbeatAck:
        this.acked = true;
        return;
      case GatewayOp.Reconnect:
        this.log("gateway: server requested reconnect");
        this.closeAndReconnect(true);
        return;
      case GatewayOp.InvalidSession: {
        const resumable = frame.d === true;
        this.log(`gateway: invalid session (resumable=${resumable})`);
        if (!resumable) {
          this.sessionId = null;
          this.seq = null;
        }
        this.closeAndReconnect(resumable);
        return;
      }
      case GatewayOp.Dispatch: {
        const name = frame.t ?? "unknown";
        if (name === "READY") {
          const ready = frame.d as ReadyPayload;
          this.sessionId = ready.session_id;
          this.resumeUrl = ready.resume_gateway_url ?? null;
          this.ready = true;
          this.reconnectAttempts = 0;
        }
        if (name === "RESUMED") {
          this.ready = true;
        }
        this.emit(name, frame.d);
        this.emit("dispatch", { t: name, d: frame.d });
        return;
      }
      default:
        return;
    }
  }

  private send(op: number, d: unknown): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ op, d }));
  }

  sendIdentify(): void {
    this.send(GatewayOp.Identify, {
      token: this.opts.token,
      intents: this.opts.intents,
      properties: { os: "linux", browser: "fudzie", device: "fudzie" },
    });
  }

  sendResume(): void {
    this.send(GatewayOp.Resume, { token: this.opts.token, session_id: this.sessionId, seq: this.seq });
  }

  sendHeartbeat(): void {
    this.acked = false;
    this.send(GatewayOp.Heartbeat, this.seq);
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    // First beat after a jittered fraction of the interval, then every interval.
    const jitter = Math.floor(intervalMs * Math.random());
    setTimeout(() => this.sendHeartbeat(), jitter);
    this.heartbeatTimer = setInterval(() => {
      if (!this.acked) {
        this.log("gateway: heartbeat not acked — reconnecting");
        this.closeAndReconnect(true);
        return;
      }
      this.sendHeartbeat();
    }, intervalMs);
  }

  private closeAndReconnect(resume: boolean): void {
    if (!resume) this.sessionId = null;
    this.closeSocket(1000);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closedByUs) return;
    this.reconnectAttempts += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.log(`gateway: reconnecting in ${backoff}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => this.connect(), backoff);
  }

  private onClose(code: number): void {
    this.stopHeartbeat();
    this.ready = false;
    this.emit("disconnect", code);
    if (this.closedByUs) return;
    // 4004 auth failed / 4014 disallowed intents are fatal — do not loop.
    if (code === 4004 || code === 4014) {
      this.emit("fatal", code);
      return;
    }
    this.scheduleReconnect();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private closeSocket(code: number): void {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(code);
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }

  /** destroy closes the socket for good (no reconnect). */
  destroy(): void {
    this.closedByUs = true;
    this.closeSocket(1000);
  }
}
