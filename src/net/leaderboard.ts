import { APP_VERSION, randomGhostName, type Difficulty, type Role } from '../game/config';

export interface ScoreSubmission {
  /** Stable id so retrying a submission can never double-post a score. */
  id: string;
  clientId: string;
  name: string;
  role: Role;
  difficulty: Difficulty;
  win: boolean;
  timeMs: number;
  seed: number;
  pondsMelted: number;
  playedAt: number;
  version: string;
}

export interface BoardRow {
  id: string;
  name: string;
  role: Role;
  difficulty: Difficulty;
  timeMs: number;
  win: boolean;
  playedAt: number;
}

export interface SyncReport {
  attempted: number;
  accepted: number;
  remaining: number;
  ok: boolean;
  error?: string;
}

const PENDING_KEY = 'seekme.pending.v1';
const IDENTITY_KEY = 'seekme.identity.v1';
const BOARD_CACHE_KEY = 'seekme.board.v1';

/**
 * Talks to the leaderboard when there is a network, and quietly keeps every
 * score in a local queue when there is not. Nothing is ever lost: the queue is
 * retried on demand, when the browser comes back online, and periodically.
 */
export class LeaderboardClient {
  private pending: ScoreSubmission[] = readJson<ScoreSubmission[]>(PENDING_KEY, []);
  private identity = readJson<{ clientId: string; name: string; custom?: boolean }>(IDENTITY_KEY, {
    clientId: makeId(),
    name: '',
    custom: false,
  });  private boards = readJson<Record<string, BoardRow[]>>(BOARD_CACHE_KEY, {});
  private inflight: Promise<SyncReport> | null = null;
  private serverReachable: boolean | null = null;

  onChange: (() => void) | null = null;

  constructor() {
    // A fresh random ghost name every visit, unless the player picked their own.
    if (!this.identity.custom || !this.identity.name) {
      this.identity.name = randomGhostName();
      this.identity.custom = false;
    }
    writeJson(IDENTITY_KEY, this.identity);
    window.addEventListener('online', () => void this.sync());
    window.setInterval(() => {
      if (this.pending.length > 0) void this.sync();
    }, 30_000);
  }

  get clientId(): string {
    return this.identity.clientId;
  }

  get playerName(): string {
    return this.identity.name;
  }

  /** Typing a name keeps it; clearing it hands you back to the dice. */
  set playerName(value: string) {
    const cleaned = value.trim().slice(0, 16);
    if (cleaned) {
      this.identity.name = cleaned;
      this.identity.custom = true;
    } else {
      this.identity.name = randomGhostName();
      this.identity.custom = false;
    }
    writeJson(IDENTITY_KEY, this.identity);
  }

  /** Rolls a new random name and stays on random for future visits. */
  rerollName(): string {
    this.identity.name = randomGhostName();
    this.identity.custom = false;
    writeJson(IDENTITY_KEY, this.identity);
    return this.identity.name;
  }

  /** True while the name is auto-generated rather than player-chosen. */
  get nameIsRandom(): boolean {
    return !this.identity.custom;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  get online(): boolean {
    return navigator.onLine && this.serverReachable !== false;
  }

  /** Queues a finished round. Returns the queued entry. */
  queue(entry: Omit<ScoreSubmission, 'id' | 'clientId' | 'version' | 'playedAt'>): ScoreSubmission {
    const submission: ScoreSubmission = {
      ...entry,
      id: makeId(),
      clientId: this.identity.clientId,
      version: APP_VERSION,
      playedAt: Date.now(),
    };
    this.pending.push(submission);
    this.persist();
    return submission;
  }

  /** Pushes every queued score. Safe to call repeatedly - it is idempotent. */
  async sync(): Promise<SyncReport> {
    // Concurrent callers (auto-retry, the sync button, the result screen) all
    // share one in-flight request instead of racing each other.
    if (!this.inflight) {
      this.inflight = this.drain().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async drain(): Promise<SyncReport> {
    if (this.pending.length === 0) {
      const reachable = await this.ping();
      return {
        attempted: 0,
        accepted: 0,
        remaining: 0,
        ok: reachable,
        error: reachable ? undefined : 'Server unreachable',
      };
    }

    let attempted = 0;
    let accepted = 0;
    let error: string | undefined;

    // Scores queued while a batch was in flight are picked up by the next pass.
    for (let pass = 0; pass < 3 && this.pending.length > 0; pass++) {
      const batch = this.pending.slice(0, 200);
      attempted += batch.length;

      try {
        const response = await fetchWithTimeout('/api/scores', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scores: batch }),
        });

        if (!response.ok) throw new Error(`Server replied ${response.status}`);
        const payload = (await response.json()) as { ok: boolean; accepted?: string[] };
        if (!payload.ok) throw new Error('Server rejected the batch');

        const acceptedIds = new Set(payload.accepted ?? batch.map((item) => item.id));
        accepted += acceptedIds.size;
        this.pending = this.pending.filter((item) => !acceptedIds.has(item.id));
        this.serverReachable = true;
        this.persist();
      } catch (cause) {
        this.serverReachable = false;
        error = cause instanceof Error ? cause.message : 'Network error';
        break;
      }
    }

    return {
      attempted,
      accepted,
      remaining: this.pending.length,
      ok: error === undefined,
      error,
    };
  }

  /** Loads a board, falling back to the last cached copy while offline. */
  async fetchBoard(role: Role): Promise<{ rows: BoardRow[]; stale: boolean }> {
    try {
      const response = await fetchWithTimeout(`/api/leaderboard?role=${role}&limit=25`);
      if (!response.ok) throw new Error(`Server replied ${response.status}`);
      const payload = (await response.json()) as { ok: boolean; rows: BoardRow[] };
      if (!payload.ok) throw new Error('Bad payload');
      this.boards[role] = payload.rows;
      writeJson(BOARD_CACHE_KEY, this.boards);
      this.serverReachable = true;
      return { rows: payload.rows, stale: false };
    } catch {
      this.serverReachable = false;
      return { rows: this.boards[role] ?? [], stale: true };
    }
  }

  /** Local-only view of the queue so players can see unsynced runs. */
  get queued(): readonly ScoreSubmission[] {
    return this.pending;
  }

  private async ping(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout('/api/health');
      this.serverReachable = response.ok;
      return response.ok;
    } catch {
      this.serverReachable = false;
      return false;
    }
  }

  private persist(): void {
    writeJson(PENDING_KEY, this.pending);
    this.onChange?.();
  }
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    window.clearTimeout(timer);
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked - the game still plays, scores just will not persist */
  }
}

function makeId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
