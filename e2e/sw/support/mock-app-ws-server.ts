/**
 * A minimal raw WebSocket server that speaks the dig-app APP-SIGN wire (dig-app `SPEC.md §5.6`) for
 * the SIGN-4 e2e. The built extension's service worker connects to it over a REAL `ws://127.0.0.1:9779`
 * socket (no `ws` npm dep — Node ships no WS server, so this does the RFC 6455 handshake + frame
 * codec by hand). It verifies each post-pairing frame's auth-MAC with the SAME construction the
 * extension uses (proving both sides agree byte-for-byte) and RECORDS the origin each connect/sign
 * frame carried, so the test asserts the extension relayed the browser-committed origin.
 *
 * TEST-ONLY.
 */
import { createServer, type Server } from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import type { Socket } from 'node:net';
import { canonicalFrameBytes, base64ToBytes } from '../../../src/lib/app-sign/auth-frame';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CHANNEL_TOKEN_B64 = Buffer.alloc(32, 7).toString('base64');
const PAIRING_ID = 'e2e-pairing-id';

/** A frame the server observed, for assertions (method + the origin it carried). */
export interface Observed {
  method: string;
  origin?: string;
}

export interface MockAppWsServer {
  readonly observed: Observed[];
  close(): Promise<void>;
}

/** Start the mock dig-app identity endpoint on `127.0.0.1:9779`. */
export async function startMockAppWsServer(): Promise<MockAppWsServer> {
  const observed: Observed[] = [];
  let lastNonce = 0;

  const sockets = new Set<Socket>();
  const server: Server = createServer();
  server.on('upgrade', (req, socket) => {
    const s = socket as Socket;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
    handleUpgrade(req.headers['sec-websocket-key'], s);
  });

  function handleUpgrade(key: string | undefined, socket: Socket): void {
    const accept = createHash('sha1').update((key ?? '') + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = drainFrames(buffer, socket);
    });
    socket.on('error', () => socket.destroy());
  }

  /** Decode as many complete client text frames as `buffer` holds; dispatch each; return the rest. */
  function drainFrames(buffer: Buffer, socket: Socket): Buffer {
    let buf = buffer;
    for (;;) {
      const frame = decodeClientFrame(buf);
      if (!frame) return buf;
      buf = frame.rest;
      if (frame.text != null) void dispatch(frame.text, socket);
    }
  }

  async function dispatch(text: string, socket: Socket): Promise<void> {
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown>; auth?: { nonce?: number; mac_b64?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const { id, method, params = {}, auth } = msg;
    const origin = typeof params.origin === 'string' ? params.origin : undefined;
    observed.push({ method: method ?? '?', origin });

    if (method === 'pair.begin') {
      return sendJson(socket, { jsonrpc: '2.0', id, result: { pairing_id: PAIRING_ID, channel_token_b64: CHANNEL_TOKEN_B64 } });
    }
    if (!auth || typeof auth.nonce !== 'number' || auth.nonce <= lastNonce) {
      return sendErr(socket, id, 'AUTH_REPLAY');
    }
    const expected = createHmac('sha256', base64ToBytes(CHANNEL_TOKEN_B64))
      .update(canonicalFrameBytes(auth.nonce, method ?? '', params as never))
      .digest('base64');
    if (expected !== auth.mac_b64) return sendErr(socket, id, 'AUTH_BAD_MAC');
    lastNonce = auth.nonce;

    if (method === 'connect.request') {
      return sendJson(socket, { jsonrpc: '2.0', id, result: { granted: true, profile_did: 'did:chia:e2e', addresses: ['xch1e2e'], pubkeys: ['b0e2e'] } });
    }
    if (method === 'sign.request') {
      return sendJson(socket, { jsonrpc: '2.0', id, result: { signature_b64: Buffer.alloc(64, 3).toString('base64'), pubkey_hex: 'b0e2e' } });
    }
    sendErr(socket, id, 'BAD_RESPONSE');
  }

  function sendJson(socket: Socket, obj: unknown): void {
    socket.write(encodeServerTextFrame(JSON.stringify(obj)));
  }
  function sendErr(socket: Socket, id: unknown, code: string): void {
    sendJson(socket, { jsonrpc: '2.0', id, error: { code: -32000, message: code, data: code } });
  }

  await new Promise<void>((resolve) => server.listen(9779, '127.0.0.1', resolve));

  return {
    observed,
    close: () =>
      new Promise<void>((resolve) => {
        // Stop accepting first (so a SW reconnect is refused, not re-tracked), then destroy every
        // live socket — otherwise `server.close` waits forever on the SW's persistent connection.
        server.close(() => resolve());
        for (const s of sockets) s.destroy();
        sockets.clear();
      }),
  };
}

/** Decode ONE masked client text frame (opcode 0x1); returns its text + the unconsumed rest, or null. */
function decodeClientFrame(buf: Buffer): { text: string | null; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const mask = masked ? buf.subarray(offset, offset + 4) : Buffer.alloc(0);
  const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  const rest = buf.subarray(offset + maskLen + len);
  // Only surface text frames (0x1); ignore close/ping/pong for this minimal server.
  return { text: opcode === 0x1 ? payload.toString('utf8') : null, rest };
}

/** Encode a server→client unmasked text frame (payloads here are always < 64 KiB). */
function encodeServerTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}
