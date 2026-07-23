require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Use SQLite if no DATABASE_URL; otherwise use PostgreSQL
let pool;
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || dbUrl.startsWith('sqlite')) {
  const localDb = require('./db');
  pool = localDb;
} else {
  pool = new Pool({ connectionString: dbUrl, ssl: false });
}
const { getDb } = require('./db');

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000', 'http://localhost:5500'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});
const upload = multer({ 
  storage, 
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /.(jpg|jpeg|png|gif|pdf|doc|docx|xls|xlsx|mp4|webm|mp3|wav)$/i;
    const extname = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimetype = /^(image|jpe?g|gif|pdf|application|video|audio)/.test(file.mimetype);
    if (extname || mimetype) return cb(null, true);
    cb(new Error('Only image, document, video, and audio files are allowed'));
  }
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 10000 : 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again in 15 minutes.' } });
const strictLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: process.env.NODE_ENV === 'test' ? 100000 : 20, standardHeaders: true, legacyHeaders: false });
app.use('/api/', strictLimiter);

const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' });

// ── Init DB ──────────────────────────────────────────────
const initDB = async () => {
  // For SQLite, db.js handles tables internally; skip PG init if not using PostgreSQL
  if (!dbUrl || !dbUrl.startsWith('postgres')) return;
  let client;
  try {
    client = await pool.connect();
    // Migration: add missing columns to existing tables
    const migrate = async (table, col, def) => {
      try {
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${def}`);
      } catch (_) {}
    };
    await migrate('users', 'is_online', 'BOOLEAN DEFAULT false');
    await migrate('users', 'email_verified', 'BOOLEAN DEFAULT false');
    await migrate('users', 'last_login', 'TIMESTAMP');
    await migrate('users', 'address', 'TEXT');
    await migrate('users', 'emergency_contact', 'VARCHAR(100)');
    await migrate('users', 'avatar_url', 'TEXT');
    await migrate('users', 'class', 'VARCHAR(20)');
    await migrate('users', 'stream', 'VARCHAR(20)');
    await migrate('users', 'gender', 'VARCHAR(10)');
    await migrate('students', 'house', 'VARCHAR(50)');

    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE, email VARCHAR(100) UNIQUE,
      password_hash TEXT NOT NULL, role VARCHAR(20) DEFAULT 'student',
      first_name VARCHAR(50), last_name VARCHAR(50), phone VARCHAR(20),
      class VARCHAR(20), stream VARCHAR(20), gender VARCHAR(10),
      address TEXT, emergency_contact VARCHAR(100), avatar_url TEXT,
      status VARCHAR(20) DEFAULT 'active', created_at TIMESTAMP DEFAULT NOW(),
      last_login TIMESTAMP, is_online BOOLEAN DEFAULT false
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      admission_no VARCHAR(50) UNIQUE, date_of_birth DATE, nationality VARCHAR(50),
      former_school TEXT, religion VARCHAR(50), guardian_name VARCHAR(100),
      guardian_phone VARCHAR(20), guardian_relation VARCHAR(50),
      medical_conditions TEXT, house VARCHAR(50), clubs TEXT[]
)`);
    // Migrations: add columns that may not exist in older deployed databases
    const studentCols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'students'`);
    const existingCols = studentCols.rows.map(r => r.column_name);
    if (!existingCols.includes('admission_no')) {
      await client.query(`ALTER TABLE students ADD COLUMN admission_no VARCHAR(50) UNIQUE`);
      console.log('Migration: added admission_no column to students');
    }
    if (!existingCols.includes('stream')) {
      await client.query(`ALTER TABLE students ADD COLUMN stream VARCHAR(20) DEFAULT 'A'`);
      console.log('Migration: added stream column to students');
    }
    if (!existingCols.includes('house')) {
      await client.query(`ALTER TABLE students ADD COLUMN house VARCHAR(50)`);
    }
    if (!existingCols.includes('clubs')) {
      await client.query(`ALTER TABLE students ADD COLUMN clubs TEXT[]`);
    }
    await client.query(`CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      employee_id VARCHAR(50) UNIQUE, qualification VARCHAR(100),
      subjects_taught TEXT[], department VARCHAR(50),
      experience_years INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS parents (
      id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      relationship VARCHAR(50), occupation VARCHAR(100), address TEXT, created_at TIMESTAMP DEFAULT NOW()
    )`);

    await client.query(`CREATE TABLE IF NOT EXISTS subjects (
      id SERIAL PRIMARY KEY, name VARCHAR(100), code VARCHAR(20) UNIQUE,
      category VARCHAR(20), level VARCHAR(20), teacher_id INTEGER REFERENCES teachers(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY, name VARCHAR(20), stream VARCHAR(20),
      class_teacher_id INTEGER REFERENCES teachers(id), created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS enrollments (
      id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER REFERENCES classes(id), subject_id INTEGER REFERENCES subjects(id),
      year INTEGER, term INTEGER, created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(student_id, class_id, subject_id, year, term)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS attendance (
      id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER REFERENCES classes(id), subject_id INTEGER REFERENCES subjects(id),
      date DATE, status VARCHAR(10), marked_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS results (
      id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER REFERENCES subjects(id), class_id INTEGER REFERENCES classes(id),
      exam_type VARCHAR(30), year INTEGER, term INTEGER,
      score DECIMAL(5,2), grade VARCHAR(5), remarks TEXT,
      entered_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS fees (
      id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      description VARCHAR(200), amount DECIMAL(10,2), paid DECIMAL(10,2) DEFAULT 0,
      due_date DATE, year INTEGER, term INTEGER, status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY, title VARCHAR(200), content TEXT, category VARCHAR(30),
      priority VARCHAR(10) DEFAULT 'normal', expires_at TIMESTAMP,
      created_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS news (
      id SERIAL PRIMARY KEY, title VARCHAR(200), slug VARCHAR(200) UNIQUE,
      content TEXT, excerpt TEXT, category VARCHAR(50), image_url TEXT,
      author_id INTEGER REFERENCES users(id), published BOOLEAN DEFAULT false,
      views INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY, title VARCHAR(200), description TEXT,
      event_date TIMESTAMP, end_date TIMESTAMP, location VARCHAR(100),
      category VARCHAR(50), created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, sender_id INTEGER REFERENCES users(id),
      receiver_id INTEGER REFERENCES users(id), subject VARCHAR(200),
      body TEXT, is_read BOOLEAN DEFAULT false, parent_id INTEGER,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30), title VARCHAR(200), message TEXT,
      is_read BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS site_content (
      id SERIAL PRIMARY KEY, page VARCHAR(50), section VARCHAR(50),
      content TEXT, updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT NOW(), UNIQUE(page, section)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS site_settings (
      id SERIAL PRIMARY KEY, key VARCHAR(50) UNIQUE, value TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS gallery (
      id SERIAL PRIMARY KEY, title VARCHAR(200), description TEXT,
      image_url TEXT, video_url TEXT, category VARCHAR(50), tags TEXT[], views INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS assignments (
      id SERIAL PRIMARY KEY, teacher_id INTEGER REFERENCES teachers(id),
      title VARCHAR(200), description TEXT, class VARCHAR(20), subject VARCHAR(100),
      due_date TIMESTAMP, max_marks INTEGER DEFAULT 100, attachments TEXT[],
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS assignment_submissions (
      id SERIAL PRIMARY KEY, assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id),
      submission_text TEXT, attachment_urls TEXT[], submitted_at TIMESTAMP DEFAULT NOW(),
      marks INTEGER, feedback TEXT, graded_by INTEGER REFERENCES users(id), graded_at TIMESTAMP
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS teacher_classes (
      id SERIAL PRIMARY KEY, teacher_id INTEGER REFERENCES teachers(id),
      class VARCHAR(20), stream VARCHAR(20), subject VARCHAR(100), year INTEGER
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS student_classes (
      id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id),
      class VARCHAR(20), stream VARCHAR(20), year INTEGER, term INTEGER,
      UNIQUE(student_id, class, stream, year, term)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS activities (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      action VARCHAR(200), entity_type VARCHAR(50), entity_id INTEGER,
      details JSONB, created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Seed admin
    const adminExists = await client.query(`SELECT id FROM users WHERE username = 'admin' LIMIT 1`);
    if (adminExists.rows.length === 0) {
      const hash = bcrypt.hashSync('Admin@2026', 10);
      await client.query(`INSERT INTO users (username, email, password_hash, role, first_name, last_name, status)
        VALUES ('admin', 'admin@kalinabiriss.ac.ug', $1, 'admin', 'System', 'Administrator', 'active')`, [hash]);
      await client.query(`INSERT INTO site_settings (key, value) VALUES ('school_name', 'KALINABIRI SECONDARY SCHOOL') ON CONFLICT DO NOTHING`);
      await client.query(`INSERT INTO site_settings (key, value) VALUES ('motto', 'Discipline is the Bridge between Goals and Accomplishment') ON CONFLICT DO NOTHING`);
      await client.query(`INSERT INTO site_settings (key, value) VALUES ('phone', '+256 700 123 456') ON CONFLICT DO NOTHING`);
      await client.query(`INSERT INTO site_settings (key, value) VALUES ('email', 'info@kalinabiriss.ac.ug') ON CONFLICT DO NOTHING`);
      await client.query(`INSERT INTO site_settings (key, value) VALUES ('address', 'Ntinda, Kampala, Uganda') ON CONFLICT DO NOTHING`);
      console.log('✓ Admin seeded — admin@kalinabiriss.ac.ug / Admin@2026');
    }

    // Seed teachers
    const teacherExists = await client.query(`SELECT id FROM users WHERE role = 'teacher' LIMIT 1`);
    if (teacherExists.rows.length === 0) {
      const t1 = bcrypt.hashSync('Teacher@2026', 10);
      const t2 = bcrypt.hashSync('Teacher@2026', 10);
      const t3 = bcrypt.hashSync('Teacher@2026', 10);
      const t4 = bcrypt.hashSync('Teacher@2026', 10);
      await client.query(`INSERT INTO users (username, email, password_hash, role, first_name, last_name, phone, status)
        VALUES ('kagaba', 'kagaba@kal.com', $1, 'teacher', 'John', 'Kagaba', '+256 700 111 111', 'active')`, [t1]);
      await client.query(`INSERT INTO users (username, email, password_hash, role, first_name, last_name, phone, status)
        VALUES ('nakato', 'nakato@kal.com', $2, 'teacher', 'Grace', 'Nakato', '+256 700 222 222', 'active')`, [t2]);
      await client.query(`INSERT INTO users (username, email, password_hash, role, first_name, last_name, phone, status)
        VALUES ('ssekitoleko', 'ssekitoleko@kal.com', $3, 'teacher', 'Robert', 'Ssekitoleko', '+256 700 333 333', 'active')`, [t3]);
      await client.query(`INSERT INTO users (username, email, password_hash, role, first_name, last_name, phone, status)
        VALUES ('namutebi', 'namutebi@kal.com', $4, 'teacher', 'Faith', 'Namutebi', '+256 700 444 444', 'active')`, [t4]);
      const tIds = await client.query(`SELECT id FROM users WHERE role = 'teacher' ORDER BY id`);
      await client.query(`INSERT INTO teachers (user_id, employee_id, qualification, department) VALUES ($1, 'T001', 'Bachelor of Education', 'Mathematics') ON CONFLICT DO NOTHING`, [tIds.rows[0].id]);
      await client.query(`INSERT INTO teachers (user_id, employee_id, qualification, department) VALUES ($1, 'T002', 'Master of Arts', 'Languages') ON CONFLICT DO NOTHING`, [tIds.rows[1].id]);
      await client.query(`INSERT INTO teachers (user_id, employee_id, qualification, department) VALUES ($1, 'T003', 'Bachelor of Science', 'Sciences') ON CONFLICT DO NOTHING`, [tIds.rows[2].id]);
      await client.query(`INSERT INTO teachers (user_id, employee_id, qualification, department) VALUES ($1, 'T004', 'Master of Chemistry', 'Sciences') ON CONFLICT DO NOTHING`, [tIds.rows[3].id]);
      console.log('✓ Teachers seeded');
    }

    // Seed subjects
    const subjExists = await client.query(`SELECT id FROM subjects LIMIT 1`);
    if (subjExists.rows.length === 0) {
      const subjects = [
        ['Mathematics', 'MATH', 'Mathematics', 'O Level'], ['English', 'ENG', 'Languages', 'O Level'],
        ['Physics', 'PHY', 'Sciences', 'A Level'], ['Chemistry', 'CHEM', 'Sciences', 'A Level'],
        ['Biology', 'BIO', 'Sciences', 'O Level'], ['Geography', 'GEO', 'Humanities', 'O Level'],
        ['History', 'HIST', 'Humanities', 'O Level'], ['CRE', 'CRE', 'Humanities', 'O Level'],
        ['Agriculture', 'AGR', 'Applied', 'O Level'], ['ICT', 'ICT', 'Applied', 'O Level']
      ];
      for (const [name, code, cat, lvl] of subjects) {
        await client.query(`INSERT INTO subjects (name, code, category, level) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [name, code, cat, lvl]);
      }
      console.log('✓ Subjects seeded');
    }

    console.log('✓ Database schema ready');
  } finally {
    if (client) client.release();
  }
};

// ── Routes ──────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', school: 'KALINABIRI SECONDARY SCHOOL', version: '2.0' }));

// Seed route — drops and recreates schema, seeds admin + teachers + subjects
app.post('/api/seed', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // Drop old tables
      await client.query(`DROP TABLE IF EXISTS activities CASCADE`);
      await client.query(`DROP TABLE IF EXISTS student_classes CASCADE`);
      await client.query(`DROP TABLE IF EXISTS teacher_classes CASCADE`);
      await client.query(`DROP TABLE IF EXISTS submissions CASCADE`);
      await client.query(`DROP TABLE IF EXISTS assignments CASCADE`);
      await client.query(`DROP TABLE IF EXISTS attendance_records CASCADE`);
      await client.query(`DROP TABLE IF EXISTS results CASCADE`);
      await client.query(`DROP TABLE IF EXISTS teachers CASCADE`);
      await client.query(`DROP TABLE IF EXISTS students CASCADE`);
      await client.query(`DROP TABLE IF EXISTS subjects CASCADE`);
      await client.query(`DROP TABLE IF EXISTS announcements CASCADE`);
      await client.query(`DROP TABLE IF EXISTS site_settings CASCADE`);
      await client.query(`DROP TABLE IF EXISTS users CASCADE`);
      await client.query(`DROP TABLE IF EXISTS classes CASCADE`);

      // Recreate schema
      await client.query(`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE, email VARCHAR(100) UNIQUE,
        password_hash TEXT, role VARCHAR(20), first_name VARCHAR(50), last_name VARCHAR(50),
        phone VARCHAR(20), class VARCHAR(20), stream VARCHAR(20), gender VARCHAR(10),
        address TEXT, emergency_contact VARCHAR(100), avatar_url TEXT,
        status VARCHAR(20) DEFAULT 'active', last_login TIMESTAMP, is_online BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS classes (
        id SERIAL PRIMARY KEY, name VARCHAR(50) UNIQUE, level VARCHAR(20), stream VARCHAR(20), year INTEGER
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS subjects (
        id SERIAL PRIMARY KEY, name VARCHAR(100), code VARCHAR(20) UNIQUE,
        category VARCHAR(50), level VARCHAR(20)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), registration_number VARCHAR(50) UNIQUE,
        class VARCHAR(20), stream VARCHAR(20), year INTEGER, term INTEGER, status VARCHAR(20) DEFAULT 'active'
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS teachers (
        id SERIAL PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id), employee_id VARCHAR(50) UNIQUE,
        qualification TEXT, department VARCHAR(100)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS results (
        id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id), subject_id INTEGER REFERENCES subjects(id),
        academic_year INTEGER, term INTEGER, score DECIMAL(5,2), grade VARCHAR(5), remarks TEXT, exam_type VARCHAR(50)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS attendance_records (
        id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id), date DATE, status VARCHAR(10), term INTEGER, year INTEGER
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY, title VARCHAR(200), content TEXT, author_id INTEGER REFERENCES users(id), category VARCHAR(50), pinned BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS site_settings (
        id SERIAL PRIMARY KEY, key VARCHAR(100) UNIQUE, value TEXT
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS assignments (
        id SERIAL PRIMARY KEY, teacher_id INTEGER REFERENCES teachers(id), class VARCHAR(20), stream VARCHAR(20),
        subject VARCHAR(100), title VARCHAR(200), description TEXT, due_date TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY, assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES students(id), submission_text TEXT, attachment_urls TEXT[],
        submitted_at TIMESTAMP DEFAULT NOW(), marks INTEGER, feedback TEXT, graded_by INTEGER REFERENCES users(id), graded_at TIMESTAMP
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS teacher_classes (
        id SERIAL PRIMARY KEY, teacher_id INTEGER REFERENCES teachers(id), class VARCHAR(20), stream VARCHAR(20), subject VARCHAR(100), year INTEGER
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS student_classes (
        id SERIAL PRIMARY KEY, student_id INTEGER REFERENCES students(id), class VARCHAR(20), stream VARCHAR(20), year INTEGER, term INTEGER,
        UNIQUE(student_id, class, stream, year, term)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), action VARCHAR(200), entity_type VARCHAR(50),
        entity_id INTEGER, details JSONB, created_at TIMESTAMP DEFAULT NOW()
      )`);

      // Seed admin
      const hash = bcrypt.hashSync('Admin@2026', 10);
      await client.query(`INSERT INTO users (username, email, password_hash, role, first_name, last_name, status)
        VALUES ('admin', 'admin@kalinabiriss.ac.ug', $1, 'admin', 'System', 'Administrator', 'active')
        ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`, [hash]);

      // Seed teachers (upsert so RETURNING always gives us IDs)
      const t1 = bcrypt.hashSync('Teacher@2026', 10);
      const t2 = bcrypt.hashSync('Teacher@2026', 10);
      const t3 = bcrypt.hashSync('Teacher@2026', 10);
      const t4 = bcrypt.hashSync('Teacher@2026', 10);
      const teacherInserts = await client.query(`
        INSERT INTO users (username, email, password_hash, role, first_name, last_name, phone, status)
        VALUES 
 ('kagaba', 'kagaba@kal.com', $1, 'teacher', 'John', 'Kagaba', '+256 700 111 111', 'active'),
          ('nakato', 'nakato@kal.com', $2, 'teacher', 'Grace', 'Nakato', '+256 700 222 222', 'active'),
          ('ssekitoleko', 'ssekitoleko@kal.com', $3, 'teacher', 'Robert', 'Ssekitoleko', '+256 700 333 333', 'active'),
          ('namutebi', 'namutebi@kal.com', $4, 'teacher', 'Faith', 'Namutebi', '+256 700 444 444', 'active')
        ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
        RETURNING id
      `, [t1, t2, t3, t4]);

      const tid0 = teacherInserts.rows[0].id;
      const tid1 = teacherInserts.rows[1].id;
      const tid2 = teacherInserts.rows[2].id;
      const tid3 = teacherInserts.rows[3].id;

      await client.query(`
        INSERT INTO teachers (user_id, employee_id, qualification, department) VALUES
 ($1, 'T001', 'Bachelor of Education', 'Mathematics'),
          ($2, 'T002', 'Master of Arts', 'Languages'),
          ($3, 'T003', 'Bachelor of Science', 'Sciences'),
          ($4, 'T004', 'Master of Chemistry', 'Sciences')
        ON CONFLICT (user_id) DO UPDATE SET employee_id = EXCLUDED.employee_id
      `, [tid0, tid1, tid2, tid3]);

      // Seed subjects
      const subjects = [
        ['Mathematics', 'MATH', 'Mathematics', 'O Level'], ['English', 'ENG', 'Languages', 'O Level'],
        ['Physics', 'PHY', 'Sciences', 'A Level'], ['Chemistry', 'CHEM', 'Sciences', 'A Level'],
        ['Biology', 'BIO', 'Sciences', 'O Level'], ['Geography', 'GEO', 'Humanities', 'O Level'],
        ['History', 'HIST', 'Humanities', 'O Level'], ['CRE', 'CRE', 'Humanities', 'O Level'],
        ['Agriculture', 'AGR', 'Applied', 'O Level'], ['ICT', 'ICT', 'Applied', 'O Level']
      ];
      for (const [name, code, cat, lvl] of subjects) {
        await client.query(`INSERT INTO subjects (name, code, category, level) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [name, code, cat, lvl]);
      }

      res.json({ success: true, message: 'Database seeded successfully', admin: 'admin@kalinabiriss.ac.ug / Admin@2026' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Seed error:', err);
    res.status(500).json({ error: 'Seed failed', details: err.message });
  }
});

// Auth
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const loginField = username || email;
    if (!loginField || !password) return res.status(400).json({ error: 'Missing credentials' });
    const result = await pool.query('SELECT * FROM users WHERE (username = $1 OR email = $1) AND status = $2', [loginField, 'active']);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid credentials' });

    await pool.query('UPDATE users SET last_login = NOW(), is_online = true WHERE id = $1', [user.id]);
    const token = jwt.sign({ id: user.id, role: user.role, username: user.username }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name, phone: user.phone, class: user.class, stream: user.stream, avatar_url: user.avatar_url } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', loginLimiter, async (req, res) => {
  try {
    const { username, email, password, role, first_name, last_name, phone, class: studentClass, stream, gender, studentNumber, subjects_taught } = req.body;
    if (!username || !email || !password || !role) return res.status(400).json({ error: 'Missing required fields' });
    const hash = await bcrypt.hash(password, 10);
    // Detect SQLite vs PostgreSQL (postgresql:// URL means PG, otherwise SQLite)
    const isSqlite = !dbUrl || !dbUrl.startsWith('postgres');
    console.log('REGISTER isSqlite:', isSqlite, 'dbUrl:', dbUrl);

    let newUser;
    if (isSqlite) {
      // SQLite: INSERT first, then SELECT to get the row
      const cols = 'username, email, password_hash, role, first_name, last_name, phone, class, stream, gender, status';
      await pool.run(
        `INSERT INTO users (${cols}) VALUES (?,?,?,?,?,?,?,?,?,?,'active')`,
        [username, email, hash, role, first_name || '', last_name || '', phone || '', studentClass || '', stream || '', gender || '']
      );
      const rows = await pool.query('SELECT id,username,email,role FROM users WHERE username = ?', [username]);
      newUser = rows.rows[0];
    } else {
      const result = await pool.query(
        `INSERT INTO users (username, email, password_hash, role, first_name, last_name, phone, class, stream, gender, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING id,username,email,role`,
        [username, email, hash, role, first_name || '', last_name || '', phone || '', studentClass || '', stream || '', gender]
      );
      newUser = result.rows[0];
    }

    if (role === 'teacher') {
      const empId = 'T' + newUser.id;
      if (isSqlite) {
        // SQLite path: store subjects_taught as JSON-encoded text
        await pool.query(
          `INSERT OR IGNORE INTO teachers (user_id, employee_id, qualification, department, subjects_taught) VALUES (?, ?, '', '', ?)`,
          [newUser.id, empId, JSON.stringify(subjects_taught ? [subjects_taught] : [])]
        );
      } else {
        await pool.query(`INSERT INTO teachers (user_id, employee_id, qualification, department, subjects_taught) VALUES ($1, $2, '', '', ARRAY[]::TEXT[]) ON CONFLICT (user_id) DO NOTHING`, [newUser.id, empId]);
      }
    } else if (role === 'student') {
      let admissionNo = studentNumber || null;
      if (!admissionNo) {
        const year = new Date().getFullYear();
        const countRes = isSqlite
          ? await pool.query("SELECT COUNT(*) as c FROM students WHERE admission_no LIKE ?", ['KSS/' + year + '/%'])
          : await pool.query("SELECT COUNT(*) FROM students WHERE admission_no LIKE $1", ['KSS/' + year + '/%']);
        const count = isSqlite ? (countRes.rows?.[0]?.c ?? 0) : parseInt(countRes.rows[0].count);
        const seq = count + 1;
        admissionNo = 'KSS/' + year + '/' + String(seq).padStart(3, '0');
      }
      if (isSqlite) {
        await pool.query(`INSERT OR REPLACE INTO students (user_id, admission_no, stream) VALUES (?, ?, ?)`, [newUser.id, admissionNo, stream || 'A']);
      } else {
        await pool.query(`INSERT INTO students (user_id, admission_no, stream) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET admission_no = EXCLUDED.admission_no, stream = EXCLUDED.stream`, [newUser.id, admissionNo, stream || 'A']);
      }
    }
    res.json({ message: 'Registered successfully', user: { id: newUser.id, username: newUser.username, email: newUser.email, role: newUser.role } });
  } catch (e) {
    // Postgres: '23505' is unique_violation. SQLite: 'SQLITE_CONSTRAINT_UNIQUE'.
    if (e.code === '23505' || e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/i.test(e.message)) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  const result = await pool.query('SELECT id,username,email,role,first_name,last_name,phone,class,stream,gender,avatar_url,status FROM users WHERE id = $1', [req.user.id]);
  res.json(result.rows[0]);
});

app.put('/api/auth/password', authenticate, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
  const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const match = await bcrypt.compare(current_password, result.rows[0].password_hash);
  if (!match) return res.status(401).json({ error: 'Current password incorrect' });
  const hash = bcrypt.hashSync(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  res.json({ message: 'Password updated successfully' });
});

app.put('/api/auth/profile', authenticate, async (req, res) => {
const { first_name, last_name, phone, email } = req.body;
  await pool.query('UPDATE users SET first_name=$1,last_name=$2,phone=$3,email=$4 WHERE id=$5', [first_name, last_name, phone, email, req.user.id]);
  res.json({ message: 'Profile updated' });
});

// Email Verification ─────────────────────────────────────────────────────────
async function ensureVerificationTable() {
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    getDb().exec(`CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      verified_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    return;
  }
  await pool.query(`CREATE TABLE IF NOT EXISTS email_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER UNIQUE NOT NULL,
    code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Request verification code (logged in user)
app.post('/api/auth/request-verification', authenticate, async (req, res) => {
  try {
    const userId = req.user.id;
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    await pool.query(
      `INSERT INTO email_verifications (user_id, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET code = $2, expires_at = $3, verified_at = NULL`,
      [userId, code, expiresAt]
    );
    // In production, send via email. For now, return code directly for testing.
    // Remove this in production — code goes to email only.
    res.json({ message: 'Verification code sent' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verify email with code
app.post('/api/auth/verify-email', authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || code.length !== 6) return res.status(400).json({ error: 'Invalid code format' });
    const result = await pool.query(
      `SELECT * FROM email_verifications WHERE user_id = $1 AND code = $2 AND expires_at > NOW() AND verified_at IS NULL`,
      [req.user.id, code]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Invalid or expired code' });
    await pool.query(`UPDATE email_verifications SET verified_at = NOW() WHERE user_id = $1`, [req.user.id]);
    await pool.query(`UPDATE users SET email_verified = true WHERE id = $1`, [req.user.id]);
    res.json({ message: 'Email verified successfully', verified: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get verification status
app.get('/api/auth/verification-status', authenticate, async (req, res) => {
  try {
    const r = await pool.query('SELECT email_verified FROM users WHERE id = $1', [req.user.id]);
    res.json({ verified: r.rows[0]?.email_verified === true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Request password reset (unauthenticated)
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!user.rows[0]) {
      // Don't reveal if email exists
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(
      `INSERT INTO email_verifications (user_id, code, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET code = $2, expires_at = $3, verified_at = NULL`,
      [user.rows[0].id, code, expiresAt]
    );
    res.json({ message: 'If that email exists, a reset code has been sent.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset password with code
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, code, new_password } = req.body;
    if (!email || !code || !new_password) return res.status(400).json({ error: 'All fields required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const result = await pool.query(
      `SELECT ev.user_id FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
       WHERE u.email = $1 AND ev.code = $2 AND ev.expires_at > NOW() AND ev.verified_at IS NULL`,
      [email, code]
    );
    if (!result.rows[0]) return res.status(400).json({ error: 'Invalid or expired code' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, result.rows[0].user_id]);
    await pool.query('UPDATE email_verifications SET verified_at = NOW() WHERE user_id = $1', [result.rows[0].user_id]);
    res.json({ message: 'Password reset successful' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stats
app.get('/api/admin/stats', authenticate, requireRole('admin'), async (req, res) => {
  const students = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'student'");
  const teachers = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'teacher'");
  const admissions = await pool.query("SELECT COUNT(*) FROM users WHERE role = 'student' AND created_at > NOW() - INTERVAL '30 days'");
  const pendingFees = await pool.query("SELECT COALESCE(SUM(amount - paid),0) FROM fees WHERE status = 'pending'");
  const announcements = await pool.query("SELECT COUNT(*) FROM announcements WHERE expires_at IS NULL OR expires_at > NOW()");
  const news = await pool.query("SELECT COUNT(*) FROM news WHERE published = true");
  const assignments = await pool.query("SELECT COUNT(*) FROM assignments");
  const gallery = await pool.query("SELECT COUNT(*) FROM gallery");
  res.json({
    totalStudents: parseInt(students.rows[0].count),
    totalTeachers: parseInt(teachers.rows[0].count),
    newAdmissions: parseInt(admissions.rows[0].count),
    pendingFees: parseFloat(pendingFees.rows[0].sum),
    announcements: parseInt(announcements.rows[0].count),
    publishedNews: parseInt(news.rows[0].count),
    totalAssignments: parseInt(assignments.rows[0].count),
    totalGallery: parseInt(gallery.rows[0].count),
    students: parseInt(students.rows[0].count),
    teachers: parseInt(teachers.rows[0].count),
  });
});

// Users CRUD
app.get('/api/admin/users', authenticate, requireRole('admin'), async (req, res) => {
  const { role, search, studentClass } = req.query;
  let query = 'SELECT id,username,email,role,first_name,last_name,phone,class,stream,gender,status,created_at,last_login FROM users WHERE 1=1';
  const params = [];
  if (role) { params.push(role); query += ` AND role = $${params.length}`; }
  if (studentClass) { params.push(studentClass); query += ` AND class = $${params.length}`; }
  if (search) { params.push(`%${search}%`); query += ` AND (first_name LIKE $${params.length} OR last_name LIKE $${params.length} OR username LIKE $${params.length})`; }
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json({ users: result.rows });
});

app.post('/api/admin/users', authenticate, requireRole('admin'), async (req, res) => {
  const { username, email, password, role, first_name, last_name, phone, class: studentClass, stream, gender, status } = req.body;
  const hash = await bcrypt.hash(password || (role === 'teacher' ? 'Teacher@2026' : 'Student@123'), 10);
  const result = await pool.query(
    `INSERT INTO users (username,email,password_hash,role,first_name,last_name,phone,class,stream,gender,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active') RETURNING id,username,email,role`,
    [username, email, hash, role, first_name, last_name, phone, studentClass, stream, gender]
  );
  // If teacher, create teacher record
  if (role === 'teacher') {
    const userId = result.rows[0].id;
    const empId = 'T' + String(Math.floor(Math.random() * 9000) + 1000);
    await pool.query(`INSERT INTO teachers (user_id, employee_id) VALUES ($1, $2)`, [userId, empId]).catch(() => {});
  }
  res.json({ message: 'User created', user: result.rows[0] });
});

app.put('/api/admin/users/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { first_name, last_name, email, phone, role, class: studentClass, stream, status } = req.body;
  await pool.query(
    'UPDATE users SET first_name=$1,last_name=$2,email=$3,phone=$4,role=$5,class=$6,stream=$7,status=$8 WHERE id=$9',
    [first_name, last_name, email, phone, role, studentClass, stream, status, req.params.id]
  );
  res.json({ message: 'User updated' });
});

app.delete('/api/admin/users/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM users WHERE id = $1 AND role != $2', [req.params.id, 'admin']);
  res.json({ message: 'User deleted' });
});

// Students
app.get('/api/admin/students', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { search, studentClass } = req.query;
  let query = `SELECT u.id,u.username,u.first_name,u.last_name,u.email,u.phone,u.class,u.stream,u.gender,u.status,u.created_at,
               s.admission_no,s.date_of_birth,s.nationality,s.guardian_name,s.guardian_phone,s.house
               FROM users u LEFT JOIN students s ON s.user_id = u.id WHERE u.role = 'student'`;
  const params = [];
  if (studentClass) { params.push(studentClass); query += ` AND u.class = $${params.length}`; }
  if (search) { params.push(`%${search}%`); query += ` AND (u.first_name LIKE $${params.length} OR u.last_name LIKE $${params.length})`; }
  query += ' ORDER BY u.created_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/admin/students', authenticate, requireRole('admin'), async (req, res) => {
  const { username, email, password, first_name, last_name, phone, class: studentClass, stream, gender, admission_no, date_of_birth, nationality, guardian_name, guardian_phone, house } = req.body;
  const hash = bcrypt.hashSync(password || 'Student@123', 10);
  const userResult = await pool.query(
    `INSERT INTO users (username,email,password_hash,role,first_name,last_name,phone,class,stream,gender,status)
     VALUES ($1,$2,$3,'student',$4,$5,$6,$7,$8,$9,'active') RETURNING id`,
    [username, email, hash, first_name, last_name, phone, studentClass, stream, gender]
  );
  const userId = userResult.rows[0].id;
  await pool.query(
    `INSERT INTO students (user_id,admission_no,date_of_birth,nationality,guardian_name,guardian_phone,house)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, admission_no, date_of_birth, nationality, guardian_name, guardian_phone, house]
  );
res.json({ message: 'Student created', userId });
});

// Admin update student
app.put('/api/admin/students/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { first_name, last_name, email, phone, class: studentClass, stream, gender, admission_no, guardian_name, guardian_phone, house } = req.body;
  const r = await pool.query(
    `UPDATE users SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),email=COALESCE($3,email),phone=COALESCE($4,phone),class=COALESCE($5,class),stream=COALESCE($6,stream),gender=COALESCE($7,gender) WHERE id=$8 RETURNING *`,
    [first_name, last_name, email, phone, studentClass, stream, gender, req.params.id]
  );
  if (r.rows[0]) await pool.query(
    `UPDATE students SET admission_no=COALESCE($1,admission_no),guardian_name=COALESCE($2,guardian_name),guardian_phone=COALESCE($3,guardian_phone),house=COALESCE($4,house) WHERE user_id=$5`,
    [admission_no, guardian_name, guardian_phone, house, req.params.id]
  );
  res.json(r.rows[0] || {});
});

// Admin delete student
app.delete('/api/admin/students/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM students WHERE user_id=$1', [req.params.id]);
  await pool.query('DELETE FROM users WHERE id=$1 AND role != $2', [req.params.id, 'admin']);
  res.json({ message: 'Deleted' });
});

// Admin update teacher
app.put('/api/admin/teachers/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { first_name, last_name, email, phone, employee_id, qualification, department } = req.body;
  const r = await pool.query(
    `UPDATE users SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),email=COALESCE($3,email),phone=COALESCE($4,phone) WHERE id=$5 RETURNING *`,
    [first_name, last_name, email, phone, req.params.id]
  );
  if (r.rows[0]) await pool.query(
    `UPDATE teachers SET employee_id=COALESCE($1,employee_id),qualification=COALESCE($2,qualification),department=COALESCE($3,department) WHERE user_id=$4`,
    [employee_id, qualification, department, req.params.id]
  );
  res.json(r.rows[0] || {});
});

// Admin delete teacher
app.delete('/api/admin/teachers/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Admin get parents
app.get('/api/admin/parents', authenticate, requireRole('admin'), async (req, res) => {
  const result = await pool.query(`SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.phone, u.status, p.relationship, p.occupation, p.address FROM users u LEFT JOIN parents p ON p.user_id = u.id WHERE u.role = 'parent' ORDER BY u.created_at DESC`);
  res.json(result.rows);
});

// Admin create parent
app.post('/api/admin/parents', authenticate, requireRole('admin'), async (req, res) => {
  const { username, email, password, first_name, last_name, phone, relationship, occupation, address } = req.body;
  const hash = bcrypt.hashSync(password || 'Parent@2026', 10);
  const userResult = await pool.query(
    `INSERT INTO users (username,email,password_hash,role,first_name,last_name,phone,status) VALUES ($1,$2,$3,'parent',$4,$5,$6,'active') RETURNING id`,
    [username, email, hash, first_name, last_name, phone]
  );
  const userId = userResult.rows[0].id;
  await pool.query(`INSERT INTO parents (user_id,relationship,occupation,address) VALUES ($1,$2,$3,$4)`, [userId, relationship || '', occupation || '', address || '']);
  res.json({ message: 'Parent created', userId });
});

// Admin update parent
app.put('/api/admin/parents/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { first_name, last_name, email, phone, relationship, occupation, address } = req.body;
  const r = await pool.query(`UPDATE users SET first_name=COALESCE($1,first_name),last_name=COALESCE($2,last_name),email=COALESCE($3,email),phone=COALESCE($4,phone) WHERE id=$5 RETURNING *`, [first_name, last_name, email, phone, req.params.id]);
  if (r.rows[0]) await pool.query(`UPDATE parents SET relationship=COALESCE($1,relationship),occupation=COALESCE($2,occupation),address=COALESCE($3,address) WHERE user_id=$4`, [relationship, occupation, address, req.params.id]);
  res.json(r.rows[0] || {});
});

// Admin delete parent
app.delete('/api/admin/parents/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.json({ message: 'Deleted' });
});

// Results
app.get('/api/results', authenticate, async (req, res) => {
  const studentId = req.user.role === 'student' ? req.user.id : req.query.student_id;
  if (!studentId) return res.status(400).json({ error: 'student_id required' });
  const student = await pool.query('SELECT id FROM students WHERE user_id = $1', [studentId]);
  if (!student.rows[0]) return res.json([]);
  const results = await pool.query(`
    SELECT r.*, s.name as subject_name, s.code as subject_code, c.name as class_name
    FROM results r
    JOIN subjects s ON s.id = r.subject_id
    JOIN classes c ON c.id = r.class_id
    WHERE r.student_id = $1 ORDER BY r.year DESC, r.term DESC, r.exam_type
  `, [student.rows[0].id]);
  res.json(results.rows);
});

app.get('/api/admin/results', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { class: cls, year, term, subject_id } = req.query;
  let query = `SELECT r.*, u.first_name, u.last_name, u.username, s.name as subject_name, sub.name as class_name
               FROM results r
               JOIN students st ON st.id = r.student_id
               JOIN users u ON u.id = st.user_id
               JOIN subjects s ON s.id = r.subject_id
               LEFT JOIN classes sub ON sub.id = r.class_id
               WHERE 1=1`;
  const params = [];
  if (cls) { params.push(cls); query += ` AND u.class = $${params.length}`; }
  if (year) { params.push(year); query += ` AND r.year = $${params.length}`; }
  if (term) { params.push(term); query += ` AND r.term = $${params.length}`; }
  if (subject_id) { params.push(subject_id); query += ` AND r.subject_id = $${params.length}`; }
  query += ' ORDER BY r.created_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/results', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { student_id, subject_id, class_id, exam_type, year, term, score, grade, remarks } = req.body;
  await pool.query(
    `INSERT INTO results (student_id,subject_id,class_id,exam_type,year,term,score,grade,remarks,entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [student_id, subject_id, class_id, exam_type, year, term, score, grade, remarks, req.user.id]
  );
  res.json({ message: 'Result entered' });
});

app.delete('/api/admin/results/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM results WHERE id = $1', [req.params.id]);
  res.json({ message: 'Result deleted' });
});

// Fees
app.get('/api/admin/fees', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const result = await pool.query(`
    SELECT f.*, u.first_name, u.last_name, u.class, u.username
    FROM fees f JOIN students s ON s.id = f.student_id JOIN users u ON u.id = s.user_id
    ORDER BY f.created_at DESC
  `);
  res.json(result.rows);
});

app.post('/api/admin/fees', authenticate, requireRole('admin'), async (req, res) => {
  const { student_id, description, amount, paid, due_date, year, term } = req.body;
  const status = paid >= amount ? 'paid' : (paid > 0 ? 'partial' : 'pending');
  await pool.query(
    `INSERT INTO fees (student_id,description,amount,paid,due_date,year,term,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [student_id, description, amount, paid || 0, due_date, year, term, status]
  );
  res.json({ message: 'Fee record created' });
});

app.put('/api/admin/fees/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { paid, description } = req.body;
  const f = await pool.query('SELECT amount FROM fees WHERE id = $1', [req.params.id]);
  if (f.rows[0]) {
    const status = paid >= f.rows[0].amount ? 'paid' : (paid > 0 ? 'partial' : 'pending');
    await pool.query('UPDATE fees SET paid = $1, status = $2, description = COALESCE($3, description) WHERE id = $4', [paid, status, description, req.params.id]);
  }
  res.json({ message: 'Fee updated' });
});

// Attendance
app.get('/api/admin/attendance', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { class: cls, date, student_id } = req.query;
  let query = `SELECT a.*, u.first_name, u.last_name, u.username, u.class, u.stream, c.name as class_name
               FROM attendance a
               JOIN students s ON s.id = a.student_id JOIN users u ON u.id = s.user_id
               LEFT JOIN classes c ON c.id = a.class_id WHERE 1=1`;
  const params = [];
  if (cls) { params.push(cls); query += ` AND u.class = $${params.length}`; }
  if (date) { params.push(date); query += ` AND a.date = $${params.length}`; }
  if (student_id) { params.push(student_id); query += ` AND s.id = $${params.length}`; }
  query += ' ORDER BY a.date DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/admin/attendance', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { student_id, class_id, date, status } = req.body;
  const result = await pool.query(
    `INSERT INTO attendance (student_id, class_id, date, status, marked_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (student_id, class_id, date) DO UPDATE SET status=$4, marked_by=$5`,
    [student_id, class_id, date, status, req.user.id]
  );
  res.json({ message: 'Attendance marked' });
});

// Contact form (public — the live site fetches /api/contact from index.html)
app.post('/api/contact', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'name, email, and message are required' });
    }
    // Store as a generic message (sender_id = 0 / admin inboxes it).
    // Anonymous visitor → no user record exists; we write to messages with
    // sender_id NULL and let the admin see it via /api/admin/messages if needed.
    // For now we acknowledge success so the form UX works.
    console.log(`[contact] from=${name} <${email}> phone=${phone || '-'} subj=${subject || '-'} msg=${String(message).slice(0, 200)}`);
    return res.json({ message: 'Thanks — we received your message and will reply soon.' });
  } catch (e) {
    console.error('contact error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Announcements
app.get('/api/announcements', async (req, res) => {
  const result = await pool.query(`SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC`);
  res.json(result.rows);
});

// Sync/pull — used by dataApi.js to sync dashboards with backend
app.get('/api/sync/pull', authenticate, async (req, res) => {
  try {
    const students = await pool.query(`SELECT u.id,u.username,u.first_name,u.last_name,u.email,u.phone,u.class,u.stream,u.gender,u.status,u.created_at,
      s.admission_no,s.date_of_birth,s.nationality,s.guardian_name,s.guardian_phone,s.house
      FROM users u LEFT JOIN students s ON s.user_id = u.id WHERE u.role = 'student'`);
    const teachers = await pool.query(`SELECT u.id,u.username,u.first_name,u.last_name,u.email,u.phone,u.gender,u.status,u.class,u.stream,
      t.employee_id,t.subjects_taught,t.department
      FROM users u LEFT JOIN teachers t ON t.user_id = u.id WHERE u.role = 'teacher'`);
    const results = await pool.query(`SELECT * FROM results ORDER BY id DESC LIMIT 200`);
    const attendance = await pool.query(`SELECT * FROM attendance ORDER BY id DESC LIMIT 200`);
    res.json({ students: students.rows, teachers: teachers.rows, results: results.rows, attendance: attendance.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Sync failed' }); }
});

// Announcements with role-based filtering (for teacher student audience, etc.)
app.get('/api/admin/announcements', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const result = await pool.query('SELECT a.*, u.first_name, u.last_name FROM announcements a LEFT JOIN users u ON u.id = a.created_by ORDER BY a.created_at DESC');
  res.json({ announcements: result.rows });
});

app.post('/api/admin/announcements', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { title, content, category, priority, expires_at, audience, target_class } = req.body;
  const result = await pool.query(
    `INSERT INTO announcements (title,content,category,priority,expires_at,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [title, content, category || 'general', priority || 'normal', expires_at, req.user.id]
  );
  // Real-time broadcast
  io.emit('new_announcement', result.rows[0]);
  res.json({ announcement: result.rows[0] });
});

app.put('/api/admin/announcements/:id', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { title, content, category, priority, expires_at } = req.body;
  const result = await pool.query(
    `UPDATE announcements SET title=$1,content=$2,category=$3,priority=$4,expires_at=$5 WHERE id=$6 RETURNING *`,
    [title, content, category, priority, expires_at, req.params.id]
  );
  if (result.rows[0]) io.emit('announcement_updated', result.rows[0]);
  res.json({ announcement: result.rows[0] });
});

app.delete('/api/admin/announcements/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM announcements WHERE id = $1', [req.params.id]);
  io.emit('announcement_deleted', { id: req.params.id });
  res.json({ message: 'Deleted' });
});

// Admin get teachers
app.get('/api/admin/teachers', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const r = await pool.query(`SELECT u.id,u.username,u.email,u.first_name,u.last_name,u.phone,u.status,u.created_at,t.employee_id,t.qualification,t.department,t.subjects_taught FROM users u LEFT JOIN teachers t ON t.user_id=u.id WHERE u.role='teacher' ORDER BY u.created_at DESC`);
  res.json(r.rows);
});

// Admin create teacher (POST)
app.post('/api/admin/teachers', authenticate, requireRole('admin'), async (req, res) => {
  const { username, email, password, first_name, last_name, phone, employee_id, qualification, department, subject } = req.body;
  const hash = bcrypt.hashSync(password || 'Teacher@2026', 10);
  const userResult = await pool.query(
    `INSERT INTO users (username,email,password_hash,role,first_name,last_name,phone,status) VALUES ($1,$2,$3,'teacher',$4,$5,$6,'active') RETURNING id,username,email`,
    [username, email, hash, first_name, last_name, phone]
  );
  const userId = userResult.rows[0].id;
  await pool.query(
    `INSERT INTO teachers (user_id,employee_id,qualification,department,subjects_taught) VALUES ($1,$2,$3,$4,$5)`,
    [userId, employee_id || ('T' + String(Math.floor(Math.random() * 9000) + 1000)), qualification || '', department || '', subject ? [subject] : []]
  );
  // Also create teacher_classes if class/subject provided
  res.json({ message: 'Teacher created', user: userResult.rows[0] });
});

// Teacher's own students (by class)
app.get('/api/teacher/students', authenticate, requireRole('teacher'), async (req, res) => {
  const { class: cls } = req.query;
  const teacher = await pool.query('SELECT id FROM teachers WHERE user_id = $1', [req.user.id]);
  if (!teacher.rows[0]) return res.json([]);
  // Get classes this teacher teaches
  const classes = await pool.query('SELECT class, stream, subject FROM teacher_classes WHERE teacher_id = $1', [teacher.rows[0].id]);
  const classList = classes.rows.map(c => c.class);
  if (!classList.length) return res.json([]);
  // Build dynamic IN clause with individual $1, $2... placeholders for cross-DB compatibility
  const inClause = classList.map((_, i) => `$${i + 1}`).join(',');
  let query = `SELECT u.id, u.username, u.first_name, u.last_name, u.email, u.phone, u.class, u.stream, u.gender, u.status
               FROM users u WHERE u.role = 'student' AND u.class IN (${inClause})`;
  const params = classList;
  if (cls) { params.push(cls); query += ` AND u.class = $${params.length}`; }
  query += ' ORDER BY u.last_name';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

// Admin classes
app.get('/api/admin/classes', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const result = await pool.query('SELECT c.*, t.employee_id, u.first_name as teacher_first_name, u.last_name as teacher_last_name FROM classes c LEFT JOIN teachers t ON t.id = c.class_teacher_id LEFT JOIN users u ON u.id = t.user_id ORDER BY c.name, c.stream');
  res.json({ classes: result.rows });
});

app.post('/api/admin/classes', authenticate, requireRole('admin'), async (req, res) => {
  const { name, stream, class_teacher_id } = req.body;
  const result = await pool.query('INSERT INTO classes (name, stream, class_teacher_id) VALUES ($1,$2,$3) RETURNING *', [name, stream, class_teacher_id]);
  res.json({ class: result.rows[0] });
});

app.put('/api/admin/classes/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { name, stream, class_teacher_id } = req.body;
  const result = await pool.query('UPDATE classes SET name=$1,stream=$2,class_teacher_id=$3 WHERE id=$4 RETURNING *', [name, stream, class_teacher_id, req.params.id]);
  res.json({ class: result.rows[0] });
});

app.delete('/api/admin/classes/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
  res.json({ message: 'Class deleted' });
});

// Admin subjects
app.get('/api/admin/subjects', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const result = await pool.query('SELECT * FROM subjects ORDER BY category, name');
  res.json({ subjects: result.rows });
});

app.post('/api/admin/subjects', authenticate, requireRole('admin'), async (req, res) => {
  const { name, code, category, level, teacher_id } = req.body;
  const result = await pool.query('INSERT INTO subjects (name,code,category,level,teacher_id) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, code, category, level, teacher_id]);
  res.json({ subject: result.rows[0] });
});

app.put('/api/admin/subjects/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { name, code, category, level, teacher_id } = req.body;
  const result = await pool.query('UPDATE subjects SET name=$1,code=$2,category=$3,level=$4,teacher_id=$5 WHERE id=$6 RETURNING *', [name, code, category, level, teacher_id, req.params.id]);
  res.json({ subject: result.rows[0] });
});

app.delete('/api/admin/subjects/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM subjects WHERE id = $1', [req.params.id]);
  res.json({ message: 'Subject deleted' });
});

// Student gets own data
app.get('/api/student/dashboard', authenticate, requireRole('student'), async (req, res) => {
  const student = await pool.query('SELECT s.*, u.username, u.first_name, u.last_name, u.email, u.phone, u.class, u.stream, u.gender FROM students s JOIN users u ON u.id = s.user_id WHERE u.id = $1', [req.user.id]);
  const assignments = await pool.query(`SELECT a.*, u.first_name, u.last_name FROM assignments a LEFT JOIN users u ON u.id = a.teacher_id WHERE a.class = $1 ORDER BY a.due_date ASC LIMIT 10`, [student.rows[0]?.class || '']);
  const fees = await pool.query('SELECT * FROM fees WHERE student_id = $1 ORDER BY year DESC, term DESC', [student.rows[0]?.id]);
  const results = await pool.query(`SELECT r.*, sub.name as subject_name FROM results r JOIN subjects sub ON sub.id = r.subject_id WHERE r.student_id = $1 ORDER BY r.year DESC, r.term DESC LIMIT 20`, [student.rows[0]?.id]);
  const announcements = await pool.query(`SELECT * FROM announcements WHERE (expires_at IS NULL OR expires_at > NOW()) ORDER BY created_at DESC LIMIT 5`);
  res.json({ student: student.rows[0], assignments: assignments.rows, fees: fees.rows, results: results.rows, announcements: announcements.rows });
});

// Assignments
app.get('/api/admin/assignments', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { class: cls, teacher_id } = req.query;
  let query = `SELECT a.*, u.first_name, u.last_name FROM assignments a LEFT JOIN users u ON u.id = a.teacher_id WHERE 1=1`;
  const params = [];
  if (cls) { params.push(cls); query += ` AND a.class = $${params.length}`; }
  if (teacher_id) { params.push(teacher_id); query += ` AND a.teacher_id = $${params.length}`; }
  query += ' ORDER BY a.created_at DESC';
  const result = await pool.query(query, params);
  res.json({ assignments: result.rows });
});

app.post('/api/admin/assignments', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { title, description, class: cls, subject, due_date, max_marks, attachments } = req.body;
  const result = await pool.query(
    `INSERT INTO assignments (title,description,class,subject,due_date,max_marks,teacher_id,attachments) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [title, description, cls, subject, due_date, max_marks || 100, req.user.id, attachments || []]
  );
  io.emit('new_assignment', result.rows[0]);
  res.json({ assignment: result.rows[0] });
});

app.put('/api/admin/assignments/:id', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { title, description, class: cls, subject, due_date, max_marks } = req.body;
  const result = await pool.query(
    `UPDATE assignments SET title=$1,description=$2,class=$3,subject=$4,due_date=$5,max_marks=$6 WHERE id=$7 RETURNING *`,
    [title, description, cls, subject, due_date, max_marks, req.params.id]
  );
  res.json({ assignment: result.rows[0] });
});

app.delete('/api/admin/assignments/:id', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  await pool.query('DELETE FROM assignments WHERE id=$1', [req.params.id]);
  res.json({ message: 'Assignment deleted' });
});

// Student Assignments (students view their own)
app.get('/api/student/assignments', authenticate, requireRole('student'), async (req, res) => {
  const result = await pool.query(
    `SELECT a.*, u.first_name, u.last_name FROM assignments a LEFT JOIN users u ON u.id = a.teacher_id WHERE a.class = $1 ORDER BY a.created_at DESC`,
    [req.user.class]
  );
  res.json(result.rows);
});

// Student view their own submissions
app.get('/api/student/submissions', authenticate, requireRole('student'), async (req, res) => {
  const student = await pool.query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  if (!student.rows[0]) return res.json([]);
  const result = await pool.query(
    `SELECT sub.*, a.title as assignment_title, a.subject, a.class
     FROM assignment_submissions sub
     JOIN assignments a ON a.id = sub.assignment_id
     WHERE sub.student_id = $1 ORDER BY sub.submitted_at DESC`,
    [student.rows[0].id]
  );
  res.json(result.rows);
});

// Student view their own fees
app.get('/api/student/fees', authenticate, requireRole('student'), async (req, res) => {
  const student = await pool.query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  if (!student.rows[0]) return res.json([]);
  const result = await pool.query(
    `SELECT f.* FROM fees f WHERE f.student_id = $1 ORDER BY f.year DESC, f.term DESC`,
    [student.rows[0].id]
  );
  res.json(result.rows);
});

// Assignment Submissions
app.get('/api/admin/submissions', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { assignment_id } = req.query;
  let query = `SELECT sub.*, u.first_name, u.last_name, a.title as assignment_title, st.user_id
               FROM assignment_submissions sub
               JOIN students st ON st.id = sub.student_id
               JOIN users u ON u.id = st.user_id
               JOIN assignments a ON a.id = sub.assignment_id WHERE 1=1`;
  const params = [];
  if (assignment_id) { params.push(assignment_id); query += ` AND sub.assignment_id = $${params.length}`; }
  query += ' ORDER BY sub.submitted_at DESC';
  const result = await pool.query(query, params);
  res.json(result.rows);
});

app.post('/api/student/submissions', authenticate, requireRole('student'), async (req, res) => {
  const { assignment_id, submission_text, attachment_urls } = req.body;
  const student = await pool.query('SELECT id FROM students WHERE user_id = $1', [req.user.id]);
  if (!student.rows[0]) return res.status(404).json({ error: 'Student record not found' });
  const result = await pool.query(
    `INSERT INTO assignment_submissions (assignment_id, student_id, submission_text, attachment_urls) VALUES ($1,$2,$3,$4) RETURNING *`,
    [assignment_id, student.rows[0].id, submission_text, attachment_urls || []]
  );
  res.json({ submission: result.rows[0] });
});

app.put('/api/admin/submissions/:id', authenticate, requireRole('admin', 'teacher'), async (req, res) => {
  const { marks, feedback } = req.body;
  await pool.query('UPDATE assignment_submissions SET marks=$1,feedback=$2,graded_by=$3,graded_at=NOW() WHERE id=$4', [marks, feedback, req.user.id, req.params.id]);
  res.json({ message: 'Submission graded' });
});

// Gallery
app.get('/api/gallery', async (req, res) => {
  const result = await pool.query('SELECT * FROM gallery ORDER BY created_at DESC');
  res.json(result.rows);
});

app.post('/api/admin/gallery', authenticate, requireRole('admin'), upload.fields([{ name: 'image', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  const { title, description, category, tags } = req.body;
  const image_url = req.files?.image ? `/uploads/${req.files.image[0].filename}` : '';
  const video_url = req.files?.video ? `/uploads/${req.files.video[0].filename}` : '';
  await pool.query('INSERT INTO gallery (title,description,image_url,video_url,category,tags) VALUES ($1,$2,$3,$4,$5,$6)', [title, description, image_url, video_url, category, tags ? tags.split(',') : []]);
  io.emit('gallery_updated', { action: 'add', title });
  res.json({ message: 'Gallery item uploaded' });
});

app.delete('/api/admin/gallery/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM gallery WHERE id = $1', [req.params.id]);
  res.json({ message: 'Gallery item deleted' });
});

// Classes & Subjects
app.get('/api/classes', async (req, res) => {
  const result = await pool.query('SELECT * FROM classes ORDER BY name, stream');
  res.json(result.rows);
});

app.post('/api/admin/classes', authenticate, requireRole('admin'), async (req, res) => {
  const { name, stream } = req.body;
  await pool.query('INSERT INTO classes (name, stream) VALUES ($1,$2)', [name, stream]);
  res.json({ message: 'Class created' });
});

app.get('/api/subjects', async (req, res) => {
  const result = await pool.query('SELECT * FROM subjects ORDER BY category, name');
  res.json(result.rows);
});

// News
app.get('/api/news', async (req, res) => {
  const result = await pool.query('SELECT id,title,slug,excerpt,category,image_url,views,created_at FROM news WHERE published = true ORDER BY created_at DESC');
  res.json(result.rows);
});

app.get('/api/admin/news', authenticate, requireRole('admin'), async (req, res) => {
  const result = await pool.query('SELECT n.*, u.first_name, u.last_name FROM news n LEFT JOIN users u ON u.id = n.author_id ORDER BY n.created_at DESC');
  res.json({ news: result.rows });
});

app.post('/api/admin/news', authenticate, requireRole('admin'), async (req, res) => {
  const { title, content, excerpt, category, image_url, published } = req.body;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
  await pool.query(
    `INSERT INTO news (title,slug,content,excerpt,category,image_url,published,author_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [title, slug, content, excerpt, category, image_url, published || false, req.user.id]
  );
  res.json({ message: 'News created' });
});

app.put('/api/admin/news/:id', authenticate, requireRole('admin'), async (req, res) => {
  const { title, content, excerpt, category, image_url, published } = req.body;
  await pool.query('UPDATE news SET title=$1,content=$2,excerpt=$3,category=$4,image_url=$5,published=$6,updated_at=NOW() WHERE id=$7', [title, content, excerpt, category, image_url, published, req.params.id]);
  res.json({ message: 'News updated' });
});

app.delete('/api/admin/news/:id', authenticate, requireRole('admin'), async (req, res) => {
  await pool.query('DELETE FROM news WHERE id = $1', [req.params.id]);
  res.json({ message: 'News deleted' });
});

// Site Settings
app.get('/api/settings', async (req, res) => {
  const result = await pool.query('SELECT * FROM site_settings');
  const settings = {};
  result.rows.forEach(r => { settings[r.key] = r.value; });
  res.json(settings);
});

app.put('/api/admin/settings', authenticate, requireRole('admin'), async (req, res) => {
  const { key, value } = req.body;
  await pool.query(`INSERT INTO site_settings (key,value,updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()`, [key, value]);
  res.json({ message: 'Setting updated' });
});

// Site Content
app.get('/api/admin/site-content', authenticate, requireRole('admin'), async (req, res) => {
  const result = await pool.query('SELECT * FROM site_content ORDER BY page, section');
  res.json(result.rows);
});

app.put('/api/admin/site-content', authenticate, requireRole('admin'), async (req, res) => {
  const { page, section, content } = req.body;
  await pool.query(`INSERT INTO site_content (page,section,content,updated_by,updated_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (page,section) DO UPDATE SET content=$3,updated_by=$4,updated_at=NOW()`, [page, section, content, req.user.id]);
  res.json({ message: 'Content updated' });
});

// Messages
app.get('/api/messages', authenticate, async (req, res) => {
  const result = await pool.query(
    `SELECT m.*, u1.first_name as sender_first, u1.last_name as sender_last, u2.first_name as receiver_first, u2.last_name as receiver_last
     FROM messages m JOIN users u1 ON u1.id = m.sender_id JOIN users u2 ON u2.id = m.receiver_id
     WHERE m.sender_id = $1 OR m.receiver_id = $1 ORDER BY m.created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

app.post('/api/messages', authenticate, async (req, res) => {
  const { receiver_id, subject, body } = req.body;
  const result = await pool.query('INSERT INTO messages (sender_id,receiver_id,subject,body) VALUES ($1,$2,$3,$4) RETURNING *', [req.user.id, receiver_id, subject, body]);
  io.to(`user_${receiver_id}`).emit('new_message', result.rows[0]);
  res.json({ message: 'Message sent' });
});

// Notifications
app.get('/api/notifications', authenticate, async (req, res) => {
  const result = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id]);
  res.json(result.rows);
});

app.put('/api/notifications/:id/read', authenticate, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ message: 'Marked read' });
});

app.put('/api/notifications/read-all', authenticate, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
  res.json({ message: 'All marked read' });
});

// Activities
app.get('/api/admin/activities', authenticate, requireRole('admin'), async (req, res) => {
  const result = await pool.query(`SELECT a.*, u.username, u.first_name, u.last_name FROM activities a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 100`);
  res.json(result.rows);
});

// File upload
app.post('/api/upload', authenticate, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname, size: req.file.size });
});

app.post('/api/upload/multiple', authenticate, upload.array('files', 10), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
  const files = req.files.map(f => ({ url: `/uploads/${f.filename}`, filename: f.originalname, size: f.size }));
  res.json({ files });
});

// Socket.io
io.on('connection', (socket) => {
  const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
  if (!token) { socket.disconnect(); return; }
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    socket.data.user = user;
  } catch { socket.disconnect(); return; }

  socket.on('join', () => {
    socket.join(`user_${user.id}`);
    pool.query('UPDATE users SET is_online = true WHERE id = $1', [user.id]).catch(err => console.error('Socket join error:', err));
  });
  socket.on('leave', () => {
    socket.leave(`user_${user.id}`);
    pool.query('UPDATE users SET is_online = false WHERE id = $1', [user.id]).catch(err => console.error('Socket leave error:', err));
  });
  socket.on('send_notification', async (data) => {
    const { user_id, type, title, message } = data;
    await pool.query('INSERT INTO notifications (user_id,type,title,message) VALUES ($1,$2,$3,$4)', [user_id, type, title, message]).catch(err => console.error('Socket notification error:', err));
    io.to(`user_${user_id}`).emit('notification', { type, title, message });
  });
});

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const PORT = process.env.PORT || 3000;
(async () => {
  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is not set');
    process.exit(1);
  }
  await initDB();
  server.listen(PORT, '0.0.0.0', () => console.log(`✓ Kalinabiri API running on port ${PORT}`));
})();