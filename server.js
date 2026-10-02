const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE-ME-NOW';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readStore() {
  if (!fs.existsSync(DATA_FILE)) return { products: [], orders: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { products: [], orders: [] }; }
}
function writeStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}
let store = readStore();
if (!Array.isArray(store.products)) store.products = [];
if (!Array.isArray(store.orders)) store.orders = [];

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))
});

function admin(req, res, next) {
  if (req.get('x-admin-password') !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function nextId(list) { return list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1; }
function orderNo() { return 'GHL-' + Date.now().toString().slice(-8); }

app.get('/api/products', (_req, res) => res.json(store.products.filter(p => Number(p.stock) > 0)));
app.get('/api/products/all', admin, (_req, res) => res.json(store.products));
app.get('/api/stats', admin, (_req, res) => {
  const revenue = store.orders.filter(o => o.status !== 'cancelled').reduce((s,o) => s + Number(o.total || 0), 0);
  res.json({ products: store.products.length, available: store.products.filter(p => Number(p.stock)>0).length, orders: store.orders.length, revenue });
});
app.get('/api/orders', admin, (_req, res) => res.json([...store.orders].reverse()));

app.post('/api/products', admin, upload.single('image'), (req, res) => {
  const p = {
    id: nextId(store.products),
    brand: String(req.body.brand || '').trim(),
    name: String(req.body.name || '').trim(),
    category: String(req.body.category || 'Vintage').trim(),
    size: String(req.body.size || '').trim(),
    price: Number(req.body.price || 0),
    stock: Number(req.body.stock || 1),
    image: req.file ? '/uploads/' + req.file.filename : String(req.body.image || '').trim(),
    description: String(req.body.description || '').trim()
  };
  if (!p.name || p.price <= 0 || p.stock < 0) return res.status(400).json({ error: 'Name, price and stock are required.' });
  store.products.push(p); writeStore(store); res.json(p);
});

app.patch('/api/products/:id', admin, (req, res) => {
  const p = store.products.find(x => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Product not found' });
  for (const key of ['brand','name','category','size','description','image']) if (req.body[key] !== undefined) p[key] = String(req.body[key]);
  for (const key of ['price','stock']) if (req.body[key] !== undefined) p[key] = Number(req.body[key]);
  writeStore(store); res.json(p);
});
app.delete('/api/products/:id', admin, (req, res) => {
  const id = Number(req.params.id); const before = store.products.length;
  store.products = store.products.filter(x => x.id !== id); writeStore(store);
  res.json({ ok: store.products.length < before });
});

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!body.customer_name || !body.phone || !body.wilaya || !body.commune || !body.address || !items.length) return res.status(400).json({ error: 'Please complete all required fields.' });
  const checked = [];
  let total = 0;
  for (const it of items) {
    const p = store.products.find(x => x.id === Number(it.product_id));
    const qty = Math.max(1, Number(it.qty || 1));
    if (!p) return res.status(400).json({ error: 'A product is no longer available.' });
    if (Number(p.stock) < qty) return res.status(409).json({ error: `Stock insuffisant: ${p.name}` });
    checked.push({ product_id: p.id, name: p.name, size: p.size, price: p.price, qty });
    total += p.price * qty;
  }
  checked.forEach(it => { const p = store.products.find(x => x.id === it.product_id); p.stock -= it.qty; });
  const order = { id: nextId(store.orders), order_no: orderNo(), customer_name: String(body.customer_name), phone: String(body.phone), wilaya: String(body.wilaya), commune: String(body.commune), address: String(body.address), delivery: String(body.delivery || 'Livraison'), total, status: 'new', items: checked, created_at: new Date().toISOString() };
  store.orders.push(order); writeStore(store); res.json({ ok: true, order_no: order.order_no, total });
});
app.patch('/api/orders/:id', admin, (req, res) => {
  const o = store.orders.find(x => x.id === Number(req.params.id));
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (req.body.status) o.status = String(req.body.status);
  writeStore(store); res.json(o);
});

app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), err => { if (err) next(err); });
});

app.listen(PORT, () => console.log('Ghir9elbl7aba shop listening on ' + PORT));
