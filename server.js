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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true' };
  if (ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
// Independent Games + AI API for the existing NicholasGPProxy frontend.
const GAMES = [
  {id:'snake',name:'Snake',type:'embed',thumb:'/api/games/thumb/snake'},
  {id:'tictactoe',name:'Tic Tac Toe',type:'embed',thumb:'/api/games/thumb/tictactoe'},
  {id:'clicker',name:'Speed Click',type:'embed',thumb:'/api/games/thumb/clicker'}
];
const aiLimits = new Map();
function encodePacked(data) {return {p:Buffer.from(JSON.stringify(data)).toString('base64url')};}
function decodePacked(raw) {
  if(!raw || typeof raw.p !== 'string' || raw.p.length > 300000) throw Error('Invalid payload');
  return JSON.parse(Buffer.from(raw.p,'base64url').toString('utf8'));
}
function sendJson(res, origin, data, status=200) {
  res.writeHead(status,cors(origin));res.end(JSON.stringify(data));
}
function readJson(req,max=300000) {
  return new Promise((resolve,reject)=>{
    let size=0,parts=[];
    req.on('data',b=>{size+=b.length;if(size>max){reject(Error('Payload too large'));req.destroy();}else parts.push(b);});
    req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(parts).toString('utf8')));}catch(e){reject(e);}});
    req.on('error',reject);
  });
}
function page(body,js) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NGP Games</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10101b;color:#f7f3ff;font:16px system-ui}main{text-align:center;width:min(95vw,500px);padding:24px}h1{font-size:32px;margin:0 0 12px}p{color:#c5bcd9}button{cursor:pointer;background:#6954cb;color:#fff;border:1px solid #8e79ff;border-radius:10px;padding:12px 16px;margin:4px;font:inherit}button:focus-visible{outline:3px solid white}canvas{background:#181627;max-width:100%;touch-action:none}#board{display:grid;grid-template-columns:repeat(3,80px);gap:8px;justify-content:center}#board button{height:80px;font-size:30px;margin:0}
  </style></head><body><main>${body}</main><script>${js}</script></body></html>`;
}
function gamePage(id) {
  if(id==='clicker')return page('<h1>Speed Click</h1><p>How many clicks in ten seconds?</p><h2 id="score">Ready?</h2><button id="tap">Tap</button><button id="reset">Reset</button>',
  `let n=0,end=0,interval;const btn=document.querySelector('#tap'),score=document.querySelector('#score');btn.onclick=()=>{if(!end){end=Date.now()+10000;interval=setInterval(()=>{const left=Math.max(0,Math.ceil((end-Date.now())/1000));score.textContent=n+' clicks · '+left+'s';if(left===0){clearInterval(interval);btn.disabled=true;score.textContent='Final score: '+n;}},100);}if(Date.now()<end)n++;};document.querySelector('#reset').onclick=()=>{clearInterval(interval);end=0;n=0;btn.disabled=false;score.textContent='Ready?';};`);
  if(id==='tictactoe')return page('<h1>Tic Tac Toe</h1><p id="status">X goes first</p><div id="board"></div><button id="reset">Restart</button>',
  `const board=document.querySelector('#board'),status=document.querySelector('#status');let cells,turn,done;function reset(){cells=Array(9).fill('');turn='X';done=false;status.textContent='X goes first';draw();}function draw(){board.replaceChildren();cells.forEach((v,i)=>{let b=document.createElement('button');b.textContent=v||'·';b.onclick=()=>move(i);board.append(b);});}function move(i){if(done||cells[i])return;cells[i]=turn;const lines=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];if(lines.some(a=>a.every(j=>cells[j]===turn))){done=true;status.textContent=turn+' wins!';}else if(cells.every(Boolean)){done=true;status.textContent='Draw!';}else{turn=turn==='X'?'O':'X';status.textContent=turn+' goes next';}draw();}document.querySelector('#reset').onclick=reset;reset();`);
  if(id==='snake')return page('<h1>Snake</h1><p id="score">Score: 0</p><canvas id="board" width="360" height="360"></canvas><p>Arrow keys / WASD</p><div><button data-dir="0,-1">↑</button><button data-dir="-1,0">←</button><button data-dir="0,1">↓</button><button data-dir="1,0">→</button></div><button id="reset">Restart</button>',
  `const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d'),score=document.querySelector('#score');let body,dir,next,apple,points,timer;function newApple(){let available=[];for(let x=0;x<18;x++)for(let y=0;y<18;y++)if(!body.some(v=>v[0]===x&&v[1]===y))available.push([x,y]);return available[Math.floor(Math.random()*available.length)]||[-1,-1];}function start(){body=[[9,9]];dir=[1,0];next=dir;apple=[3,3];points=0;score.textContent='Score: 0';clearInterval(timer);timer=setInterval(tick,130);draw();}function turn(x,y){if(x!==-dir[0]||y!==-dir[1])next=[x,y];}document.addEventListener('keydown',e=>{const m={ArrowUp:[0,-1],ArrowDown:[0,1],ArrowLeft:[-1,0],ArrowRight:[1,0],w:[0,-1],s:[0,1],a:[-1,0],d:[1,0]};if(m[e.key]){e.preventDefault();turn(...m[e.key]);}});document.querySelectorAll('[data-dir]').forEach(b=>b.onclick=()=>turn(...b.dataset.dir.split(',').map(Number)));function tick(){dir=next;const head=[body[0][0]+dir[0],body[0][1]+dir[1]];const eat=head[0]===apple[0]&&head[1]===apple[1];const check=eat?body:body.slice(0,-1);if(head.some(v=>v<0||v>=18)||check.some(p=>p[0]===head[0]&&p[1]===head[1])){clearInterval(timer);score.textContent='Game over · Score: '+points;return;}body.unshift(head);if(eat){points++;score.textContent='Score: '+points;apple=newApple();}else body.pop();draw();}function draw(){ctx.fillStyle='#181627';ctx.fillRect(0,0,360,360);ctx.fillStyle='#ae90ff';for(const p of body)ctx.fillRect(p[0]*20+1,p[1]*20+1,18,18);ctx.fillStyle='#fa5b82';ctx.fillRect(apple[0]*20+2,apple[1]*20+2,16,16);}document.querySelector('#reset').onclick=start;start();`);
  return null;
}
function svgThumb(id) {
 const g=GAMES.find(x=>x.id===id), color={snake:'#a586f5',tictactoe:'#60c8d5',clicker:'#fa7ba2'}[id];
 return g?`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" rx="20" fill="#151322"/><circle cx="160" cy="73" r="36" fill="${color}"/><text x="160" y="140" fill="white" font-family="Arial" font-size="25" text-anchor="middle">${g.name}</text></svg>`:null;
}
async function handleFeatures(req,res,u,origin) {
  const p=u.pathname;
  if(p==='/api/games' && req.method==='GET') {
    const q=(u.searchParams.get('q')||'').toLowerCase();
    const list=GAMES.filter(x=>x.name.toLowerCase().includes(q));
    return sendJson(res,origin,{games:list,total:list.length});
  }
  let m=p.match(/^\/api\/games\/(snake|tictactoe|clicker)$/);
  if(m && req.method==='GET') {
    const id=m[1],game=GAMES.find(g=>g.id===id);
    return sendJson(res,origin,{meta:game,type:'embed',thumb:`${u.origin}/api/games/thumb/${id}`,url:`${u.origin}/api/games/play/${id}`});
  }
  m=p.match(/^\/api\/games\/(thumb|play)\/(snake|tictactoe|clicker)$/);
  if(m&&req.method==='GET') {
    const [kind,id]=m.slice(1),isSvg=kind==='thumb';
    res.writeHead(200,{'Content-Type':isSvg?'image/svg+xml; charset=utf-8':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Security-Policy':isSvg?"default-src 'none'":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",'Cache-Control':'public, max-age=600'});
    return res.end(isSvg?svgThumb(id):gamePage(id));
  }
  if(p==='/api/ai/usage'&&req.method==='GET') return sendJson(res,origin,{used:0,limit:0});
  if(p==='/api/ai/embed'&&req.method==='GET') return sendJson(res,origin,{});
  if(p==='/api/ai/title'&&req.method==='POST') {
    try{const x=decodePacked(await readJson(req));return sendJson(res,origin,encodePacked({title:String(x.message||'New conversation').trim().replace(/\s+/g,' ').slice(0,60)}));}
    catch{return sendJson(res,origin,{error:'Bad request'},400);}
  }
  if(p==='/api/ai/chat'&&req.method==='POST') {
    if(!process.env.OPENAI_API_KEY) return sendJson(res,origin,{error:'Set OPENAI_API_KEY in Render environment variables to enable AI.'},503);
    // Small per-client rate limit to limit accidental API spending. Add strong auth before making this public.
    const id=req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.socket.remoteAddress||'unknown';
    const now=Date.now(), old=aiLimits.get(id)||{at:now,count:0};
    const entry=now-old.at>60000?{at:now,count:1}:{at:old.at,count:old.count+1};
    aiLimits.set(id,entry);
    if(aiLimits.size>2000)for(const [key,val] of aiLimits)if(now-val.at>60000)aiLimits.delete(key);
    if(entry.count>5)return sendJson(res,origin,{error:'AI rate limit: try again shortly.'},429);
    let data;
    try{data=decodePacked(await readJson(req));}catch{return sendJson(res,origin,{error:'Invalid packed AI request'},400);}
    const input=Array.isArray(data.messages)?data.messages.slice(-16):[];
    const messages=input.map(x=>({role:x.role==='assistant'?'assistant':'user',content:typeof x.content==='string'?x.content.slice(0,6000):Array.isArray(x.content)?x.content.filter(y=>y?.type==='text').map(y=>String(y.text||'')).join('\n').slice(0,6000):''})).filter(x=>x.content.trim());
    if(!messages.length)return sendJson(res,origin,{error:'Message required'},400);
    try{
      const ac=new AbortController(), timeout=setTimeout(()=>ac.abort(),40000);
      let response;
      try{response=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Authorization':`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-4.1-mini',messages:[{role:'system',content:'You are NicholasGPProxy AI. Be helpful, accurate, and concise.'},...messages],max_completion_tokens:700}),signal:ac.signal});}
      finally{clearTimeout(timeout);}
      if(!response.ok){console.error('AI provider HTTP status',response.status);return sendJson(res,origin,{error:'AI provider unavailable or API key/billing issue.'},502);}
      const completion=await response.json();const output=completion.choices?.[0]?.message?.content;
      if(typeof output!=='string'||!output)return sendJson(res,origin,{error:'No AI response returned'},502);
      // Existing frontend requires packed JSON SSE data events.
      res.writeHead(200,{...cors(origin),'Content-Type':'text/event-stream; charset=utf-8','X-Accel-Buffering':'no','Connection':'keep-alive'});
      const chunk={choices:[{index:0,delta:{content:output},finish_reason:null}]};
      res.write(`data: ${JSON.stringify(encodePacked(JSON.stringify(chunk)))}\n\n`);
      res.end(`data: ${JSON.stringify(encodePacked('[DONE]'))}\n\n`);
      return;
    } catch(e){console.error('AI request failed:',e?.message);return sendJson(res,origin,{error:'AI request failed.'},502);}
  }
  return false;
}

// NicholasGPProxy Arcade: rebranded catalog imported from user-supplied DuckMath source.
const fs = require('node:fs');
const path = require('node:path');
const GAME_CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname,'games.json'),'utf8'));
const GAMES_HTML = fs.readFileSync(path.join(__dirname,'games.html'),'utf8');
const GAME_BY_ID = new Map(GAME_CATALOG.map(g=>[g.id,g]));
function catalogRoutes(req,res,u,origin){
  const p=u.pathname;
  if(req.method!=='GET') return false;
  if(p==='/games'||p==='/games/'||/^\/games\/[a-z0-9-]+\/?$/.test(p)){
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    res.end(GAMES_HTML);return true;
  }
  if(p==='/api/games'){
    const q=(u.searchParams.get('q')||'').trim().toLowerCase();
    const cat=(u.searchParams.get('category')||'').trim().toLowerCase();
    const list=GAME_CATALOG.filter(g=>(!q||g.name.toLowerCase().includes(q))&&(!cat||g.category.toLowerCase()===cat));
    res.writeHead(200,{...cors(origin),'Cache-Control':'public, max-age=60'});
    res.end(JSON.stringify({games:list,total:list.length}));return true;
  }
  let m=p.match(/^\/api\/games\/([a-z0-9-]+)$/);
  if(m){const g=GAME_BY_ID.get(m[1]);if(!g){res.writeHead(404,cors(origin));res.end(JSON.stringify({error:'Game not found'}));return true;}
    res.writeHead(200,cors(origin));res.end(JSON.stringify({meta:g,type:'embed',url:g.url,thumb:g.thumb,play:`${u.origin}/games/${g.id}`}));return true;}
  m=p.match(/^\/api\/games\/play\/([a-z0-9-]+)$/);
  if(m){const g=GAME_BY_ID.get(m[1]);if(!g){res.writeHead(404,cors(origin));res.end(JSON.stringify({error:'Game not found'}));return true;}
    res.writeHead(302,{'Location':`/games/${encodeURIComponent(g.id)}`});res.end();return true;}
  return false;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const headers = cors(origin);
  const write = (data, status = 200) => {res.writeHead(status, headers); res.end(JSON.stringify(data));};
  if (req.method === 'OPTIONS') {res.writeHead(204, headers); return res.end();}
  if (origin && !ORIGINS.has(origin)) return write({ error: 'Origin not allowed' }, 403);
  const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  if (catalogRoutes(req,res,u,origin)) return;
  if (await handleFeatures(req,res,u,origin) !== false) return;
  if (u.pathname === '/' || u.pathname === '/api/ping') return write({ok:true,service:'NicholasGPProxy',relay:'amr-v1',host:'render',version:'fast-games-ai-1',games:true,ai:!!process.env.OPENAI_API_KEY});
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
  const opening = new Set();
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
    if (streams.has(id) || opening.has(id) || streams.size + opening.size >= MAX_STREAMS || payload.length < 4 || payload[0] !== 1)
      return send(packet(4,id,Buffer.from([3])));
    const port = payload.readUInt16LE(1), host = payload.subarray(3).toString('utf8').toLowerCase().trim();
    if (![80,443].includes(port) || !validHost(host)) return send(packet(4,id,Buffer.from([3])));
    opening.add(id);
    try {
      // Resolve, filter, and connect to the exact checked address to avoid DNS rebinding.
      const ips = await dns.resolve4(host);
      const ip = ips.find(x => !denyIP(x));
      if (!ip || stopped) throw Error('Unsafe or unavailable address');
      const s = net.connect({host:ip,port,timeout:12000});
      s.setNoDelay(true);
      s.setKeepAlive(true, 30000);
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
    finally { opening.delete(id); }
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
    if (type === 1) { void open(id,body).catch(()=>send(packet(4,id,Buffer.from([3])))); }
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
