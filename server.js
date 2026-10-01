const express = require("express");
const Database = require("better-sqlite3");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "CHANGE-ME";

const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "public", "uploads");
fs.mkdirSync(dataDir, {recursive:true});
fs.mkdirSync(uploadDir, {recursive:true});

const db = new Database(path.join(dataDir, "shop.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 brand TEXT NOT NULL DEFAULT '',
 name TEXT NOT NULL,
 category TEXT NOT NULL DEFAULT 'Other',
 size TEXT NOT NULL DEFAULT '',
 price INTEGER NOT NULL,
 stock INTEGER NOT NULL DEFAULT 1,
 image TEXT NOT NULL DEFAULT '',
 description TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_no TEXT UNIQUE NOT NULL,
 customer_name TEXT NOT NULL,
 phone TEXT NOT NULL,
 wilaya TEXT NOT NULL,
 commune TEXT NOT NULL,
 address TEXT NOT NULL,
 delivery TEXT NOT NULL,
 total INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'new',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER NOT NULL,
 product_id INTEGER NOT NULL,
 name TEXT NOT NULL,
 size TEXT NOT NULL,
 price INTEGER NOT NULL,
 qty INTEGER NOT NULL,
 FOREIGN KEY(order_id) REFERENCES orders(id)
);
`);

app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));

function admin(req,res,next){
  if(req.headers["x-admin-password"] !== ADMIN_PASSWORD)
    return res.status(401).json({error:"Unauthorized"});
  next();
}
function orderNo(){
  return "GHL-" + Date.now().toString(36).toUpperCase() + "-" +
    crypto.randomBytes(2).toString("hex").toUpperCase();
}

const storage = multer.diskStorage({
  destination: (_,__,cb)=>cb(null,uploadDir),
  filename: (_,file,cb)=>{
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now()+"-"+crypto.randomBytes(4).toString("hex")+ext);
  }
});
const upload = multer({
  storage,
  limits:{fileSize:6*1024*1024},
  fileFilter:(_,file,cb)=>cb(null,/^image\/(jpeg|png|webp|avif)$/.test(file.mimetype))
});

app.get("/api/products",(req,res)=>{
  const rows=db.prepare("SELECT * FROM products WHERE active=1 AND stock>0 ORDER BY id DESC").all();
  res.json(rows);
});
app.get("/api/products/all",admin,(req,res)=>{
  res.json(db.prepare("SELECT * FROM products ORDER BY id DESC").all());
});
app.post("/api/products",admin,upload.single("image"),(req,res)=>{
  const {brand="",name="",category="Other",size="",price,stock=1,description=""}=req.body;
  if(!name || !Number.isFinite(Number(price))) return res.status(400).json({error:"Name and price required"});
  const image=req.file ? "/uploads/"+req.file.filename : (req.body.image||"");
  const info=db.prepare(`INSERT INTO products(brand,name,category,size,price,stock,image,description)
    VALUES(?,?,?,?,?,?,?,?)`).run(brand,name,category,size,Math.round(Number(price)),Math.max(0,Number(stock)),image,description);
  res.json({id:info.lastInsertRowid});
});
app.patch("/api/products/:id",admin,(req,res)=>{
  const p=db.prepare("SELECT * FROM products WHERE id=?").get(req.params.id);
  if(!p) return res.status(404).json({error:"Not found"});
  const fields=["brand","name","category","size","price","stock","image","description","active"];
  const data={...p,...req.body};
  db.prepare(`UPDATE products SET ${fields.map(f=>f+"=?").join(",")} WHERE id=?`)
    .run(...fields.map(f=>data[f]),p.id);
  res.json({ok:true});
});
app.delete("/api/products/:id",admin,(req,res)=>{
  db.prepare("DELETE FROM products WHERE id=?").run(req.params.id);
  res.json({ok:true});
});

app.post("/api/orders",(req,res)=>{
  const {customer_name,phone,wilaya,commune,address,delivery,items}=req.body;
  if(!customer_name||!phone||!wilaya||!commune||!address||!delivery||!Array.isArray(items)||!items.length)
    return res.status(400).json({error:"Missing order information"});
  const ids=items.map(x=>Number(x.product_id));
  const products=ids.map(id=>db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(id));
  if(products.some(p=>!p)) return res.status(400).json({error:"Product unavailable"});
  let total=0;
  const clean=[];
  for(const item of items){
    const p=products.find(x=>x.id===Number(item.product_id));
    const qty=Math.max(1,Math.floor(Number(item.qty)||1));
    if(qty>p.stock) return res.status(400).json({error:`Stock insuffisant: ${p.name}`});
    total += p.price*qty;
    clean.push({p,qty});
  }
  const tx=db.transaction(()=>{
    const no=orderNo();
    const order=db.prepare(`INSERT INTO orders(order_no,customer_name,phone,wilaya,commune,address,delivery,total)
      VALUES(?,?,?,?,?,?,?,?)`).run(no,customer_name,phone,wilaya,commune,address,delivery,total);
    for(const x of clean){
      db.prepare(`INSERT INTO order_items(order_id,product_id,name,size,price,qty) VALUES(?,?,?,?,?,?)`)
        .run(order.lastInsertRowid,x.p.id,x.p.name,x.p.size,x.p.price,x.qty);
      db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(x.qty,x.p.id);
    }
    return no;
  });
  res.json({ok:true,order_no:tx,total});
});

app.get("/api/orders",admin,(req,res)=>{
  const orders=db.prepare("SELECT * FROM orders ORDER BY id DESC").all();
  for(const o of orders) o.items=db.prepare("SELECT * FROM order_items WHERE order_id=?").all(o.id);
  res.json(orders);
});
app.patch("/api/orders/:id",admin,(req,res)=>{
  const allowed=["new","confirmed","shipped","delivered","cancelled"];
  if(!allowed.includes(req.body.status)) return res.status(400).json({error:"Invalid status"});
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(req.body.status,req.params.id);
  res.json({ok:true});
});
app.get("/api/stats",admin,(req,res)=>{
  const stats={
    products:db.prepare("SELECT COUNT(*) n FROM products").get().n,
    available:db.prepare("SELECT COUNT(*) n FROM products WHERE active=1 AND stock>0").get().n,
    orders:db.prepare("SELECT COUNT(*) n FROM orders").get().n,
    newOrders:db.prepare("SELECT COUNT(*) n FROM orders WHERE status='new'").get().n,
    revenue:db.prepare("SELECT COALESCE(SUM(total),0) n FROM orders WHERE status!='cancelled'").get().n
  };
  res.json(stats);
});

const SHOP_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GHIR9ELBL7ABA — Thrift & Vintage</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f8eef3;color:#301b28;font-family:Arial,sans-serif}
header{position:sticky;top:0;z-index:5;background:#5b183b;color:#fff;padding:14px 16px;box-shadow:0 2px 12px #0002}
.top{max-width:1100px;margin:auto;display:flex;align-items:center;justify-content:space-between;gap:12px}.logo{font-weight:900;letter-spacing:2px;font-size:20px}.cart{border:0;border-radius:20px;padding:9px 13px;background:#f3c45b;color:#321522;font-weight:800}
.hero{max-width:1100px;margin:auto;padding:28px 16px 15px}.hero h1{font-family:Georgia,serif;font-size:42px;margin:5px 0}.hero p{margin:0;color:#6f5360}
.search{margin-top:16px;width:100%;padding:13px 15px;border:1px solid #dcc6d0;border-radius:14px;background:#fff}
.cats{display:flex;gap:8px;overflow:auto;padding:12px 16px;max-width:1100px;margin:auto}.cat{border:1px solid #b98ca1;background:#fff;border-radius:999px;padding:8px 13px;white-space:nowrap}.cat.active{background:#5b183b;color:white}
.grid{max-width:1100px;margin:auto;padding:8px 16px 40px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.card{background:#fff;border:1px solid #ead9e0;border-radius:16px;overflow:hidden;box-shadow:0 5px 18px #5b183b12}.pic{aspect-ratio:1/1.18;background:#eee0e7;position:relative}.pic img{width:100%;height:100%;object-fit:cover}.tag{position:absolute;left:8px;top:8px;background:#5b183b;color:#fff;border-radius:8px;padding:5px 8px;font-size:12px}.info{padding:10px}.brand{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8c6374}.name{font-weight:800;margin:3px 0}.meta{display:flex;justify-content:space-between;gap:5px;font-size:12px;color:#725664}.price{font-size:18px;font-weight:900;margin:8px 0}.buy{width:100%;padding:10px;border:0;border-radius:10px;background:#5b183b;color:#fff;font-weight:800}
.overlay{position:fixed;inset:0;background:#0008;display:none;z-index:10}.panel{position:absolute;right:0;top:0;height:100%;width:min(470px,100%);background:#fff;padding:18px;overflow:auto}.close{float:right;border:0;background:#eee;border-radius:50%;width:34px;height:34px}.row{display:flex;gap:10px;margin:12px 0}.row>div{flex:1}.field{width:100%;padding:11px;border:1px solid #ddd;border-radius:10px}.cartline{display:flex;gap:10px;border-bottom:1px solid #eee;padding:10px 0}.cartline img{width:65px;height:75px;object-fit:cover;border-radius:8px}.qty{display:flex;align-items:center;gap:7px}.qty button{border:0;border-radius:7px;padding:5px 9px}.total{font-size:21px;font-weight:900;margin:15px 0}.submit{width:100%;padding:13px;background:#5b183b;color:white;border:0;border-radius:12px;font-weight:900}
.success{display:none;text-align:center;padding:30px}.orderNo{font-size:27px;font-weight:900;color:#5b183b}
@media(min-width:800px){.grid{grid-template-columns:repeat(3,1fr)}}
</style></head><body>
<header><div class="top"><div class="logo">GHIR9ELBL7ABA</div><button class="cart" onclick="openCart()">🛍️ Panier <span id="count">0</span></button></div></header>
<section class="hero"><h1>THRIFT & VINTAGE</h1><p>Pièces sélectionnées • une seule pièce par modèle</p><input id="search" class="search" placeholder="Rechercher une marque ou une pièce..." oninput="render()"></section>
<div id="cats" class="cats"></div><main id="grid" class="grid"></main>

<div id="overlay" class="overlay"><div class="panel"><button class="close" onclick="closeCart()">×</button><h2>Ton panier</h2><div id="cart"></div>
<div id="checkout" style="display:none"><hr><h3>Livraison</h3>
<div class="row"><div><input id="name" class="field" placeholder="Nom et prénom"></div><div><input id="phone" class="field" placeholder="Téléphone"></div></div>
<div class="row"><div><input id="wilaya" class="field" placeholder="Wilaya"></div><div><input id="commune" class="field" placeholder="Commune"></div></div>
<input id="address" class="field" placeholder="Adresse / point de livraison" style="margin-bottom:10px">
<select id="delivery" class="field"><option value="domicile">Livraison à domicile</option><option value="point">Point de retrait</option></select>
<div class="total" id="total"></div><button class="submit" onclick="submitOrder()">CONFIRMER LA COMMANDE</button></div>
<div id="success" class="success"><h2>Commande enregistrée ✓</h2><p>Ton numéro de commande :</p><div class="orderNo" id="orderNo"></div><p>Garde ce numéro pour suivre ta commande.</p></div>
</div></div>
<script>
let products=[],cartItems=[],cat="All";
const money=n=>new Intl.NumberFormat("fr-DZ").format(n)+" DA";
async function load(){products=await (await fetch("/api/products")).json();cats();render()}
function cats(){let c=["All",...new Set(products.map(p=>p.category))];document.getElementById("cats").innerHTML=c.map(x=>\\`<button class="cat \\${x===cat?"active":""}" onclick="cat='\\${x.replaceAll("'","&#39;")}';cats();render()">\\${x}</button>\\`).join("")}
function render(){let q=document.getElementById("search").value.toLowerCase();let list=products.filter(p=>(cat==="All"||p.category===cat)&&((p.name+" "+p.brand).toLowerCase().includes(q)));document.getElementById("grid").innerHTML=list.map(p=>\\`<article class="card"><div class="pic">\\${p.image?\\`<img src="\\${p.image}">\\`:\\`<div style="height:100%;display:grid;place-items:center;color:#8c6374">PHOTO</div>\\`}<span class="tag">\\${p.size||"One size"}</span></div><div class="info"><div class="brand">\\${p.brand||"Vintage"}</div><div class="name">\\${p.name}</div><div class="meta"><span>Stock: \\${p.stock}</span><span>\\${p.category}</span></div><div class="price">\\${money(p.price)}</div><button class="buy" onclick="add(\\${p.id})">COMMANDER</button></div></article>\\`).join("")||"<p>Aucune pièce disponible.</p>"}
function add(id){let p=products.find(x=>x.id===id);let x=cartItems.find(x=>x.id===id);if(x)x.qty++;else cartItems.push({id,qty:1,p});openCart()}
function openCart(){document.getElementById("overlay").style.display="block";drawCart()}
function closeCart(){document.getElementById("overlay").style.display="none"}
function drawCart(){document.getElementById("count").textContent=cartItems.reduce((a,x)=>a+x.qty,0);let el=document.getElementById("cart");if(!cartItems.length){el.innerHTML="<p>Panier vide.</p>";document.getElementById("checkout").style.display="none";return}el.innerHTML=cartItems.map(x=>\\`<div class="cartline"><div style="flex:1"><b>\\${x.p.name}</b><br><small>\\${x.p.size} • \\${money(x.p.price)}</small><div class="qty"><button onclick="change(\\${x.id},-1)">−</button>\\${x.qty}<button onclick="change(\\${x.id},1)">+</button></div></div></div>\\`).join("");document.getElementById("checkout").style.display="block";document.getElementById("total").textContent=money(cartItems.reduce((a,x)=>a+x.qty*x.p.price,0))}
function change(id,d){let x=cartItems.find(x=>x.id===id);x.qty+=d;if(x.qty<=0)cartItems=cartItems.filter(y=>y.id!==id);drawCart()}
async function submitOrder(){let data={customer_name:name.value.trim(),phone:phone.value.trim(),wilaya:wilaya.value.trim(),commune:commune.value.trim(),address:address.value.trim(),delivery:delivery.value,items:cartItems.map(x=>({product_id:x.id,qty:x.qty}))};if(Object.values(data).slice(0,6).some(v=>!v)){alert("كملي معلومات التوصيل.");return}let r=await fetch("/api/orders",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});let j=await r.json();if(!r.ok){alert(j.error||"خطأ");return}document.getElementById("cart").style.display="none";document.getElementById("checkout").style.display="none";document.getElementById("success").style.display="block";document.getElementById("orderNo").textContent=j.order_no;cartItems=[];await load()}
load();
</script></body></html>`;
const ADMIN_HTML = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GHL Admin</title>
<style>body{font-family:Arial;background:#f6eef2;margin:0;color:#321522}.wrap{max-width:1100px;margin:auto;padding:18px}.box{background:#fff;border-radius:14px;padding:16px;margin:12px 0;box-shadow:0 4px 15px #0001}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat{background:#5b183b;color:#fff;padding:15px;border-radius:12px}.field{padding:10px;border:1px solid #ddd;border-radius:8px;width:100%;box-sizing:border-box;margin:4px 0}.btn{padding:10px 14px;border:0;border-radius:8px;background:#5b183b;color:#fff;font-weight:700}.danger{background:#9d294c}.item{border-bottom:1px solid #eee;padding:12px 0}@media(max-width:650px){.stats{grid-template-columns:repeat(2,1fr)}}</style></head><body><div class="wrap">
<h1>GHIR9ELBL7ABA — ADMIN</h1><div class="box"><input id="pw" class="field" type="password" placeholder="Admin password"><button class="btn" onclick="login()">Connexion</button><span id="msg"></span></div>
<div id="app" style="display:none"><div id="stats" class="stats"></div>
<div class="box"><h2>Ajouter une pièce</h2><form id="form"><input name="brand" class="field" placeholder="Marque"><input name="name" class="field" placeholder="Nom *" required><input name="category" class="field" placeholder="Catégorie" value="Other"><input name="size" class="field" placeholder="Taille"><input name="price" class="field" type="number" placeholder="Prix DA" required><input name="stock" class="field" type="number" value="1" min="0"><input name="description" class="field" placeholder="Description"><input name="image" class="field" type="file" accept="image/*"><button class="btn">Ajouter</button></form></div>
<div class="box"><h2>Produits</h2><div id="products"></div></div><div class="box"><h2>Commandes</h2><div id="orders"></div></div></div></div>
<script>let pass="";const H=()=>({"x-admin-password":pass});async function login(){pass=pw.value;let r=await fetch("/api/stats",{headers:H()});if(!r.ok){msg.textContent=" Mot de passe incorrect";return}app.style.display="block";load()}async function load(){let s=await (await fetch("/api/stats",{headers:H()})).json();stats.innerHTML=Object.entries({Produits:s.products,Disponibles:s.available,"Commandes":s.orders,"Nouvelles":s.newOrders}).map(([k,v])=>\\`<div class=stat><b>\\${k}</b><br><strong>\\${v}</strong></div>\\`).join("");let ps=await (await fetch("/api/products/all",{headers:H()})).json();products.innerHTML=ps.map(p=>\\`<div class=item><b>\\${p.brand} \\${p.name}</b> — \\${p.price} DA — taille \\${p.size} — stock \\${p.stock} <button class="btn danger" onclick="del(\\${p.id})">Supprimer</button></div>\\`).join("");let os=await (await fetch("/api/orders",{headers:H()})).json();orders.innerHTML=os.map(o=>\\`<div class=item><b>\\${o.order_no}</b> — \\${o.customer_name} — \\${o.phone}<br>\\${o.wilaya}, \\${o.commune} — \\${o.total} DA — \\${o.status}<br>\\${o.items.map(i=>\\`\\${i.name} x\\${i.qty}\\`).join(" • ")}<br><select onchange="status(\\${o.id},this.value)"><option \\${o.status==="new"?"selected":""}>new</option><option \\${o.status==="confirmed"?"selected":""}>confirmed</option><option \\${o.status==="shipped"?"selected":""}>shipped</option><option \\${o.status==="delivered"?"selected":""}>delivered</option><option \\${o.status==="cancelled"?"selected":""}>cancelled</option></select></div>\\`).join("")}async function del(id){if(confirm("Supprimer ?")){await fetch("/api/products/"+id,{method:"DELETE",headers:H()});load()}}async function status(id,v){await fetch("/api/orders/"+id,{method:"PATCH",headers:{...H(),"Content-Type":"application/json"},body:JSON.stringify({status:v})});load()}form.onsubmit=async e=>{e.preventDefault();let fd=new FormData(form);let r=await fetch("/api/products",{method:"POST",headers:H(),body:fd});if(!r.ok){alert("Erreur ajout");return}form.reset();load()}</script></body></html>`;
app.use("/uploads", express.static(uploadDir));
app.get("/admin.html",(req,res)=>res.type("html").send(ADMIN_HTML));
app.get("*",(req,res)=>res.type("html").send(SHOP_HTML));
app.listen(PORT,()=>console.log("Ghir9elbl7aba running on "+PORT));
