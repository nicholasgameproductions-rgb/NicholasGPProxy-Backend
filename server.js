'use strict';
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 10000);
const ORIGINS = new Set(['https://cdn.jsdelivr.net', 'https://nicholasgameproductions-rgb.github.io']);
const MAGIC = Buffer.from([110,209,210,184,240,105,71,124,161,147,176,203,72,148,189,109,178,243,213,20,57,125,96,243,158,150,135,196,241,183,216,244]);
const KEY = crypto.createHash('sha256').update(MAGIC).digest();
const MAX_FRAME = 1024 * 1024, MAX_STREAMS = 16, MAX_CLIENTS_PER_IP = 3;
const clients = new Map();
const denyIP = ip => {
  const a = ip.split('.').map(Number);
  if (a.length !== 4 || a.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
    (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
    (a[0] === 169 && a[1] === 254) ||
    (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
    (a[0] === 192 && (a[1] === 168 || a[1] === 0)) ||
    (a[0] === 198 && (a[1] === 18 || a[1] === 19)) ||
    (a[0] === 192 && a[1] === 0 && a[2] === 2) ||
    (a[0] === 198 && a[1] === 51 && a[2] === 100) ||
    (a[0] === 203 && a[1] === 0 && a[2] === 113);
};
function validHost(host) {
  return typeof host === 'string' && host.length <= 253 &&
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(host) &&
    host.includes('.') && !host.includes('..') && !net.isIP(host) &&
    !/\.(local|localhost|internal|test|invalid|onion)$/.test(host);
}
function packet(type, id, data = Buffer.alloc(0)) {
  const b = Buffer.alloc(5 + data.length);
  b[0] = type;
  b.writeUInt32LE(id, 1);
  Buffer.from(data).copy(b, 5);
  return b;
}
function number(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function cors(origin) {
  const h = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true' };
  if (ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = cors(origin);
  const write = (data, status = 200) => {res.writeHead(status, headers); res.end(JSON.stringify(data));};
  if (req.method === 'OPTIONS') {res.writeHead(204, headers); return res.end();}
  if (origin && !ORIGINS.has(origin)) return write({ error: 'Origin not allowed' }, 403);
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/api/ping') return write({ok:true,service:'NicholasGPProxy',relay:'amr-v1',host:'render',version:'stable-1'});
  if (u.pathname === '/api/ac') {
    const q = (u.searchParams.get('q') || '').trim().slice(0, 120);
    if (q.length < 2) return write([]);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      let response;
      try { response = await fetch('https://duckduckgo.com/ac/?q=' + encodeURIComponent(q) + '&type=list', {signal:controller.signal}); }
      finally { clearTimeout(timer); }
      const data = response.ok ? await response.json() : [];
      return write(Array.isArray(data) ? data.map(x => typeof x === 'string' ? x : x?.phrase).filter(x => typeof x === 'string').slice(0,8) : []);
    } catch { return write([]); }
  }
  write({error:'Not found'},404);
});

const wss = new WebSocketServer({noServer:true, maxPayload:MAX_FRAME+64, perMessageDeflate:false});
server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const origin = req.headers.origin;
  // Browsers send an Origin on WebSocket handshakes. Reject other clients by default.
  if (!['/fairs/', '/piers/'].includes(path) || !ORIGINS.has(origin)) return socket.destroy();
  const ip = req.socket.remoteAddress || 'unknown';
  const n = clients.get(ip) || 0;
  if (n >= MAX_CLIENTS_PER_IP) return socket.destroy();
  clients.set(ip, n + 1);
  wss.handleUpgrade(req, socket, head, ws => {
    ws.once('close', () => {
      const count = (clients.get(ip) || 1) - 1;
      if (count <= 0) clients.delete(ip); else clients.set(ip, count);
    });
    wss.emit('connection', ws);
  });
});
wss.on('connection', ws => {
  const streams = new Map();
  let ready = false, stopped = false, queue = Promise.resolve();
  function send(b) {
    if (!ready || stopped || ws.readyState !== WebSocket.OPEN) return;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, nonce);
    const ciphertext = Buffer.concat([cipher.update(b), cipher.final()]);
    if (ws.bufferedAmount > 4 * MAX_FRAME) {ws.close(1011, 'Backpressure');return;}
    ws.send(Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]));
  }
  function end(id, reason=1, notify=true) {
    const s = streams.get(id); if (!s) return;
    streams.delete(id); s.destroy();
    if (notify) send(packet(4,id,Buffer.from([reason])));
  }
  async function open(id, payload) {
    if (streams.has(id) || streams.size >= MAX_STREAMS || payload.length < 4 || payload[0] !== 1)
      return send(packet(4,id,Buffer.from([3])));
    const port = payload.readUInt16LE(1), host = payload.subarray(3).toString('utf8').toLowerCase().trim();
    if (![80,443].includes(port) || !validHost(host)) return send(packet(4,id,Buffer.from([3])));
    try {
      // Resolve, filter, and connect to the exact checked address to avoid DNS rebinding.
      const ips = await dns.resolve4(host);
      const ip = ips.find(x => !denyIP(x));
      if (!ip || stopped) throw Error('Unsafe or unavailable address');
      const s = net.connect({host:ip,port,timeout:12000});
      s.setNoDelay(true);
      await new Promise((resolve,reject) => {
        s.once('connect',resolve); s.once('error',reject); s.once('timeout',()=>reject(Error('timeout')));
      });
      if (stopped) return s.destroy();
      streams.set(id,s);
      s.on('data', data => {
        for (let pos=0;pos<data.length;pos+=65536) send(packet(2,id,data.subarray(pos,pos+65536)));
        if(ws.bufferedAmount > 2*MAX_FRAME){s.pause();setTimeout(()=>{if(!s.destroyed)s.resume()},100);}
      });
      s.on('error',()=>end(id,3));
      s.on('close',()=>end(id,1));
      send(packet(3,id,number(32)));
    } catch {send(packet(4,id,Buffer.from([3])));}
  }
  async function process(raw) {
    if (stopped) return;
    if (!ready) {
      if (!raw.equals(MAGIC)) throw Error('Bad handshake');
      ready=true; send(packet(3,0,number(32))); return;
    }
    if (raw.length < 29 || raw.length > MAX_FRAME+64) throw Error('Bad encrypted packet');
    const decipher = crypto.createDecipheriv('aes-256-gcm',KEY,raw.subarray(0,12));
    decipher.setAuthTag(raw.subarray(raw.length-16));
    const b = Buffer.concat([decipher.update(raw.subarray(12,-16)),decipher.final()]);
    if (b.length < 5 || b.length > MAX_FRAME) throw Error('Bad frame');
    const type = b[0], id = b.readUInt32LE(1), body=b.subarray(5);
    if (type === 1) await open(id,body);
    else if (type === 2) {const s=streams.get(id);if(s) {if(s.destroyed)end(id,3);else {s.write(body);send(packet(3,id,number(1)));}}}
    else if (type === 4) end(id,body[0]||1,false);
  }
  ws.on('message', (data, isBinary) => {
    queue=queue.then(()=>{if(!isBinary) throw Error('Binary only');return process(Buffer.from(data));})
      .catch(()=>{stopped=true;ws.close(1008,'Protocol error');});
  });
  function cleanup(){stopped=true;for(const s of streams.values())s.destroy();streams.clear();}
  ws.on('close',cleanup); ws.on('error',cleanup);
});
server.listen(PORT,'0.0.0.0',()=>console.log(`NicholasGPProxy listening on ${PORT}`));
