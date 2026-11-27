/* =====================================================================
 *   火柴人决斗 · Cloudflare Worker 联机中继（亚太节点）
 *   协议版本 NET_VER 必须与游戏内 src/net.js 一致：9
 *
 *   服务器只做三件事：
 *     1. 建房间 / 分配房间号 / 让两人配对
 *     2. 收齐双方选人后生成 seed，统一下发 start
 *     3. 原样转发 in（逐帧输入）、hash（状态哈希）、ping/pong
 *   战斗模拟在两端本地各跑一份（双端锁步），服务器不碰战斗逻辑。
 * ===================================================================== */
import GAME_HTML from './index.html';

const NET_VER = 9;
const ROOM_CHARS = 'ACDEFGHJKLMNPQRTUVWXY3456789';
const ROOM_LEN = 4;
const RELAY_ROOM = 'stickman-apac-v2';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const id = env.RELAY.idFromName(RELAY_ROOM);
      return env.RELAY.get(id, { locationHint: 'apac' }).fetch(req);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response(GAME_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    });
  },
};

export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map(); // code -> { clients, mode, picks, relicPicks, chars, relics, seed }
  }

  async fetch() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.room = null;
    server.slot = 0;
    server._done = false;

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
    if (!ws || ws._done) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  roomOf(ws) {
    return ws.room ? this.rooms.get(ws.room) : null;
  }

  otherOf(ws, r) {
    if (!r || r.clients.length < 2) return null;
    return r.clients.find((c) => c !== ws) || null;
  }

  newCode() {
    let c = '';
    do {
      c = Array.from({ length: ROOM_LEN }, () =>
        ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]).join('');
    } while (this.rooms.has(c));
    return c;
  }

  onMessage(ws, msg) {
    const t = msg.type;

    if (t === 'create') {
      if (ws.room) return;
      const code = this.newCode();
      const mode = msg.mode === 'team' ? 'team' : '1v1';
      ws.room = code;
      ws.slot = 1;
      this.rooms.set(code, { clients: [ws], mode, picks: null, relicPicks: null, chars: null, relics: null, seed: 0 });
      this.send(ws, { type: 'joined', room: code, slot: 1, ver: NET_VER, mode });

    } else if (t === 'join') {
      if (ws.room) return;
      const code = String(msg.room || '').toUpperCase().trim();
      const r = this.rooms.get(code);
      if (!r) { this.send(ws, { type: 'notfound' }); return; }
      if (r.clients.length >= 2) { this.send(ws, { type: 'full' }); return; }
      ws.room = code;
      ws.slot = 2;
      r.clients.push(ws);
      this.send(ws, { type: 'joined', room: code, slot: 2, ver: NET_VER, mode: r.mode || '1v1' });
      const host = r.clients[0];
      this.send(host, { type: 'peer' });
      this.send(ws, { type: 'peer' });

    } else if (t === 'pick') {
      const r = this.roomOf(ws);
      if (!r) return;
      r.picks = r.picks || {};
      r.relicPicks = r.relicPicks || {};
      const mode = r.mode === 'team' ? 'team' : '1v1';

      if (mode === 'team') {
        const picked = Array.isArray(msg.chars)
          ? msg.chars.map(String).slice(0, 3)
          : (msg.char ? [String(msg.char)] : []);
        if (picked.length < 3) return;            /* 车轮战必须选满 3 人 */
        r.picks[ws.slot] = picked;
        r.relicPicks[ws.slot] = Array.isArray(msg.relics) ? msg.relics.slice(0, 3) : [null, null, null];
        if (!r.picks[1] || !r.picks[2]) return;
        r.seed = (Math.random() * 1e9) | 0;
        r.chars = [r.picks[1], r.picks[2]];
        r.relics = [r.relicPicks[1] || [null, null, null], r.relicPicks[2] || [null, null, null]];
        r.clients.forEach((c) => this.send(c, {
          type: 'start',
          c1: r.chars[0][0], c2: r.chars[1][0],
          c1s: r.chars[0], c2s: r.chars[1],
          c1r: r.relics[0], c2r: r.relics[1],
          seed: r.seed, mode: 'team',
        }));
        r.picks = null;
      } else {
        const pick = String((Array.isArray(msg.chars) && msg.chars[0]) || msg.char || 'niu');
        r.picks[ws.slot] = pick;
        r.relicPicks[ws.slot] = (Array.isArray(msg.relics) && msg.relics[0]) ? String(msg.relics[0]) : null;
        if (!r.picks[1] || !r.picks[2]) return;
        r.seed = (Math.random() * 1e9) | 0;
        r.chars = [r.picks[1], r.picks[2]];
        r.relics = [r.relicPicks[1] || null, r.relicPicks[2] || null];
        r.clients.forEach((c) => this.send(c, {
          type: 'start', c1: r.chars[0], c2: r.chars[1],
          r1: r.relics[0], r2: r.relics[1], seed: r.seed, mode: '1v1',
        }));
        r.picks = null;
      }

    } else if (t === 'ping' || t === 'pong') {
      /* 输入延迟测量：原样转给对方，服务器不参与计时 */
      const other = this.otherOf(ws, this.roomOf(ws));
      if (other) this.send(other, { type: t, id: msg.id, t: msg.t });

    } else if (t === 'in') {
      /* 双端锁步：只转发带帧号的输入 */
      const r = this.roomOf(ws);
      if (!r || r.clients.length < 2) return;
      if (typeof msg.f !== 'number' || !msg.i) return;
      const other = this.otherOf(ws, r);
      if (other) this.send(other, { type: 'in', f: msg.f, i: msg.i });

    } else if (t === 'hash') {
      /* 状态哈希看门狗：只转发 */
      const r = this.roomOf(ws);
      if (!r || r.clients.length < 2) return;
      if (typeof msg.f !== 'number' || typeof msg.h !== 'number') return;
      const other = this.otherOf(ws, r);
      if (other) this.send(other, { type: 'hash', f: msg.f, h: msg.h });

    } else if (t === 'again') {
      const r = this.roomOf(ws);
      if (!r || !r.chars) return;
      const seed = (Math.random() * 1e9) | 0;
      if (r.mode === 'team') {
        r.clients.forEach((c) => this.send(c, {
          type: 'again', c1: r.chars[0][0], c2: r.chars[1][0],
          c1s: r.chars[0], c2s: r.chars[1], c1r: r.relics[0], c2r: r.relics[1],
          seed, mode: 'team',
        }));
      } else {
        r.clients.forEach((c) => this.send(c, {
          type: 'again', c1: r.chars[0], c2: r.chars[1],
          r1: r.relics[0], r2: r.relics[1], seed, mode: '1v1',
        }));
      }

    } else if (t === 'leave') {
      this.handleClose(ws);
      try { ws.close(1000, 'left'); } catch (e) {}
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
