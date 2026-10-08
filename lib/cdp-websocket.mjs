// Minimal RFC 6455 WebSocket client for talking to Chrome's DevTools endpoint.
// The tool has no npm dependencies and may run on Node 18, which has no global WebSocket, so
// this speaks the protocol directly over an HTTP upgrade. Only what CDP needs: text messages
// (fragmented or not, up to hundreds of MB), ping/pong and close. No extensions, no TLS.

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };

// Opens ws://host:port/path. Resolves with a WebSocket once the handshake succeeded.
export function connectWebSocket(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const key = crypto.randomBytes(16).toString('base64');
    const request = http.request({
      host: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
        // No Origin header on purpose: Chrome ≥ 111 rejects origins not listed in
        // --remote-allow-origins, but accepts clients that send none.
      }
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`WebSocket connect timed out after ${timeoutMs} ms: ${url}`));
    }, timeoutMs);
    request.on('upgrade', (response, socket, head) => {
      clearTimeout(timer);
      const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        reject(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'));
        return;
      }
      resolve(new WebSocket(socket, head));
    });
    request.on('response', response => {
      clearTimeout(timer);
      response.resume();
      reject(new Error(`WebSocket upgrade refused: HTTP ${response.statusCode} for ${url}`));
    });
    request.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    request.end();
  });
}

// Events: 'message' (string), 'close' ({ code, reason }), 'error' (Error). 'close' fires exactly once.
export class WebSocket extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.open = true;
    // Incoming bytes are kept as a list of chunks and only concatenated once a whole frame is
    // there: re-concatenating a growing buffer per TCP chunk is quadratic for multi-MB messages.
    this.chunks = [];
    this.buffered = 0;
    this.fragments = [];
    socket.setNoDelay(true);
    socket.on('data', chunk => this.receive(chunk));
    socket.on('error', error => {
      // A reset socket (tab crashed, browser quit) ends in 'close' as well; report, don't throw.
      if (this.listenerCount('error')) this.emit('error', error);
    });
    socket.on('close', () => this.finish(1006, 'socket closed'));
    if (head && head.length) this.receive(head);
  }

  send(text) {
    if (!this.open) throw new Error('WebSocket is closed');
    this.socket.write(encodeFrame(OPCODE.text, Buffer.from(text, 'utf8')));
  }

  close(code = 1000) {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      this.socket.write(encodeFrame(OPCODE.close, payload));
    } catch {}
    this.socket.end();
    // Do not wait for the peer's close frame forever.
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.finish(code, 'closed by client');
  }

  finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    this.chunks = [];
    this.fragments = [];
    this.emit('close', { code, reason });
  }

  receive(chunk) {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    while (this.open) {
      const frame = this.parseHeader();
      if (!frame || this.buffered < frame.headerLength + frame.length) return;
      this.take(frame.headerLength);
      const payload = this.take(frame.length);
      if (frame.mask) for (let i = 0; i < payload.length; i++) payload[i] ^= frame.mask[i & 3];
      this.handleFrame(frame, payload);
    }
  }

  // Reads the frame header (2-14 bytes) without consuming it; null until enough bytes are buffered.
  parseHeader() {
    if (this.buffered < 2) return null;
    const start = this.peek(Math.min(this.buffered, 14));
    const fin = (start[0] & 0x80) !== 0;
    const opcode = start[0] & 0x0f;
    const masked = (start[1] & 0x80) !== 0;
    let length = start[1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (start.length < 4) return null;
      length = start.readUInt16BE(2);
      headerLength = 4;
    } else if (length === 127) {
      if (start.length < 10) return null;
      // 2^53 is far beyond anything a socket will deliver; Number is exact up to there.
      length = Number(start.readBigUInt64BE(2));
      headerLength = 10;
    }
    let mask = null;
    if (masked) {
      if (start.length < headerLength + 4) return null;
      mask = start.subarray(headerLength, headerLength + 4);
      headerLength += 4;
    }
    return { fin, opcode, length, headerLength, mask: mask && Buffer.from(mask) };
  }

  peek(count) {
    if (this.chunks[0].length >= count) return this.chunks[0].subarray(0, count);
    return Buffer.concat(this.chunks, Math.min(count, this.buffered)).subarray(0, count);
  }

  // Removes `count` bytes from the front of the chunk list; copies only when a frame spans chunks.
  take(count) {
    this.buffered -= count;
    const first = this.chunks[0];
    if (count === 0) return Buffer.alloc(0);
    if (first.length === count) return this.chunks.shift();
    if (first.length > count) {
      this.chunks[0] = first.subarray(count);
      return Buffer.from(first.subarray(0, count));
    }
    const out = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.chunks[0];
      const needed = count - offset;
      if (chunk.length <= needed) {
        chunk.copy(out, offset);
        offset += chunk.length;
        this.chunks.shift();
      } else {
        chunk.copy(out, offset, 0, needed);
        this.chunks[0] = chunk.subarray(needed);
        offset += needed;
      }
    }
    return out;
  }

  handleFrame(frame, payload) {
    switch (frame.opcode) {
      case OPCODE.ping:
        if (this.open) this.socket.write(encodeFrame(OPCODE.pong, payload));
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        try {
          this.socket.write(encodeFrame(OPCODE.close, payload.subarray(0, 2)));
        } catch {}
        this.socket.end();
        this.finish(code, payload.subarray(2).toString('utf8'));
        return;
      }
      case OPCODE.text:
      case OPCODE.binary:
      case OPCODE.continuation: {
        this.fragments.push(payload);
        if (!frame.fin) return;
        // Decode once at the end: a UTF-8 character may be split across fragments.
        const message = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
        this.fragments = [];
        this.emit('message', message.toString('utf8'));
        return;
      }
      default:
        // Unknown opcode: the stream can no longer be trusted.
        this.socket.destroy();
        this.finish(1002, `unknown opcode ${frame.opcode}`);
    }
  }
}

// Client-to-server frames must be masked (RFC 6455 §5.3).
function encodeFrame(opcode, payload) {
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = crypto.randomBytes(4);
  mask.copy(frame, headerLength);
  const offset = headerLength + 4;
  for (let i = 0; i < length; i++) frame[offset + i] = payload[i] ^ mask[i & 3];
  return frame;
}
