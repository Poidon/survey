// ระบบลงทะเบียน - Backend (Node.js)
// เก็บข้อมูลใน PostgreSQL เมื่อมี DATABASE_URL (เช่นบน Railway)
// ถ้าไม่มี DATABASE_URL จะใช้ไฟล์ JSON ชั่วคราว (สำหรับทดสอบในเครื่อง)
//
// รันด้วย: node server.js
// เปิดหน้าลงทะเบียน:  http://localhost:3000
// เปิดหน้าหลังบ้าน:   http://localhost:3000/admin

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// รหัสผ่านเข้าหน้าหลังบ้าน (กำหนดผ่าน env: ADMIN_KEY)
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const DATABASE_URL = process.env.DATABASE_URL || '';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'registrations.json');

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
const normPhone = s => String(s).replace(/[\s-]/g, '');
const GENDERS = ['ชาย', 'หญิง', 'อื่นๆ', 'ไม่ระบุ'];
function validGender(v) { return GENDERS.includes(v); }
const MAX_PHOTO_LEN = 8_000_000; // จำกัดขนาด data URL ของรูป (~8MB)
function validPhoto(v) {
  return typeof v === 'string'
    && /^data:image\/(jpeg|png|webp);base64,/.test(v)
    && v.length <= MAX_PHOTO_LEN;
}

// ---------- ชั้นเก็บข้อมูล: PostgreSQL ----------
function createPgStore(url) {
  const { Pool } = require('pg');
  const useSSL = /sslmode=require/.test(url) || process.env.PGSSL === 'true';
  const pool = new Pool({
    connectionString: url,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  });

  const mapRow = r => ({
    id: r.id, name: r.name, email: r.email, phone: r.phone,
    gender: r.gender, birthdate: r.birthdate, hasPhoto: !!r.has_photo,
    createdAt: (r.created_at instanceof Date) ? r.created_at.toISOString() : r.created_at,
  });

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS registrations (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          email      TEXT NOT NULL,
          phone      TEXT NOT NULL,
          phone_norm TEXT NOT NULL,
          gender     TEXT,
          birthdate  TEXT NOT NULL,
          photo      TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      // เผื่อตารางเก่ายังไม่มีคอลัมน์ที่เพิ่มภายหลัง
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS gender TEXT`);
      await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS photo TEXT`);
      // กันซ้ำระดับฐานข้อมูล (กันกรณีลงทะเบียนพร้อมกัน)
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_reg_email
        ON registrations (lower(email))`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_reg_phone
        ON registrations (phone_norm)`);
    },
    async all() {
      // ไม่ดึงคอลัมน์ photo (ก้อนใหญ่) มาในลิสต์ ใช้แค่ว่ามีรูปไหม
      const { rows } = await pool.query(
        `SELECT id, name, email, phone, gender, birthdate, created_at,
                (photo IS NOT NULL) AS has_photo
           FROM registrations ORDER BY created_at ASC`);
      return rows.map(mapRow);
    },
    async getPhoto(id) {
      const { rows } = await pool.query(`SELECT photo FROM registrations WHERE id=$1`, [id]);
      return rows[0] ? rows[0].photo : null;
    },
    async emailExists(email) {
      const { rows } = await pool.query(
        `SELECT 1 FROM registrations WHERE lower(email)=lower($1) LIMIT 1`, [email]);
      return rows.length > 0;
    },
    async phoneExists(phone) {
      const { rows } = await pool.query(
        `SELECT 1 FROM registrations WHERE phone_norm=$1 LIMIT 1`, [normPhone(phone)]);
      return rows.length > 0;
    },
    async insert(rec) {
      await pool.query(
        `INSERT INTO registrations (id, name, email, phone, phone_norm, gender, birthdate, photo, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [rec.id, rec.name, rec.email, rec.phone, normPhone(rec.phone), rec.gender, rec.birthdate, rec.photo || null, rec.createdAt]);
    },
    async remove(id) {
      await pool.query(`DELETE FROM registrations WHERE id=$1`, [id]);
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM registrations`);
      return rows[0].c;
    },
  };
}

// ---------- ชั้นเก็บข้อมูล: ไฟล์ JSON (สำหรับทดสอบในเครื่อง) ----------
function createFileStore() {
  function ensure() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
  }
  function read() { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || []; } catch { return []; } }
  function write(list) { fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2), 'utf8'); }
  return {
    async init() { ensure(); },
    async all() {
      // ไม่ส่งก้อนรูป (photo) มาในลิสต์ ใช้แค่ธง hasPhoto
      return read().map(({ photo, ...rest }) => ({ ...rest, hasPhoto: !!photo }));
    },
    async getPhoto(id) { const r = read().find(x => x.id === id); return r ? (r.photo || null) : null; },
    async emailExists(email) { return read().some(r => r.email.toLowerCase() === email.toLowerCase()); },
    async phoneExists(phone) { return read().some(r => normPhone(r.phone) === normPhone(phone)); },
    async insert(rec) { const l = read(); l.push(rec); write(l); },
    async remove(id) { const l = read().filter(r => r.id !== id); write(l); return l.length; },
  };
}

let store; // ถูกกำหนดค่าตอนเริ่มเซิร์ฟเวอร์

// ---------- ตัวช่วย HTTP ----------
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 12e6) { reject(new Error('payload too large')); req.destroy(); }
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
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // --- API: ลงทะเบียน ---
    if (req.method === 'POST' && p === '/api/register') {
      const body = await readBody(req);
      let data;
      try { data = JSON.parse(body); } catch { return sendJson(res, 400, { ok: false, error: 'รูปแบบข้อมูลไม่ถูกต้อง' }); }

      const name = String(data.name || '').trim();
      const email = String(data.email || '').trim();
      const phone = String(data.phone || '').trim();
      const gender = String(data.gender || '').trim();
      const birthdate = String(data.birthdate || '').trim();
      const photo = typeof data.photo === 'string' ? data.photo : '';

      if (!name) return sendJson(res, 400, { ok: false, error: 'กรุณากรอกชื่อ' });
      if (!validEmail(email)) return sendJson(res, 400, { ok: false, error: 'อีเมลไม่ถูกต้อง' });
      if (!validPhone(phone)) return sendJson(res, 400, { ok: false, error: 'เบอร์โทรไม่ถูกต้อง (9-10 หลัก)' });
      if (!validGender(gender)) return sendJson(res, 400, { ok: false, error: 'กรุณาเลือกเพศ' });
      if (!validBirthdate(birthdate)) return sendJson(res, 400, { ok: false, error: 'วันเกิดไม่ถูกต้อง' });
      if (!validPhoto(photo)) return sendJson(res, 400, { ok: false, error: 'กรุณาถ่าย/เลือกภาพ (รองรับ jpg/png/webp และไม่เกิน 8MB)' });

      if (await store.emailExists(email)) return sendJson(res, 409, { ok: false, error: 'อีเมลนี้ลงทะเบียนไปแล้ว' });
      if (await store.phoneExists(phone)) return sendJson(res, 409, { ok: false, error: 'เบอร์โทรนี้ลงทะเบียนไปแล้ว' });

      const record = {
        id: Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
        name, email, phone, gender, birthdate, photo,
        createdAt: new Date().toISOString(),
      };
      try {
        await store.insert(record);
      } catch (e) {
        if (e && e.code === '23505') { // unique violation (ลงพร้อมกันพอดี)
          return sendJson(res, 409, { ok: false, error: 'อีเมลหรือเบอร์โทรนี้ลงทะเบียนไปแล้ว' });
        }
        throw e;
      }
      const total = (await store.all()).length;
      return sendJson(res, 201, { ok: true, id: record.id, total });
    }

    // --- API: ตรวจว่าอีเมล/เบอร์ซ้ำไหม (เรียกตอนกรอกฟอร์ม) ---
    if (req.method === 'GET' && p === '/api/check') {
      const email = String(url.searchParams.get('email') || '').trim();
      const phone = String(url.searchParams.get('phone') || '').trim();
      const emailTaken = email ? await store.emailExists(email) : false;
      const phoneTaken = phone ? await store.phoneExists(phone) : false;
      return sendJson(res, 200, { ok: true, emailTaken, phoneTaken });
    }

    // --- API: ดึงรายชื่อทั้งหมด (ต้องมีรหัสผ่าน) ---
    if (req.method === 'GET' && p === '/api/registrations') {
      if (!isAuthed(req, url)) return sendJson(res, 401, { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
      return sendJson(res, 200, { ok: true, data: await store.all() });
    }

    // --- API: ลบทีละรายการ (ต้องมีรหัสผ่าน) ---
    if (req.method === 'DELETE' && p.startsWith('/api/registrations/')) {
      if (!isAuthed(req, url)) return sendJson(res, 401, { ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
      const id = decodeURIComponent(p.split('/').pop());
      const total = await store.remove(id);
      return sendJson(res, 200, { ok: true, total });
    }

    // --- รูปภาพของผู้ลงทะเบียน (ต้องมีรหัสผ่าน) ---
    if (req.method === 'GET' && p.startsWith('/api/photo/')) {
      if (!isAuthed(req, url)) { res.writeHead(401); res.end('unauthorized'); return; }
      const id = decodeURIComponent(p.split('/').pop());
      const dataUrl = await store.getPhoto(id);
      const m = dataUrl && /^data:(image\/[a-z]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) { res.writeHead(404); res.end('not found'); return; }
      const buf = Buffer.from(m[2], 'base64');
      res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=300' });
      res.end(buf);
      return;
    }

    // --- ดาวน์โหลด CSV (ต้องมีรหัสผ่าน) ---
    if (req.method === 'GET' && p === '/api/export.csv') {
      if (!isAuthed(req, url)) { res.writeHead(401); res.end('unauthorized'); return; }
      const list = await store.all();
      const header = ['ลำดับ', 'ชื่อ', 'อีเมล', 'เบอร์โทร', 'เพศ', 'วันเกิด', 'ภาพถ่าย', 'เวลาลงทะเบียน'];
      const rows = list.map((r, i) => [
        i + 1, r.name, r.email, r.phone, r.gender || '', r.birthdate || '',
        r.hasPhoto ? 'มี' : '', new Date(r.createdAt).toLocaleString('th-TH'),
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
  } catch (e) {
    console.error('เกิดข้อผิดพลาด:', e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'เกิดข้อผิดพลาดในระบบ' });
  }
});

// เปิดให้เทสต์ import ฟังก์ชัน store ได้ (ไม่เริ่มเซิร์ฟเวอร์ตอน require)
module.exports = { createPgStore, createFileStore, validEmail, validPhone, validBirthdate, normPhone };

// ---------- เริ่มเซิร์ฟเวอร์ ----------
async function start() {
  const usingPg = !!DATABASE_URL;
  store = usingPg ? createPgStore(DATABASE_URL) : createFileStore();
  try {
    await store.init();
  } catch (e) {
    console.error('เชื่อมต่อฐานข้อมูลไม่สำเร็จ:', e.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log('=================================================');
    console.log(' ระบบลงทะเบียนเริ่มทำงานแล้ว');
    console.log(' หน้าลงทะเบียน:  http://localhost:' + PORT);
    console.log(' หน้าหลังบ้าน:   http://localhost:' + PORT + '/admin');
    console.log(' รหัสผ่านหลังบ้าน: ' + ADMIN_KEY);
    if (usingPg) {
      console.log(' เก็บข้อมูลใน: PostgreSQL (ผ่าน DATABASE_URL)');
    } else {
      console.log(' ⚠️  ไม่พบ DATABASE_URL — ใช้ไฟล์ JSON ชั่วคราว (ข้อมูลจะหายเมื่อ restart)');
      console.log('     เหมาะกับทดสอบในเครื่องเท่านั้น; บน Railway ให้เพิ่ม PostgreSQL');
    }
    console.log('=================================================');
  });
}

// รันเซิร์ฟเวอร์เฉพาะเมื่อสั่งไฟล์นี้โดยตรง (ไม่รันตอนถูก require เข้าไปเทสต์)
if (require.main === module) start();
