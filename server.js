const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE-ME';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');
const DB_FILE = path.join(DATA_DIR, 'store.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function loadStore() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { products: [], orders: [], nextProductId: 1, nextOrderId: 1 };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { products: [], orders: [], nextProductId: 1, nextOrderId: 1 };
  }
}
function saveStore(store) {
  fs.writeFileSync(DB_FILE, JSON.stringify(store, null, 2));
}
let store = loadStore();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

function adminOnly(req, res, next) {
  const supplied = req.get('x-admin-password') || req.body.adminPassword || req.query.adminPassword;
  if (!supplied || supplied !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function cleanProduct(p) {
  return { ...p, price: Number(p.price), stock: Number(p.stock) };
}
function orderNumber(id) {
  return `GHL-${String(id).padStart(6, '0')}`;
}

app.get('/api/products', (_req, res) => {
  res.json(store.products.filter(p => p.stock > 0).map(cleanProduct));
});

app.get('/api/products/all', adminOnly, (_req, res) => {
  res.json(store.products.map(cleanProduct));
});

app.post('/api/products', adminOnly, upload.single('image'), (req, res) => {
  const { brand = '', name, category = 'Other', size = '', price, stock = 1, description = '' } = req.body;
  if (!name || price === undefined || Number.isNaN(Number(price))) {
    return res.status(400).json({ error: 'Name and valid price are required' });
  }
  const product = {
    id: store.nextProductId++,
    brand: String(brand).trim(),
    name: String(name).trim(),
    category: String(category).trim() || 'Other',
    size: String(size).trim(),
    price: Number(price),
    stock: Math.max(0, Number(stock) || 0),
    image: req.file ? `/uploads/${req.file.filename}` : '',
    description: String(description).trim()
  };
  store.products.push(product);
  saveStore(store);
  res.status(201).json(product);
});

app.patch('/api/products/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const p = store.products.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const allowed = ['brand', 'name', 'category', 'size', 'description'];
  for (const key of allowed) if (req.body[key] !== undefined) p[key] = String(req.body[key]);
  if (req.body.price !== undefined) p.price = Number(req.body.price);
  if (req.body.stock !== undefined) p.stock = Math.max(0, Number(req.body.stock) || 0);
  saveStore(store);
  res.json(cleanProduct(p));
});

app.delete('/api/products/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const i = store.products.findIndex(x => x.id === id);
  if (i < 0) return res.status(404).json({ error: 'Product not found' });
  store.products.splice(i, 1);
  saveStore(store);
  res.json({ ok: true });
});

app.post('/api/orders', (req, res) => {
  const { customer_name, phone, wilaya, commune, address, delivery = 'home', items } = req.body || {};
  if (!customer_name || !phone || !wilaya || !commune || !address || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Please complete all required fields and add at least one item.' });
  }
  const requested = new Map();
  for (const item of items) {
    const id = Number(item.product_id);
    const qty = Math.max(1, Number(item.qty) || 1);
    requested.set(id, (requested.get(id) || 0) + qty);
  }
  const orderItems = [];
  let total = 0;
  for (const [id, qty] of requested.entries()) {
    const p = store.products.find(x => x.id === id);
    if (!p) return res.status(400).json({ error: 'One of the products is no longer available.' });
    if (p.stock < qty) return res.status(409).json({ error: `Stock insuffisant pour ${p.name}.` });
    orderItems.push({ product_id: p.id, name: p.name, size: p.size, price: p.price, qty });
    total += p.price * qty;
  }
  for (const item of orderItems) {
    const p = store.products.find(x => x.id === item.product_id);
    p.stock -= item.qty;
  }
  const id = store.nextOrderId++;
  const order = {
    id,
    order_no: orderNumber(id),
    customer_name: String(customer_name).trim(),
    phone: String(phone).trim(),
    wilaya: String(wilaya).trim(),
    commune: String(commune).trim(),
    address: String(address).trim(),
    delivery: String(delivery),
    total,
    status: 'new',
    created_at: new Date().toISOString(),
    items: orderItems
  };
  store.orders.unshift(order);
  saveStore(store);
  res.status(201).json({ order_no: order.order_no, total, status: order.status });
});

app.get('/api/orders', adminOnly, (_req, res) => res.json(store.orders));

app.patch('/api/orders/:id', adminOnly, (req, res) => {
  const order = store.orders.find(x => x.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const allowed = ['new', 'confirmed', 'shipped', 'completed', 'cancelled'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  order.status = req.body.status;
  saveStore(store);
  res.json(order);
});

app.get('/api/stats', adminOnly, (_req, res) => {
  const revenue = store.orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + Number(o.total || 0), 0);
  res.json({ products: store.products.length, available: store.products.reduce((s, p) => s + Number(p.stock || 0), 0), orders: store.orders.length, revenue });
});

app.get('/admin', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('*', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || 'Request failed' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Ghir9elbl7aba shop listening on port ${PORT}`));
