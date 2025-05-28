// ----------------- 기본 설정 -----------------
import express from 'express';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---------- SQLite 초기화 ----------
const db = await open({
  filename: './db.sqlite',
  driver: sqlite3.Database,
});
await db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_no INTEGER,
    name TEXT,
    amount INTEGER,
    items TEXT,        -- JSON 문자열
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    served INTEGER DEFAULT 0
  );
`);

// ---------- 메뉴(하드코딩) ----------
const BASE_MENU = [
  { id: 1, name: '치즈불닭',        price: 15000, stock: 30, category:'MAIN MENU' },
  { id: 2, name: '마라쏘야',        price: 15000, stock: 30, category:'MAIN MENU' },
  { id: 3, name: '떠먹는피자',        price: 13000, stock: 20, category:'MAIN MENU' },
  { id: 4, name: '치즈김치볶음밥',    price: 10000, stock: 30, category:'MAIN MENU' },
  { id: 5, name: '타락토스트',        price: 8000, stock: 20, category:'SIDE MENU' },
  { id: 6, name: '꼬치오뎅라면',      price: 6000, stock: 36, category:'SIDE MENU' },
  { id: 7, name: '묵사발',          price: 6000, stock: 30, category:'SIDE MENU' },
  { id: 8, name: '생크림 꿀호떡',     price: 5000, stock: 20, category:'SIDE MENU' },
  { id: 9, name: '랜덤과자박스',      price: 5000, stock: 30, category:'SIDE MENU' },
  { id: 10, name: '취했GU',          price: 5000, stock: 40, category:'BEVERAGE' },
  { id: 11, name: '제로콜라',        price: 2000, stock: 72, category:'BEVERAGE' },
  { id: 12, name: '초코에몽',        price: 2000, stock: 20, category:'BEVERAGE' },
];

/* ─── “세트(콤보)” : 재고 X, 구성품 ID 목록만 보유 ─── */
const COMBO_MENU = [
  { id: 101, name: '점장세트', price: 29000, components: [1, 4, 6], category:'SET MENU' },
  { id: 102, name: '알바세트', price: 19000, components: [7, 8, 9, 10], category:'SET MENU' },
];

/* 메뉴 테이블 */
await db.exec(`
  CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY,
    name TEXT,
    price INTEGER,
    stock INTEGER,
    category TEXT
  );
`);

/* 처음 실행 시만 데이터 삽입 (없으면 스킵) */
for (const m of BASE_MENU) {
  await db.run(
    `INSERT OR IGNORE INTO menu (id, name, price, stock, category) VALUES (?,?,?,?,?)`,
    m.id, m.name, m.price, m.stock, m.category
  );
}

/* 메뉴+재고 조회 API */
app.get('/api/menu', async (req, res) => {
  const rows = await db.all(`SELECT * FROM menu ORDER BY id`);
  const stockMap = Object.fromEntries(rows.map(r => [r.id, r.stock]));

  const combos = COMBO_MENU.map(c => {
    const minStock = Math.min(...c.components.map(id => stockMap[id] ?? 0));
    return { ...c, stock: minStock };           // 세트의 ‘재고’ = 구성품 최소
  });

  res.json([...rows, ...combos]);               // [{id,name,price,stock},...]
});

// ---------- 주문 생성 ----------
app.post('/api/order', async (req, res) => {
  const { name, cart, table } = req.body;
  if (!name?.trim() || !cart?.length) return res.status(400).end();

  try {
    await db.run('BEGIN');                // ── 트랜잭션 시작
    let amount = 0;

    /*  재고 검증 + 금액 계산  */
    for (const c of cart) {
      const base = await db.get(`SELECT price, stock, name FROM menu WHERE id=?`, c.id);
      const combo = COMBO_MENU.find(x => x.id === c.id);

      /* ── 단품 ── */
      if (base) {
        if (base.stock < c.qty) {
          await db.run('ROLLBACK');
          return res.status(409).json({ msg: 'soldout', itemId: c.id,
                                        itemName: base.name, remain: base.stock });
        }
        amount += base.price * c.qty;
        continue;
      }

      /* ── 세트 ── */
      if (combo) {
        for (const cid of combo.components) {
          const r = await db.get(`SELECT stock,name FROM menu WHERE id=?`, cid);
          if (!r || r.stock < c.qty) {
            await db.run('ROLLBACK');
            return res.status(409).json({ msg: 'soldout', itemId: c.id,
                                          itemName: combo.name, remain: 0 });
          }
        }
        amount += combo.price * c.qty;
        continue;
      }

      /* ── 정의되지 않은 ID ── */
      await db.run('ROLLBACK');
      return res.status(400).end();
    }

    /*  재고 차감  */
    for (const c of cart) {
      const combo = COMBO_MENU.find(x => x.id === c.id);
      if (combo) {
        for (const cid of combo.components) {
          await db.run(`UPDATE menu SET stock = stock - ? WHERE id=?`, c.qty, cid);
        }
      } else {
        await db.run(`UPDATE menu SET stock = stock - ? WHERE id=?`, c.qty, c.id);
      }
    }

    /*  주문 저장  */
    const r = await db.run(
      `INSERT INTO orders (table_no,name,amount,items)
       VALUES (?,?,?,?)`,
      table, name.trim(), amount, JSON.stringify(cart)
    );

    await db.run('COMMIT');               // ── 트랜잭션 끝

    res.json({
      orderId: r.lastID,
      amount,
      bank: {
        account: process.env.BANK_ACCOUNT || '농협 301-00-123456',
        holder:  process.env.BANK_HOLDER  || 'KWU축제주점',
        depositor: name.trim()
      }
    });
  } catch (e) {
    await db.run('ROLLBACK');
    console.error(e);
    res.status(500).end();
  }
});

// ---------- 주문 조회 ----------
app.get('/api/order/:id', async (req, res) => {
  const order = await db.get(`SELECT * FROM orders WHERE id = ?`, req.params.id);
  order ? res.json(order) : res.status(404).end();
});

// ---------- KB PUSH LISTENER ----------
app.post('/bank/hit', async (req, res) => {
  const { name, amount } = req.body ?? {};
  if (!name || !amount) return res.status(400).end();

  /* ① 같은 이름·금액의 미결 주문 전체 조회 */
  const rows = await db.all(
    `SELECT id FROM orders
     WHERE status='pending' AND name=? AND amount=?`,
    name.trim(), amount
  );

  if (rows.length === 0) {
    return res.json({ ok:false, msg:'no_match' });
  }

  /* ② 중복인지 단일인지 판별 */
  if (rows.length === 1) {
    await db.run(`UPDATE orders SET status='paid' WHERE id=?`, rows[0].id);
    return res.json({ ok:true, status:'paid', orderId: rows[0].id });
  }

  /* ③ 동일 (name,amount) 가 2건↑ → manual_check */
  await db.run(`UPDATE orders SET status='manual_check' WHERE id=?`, rows[0].id);
  return res.json({
    ok:true,
    status:'manual_check',
    orderId: rows[0].id,
    duplicates: rows.length
  });
});

app.listen(3000, () => console.log('🎉 http://localhost:3000'));



// 관리자
/* ────────── 관리자 인증 미들웨어 ────────── */
function adminAuth(req, res, next) {
  if (req.query.key !== process.env.ADMIN_KEY) return res.sendStatus(401);
  next();
}

/* 모든 관리자용 API에 적용 */
app.use('/api/admin', adminAuth);

/* ────────── 주문 목록 조회 ──────────
   GET /api/admin/orders
   → [{id, table_no, name, amount, status, served}, ...]
*/
app.get('/api/admin/orders', async (req, res) => {
  /* ① 주문 행 + ② 메뉴 이름 사전 가져오기 */
  const rows = await db.all(`
    SELECT id, table_no, name, amount, status, served, items
    FROM orders
    ORDER BY status='pending' DESC, created_at ASC
  `);
  const menuRows = await db.all(`SELECT id, name FROM menu`);
  const nameMap = Object.fromEntries([...menuRows.map(r => [r.id, r.name]), ...COMBO_MENU.map(c => [c.id, c.name])]);

  /* ③ items(JSON) → '이름×수량' 문자열 생성 */
  const withItems = rows.map(r => {
    let list = [];
    try {
      const arr = JSON.parse(r.items);   // [{id,qty}, …]
      list = arr.map(v => `${nameMap[v.id]||v.id}×${v.qty}`);
    } catch { list = ['-']; }
    return { ...r, items_text: list.join(', ') };
  });
  res.json(withItems);
});

/* ────────── 음식 전달 체크 ──────────
   POST /api/admin/order/:id/serve
   body: {served: 0|1}
*/
app.post('/api/admin/order/:id/serve', async (req, res) => {
  const { served } = req.body;
  const row = await db.get(`SELECT status, served FROM orders WHERE id=?`, req.params.id);
  if (!row) return res.sendStatus(404);
  
  // 결제(PAID) 돼 있지 않은데 음식을 내보내려 하면 차단
  if (row.status !== 'paid' && !row.served && served) {
    return res.status(400).json({ ok: false, msg: 'not_paid' });
  }

  await db.run(`UPDATE orders SET served=? WHERE id=?`, served ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

/* ────────── 결제 수동 확인 ──────────
   POST /api/admin/order/:id/pay     body: {}
*/
app.post('/api/admin/order/:id/pay', async (req, res) => {
  const { id } = req.params;
  const row = await db.get(`SELECT status FROM orders WHERE id=?`, id);
  if (!row) return res.sendStatus(404);

  if (row.status === 'paid') return res.json({ ok: true, msg: 'already' });

  await db.run(`UPDATE orders SET status='paid' WHERE id=?`, id);
  res.json({ ok: true });
});
