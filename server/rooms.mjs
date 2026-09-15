/**
 * Private match rooms.
 *
 * The server is a dumb relay on purpose: both clients simulate the maze from
 * the shared seed and exchange only "where am I" packets plus a handful of
 * events. That keeps the bandwidth at a few hundred bytes a second and means a
 * laggy connection never desynchronises the maze itself.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const ROOM_IDLE_MS = 15 * 60 * 1000;
const MAX_ROOMS = 500;

/** Packets a client may relay untouched to its partner. */
const RELAYABLE = new Set(['state', 'event']);

export class RoomHub {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    setInterval(() => this.sweep(), 60_000).unref?.();
  }

  get size() {
    return this.rooms.size;
  }

  /** @param {import('./ws.mjs').WebSocketConnection} connection */
  attach(connection) {
    const client = { connection, room: null, slot: -1, name: 'Ghost' };

    connection.onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message || typeof message.t !== 'string') return;
      this.handle(client, message);
    };

    connection.onClose = () => this.leave(client, 'left');
  }

  handle(client, message) {
    switch (message.t) {
      case 'create':
        this.create(client, message);
        break;
      case 'join':
        this.join(client, message);
        break;
      case 'leave':
        this.leave(client, 'left');
        break;
      case 'ping':
        client.connection.sendJson({ t: 'pong', at: message.at ?? Date.now() });
        break;
      default:
        if (RELAYABLE.has(message.t)) this.relay(client, message);
        break;
    }
  }

  create(client, message) {
    if (client.room) this.leave(client, 'left');
    if (this.rooms.size >= MAX_ROOMS) {
      client.connection.sendJson({ t: 'error', message: 'The server is full, try again shortly.' });
      return;
    }

    const code = this.makeCode();
    const hostRole = message.role === 'seeker' ? 'seeker' : 'hider';
    const room = {
      code,
      seed: (Math.random() * 0xffffffff) >>> 0,
      hostRole,
      difficulty: normaliseDifficulty(message.difficulty),
      clients: [client, null],
      createdAt: Date.now(),
      touchedAt: Date.now(),
      started: false,
    };

    client.room = room;
    client.slot = 0;
    client.name = cleanName(message.name);
    this.rooms.set(code, room);

    client.connection.sendJson({
      t: 'created',
      code,
      seed: room.seed,
      role: hostRole,
      difficulty: room.difficulty,
      you: client.name,
    });
  }

  join(client, message) {
    const code = String(message.code ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);

    if (!room) {
      client.connection.sendJson({ t: 'error', message: `No game found with code ${code || '????'}.` });
      return;
    }
    if (room.clients[1] && room.clients[1] !== client) {
      client.connection.sendJson({ t: 'error', message: 'That game already has two ghosts.' });
      return;
    }
    if (client.room && client.room !== room) this.leave(client, 'left');

    client.room = room;
    client.slot = 1;
    client.name = cleanName(message.name);
    room.clients[1] = client;
    room.touchedAt = Date.now();
    room.started = true;

    const host = room.clients[0];
    const guestRole = room.hostRole === 'seeker' ? 'hider' : 'seeker';

    client.connection.sendJson({
      t: 'joined',
      code: room.code,
      seed: room.seed,
      role: guestRole,
      difficulty: room.difficulty,
      you: client.name,
      peer: host?.name ?? 'Ghost',
    });

    host?.connection.sendJson({ t: 'peerJoined', peer: client.name });

    // Both sides start together, a moment in the future so the packet lands first.
    const startAt = Date.now() + 900;
    for (const member of room.clients) {
      member?.connection.sendJson({ t: 'start', at: startAt, peer: this.peerName(room, member) });
    }
  }

  relay(client, message) {
    const room = client.room;
    if (!room) return;
    room.touchedAt = Date.now();
    const peer = room.clients[client.slot === 0 ? 1 : 0];
    if (!peer) return;
    peer.connection.sendJson(message);
  }

  leave(client, reason) {
    const room = client.room;
    client.room = null;
    if (!room) return;

    room.clients[client.slot] = null;
    const peer = room.clients[client.slot === 0 ? 1 : 0];
    if (peer) {
      peer.connection.sendJson({ t: 'peerLeft', reason });
    }
    if (!room.clients[0] && !room.clients[1]) {
      this.rooms.delete(room.code);
    }
  }

  peerName(room, member) {
    const peer = room.clients[member === room.clients[0] ? 1 : 0];
    return peer?.name ?? 'Ghost';
  }

  makeCode() {
    for (let attempt = 0; attempt < 200; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    return `${Date.now().toString(36).toUpperCase().slice(-5)}`;
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      const empty = !room.clients[0] && !room.clients[1];
      if (empty || now - room.touchedAt > ROOM_IDLE_MS) {
        for (const member of room.clients) member?.connection.close(1000, 'Room closed');
        this.rooms.delete(code);
      }
    }
  }
}

function cleanName(value) {
  if (typeof value !== 'string') return 'Ghost';
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return cleaned || 'Ghost';
}

function normaliseDifficulty(value) {
  return value === 'easy' || value === 'hard' ? value : 'normal';
}
