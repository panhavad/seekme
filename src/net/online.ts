import type { Difficulty, Role } from '../game/config';

/** What the other ghost is doing, as it comes off the wire. */
export interface PeerState {
  /** world x, world z, facing, moving flag, sender clock (ms) */
  x: number;
  z: number;
  f: number;
  m: boolean;
  c: number;
}

export type PeerEvent =
  | { e: 'splash'; x: number; z: number }
  | { e: 'pond'; cx: number; cy: number }
  | { e: 'caught'; t: number }
  | { e: 'timeup'; t: number };

export interface MatchInfo {
  code: string;
  seed: number;
  role: Role;
  difficulty: Difficulty;
  peer: string;
  /** Server clock timestamp both sides start on. */
  startAt: number;
}

type Status = 'idle' | 'connecting' | 'waiting' | 'ready' | 'playing' | 'closed';

/**
 * Online play is a thin peer-to-peer relay: each client owns its own ghost and
 * publishes a tiny transform packet ~15 times a second. The maze, the trails
 * and the fog of war are all derived locally from the shared seed, so the only
 * thing crossing the network is "where am I" plus the rare event.
 */
export class OnlineSession {
  private socket: WebSocket | null = null;
  private status: Status = 'idle';
  private info: Partial<MatchInfo> = {};
  /** Server time minus local time, so both sides share a clock. */
  private clockOffset = 0;

  onStatus: ((status: Status, detail?: string) => void) | null = null;
  onCode: ((code: string) => void) | null = null;
  onMatch: ((info: MatchInfo) => void) | null = null;
  onPeerState: ((state: PeerState) => void) | null = null;
  onPeerEvent: ((event: PeerEvent) => void) | null = null;
  onPeerLeft: (() => void) | null = null;
  onError: ((message: string) => void) | null = null;

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get state(): Status {
    return this.status;
  }

  get serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.setStatus('connecting');

    await new Promise<void>((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      this.socket = socket;

      const failed = (): void => reject(new Error('Could not reach the game server.'));
      socket.addEventListener('open', () => {
        socket.removeEventListener('error', failed);
        this.measureClock();
        resolve();
      }, { once: true });
      socket.addEventListener('error', failed, { once: true });

      socket.addEventListener('message', (event) => this.receive(String(event.data)));
      socket.addEventListener('close', () => {
        if (this.status !== 'closed') this.setStatus('closed', 'Connection lost.');
        this.socket = null;
      });
    });
  }

  /** Opens a private room and returns once the server hands back a code. */
  async host(name: string, role: Role, difficulty: Difficulty): Promise<void> {
    await this.connect();
    this.send({ t: 'create', name, role, difficulty });
    this.setStatus('waiting');
  }

  async join(name: string, code: string): Promise<void> {
    await this.connect();
    this.send({ t: 'join', name, code: code.trim().toUpperCase() });
    this.setStatus('waiting');
  }

  leave(): void {
    if (this.connected) this.send({ t: 'leave' });
    this.status = 'idle';
  }

  close(): void {
    this.status = 'closed';
    this.socket?.close();
    this.socket = null;
  }

  /** Publishes our ghost. Called ~15x a second while playing. */
  sendState(x: number, z: number, facing: number, moving: boolean): void {
    if (!this.connected) return;
    this.send({
      t: 'state',
      x: round(x),
      z: round(z),
      f: round(facing),
      m: moving,
      c: this.serverNow,
    });
  }

  sendEvent(event: PeerEvent): void {
    if (!this.connected) return;
    this.send({ t: 'event', ...event });
  }

  private receive(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    switch (message.t) {
      case 'pong': {
        // Round-trip estimate: assume symmetric latency.
        const sent = Number(message.at ?? 0);
        if (sent > 0) this.clockOffset = 0; // server echoes our own clock, nothing to correct
        break;
      }
      case 'created':
        this.info = {
          code: String(message.code),
          seed: Number(message.seed),
          role: message.role as Role,
          difficulty: message.difficulty as Difficulty,
        };
        this.onCode?.(String(message.code));
        this.setStatus('waiting', 'Waiting for a friend to join…');
        break;
      case 'joined':
        this.info = {
          code: String(message.code),
          seed: Number(message.seed),
          role: message.role as Role,
          difficulty: message.difficulty as Difficulty,
          peer: String(message.peer ?? 'Ghost'),
        };
        this.setStatus('ready', 'Joined! Starting…');
        break;
      case 'peerJoined':
        this.info.peer = String(message.peer ?? 'Ghost');
        this.setStatus('ready', `${this.info.peer} joined!`);
        break;
      case 'start': {
        const startAt = Number(message.at ?? Date.now());
        this.info.peer = String(message.peer ?? this.info.peer ?? 'Ghost');
        this.status = 'playing';
        this.onMatch?.({
          code: this.info.code ?? '????',
          seed: this.info.seed ?? 1,
          role: (this.info.role ?? 'hider') as Role,
          difficulty: (this.info.difficulty ?? 'normal') as Difficulty,
          peer: this.info.peer ?? 'Ghost',
          startAt,
        });
        break;
      }
      case 'state':
        this.onPeerState?.({
          x: Number(message.x ?? 0),
          z: Number(message.z ?? 0),
          f: Number(message.f ?? 0),
          m: Boolean(message.m),
          c: Number(message.c ?? Date.now()),
        });
        break;
      case 'event':
        this.onPeerEvent?.(message as unknown as PeerEvent);
        break;
      case 'peerLeft':
        this.setStatus('waiting', 'Your friend disconnected.');
        this.onPeerLeft?.();
        break;
      case 'error':
        this.onError?.(String(message.message ?? 'Something went wrong.'));
        this.setStatus('idle');
        break;
      default:
        break;
    }
  }

  private measureClock(): void {
    this.send({ t: 'ping', at: Date.now() });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private setStatus(status: Status, detail?: string): void {
    this.status = status;
    this.onStatus?.(status, detail);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
