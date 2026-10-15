// Kodli fayl almashish — hisobsiz, bog'liqliksiz (faqat Node.js 18+)
// Ishga tushirish: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DIR = path.join(__dirname, 'data');
const MAX_SIZE = 50 * 1024 * 1024;   // bitta fayl: 50 MB
const MAX_FILES = 20;                // bitta kod ostida: 20 fayl
const TTL = 24 * 3600 * 1000;        // fayllar 24 soatdan keyin o'chadi
const MAX_REQ_PER_MIN = 120;         // bitta IP uchun

fs.mkdirSync(DIR, { recursive: true });

const html = zlib.gzipSync(fs.readFileSync(path.join(__dirname, 'index.html')));

const validCode = c => typeof c === 'string' && c.length >= 4 && c.length <= 64;
const dirOf = c => path.join(DIR, crypto.createHash('sha256').update(c).digest('hex').slice(0, 32));
const cleanName = n => (path.basename(n || '').replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120)) || 'fayl';

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000);

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const n = (hits.get(ip) || 0) + 1;
  hits.set(ip, n);
  if (n > MAX_REQ_PER_MIN) return send(res, 429, "Juda ko'p so'rov. Biroz kuting.");

  if (u.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Cache-Control': 'public, max-age=3600'
    });
    return res.end(html);
  }

  const c = (u.searchParams.get('c') || '').trim();
  if (!u.pathname.startsWith('/api/')) return send(res, 404, 'Topilmadi');
  if (!validCode(c)) return send(res, 400, "Kod kamida 4 ta belgi bo'lishi kerak");
  const d = dirOf(c);

  // Fayllar ro'yxati
  if (u.pathname === '/api/list' && req.method === 'GET') {
    let out = [];
    if (fs.existsSync(d)) {
      out = fs.readdirSync(d).map(f => {
        const s = fs.statSync(path.join(d, f));
        return { name: f, size: s.size, time: s.mtimeMs };
      }).sort((a, b) => b.time - a.time);
    }
    return send(res, 200, JSON.stringify(out), 'application/json');
  }

  // Yuklash (xom PUT — multipart kerak emas, tez va sodda)
  if (u.pathname === '/api/up' && req.method === 'PUT') {
    fs.mkdirSync(d, { recursive: true });
    const name = cleanName(u.searchParams.get('n'));
    const f = path.join(d, name);
    if (!fs.existsSync(f) && fs.readdirSync(d).length >= MAX_FILES)
      return send(res, 400, `Bitta kod ostida ${MAX_FILES} tadan ortiq fayl bo'lmaydi`);
    if ((+req.headers['content-length'] || 0) > MAX_SIZE)
      return send(res, 413, `Fayl ${MAX_SIZE / 1024 / 1024} MB dan katta`);

    const tmp = f + '.part';
    const out = fs.createWriteStream(tmp);
    let size = 0, aborted = false;
    req.on('data', b => {
      size += b.length;
      if (size > MAX_SIZE && !aborted) {
        aborted = true;
        out.destroy();
        fs.unlink(tmp, () => {});
        res.writeHead(413, { Connection: 'close' });
        res.end('Fayl juda katta');
        req.destroy();
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (aborted) return;
      fs.rename(tmp, f, () => send(res, 200, 'ok'));
    });
    out.on('error', () => { if (!aborted) send(res, 500, 'Saqlashda xato'); });
    req.on('aborted', () => { out.destroy(); fs.unlink(tmp, () => {}); });
    return;
  }

  // Yuklab olish
  if (u.pathname === '/api/get' && req.method === 'GET') {
    const f = path.join(d, cleanName(u.searchParams.get('n')));
    if (!fs.existsSync(f)) return send(res, 404, 'Fayl topilmadi');
    const s = fs.statSync(f);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': s.size,
      'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(path.basename(f)),
      'Cache-Control': 'no-store'
    });
    return fs.createReadStream(f).pipe(res);
  }

  // O'chirish
  if (u.pathname === '/api/del' && req.method === 'DELETE') {
    const f = path.join(d, cleanName(u.searchParams.get('n')));
    fs.unlink(f, () => send(res, 200, 'ok'));
    return;
  }

  send(res, 404, 'Topilmadi');
}).listen(PORT, () => console.log('Ishlayapti: http://localhost:' + PORT));

// Eski fayllarni tozalash (har 10 daqiqada)
function cleanup() {
  const now = Date.now();
  for (const sub of fs.readdirSync(DIR)) {
    const dir = path.join(DIR, sub);
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (now - fs.statSync(p).mtimeMs > TTL) fs.unlinkSync(p);
      }
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch (e) {}
  }
}
setInterval(cleanup, 10 * 60 * 1000);
cleanup();
