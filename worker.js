/* 火柴人决斗 · Cloudflare Worker 联机服务器（亚太节点） */
import GAME_HTML from './index.html';

const NET_VER = 7;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const id = env.RELAY.idFromName('stickman-apac-v2');
      return env.RELAY.get(id, { locationHint: 'apac' }).fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response(GAME_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
    });
  }
};

export class Relay {
  constructor(state, env) {
    this.state = state;
    this.rooms = new Map();
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.room = null;
    server.slot = 0;

    server.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      try { this.onMessage(server, msg); } catch (e) {}
    });
    server.addEventListener('close', () => this.handleClose(server));
    server.addEventListener('error', () => this.handleClose(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  newCode() {
    const chars = 'ACDEFGHJKLMNPQRTUVWXY3456789';
    let c = '';
    do {
      c = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.rooms.has(c));
    return c;
  }

  roomOf(ws) { return ws.room ? this.rooms.get(ws.room) : null; }

  onMessage(ws, msg) {
    const t = msg.type;
    const send = (w, o) => this.send(w, o);

    if (t === 'create') {
      if (ws.room) return;
      const code = this.newCode();
      const mode = msg.mode === 'team' ? 'team' : '1v1';
      ws.room = code; ws.slot = 1;
      this.rooms.set(code, { clients: [ws], chars: null, seed: 0, frame: 0, mode });
      send(ws, { type: 'joined', room: code, slot: 1, ver: NET_VER, mode });
    } else if (t === 'join') {
      if (ws.room) return;
      const code = String(msg.room || '').toUpperCase().trim();
      const r = this.rooms.get(code);
      if (!r) { send(ws, { type: 'notfound' }); return; }
      if (r.clients.length >= 2) { send(ws, { type: 'full' }); return; }
      ws.room = code; ws.slot = 2;
      r.clients.push(ws);
      send(ws, { type: 'joined', room: code, slot: 2, ver: NET_VER, mode: r.mode || '1v1' });
      const host = r.clients[0];
      send(host, { type: 'peer' }); send(ws, { type: 'peer' });
      if (r.chars && r.stateSent) {
        send(ws, { type: 'start', c1: r.chars[0], c2: r.chars[1], seed: r.seed, mode: '1v1' });
        if (r.lastState) send(ws, { type: 'state', s: r.lastState });
      }
    } else if (t === 'pick') {
      const r = this.roomOf(ws); if (!r) return;
      r.picks = r.picks || {};
      const pick = String((Array.isArray(msg.chars) && msg.chars[0]) || msg.char || 'niu');
      r.picks[ws.slot] = pick;
      if (!r.picks[1] || !r.picks[2]) return;
      r.lastState = null;
      r.seed = (Math.random() * 1e9) | 0;
      r.frame = 0;
      r.chars = [r.picks[1], r.picks[2]];
      r.stateSent = true;
      r.clients.forEach((c) => send(c, { type: 'start', c1: r.chars[0], c2: r.chars[1], seed: r.seed, mode: '1v1' }));
      r.picks = null;
    } else if (t === 'ctl') {
      const r = this.roomOf(ws); if (!r || r.clients.length < 2) return;
      const other = r.clients.find((c) => c !== ws);
      if (other) send(other, { type: 'ctl', h: msg.h });
    } else if (t === 'in') {
      const r = this.roomOf(ws); if (!r || r.clients.length < 2) return;
      const other = r.clients.find((c) => c !== ws);
      if (other) send(other, { type: 'in', frame: msg.frame, inp: msg.inp });
    } else if (t === 'snap') {
      const r = this.roomOf(ws); if (!r || r.clients.length < 2) return;
      const other = r.clients.find((c) => c !== ws);
      if (other) send(other, { type: 'snap', st: msg.st });
    } else if (t === 'state') {
      const r = this.roomOf(ws); if (!r) return;
      const other = r.clients.find((c) => c !== ws);
      r.lastState = msg.s;
      if (other) send(other, { type: 'state', s: msg.s });
    } else if (t === 'again') {
      const r = this.roomOf(ws); if (!r) return;
      r.clients.forEach((c) => send(c, {
        type: 'again', c1: r.chars[0], c2: r.chars[1],
        seed: (Math.random() * 1e9) | 0, mode: '1v1'
      }));
    } else if (t === 'leave') {
      this.handleClose(ws);
    }
  }

  handleClose(ws) {
    if (ws._done) return;
    ws._done = true;
    const r = this.roomOf(ws);
    if (r) {
      r.clients = r.clients.filter((c) => c !== ws);
      r.clients.forEach((c) => this.send(c, { type: 'peer_left' }));
      if (r.clients.length === 0) this.rooms.delete(ws.room);
      else r.picks = null;
    }
    ws.room = null;
  }
}
