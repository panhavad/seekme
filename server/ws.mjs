/**
 * A very small WebSocket server (RFC 6455), written by hand so the game keeps
 * its zero-dependency deployment. It speaks exactly as much of the protocol as
 * SeekMe needs: text frames, ping/pong and a clean close.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 64 * 1024;

export const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

export class WebSocketConnection {
  /**
   * @param {import('node:net').Socket} socket
   */
  constructor(socket) {
    this.socket = socket;
    this.open = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.alive = true;
    /** @type {((message: string) => void) | null} */
    this.onMessage = null;
    /** @type {(() => void) | null} */
    this.onClose = null;

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());

    this.heartbeat = setInterval(() => {
      if (!this.open) return;
      if (!this.alive) {
        this.destroy();
        return;
      }
      this.alive = false;
      this.sendFrame(OPCODE.PING, Buffer.alloc(0));
    }, 25_000);
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const frame = decodeFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.size);

      switch (frame.opcode) {
        case OPCODE.PING:
          this.sendFrame(OPCODE.PONG, frame.payload);
          break;
        case OPCODE.PONG:
          this.alive = true;
          break;
        case OPCODE.CLOSE:
          this.close();
          break;
        case OPCODE.CONTINUATION:
        case OPCODE.TEXT:
        case OPCODE.BINARY: {
          if (frame.opcode !== OPCODE.CONTINUATION) {
            this.fragments = [];
            this.fragmentOpcode = frame.opcode;
          }
          this.fragments.push(frame.payload);
          const total = this.fragments.reduce((sum, part) => sum + part.length, 0);
          if (total > MAX_MESSAGE_BYTES) {
            this.close(1009, 'Message too big');
            return;
          }
          if (frame.fin) {
            const payload = Buffer.concat(this.fragments);
            this.fragments = [];
            this.alive = true;
            if (this.fragmentOpcode === OPCODE.TEXT && this.onMessage) {
              this.onMessage(payload.toString('utf8'));
            }
          }
          break;
        }
        default:
          this.close(1002, 'Unsupported opcode');
          return;
      }
    }
  }

  /** @param {string} text */
  send(text) {
    if (!this.open) return;
    this.sendFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'));
  }

  /** @param {unknown} value */
  sendJson(value) {
    this.send(JSON.stringify(value));
  }

  sendFrame(opcode, payload) {
    if (!this.open) return;
    try {
      this.socket.write(encodeFrame(opcode, payload));
    } catch {
      this.destroy();
    }
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.sendFrame(OPCODE.CLOSE, payload);
    this.destroy();
  }

  destroy() {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.heartbeat);
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.onClose?.();
  }
}

/**
 * Hooks the WebSocket handshake onto an existing http server.
 * @param {import('node:http').Server} server
 * @param {string} path
 * @param {(connection: WebSocketConnection, request: import('node:http').IncomingMessage) => void} onConnection
 */
export function attachWebSocketServer(server, path, onConnection) {
  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || !key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);

    onConnection(new WebSocketConnection(socket), request);
  });
}

/** Reads one frame, or null when more bytes are needed. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return null;
    length = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }

  return { fin, opcode, payload, size: offset + length };
}

/** Server frames are never masked. */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}
