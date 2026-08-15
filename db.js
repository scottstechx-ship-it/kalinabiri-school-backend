// db.js - SQLite fallback wrapper that mimics pg Pool interface
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'kalinabiri.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initTables();
  }
  return db;
}

// Schema must stay in lockstep with server.js initDB() (Postgres init).
// SQLite is used for local dev; columns here mirror the PG schema so
// pool.query() calls don't crash with "no such column" on SQLite.
// Anything that doesn't apply on SQLite (ARRAY, BOOLEAN, JSONB) is
// modelled with TEXT/INTEGER equivalents.
function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE, email TEXT UNIQUE,
      password_hash TEXT NOT NULL, role TEXT DEFAULT 'student',
      first_name TEXT, last_name TEXT, phone TEXT,
      class TEXT, stream TEXT, gender TEXT,
      address TEXT, emergency_contact TEXT, avatar_url TEXT,
      status TEXT DEFAULT 'active', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME, is_online INTEGER DEFAULT 0,
      email_verified INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      admission_no TEXT UNIQUE, class TEXT, stream TEXT,
      house TEXT, gender TEXT, date_of_birth TEXT,
      nationality TEXT, former_school TEXT, religion TEXT,
      guardian_name TEXT, guardian_phone TEXT, guardian_relation TEXT,
      medical_conditions TEXT,
      clubs TEXT,           -- JSON array as TEXT on SQLite
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS teachers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      employee_id TEXT UNIQUE, department TEXT, subject TEXT,
      qualification TEXT, experience_years INTEGER DEFAULT 0, gender TEXT,
      date_of_birth TEXT,
      subjects_taught TEXT, -- TEXT[] modelled as JSON TEXT on SQLite
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS parents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      relationship TEXT, occupation TEXT, address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, code TEXT UNIQUE,
      category TEXT, level TEXT,
      teacher_id INTEGER REFERENCES teachers(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, stream TEXT,
      level TEXT, year INTEGER,
      class_teacher_id INTEGER REFERENCES teachers(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER REFERENCES classes(id), subject_id INTEGER REFERENCES subjects(id),
      year INTEGER, term INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, class_id, subject_id, year, term)
    );
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      class_id INTEGER REFERENCES classes(id),
      subject_id INTEGER REFERENCES subjects(id),
      date DATE, status TEXT, period TEXT,
      marked_by INTEGER REFERENCES users(id),
      term INTEGER, year INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      subject_id INTEGER REFERENCES subjects(id),
      class_id INTEGER REFERENCES classes(id),
      exam_type TEXT, year INTEGER, term INTEGER,
      score REAL, grade TEXT, remarks TEXT,
      entered_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
      description TEXT, amount REAL, paid REAL DEFAULT 0,
      due_date DATE, year INTEGER, term INTEGER,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, content TEXT, category TEXT,
      priority TEXT DEFAULT 'normal',
      expires_at DATETIME,
      posted_by INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      pinned INTEGER DEFAULT 0,
      audience TEXT,
      target_class TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, slug TEXT UNIQUE,
      content TEXT, excerpt TEXT, category TEXT,
      image_url TEXT, author_id INTEGER REFERENCES users(id),
      published INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, description TEXT,
      event_date DATETIME, end_date DATETIME, location TEXT,
      category TEXT, created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER REFERENCES users(id),
      recipient_id INTEGER REFERENCES users(id),
      receiver_id INTEGER REFERENCES users(id),
      subject TEXT, body TEXT,
      is_read INTEGER DEFAULT 0,
      read INTEGER DEFAULT 0,
      parent_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT, title TEXT, message TEXT,
      is_read INTEGER DEFAULT 0,
      read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      code TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      verified_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS site_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page TEXT, section TEXT,
      content TEXT, updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(page, section)
    );
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT UNIQUE, value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS gallery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, description TEXT,
      image_url TEXT, video_url TEXT,
      category TEXT,
      tags TEXT,            -- TEXT[] modelled as JSON TEXT on SQLite
      views INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER REFERENCES teachers(id),
      title TEXT, description TEXT,
      class TEXT, stream TEXT, subject TEXT,
      due_date DATETIME, max_marks INTEGER DEFAULT 100,
      attachments TEXT,     -- TEXT[] modelled as JSON TEXT on SQLite
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS assignment_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id),
      submission_text TEXT,
      attachment_urls TEXT, -- TEXT[] modelled as JSON TEXT on SQLite
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      marks INTEGER, feedback TEXT,
      graded_by INTEGER REFERENCES users(id),
      graded_at DATETIME
    );
    CREATE TABLE IF NOT EXISTS teacher_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER REFERENCES teachers(id),
      class TEXT, stream TEXT, subject TEXT, year INTEGER
    );
    CREATE TABLE IF NOT EXISTS student_classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER REFERENCES students(id),
      class TEXT, stream TEXT, year INTEGER, term INTEGER,
      UNIQUE(student_id, class, stream, year, term)
    );
    CREATE TABLE IF NOT EXISTS activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id),
          action TEXT, entity_type TEXT, entity_id INTEGER,
          details TEXT,         -- JSONB modelled as TEXT on SQLite
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Communication Platform Tables
        CREATE TABLE IF NOT EXISTS conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          school_id INTEGER DEFAULT 1,
          type TEXT NOT NULL, -- 'direct', 'group', 'class', 'announcement'
          name TEXT,
          description TEXT,
          created_by INTEGER REFERENCES users(id),
          is_archived INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS conversation_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          role TEXT DEFAULT 'member', -- 'admin', 'moderator', 'member'
          joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_read_at DATETIME,
          is_muted INTEGER DEFAULT 0,
          UNIQUE(conversation_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
          sender_id INTEGER REFERENCES users(id),
          parent_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
          content TEXT NOT NULL,
          message_type TEXT DEFAULT 'text', -- 'text', 'image', 'file', 'voice', 'system'
          attachment_url TEXT,
          attachment_name TEXT,
          attachment_size INTEGER,
          is_edited INTEGER DEFAULT 0,
          is_deleted INTEGER DEFAULT 0,
          is_pinned INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS message_reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          reaction TEXT NOT NULL, -- emoji like '👍', '❤️', '😂'
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(message_id, user_id, reaction)
        );

        CREATE TABLE IF NOT EXISTS message_reads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(message_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS typing_indicators (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          is_typing INTEGER DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(conversation_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS user_presence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          status TEXT DEFAULT 'offline', -- 'online', 'away', 'busy', 'offline'
          last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS emergency_alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          school_id INTEGER DEFAULT 1,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          severity TEXT DEFAULT 'high', -- 'low', 'medium', 'high', 'critical'
          target_audience TEXT, -- 'all', 'teachers', 'students', 'parents', 'staff'
          target_class TEXT,
          sent_by INTEGER REFERENCES users(id),
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS moderation_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action_type TEXT NOT NULL, -- 'warn', 'mute', 'ban', 'delete_message', 'flag'
          target_user_id INTEGER REFERENCES users(id),
          target_message_id INTEGER REFERENCES messages(id),
          moderator_id INTEGER REFERENCES users(id),
          reason TEXT,
          expires_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id),
          action TEXT NOT NULL,
          entity_type TEXT,
          entity_id INTEGER,
          old_value TEXT,  -- JSONB modelled as TEXT on SQLite
          new_value TEXT,  -- JSONB modelled as TEXT on SQLite
          ip_address TEXT,
          user_agent TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        -- Indexes for communication tables
        CREATE INDEX IF NOT EXISTS idx_conversations_school ON conversations(school_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_members_conv ON conversation_members(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
        CREATE INDEX IF NOT EXISTS idx_message_reactions_msg ON message_reactions(message_id);
        CREATE INDEX IF NOT EXISTS idx_message_reads_msg ON message_reads(message_id);
        CREATE INDEX IF NOT EXISTS idx_typing_conv ON typing_indicators(conversation_id);
        CREATE INDEX IF NOT EXISTS idx_presence_user ON user_presence(user_id);
  `);

  // Seed default admin if none exists
  const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  if (!adminExists) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const randomPassword = Array.from({length: 12}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    const hash = bcrypt.hashSync(randomPassword, 10);
    db.prepare(`INSERT INTO users (username,email,password_hash,role,first_name,last_name)
      VALUES (?,?,?,'admin','School','Administrator')`).run('admin', 'admin@kalinabiriss.ac.ug', hash);
    console.log(`\n✓ SQLite admin seeded — admin@kalinabiriss.ac.ug / ${randomPassword}\n`);
  }

  // Seed default site settings used by the public-facing pages
  const settingCount = db.prepare("SELECT COUNT(*) AS c FROM site_settings").get().c;
  if (settingCount === 0) {
    const ins = db.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?)");
    ins.run('school_name', 'KALINABIRI SECONDARY SCHOOL');
    ins.run('motto', 'Discipline is the Bridge between Goals and Accomplishment');
    ins.run('phone', '+256 700 123 456');
    ins.run('email', 'info@kalinabiriss.ac.ug');
    ins.run('address', 'Ntinda, Kampala, Uganda');
    console.log('✓ SQLite site_settings seeded');
  }

  // Seed subjects (mirrors the Postgres seed block in server.js — that
  // block only runs when DATABASE_URL starts with 'postgres', so the
  // local SQLite dev path needs its own seed or /api/subjects returns []).
  const subjCount = db.prepare("SELECT COUNT(*) AS c FROM subjects").get().c;
  if (subjCount === 0) {
    const insSubj = db.prepare("INSERT INTO subjects (name, code, category, level) VALUES (?, ?, ?, ?)");
    const subjects = [
      ['Mathematics', 'MATH', 'Mathematics', 'O Level'], ['English', 'ENG', 'Languages', 'O Level'],
      ['Physics', 'PHY', 'Sciences', 'A Level'], ['Chemistry', 'CHEM', 'Sciences', 'A Level'],
      ['Biology', 'BIO', 'Sciences', 'O Level'], ['Geography', 'GEO', 'Humanities', 'O Level'],
      ['History', 'HIST', 'Humanities', 'O Level'], ['CRE', 'CRE', 'Humanities', 'O Level'],
      ['Agriculture', 'AGR', 'Applied', 'O Level'], ['ICT', 'ICT', 'Applied', 'O Level']
    ];
    for (const [name, code, cat, lvl] of subjects) insSubj.run(name, code, cat, lvl);
    console.log('✓ SQLite subjects seeded');
  }

  // Seed classes (S.1..S.6 streams A/B) + teacher_classes so the
  // teacher dashboard's "my students" view and /api/classes work
  // out-of-the-box. Mirrors the Postgres seed block in server.js.
  const classCount = db.prepare("SELECT COUNT(*) AS c FROM classes").get().c;
  if (classCount === 0) {
    const insClass = db.prepare("INSERT OR IGNORE INTO classes (name, stream, level, year) VALUES (?, ?, ?, ?)");
    const year = new Date().getFullYear();
    const classRows = [
      ['S.1', 'A'], ['S.1', 'B'], ['S.2', 'A'], ['S.2', 'B'],
      ['S.3', 'A'], ['S.3', 'B'], ['S.4', 'A'], ['S.4', 'B'],
      ['S.5', 'A'], ['S.5', 'B'], ['S.6', 'A'], ['S.6', 'B'],
    ];
    for (const [name, stream] of classRows) {
      insClass.run(name, stream, 'O Level', year);
    }
    // Wire each teacher to two classes so /api/teacher/students returns data
    // the moment a teacher logs in. SQLite-translated SQL via this DbWrapper
    // isn't reachable from inside initTables() — use better-sqlite3 directly.
    const teachers = db.prepare("SELECT id FROM teachers ORDER BY id").all();
    const classes = db.prepare("SELECT id, name, stream FROM classes ORDER BY id").all();
    const insTc = db.prepare("INSERT INTO teacher_classes (teacher_id, class, stream, subject, year) VALUES (?, ?, ?, ?, ?)");
    teachers.forEach((t, idx) => {
      const a = classes[idx * 2 % classes.length];
      const b = classes[(idx * 2 + 1) % classes.length];
      if (a) insTc.run(t.id, a.name, a.stream, 'Mathematics', year);
      if (b) insTc.run(t.id, b.name, b.stream, 'Mathematics', year);
    });
    console.log('✓ SQLite classes + teacher_classes seeded');
  }
}

function convertPlaceholders(sql, params) {
  // Postgres uses the SAME $N multiple times to bind the same value (e.g.
  // `WHERE username = $1 OR email = $1` → 1 param, but the value appears
  // twice in the SQL). SQLite's `?` is strictly positional, so we have to
  // duplicate the bound value in the params array for each re-use.
  //
  // Params can arrive in two shapes:
  //   (a) pool.query(sql, 'a', 'b', 'c')        → params = ['a','b','c']
  //   (b) pool.query(sql, ['a','b','c'])         → params = [['a','b','c']]
  // Both are normal pg-Pool calling conventions. Normalise to (a).
  // CRITICAL: do this even when the SQL has no $N placeholders — e.g. an
  // `INSERT ... VALUES (?, ?, ?)` query still arrives in shape (b) and
  // better-sqlite3 needs the inner array, not the wrapper.
  if (params.length === 1 && Array.isArray(params[0])) params = params[0];

  if (!/\$/.test(sql)) {
    // No Postgres placeholders — params are already in correct shape.
    // Coerce JS booleans to 0/1 for SQLite (better-sqlite3 throws
    // "SQLite3 can only bind numbers, strings, bigints, buffers, and null"
    // if it sees a raw boolean — happens on `published: true` from the
    // /api/admin/news body, for example).
    return { sql, params: params.map(_toSqliteValue) };
  }

  // Build a parallel walk: emit one `?` per `$N` occurrence AND duplicate
  // the value in newParams so positions line up.
  const newParams = [];
  const converted = sql.replace(/\$(\d+)/g, (_m, n) => {
    const idx = parseInt(n, 10) - 1;
    const val = idx >= 0 && idx < params.length ? params[idx] : null;
    newParams.push(_toSqliteValue(val === undefined ? null : val));
    return '?';
  });
  return { sql: converted, params: newParams };
}

// Coerce a JS value into one of better-sqlite3's accepted bind types.
// Booleans become 0/1 (SQLite has no boolean type; the column is INTEGER).
// Dates pass through as their ISO string so SQLite stores TEXT — that's
// what the existing schema declares (DATETIME columns stored as ISO).
// Arrays become JSON-encoded strings (SQLite TEXT[] columns are modelled
// as JSON TEXT). An empty array would otherwise spread into zero bind
// args and produce "Too few parameter values were provided" — bind NULL.
function _toSqliteValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null;
  return v;
}

// Translate Postgres-flavoured SQL to SQLite on the fly.
// SQLite is used for local dev. Production runs on Postgres (Railway).
// Every route in server.js was written for Postgres, so this layer exists
// to make `node server.js` work on a laptop too. The transformations are
// narrow on purpose — anything outside this list will surface as a real
// SQLite error so it can be added deliberately.
function translateSqlite(sql) {
  let s = sql;

  // NOW() → CURRENT_TIMESTAMP (both return the same instant)
  s = s.replace(/\bNOW\s*\(\s*\)/gi, "CURRENT_TIMESTAMP");

  // INTERVAL '<n> <unit>' → '<n> <unit>s'
    // e.g. NOW() - INTERVAL '30 days'  →  CURRENT_TIMESTAMP - '30 days'
    // Preserve the original plural ('days' stays 'days') and singular ('day'
    // becomes 'days'). Earlier this unconditionally appended 's', turning
    // 'days' into 'dayss', which SQLite treated as a bare string literal and
    // broke the date math (newAdmissions filter returning 0).
    s = s.replace(
      /INTERVAL\s+'(\d+)\s+(\w+)'/gi,
      (_m, n, unit) => `'${n} ${/s$/i.test(unit) ? unit : unit.toLowerCase() + 's'}'`
    );
  // After the above, rewrite `CURRENT_TIMESTAMP - '30 days'` → `datetime('now', '-30 days')`
  s = s.replace(
    /CURRENT_TIMESTAMP\s*-\s*'(\d+)\s+(\w+)'/gi,
    (_m, n, unit) => `datetime('now', '-${n} ${unit}')`
  );

  // ARRAY[]::TYPE[] → empty JSON array literal. server.js code writes these
  // on INSERT INTO teachers (subjects_taught). Treat as a literal '[]'.
  s = s.replace(/ARRAY\s*\[\s*\]::[A-Z]+\[\s*\]/gi, "'[]'");

  // ::TYPE casts — SQLite doesn't have them; just drop them.
  s = s.replace(/::[A-Z][A-Z0-9_]*/g, '');

  // TRUE / FALSE literals (SQLite has them, but we keep things simple — leave alone)

  return s;
}

// Mock Pool-like interface
class DbWrapper {
  connect() {
    return { query: (...args) => this.all(...args), release: () => {} };
  }
  query(...args) { return this.all(...args); }
  all(sql, ...params) {
    const database = getDb();
    const { sql: converted, params: convertedParams } = convertPlaceholders(sql, params);
    const sqliteSql = translateSqlite(converted);
    if (process.env.SQLITE_DEBUG) console.log('[sql]', sqliteSql, 'params=', convertedParams);
    const trimmed = sqliteSql.trim();
    const isMutation = /^(INSERT|UPDATE|DELETE)/i.test(trimmed);
    const hasReturning = /RETURNING/i.test(sqliteSql);
    if (isMutation) {
      const stmt = database.prepare(sqliteSql);
      if (hasReturning) {
        const row = convertedParams.length ? stmt.get(...convertedParams) : stmt.get();
        return Promise.resolve({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
      }
      // INSERT/UPDATE/DELETE without RETURNING — use stmt.run()
      const info = convertedParams.length ? stmt.run(...convertedParams) : stmt.run();
      return Promise.resolve({ rows: [], rowCount: info.changes });
    }
    const stmt = database.prepare(sqliteSql);
    const rows = convertedParams.length ? stmt.all(...convertedParams) : stmt.all();
    return Promise.resolve({ rows, rowCount: rows.length });
  }
  run(sql, ...params) {
    const database = getDb();
    const { sql: converted, params: convertedParams } = convertPlaceholders(sql, params);
    const sqliteSql = translateSqlite(converted);
    if (process.env.SQLITE_DEBUG) console.log('[run]', sqliteSql, 'params=', convertedParams);
    const stmt = database.prepare(sqliteSql);
    const info = convertedParams.length ? stmt.run(...convertedParams) : stmt.run();
    return Promise.resolve({ rowCount: info.changes });
  }
  exec(sql) {
    getDb().exec(sql);
    return Promise.resolve();
  }
}

const wrapper = new DbWrapper();
module.exports = wrapper;
module.exports.getDb = getDb;