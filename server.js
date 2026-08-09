const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const root = __dirname;
const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const db = new DatabaseSync(path.join(root, 'vanta-users.db'));
db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)');
const sessions = new Map();
const parseCookies = request => Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map(item => item.trim().split('=')));
const sendJson = (response, status, data, cookie) => { response.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', ...(cookie ? {'Set-Cookie':cookie} : {}) }); response.end(JSON.stringify(data)); };
const passwordHash = password => crypto.scryptSync(password, 'vanta-enterprise-salt', 64).toString('hex');
const currentUser = request => sessions.get(parseCookies(request).vanta_session);
const readBody = request => new Promise((resolve, reject) => { let body=''; request.on('data', chunk => body += chunk); request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid request')) } }); });

http.createServer(async (request, response) => {
  if (request.url === '/api/me') return sendJson(response, 200, { user: currentUser(request) || null });
  if (request.url === '/api/logout' && request.method === 'POST') { const token = parseCookies(request).vanta_session; sessions.delete(token); return sendJson(response, 200, { ok:true }, 'vanta_session=; Max-Age=0; Path=/; SameSite=Lax'); }
  if ((request.url === '/api/signup' || request.url === '/api/login') && request.method === 'POST') {
    try {
      const { name, email, password } = await readBody(request);
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail || !password || (request.url === '/api/signup' && !String(name || '').trim())) return sendJson(response, 400, { error:'Please complete all fields.' });
      let user;
      if (request.url === '/api/signup') {
        if (String(password).length < 8) return sendJson(response, 400, { error:'Use a password with at least 8 characters.' });
        try { const result = db.prepare('INSERT INTO users (name,email,password_hash,created_at) VALUES (?,?,?,?)').run(String(name).trim(), normalizedEmail, passwordHash(password), new Date().toISOString()); user = { id:Number(result.lastInsertRowid), name:String(name).trim(), email:normalizedEmail }; }
        catch { return sendJson(response, 409, { error:'An account with this email already exists.' }); }
      } else {
        const row = db.prepare('SELECT id,name,email,password_hash FROM users WHERE email = ?').get(normalizedEmail);
        if (!row || row.password_hash !== passwordHash(password)) return sendJson(response, 401, { error:'Incorrect email or password.' });
        user = { id:row.id, name:row.name, email:row.email };
      }
      const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user);
      return sendJson(response, 200, { user }, `vanta_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400`);
    } catch { return sendJson(response, 400, { error:'Unable to process this request.' }); }
  }
  const urlPath = request.url === '/' ? '/index.html' : decodeURIComponent(request.url.split('?')[0]);
  const filePath = path.resolve(root, `.${urlPath}`);
  if (!filePath.startsWith(root)) { response.writeHead(403); return response.end('Forbidden'); }
  fs.readFile(filePath, (error, data) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); return response.end('Not found'); }
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(data);
  });
}).listen(4173, '127.0.0.1', () => console.log('Vanta Cloud is running at http://127.0.0.1:4173'));
