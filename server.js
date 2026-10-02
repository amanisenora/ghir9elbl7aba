const express=require('express');
const multer=require('multer');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const app=express();
const PORT=process.env.PORT||10000;
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'CHANGE-ME';
const ROOT=__dirname;
const DATA=path.join(ROOT,'data','store.json');
const UP=path.join(ROOT,'public','uploads');
fs.mkdirSync(path.dirname(DATA),{recursive:true}); fs.mkdirSync(UP,{recursive:true});
function read(){try{return JSON.parse(fs.readFileSync(DATA,'utf8'))}catch{return {products:[],orders:[]}}}
function write(d){fs.writeFileSync(DATA,JSON.stringify(d,null,2))}
function admin(req,res,next){if(req.headers['x-admin-password']!==ADMIN_PASSWORD)return res.status(401).json({error:'Unauthorized'});next()}
const storage=multer.diskStorage({destination:UP,filename:(req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(null,Date.now()+'-'+crypto.randomBytes(4).toString('hex')+ext)}});
const upload=multer({storage,limits:{fileSize:8*1024*1024},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))});
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true}));
app.use('/uploads',express.static(UP));
app.use(express.static(path.join(ROOT,'public')));
app.get('/api/products',(req,res)=>{const d=read();res.json(d.products.filter(p=>p.active!==false && p.stock>0))});
app.post('/api/products',admin,upload.single('image'),(req,res)=>{const d=read();const {brand='',name='',category='Other',size='Unique',price,stock,description=''}=req.body;if(!name||price===undefined||stock===undefined)return res.status(400).json({error:'name, price and stock are required'});const p={id:crypto.randomUUID(),brand,name,category,size,price:Number(price),stock:Number(stock),description,image:req.file?'/uploads/'+req.file.filename:'',active:true,createdAt:new Date().toISOString()};d.products.unshift(p);write(d);res.json(p)});
app.patch('/api/products/:id',admin,upload.single('image'),(req,res)=>{const d=read();const p=d.products.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({error:'Not found'});for(const k of ['brand','name','category','size','description'])if(req.body[k]!==undefined)p[k]=req.body[k];for(const k of ['price','stock'])if(req.body[k]!==undefined)p[k]=Number(req.body[k]);if(req.body.active!==undefined)p.active=req.body.active!=='false';if(req.file)p.image='/uploads/'+req.file.filename;write(d);res.json(p)});
app.delete('/api/products/:id',admin,(req,res)=>{const d=read();const i=d.products.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'Not found'});d.products.splice(i,1);write(d);res.json({ok:true})});
app.post('/api/orders',(req,res)=>{const {customerName,phone,wilaya,commune,address,delivery,items}=req.body;if(!customerName||!phone||!wilaya||!items?.length)return res.status(400).json({error:'Missing customer information'});const d=read();let total=0;const clean=[];for(const it of items){const p=d.products.find(x=>x.id===it.id&&x.active!==false);const qty=Math.max(1,Number(it.qty||1));if(!p||p.stock<qty)return res.status(409).json({error:`Stock unavailable for ${p?.name||'item'}`});total+=p.price*qty;clean.push({productId:p.id,name:p.name,size:p.size,price:p.price,qty})}for(const it of clean){const p=d.products.find(x=>x.id===it.productId);p.stock-=it.qty}const order={id:crypto.randomUUID(),orderNo:'GHL-'+Date.now().toString().slice(-7),customerName,phone,wilaya,commune:commune||'',address:address||'',delivery:delivery||'home',total,items:clean,status:'new',createdAt:new Date().toISOString()};d.orders.unshift(order);write(d);res.json({ok:true,orderNo:order.orderNo,total})});
app.get('/api/orders',admin,(req,res)=>res.json(read().orders));
app.patch('/api/orders/:id',admin,(req,res)=>{const d=read();const o=d.orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'Not found'});if(req.body.status)o.status=req.body.status;write(d);res.json(o)});
app.get('/api/stats',admin,(req,res)=>{const d=read();res.json({products:d.products.length,inStock:d.products.reduce((s,p)=>s+Number(p.stock||0),0),orders:d.orders.length,newOrders:d.orders.filter(o=>o.status==='new').length,sales:d.orders.filter(o=>o.status!=='cancelled').reduce((s,o)=>s+o.total,0)})});
app.get('/health',(req,res)=>res.json({ok:true}));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.listen(PORT,()=>console.log('Ghir9elbl7aba running on '+PORT));
