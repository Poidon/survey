// ระบบลงทะเบียน - Backend (Node.js, zero dependencies)
// รันด้วย: node server.js
// เปิดหน้าลงทะเบียน:  http://localhost:3000
// เปิดหน้าหลังบ้าน:   http://localhost:3000/admin

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// รหัสผ่านเข้าหน้าหลังบ้าน (เปลี่ยนได้ หรือกำหนดผ่าน env: ADMIN_KEY)
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'registrations.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- จัดการข้อมูล ----------
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}
function readAll() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || []; }
  catch { return []; }
}
function writeAll(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8');
}

// ---------- ตรวจสอบข้อมูล ----------
function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function validPhone(v) { return /^[0-9]{9,10}$/.test(String(v).replace(/[\s-]/g, '')); }
function validBirthdate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;      // ต้องเป็นรูปแบบ YYYY-MM-DD
  const d = new Date(v + 'T00:00:00');
  if (isNaN(d.getTime())) return false;                  // ต้องเป็นวันที่ที่มีจริง
  if (v.slice(0, 10) > new Date().toISOString().slice(0, 10)) return false; // ต้องไม่เกินวันนี้
  return true;
}

// ---------- ตัวช่วย HTTP ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(buf);
  });
}
function isAuthed(req, url) {
  const key = req.headers['x-admin-key'] || url.searchParams.get('key');
  return key === ADMIN_KEY;
}
function csvEscape(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }

// ---------- Router ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // --- API: ลงทะเบียน ---
  if (req.method === 'POST' && p === '/api/register') {
    try {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'รูปแบบข้อมูลไม่ถูกต้อง' }); }

      const name = String(data.name || '').trim();
      const email = String(data.email || '').trim();
      const phone = String(data.phone || '').trim();
      const birthdate = String(data.birthdate || '').trim();

      if (!name) return sendJson(res, 400, { ok: false, error: 'กรุณากรอกชื่อ' });
      if (!validEmail(email)) return sendJson(res, 400, { ok: false, error: 'อีเมลไม่ถูกต้อง' });
      if (!validPhone(phone)) return sendJson(res, 400, { ok: false, error: 'เบอร์โทรไม่ถูกต้อง (9-10 หลัก)' });
      if (!validBirthdate(birthdate)) return sendJson(res, 400, { ok: false, error: 'วันเกิดไม่ถูกต้อง' });

      const list = readAll();
      if (list.some(r => r.email.toLowerCase() === email.toLowerCase())) {
        return sendJson(res, 409, { ok: false, error: 'อีเมลนี้ลงทะเบียนไปแล้ว' });
      }
      const normPhone = s => String(s).replace(/[\s-]/g, '');
      if (list.some(r => normPhone(r.phone) === normPhone(phone))) {
        return sendJson(res, 409, { ok: false, error: 'เบอร์โทรนี้ลงทะเบียนไปแล้ว' });
      }

      const record = {
        id: Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
        name, email, phone, birthdate,
        createdAt: new Date().toISOString(),
      };
      list.push(record);
      writeAll(list);
      return sendJson(res, 201, { ok: true, id: record.id, total: list.length });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'เกิดข้อผิดพลาดในระบบ' });
    }
  }

  // --- API: ตรวจว่าอีเมล/เบอร์ซ้ำไหม (เรียกตอนกรอกฟอร์ม) ---
  if (req.method === 'GET' && p === '/api/check') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
    const phone = String(url.searchParams.get('phone') || '').replace(/[\s-]/g, '');
    const list = readAll();
    const emailTaken = email ? list.some(r => r.email.toLowerCase() === email) : false;
    const phoneTaken = phone ? list.some(r => r.phone.replace(/[\s-]/g, '') === phone) : false;
    return sendJson(res, 200, { ok: true, emailTaken, phoneTaken });
  }

  // --- API: ดึงรายชื่อทั้งหมด (ต้องมีรหัสผ่าน) ---
  if (req.method === 'GET' && p === '/api/registrations') {
    if (!isAuthed(req, url)) return sendJson(res, 401, { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
    return sendJson(res, 200, { ok: true, data: readAll() });
  }

  // --- API: ลบทีละรายการ (ต้องมีรหัสผ่าน) ---
  if (req.method === 'DELETE' && p.startsWith('/api/registrations/')) {
    if (!isAuthed(req, url)) return sendJson(res, 401, { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
    const id = decodeURIComponent(p.split('/').pop());
    const list = readAll();
    const next = list.filter(r => r.id !== id);
    writeAll(next);
    return sendJson(res, 200, { ok: true, total: next.length });
  }

  // --- ดาวน์โหลด CSV (ต้องมีรหัสผ่าน) ---
  if (req.method === 'GET' && p === '/api/export.csv') {
    if (!isAuthed(req, url)) { res.writeHead(401); res.end('unauthorized'); return; }
    const list = readAll();
    const header = ['ลำดับ', 'ชื่อ', 'อีเมล', 'เบอร์โทร', 'วันเกิด', 'เวลาลงทะเบียน'];
    const rows = list.map((r, i) => [
      i + 1, r.name, r.email, r.phone, r.birthdate || '',
      new Date(r.createdAt).toLocaleString('th-TH'),
    ]);
    const csv = [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="registrations.csv"',
    });
    res.end('﻿' + csv); // BOM เพื่อให้ Excel อ่านภาษาไทยถูกต้อง
    return;
  }

  // --- หน้าเว็บ ---
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && (p === '/admin' || p === '/admin.html')) {
    return serveFile(res, path.join(PUBLIC_DIR, 'admin.html'), 'text/html; charset=utf-8');
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
});

ensureStore();
server.listen(PORT, () => {
  console.log('=================================================');
  console.log(' ระบบลงทะเบียนเริ่มทำงานแล้ว');
  console.log(' หน้าลงทะเบียน:  http://localhost:' + PORT);
  console.log(' หน้าหลังบ้าน:   http://localhost:' + PORT + '/admin');
  console.log(' รหัสผ่านหลังบ้าน: ' + ADMIN_KEY);
  console.log(' ข้อมูลถูกเก็บที่: ' + DATA_FILE);
  console.log('=================================================');
});
