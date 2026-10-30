// PrintQR server: website, accounts, keys, shops, print jobs. Zero dependencies (Node 18+).
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');

// Load environment variables from .env file if available
[path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')].some(f => {
  if (fs.existsSync(f)) {
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
      if (m && !m[1].startsWith('#')) {
        let v = (m[2] || '').trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    });
    return true;
  }
  return false;
});

const PORT=process.env.PORT||3000;
// ---- RAZORPAY: set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET (+ RAZORPAY_WEBHOOK_SECRET) in .env to turn on real payments ----
const RZP_ID=process.env.RAZORPAY_KEY_ID||'',RZP_SECRET=process.env.RAZORPAY_KEY_SECRET||'',RZP_WH=process.env.RAZORPAY_WEBHOOK_SECRET||'';
const RZP_ON=!!(RZP_ID&&RZP_SECRET),RZP_TEST=RZP_ID.startsWith('rzp_test_');
const FEE_PCT=Math.max(0,Math.min(50,Number(process.env.PLATFORM_FEE_PERCENT)||0)); // your cut of each print payment
const rzp=async(method,url,payload,idem)=>{
  const r=await fetch('https://api.razorpay.com'+url,{method,headers:{'Content-Type':'application/json',Authorization:'Basic '+Buffer.from(RZP_ID+':'+RZP_SECRET).toString('base64'),...(idem?{'Idempotency-Key':idem}:{})},body:payload?JSON.stringify(payload):undefined});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error((j.error&&j.error.description)||'Razorpay error '+r.status);return j;
};
const hmac=(s,k)=>crypto.createHmac('sha256',k).update(s).digest('hex');
const same=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const sigOk=b=>!!(b.razorpay_order_id&&b.razorpay_payment_id&&same(hmac(b.razorpay_order_id+'|'+b.razorpay_payment_id,RZP_SECRET),b.razorpay_signature||''));
console.log(RZP_ON?'Razorpay ON ('+(RZP_TEST?'TEST':'LIVE')+' mode)':'NOTE: Razorpay keys not set - payments are SIMULATED (testing only).');
// ---- EDIT YOUR PRICES (INR) ----
const DUR={demo:48*36e5,'3m':90*864e5,'6m':180*864e5,'12m':365*864e5};
const NAMES={demo:'48-hour demo','3m':'3 months','6m':'6 months','12m':'12 months'};
const DBF=path.join(__dirname,'data.json'),UP=path.join(__dirname,'uploads'),PUB=path.join(__dirname,'public');
fs.mkdirSync(UP,{recursive:true});
let db={users:[],sessions:{},keys:[],shops:[],jobs:[],orders:[]};
try{db=Object.assign(db,JSON.parse(fs.readFileSync(DBF)))}catch(e){}
const save=()=>fs.writeFileSync(DBF,JSON.stringify(db,null,1));
const rid=n=>crypto.randomBytes(n).toString('hex');
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
// Plan prices (INR). Admin can change them from the admin dashboard.
db.settings=db.settings||{};
const PRICES=db.settings.prices=Object.assign({'3m':999,'6m':1799,'12m':2999},db.settings.prices||{});
// Admin account management: strictly synchronized with .env credentials.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD !== undefined ? String(process.env.ADMIN_PASSWORD).trim() : '';

if (ADMIN_EMAIL && ADMIN_PASSWORD) {
  let adminUser = db.users.find(x => x.isAdmin || x.email === ADMIN_EMAIL);
  if (!adminUser) {
    adminUser = { id: rid(6), name: 'Admin', email: ADMIN_EMAIL, demoUsed: true, isAdmin: true };
    db.users.push(adminUser);
  }
  adminUser.email = ADMIN_EMAIL;
  adminUser.isAdmin = true;
  adminUser.salt = rid(8);
  adminUser.hash = hash(ADMIN_PASSWORD, adminUser.salt);
  save();
  console.log('Admin account locked to .env credentials: ' + ADMIN_EMAIL);
} else if (!db.users.find(x => x.isAdmin)) {
  const salt = rid(8), em = 'admin@printqr.local', pw = 'admin123';
  db.users.push({ id: rid(6), name: 'Admin', email: em, salt, hash: hash(pw, salt), demoUsed: true, isAdmin: true });
  save();
}
const body=req=>new Promise((ok,no)=>{let c=[],n=0;req.on('data',d=>{n+=d.length;if(n>40e6){no(new Error('File too large'));req.destroy();return}c.push(d)});req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(c).toString()||'{}'))}catch(e){ok({})}})});
const live=k=>k&&k.expiresAt&&Date.now()<k.expiresAt;
const shopActive=s=>live(db.keys.find(k=>k.key===s.keyId));
const pub=s=>({id:s.id,name:s.name,mode:s.mode,defaults:s.defaults,rates:s.rates,upi:s.upi,active:shopActive(s)});
const full=s=>({...pub(s),slots:s.slots,ownerName:s.ownerName||'',phone:s.phone||'',payoutReady:!!s.linkedAccountId});
function newKey(userId,plan,price,extra){const k={key:'PQR-'+[0,1,2].map(()=>rid(2).toUpperCase()).join('-'),userId,plan,price,createdAt:Date.now(),...extra};db.keys.push(k);return k}
async function createOrder(o,receipt,transfers){
  try{
    const r=await rzp('POST','/v1/orders',{amount:o.amount,currency:'INR',receipt,notes:{kind:o.kind},...(transfers?{transfers}:{})});
    o.id=r.id;db.orders.push(o);save();return{id:r.id,amount:o.amount,currency:'INR'};
  }catch(e){
    if(transfers&&(e.message||'').toLowerCase().includes('route')){
      console.warn('[Razorpay Route Warning] Retrying without transfers:', e.message);
      const r=await rzp('POST','/v1/orders',{amount:o.amount,currency:'INR',receipt,notes:{kind:o.kind}});
      o.id=r.id;db.orders.push(o);save();return{id:r.id,amount:o.amount,currency:'INR'};
    }
    throw e;
  }
}
// Safe to call twice (browser verify + webhook): the second call does nothing.
function settleOrder(o,paymentId){
  if(o.status==='paid')return;
  if(o.kind==='plan'){const k=newKey(o.userId,o.plan,o.amount/100,{paymentId});o.keyId=k.key}
  else{const j=db.jobs.find(x=>x.id===o.jobId);if(j&&j.status==='created')j.status='paid'}
  o.status='paid';o.paymentId=paymentId;save();
}
async function webhook(req,res){
  const c=[];for await(const d of req)c.push(d);const raw=Buffer.concat(c);
  if(!RZP_WH||!same(hmac(raw,RZP_WH),req.headers['x-razorpay-signature']||'')){res.writeHead(400);return res.end('bad signature')}
  try{const ev=JSON.parse(raw.toString());
    if(ev.event==='payment.captured'||ev.event==='order.paid'){
      const pay=ev.payload.payment&&ev.payload.payment.entity,o=pay&&db.orders.find(x=>x.id===pay.order_id);
      if(o&&pay.amount===o.amount)settleOrder(o,pay.id);
    }
  }catch(e){}
  res.writeHead(200);res.end('ok');
}
function count(range,total){if(!range)return total;const set=new Set();range.split(',').forEach(p=>{const m=p.trim().match(/^(\d+)(?:-(\d+))?$/);if(!m)return;let a=+m[1],b=+(m[2]||m[1]);for(let i=a;i<=Math.min(b,total);i++)if(i>0)set.add(i)});return set.size||total}
const ext={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.zip':'application/zip','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x'),p=u.pathname,m=req.method;
  const J=(o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
  try{
    if((p==='/api/razorpay/webhook'||p==='/api/webhook/razorpay'||(p==='/'&&req.headers['x-razorpay-signature']))&&m==='POST')return webhook(req,res);
    if(p.startsWith('/api/')){
      const b=m==='POST'?await body(req):{};
      const me=db.users.find(x=>x.id===db.sessions[(req.headers.authorization||'').replace('Bearer ','')]);
      const ak=db.keys.find(k=>k.key===(u.searchParams.get('key')||b.key)&&k.shopId&&live(k));
      const ashop=ak&&db.shops.find(s=>s.id===ak.shopId);
      let r;
      if(p==='/api/config')return J({keyId:RZP_ON?RZP_ID:null,test:RZP_TEST});
      if(p==='/api/signup'&&m==='POST'){
        if(!b.name||!/^\S+@\S+\.\S+$/.test(b.email||'')||(b.password||'').length<6)return J({error:'Enter your name, a valid email and a password of 6+ characters.'},400);
        const email=b.email.toLowerCase();
        if(db.users.find(x=>x.email===email))return J({error:'This email already has an account. Log in instead.'},400);
        const salt=rid(8),usr={id:rid(6),name:b.name,email,salt,hash:hash(b.password,salt),demoUsed:false};
        db.users.push(usr);const t=rid(24);db.sessions[t]=usr.id;save();return J({token:t});
      }
      if(p==='/api/login'&&m==='POST'){
        const email = (b.email || '').trim().toLowerCase();
        const pass = String(b.password || '');

        // If credentials in .env are configured for admin, enforce strictly with .env id and password:
        if (ADMIN_EMAIL && ADMIN_PASSWORD) {
          if (email === ADMIN_EMAIL) {
            // Must match the exact password from .env, NEVER any default or old password
            if (pass !== ADMIN_PASSWORD) {
              return J({ error: 'Email or password is wrong.' }, 401);
            }
            let adminUser = db.users.find(x => x.isAdmin || x.email === ADMIN_EMAIL);
            if (!adminUser) {
              adminUser = { id: rid(6), name: 'Admin', email: ADMIN_EMAIL, salt: rid(8), hash: hash(ADMIN_PASSWORD, rid(8)), demoUsed: true, isAdmin: true };
              db.users.push(adminUser);
            }
            const t = rid(24);
            db.sessions[t] = adminUser.id;
            save();
            return J({ token: t, admin: true });
          }
        }

        const usr = db.users.find(x => x.email === email && !x.isAdmin);
        if (!usr || usr.hash !== hash(pass, usr.salt)) return J({ error: 'Email or password is wrong.' }, 401);
        const t = rid(24);
        db.sessions[t] = usr.id;
        save();
        return J({ token: t, admin: !!usr.isAdmin });
      }
      if(p==='/api/me'){if(!me)return J({error:'Log in first'},401);return J({name:me.name,email:me.email,demoUsed:me.demoUsed,prices:PRICES,names:NAMES})}
      if(p==='/api/buy'&&m==='POST'){
        if(!me)return J({error:'Log in first'},401);
        if(b.plan==='demo'){if(me.demoUsed)return J({error:'You have already used your 48-hour demo.'},400);me.demoUsed=true}
        else if(!PRICES[b.plan])return J({error:'Unknown plan'},400);
        if(b.plan!=='demo'&&RZP_ON){
          // Real payment: the key is created only after Razorpay confirms (/api/buy/verify or the webhook).
          const o={kind:'plan',userId:me.id,plan:b.plan,amount:Math.round(PRICES[b.plan]*100),status:'created',createdAt:Date.now()};
          return J({order:await createOrder(o,'plan_'+rid(4)),keyId:RZP_ID});
        }
        const k=newKey(me.id,b.plan,PRICES[b.plan]||0);save();return J(k); // simulated (no Razorpay keys set)
      }
      if(p==='/api/buy/verify'&&m==='POST'){
        if(!me)return J({error:'Log in first'},401);
        const o=RZP_ON&&db.orders.find(x=>x.id===b.razorpay_order_id&&x.kind==='plan'&&x.userId===me.id);
        if(!o||!sigOk(b))return J({error:'Payment could not be verified.'},400);
        settleOrder(o,b.razorpay_payment_id);return J({key:o.keyId});
      }
      if(p==='/api/keys'){if(!me)return J({error:'Log in first'},401);return J(db.keys.filter(k=>k.userId===me.id).map(k=>({...k,planName:NAMES[k.plan],status:!k.activatedAt?'waiting':live(k)?'active':'expired'})).reverse())}
      if(p==='/api/activate'&&m==='POST'){
        const k=db.keys.find(x=>x.key===(b.key||'').trim().toUpperCase());
        if(!k)return J({error:'This key was not found. Check it and try again.'},400);
        if(k.expiresAt&&Date.now()>=k.expiresAt)return J({error:'This key has expired. Buy a new plan in your dashboard.'},400);
        const usr=db.users.find(x=>x.id===k.userId);
        if(!k.activatedAt){
          k.activatedAt=Date.now();k.expiresAt=k.activatedAt+DUR[k.plan]+(k.extraMs||0);
          const s={id:rid(4),keyId:k.key,name:usr.name+"'s shop",mode:'default',upi:'',rates:{bw:2,color:10},defaults:{color:'bw',copies:1,duplex:false,range:''},slots:{bw:'',color:'',duplex:'',photo:''}};
          db.shops.push(s);k.shopId=s.id;
        }
        save();return J({shop:full(db.shops.find(s=>s.id===k.shopId)),user:{name:usr.name,email:usr.email},plan:NAMES[k.plan],expiresAt:k.expiresAt,key:k.key});
      }
      if(p==='/api/agent/settings'&&m==='POST'){
        if(!ashop)return J({error:'Key not valid'},401);
        ['name','mode','upi','rates','defaults','slots','ownerName','phone'].forEach(f=>{if(b[f]!==undefined)ashop[f]=b[f]});
        // Payout setup: link this shop's UPI ID to Razorpay Route so customer payments go straight to the shop.
        // UPI linked accounts need LIVE keys + VPA Settlements enabled by Razorpay support.
        const sig=[ashop.upi,ashop.ownerName,ashop.phone].join('|');
        if(RZP_ON&&!RZP_TEST&&ashop.upi&&sig!==ashop.rzpFor){
          const nm=(ashop.ownerName||'').trim(),ph=String(ashop.phone||'').replace(/\D/g,'').slice(-10);
          if(nm.length<4||ph.length!==10){save();return J({error:'Enter the name on your UPI account (4+ letters) and your 10-digit mobile number.'},400)}
          const kk=db.keys.find(x=>x.key===ashop.keyId),own=db.users.find(x=>x.id===kk.userId),ref='shop_'+ashop.id+'_'+rid(3);
          try{
            const a=await rzp('POST','/v2/accounts',{type:'route',tnc_accepted:true,reference_id:ref,legal_business_name:nm,business_type:'individual',email:own.email,phone:'+91'+ph,
              settlement_accounts:[{method:'upi',upi:{vpa:ashop.upi,beneficiary_name:nm,currency:'INR',is_default:true}}]},ref);
            ashop.linkedAccountId=a.id;ashop.rzpFor=sig;
          }catch(e){
            console.warn('[Razorpay Route Warning]', e.message);
            // If Route is not yet enabled by Razorpay support, save settings and allow direct collection
            ashop.rzpFor=sig;
            save();
            return J(full(ashop));
          }
        }
        save();return J(full(ashop));
      }
      if(p==='/api/agent/jobs'){
        if(!ashop)return J({error:'Key not valid'},401);
        const out=db.jobs.filter(j=>j.shopId===ashop.id&&j.status==='paid');
        out.forEach(j=>j.status='printing');if(out.length)save();return J(out);
      }
      if((r=p.match(/^\/api\/agent\/file\/(\w+)$/))){
        if(!ashop)return J({error:'Key not valid'},401);
        const j=db.jobs.find(x=>x.id===r[1]&&x.shopId===ashop.id);if(!j)return J({error:'No job'},404);
        res.writeHead(200,{'Content-Type':'application/pdf'});return res.end(fs.readFileSync(path.join(UP,j.id+'.pdf')));
      }
      if((r=p.match(/^\/api\/agent\/jobs\/(\w+)$/))&&m==='POST'){
        if(!ashop)return J({error:'Key not valid'},401);
        const j=db.jobs.find(x=>x.id===r[1]&&x.shopId===ashop.id);if(j){j.status=b.status==='printed'?'printed':'failed';save()}return J({ok:1});
      }
      if((r=p.match(/^\/api\/shop\/(\w+)$/))){const s=db.shops.find(x=>x.id===r[1]);return s?J(pub(s)):J({error:'Shop not found'},404)}
      if((r=p.match(/^\/api\/shop\/(\w+)\/jobs$/))&&m==='POST'){
        const s=db.shops.find(x=>x.id===r[1]);
        if(!s||!shopActive(s))return J({error:'This shop is offline right now.'},400);
        if(!s.upi)return J({error:'The shop has not set a UPI ID yet.'},400);
        const buf=Buffer.from(b.data||'','base64');
        if(buf.slice(0,4).toString()!=='%PDF')return J({error:'Only PDF files can be printed.'},400);
        const o=s.mode==='locked'?{...s.defaults}:{color:b.options?.color==='col'?'col':'bw',copies:Math.min(99,Math.max(1,parseInt(b.options?.copies)||1)),duplex:!!b.options?.duplex,range:/^[0-9,\-\s]*$/.test(b.options?.range||'')?(b.options.range||''):''};
        const total=Math.max(1,parseInt(b.pages)||1),n=count(o.range,total);
        const j={id:rid(5),shopId:s.id,filename:String(b.filename||'file.pdf').slice(0,80),options:o,pages:n,amount:n*o.copies*(o.color==='col'?s.rates.color:s.rates.bw),status:'created',createdAt:Date.now()};
        fs.writeFileSync(path.join(UP,j.id+'.pdf'),buf);db.jobs.push(j);save();return J({id:j.id,amount:j.amount,pages:n});
      }
      if((r=p.match(/^\/api\/jobs\/(\w+)$/))){const j=db.jobs.find(x=>x.id===r[1]);return j?J({status:j.status,amount:j.amount}):J({error:'No job'},404)}
      if((r=p.match(/^\/api\/jobs\/(\w+)\/pay$/))&&m==='POST'){
        const j=db.jobs.find(x=>x.id===r[1]);if(!j)return J({error:'No job'},404);
        if(RZP_ON){
          // Real payment: create a Razorpay order whose money is split to the shop's linked UPI account.
          if(j.status!=='created')return J({status:j.status});
          const s=db.shops.find(x=>x.id===j.shopId),paise=Math.round(j.amount*100);let transfers;
          if(!RZP_TEST && s && s.linkedAccountId){
            transfers=[{account:s.linkedAccountId,amount:paise-Math.round(paise*FEE_PCT/100),currency:'INR',notes:{job:j.id}}];
          }
          const o={kind:'job',jobId:j.id,amount:paise,status:'created',createdAt:Date.now()};
          return J({order:await createOrder(o,'job_'+j.id,transfers),keyId:RZP_ID,shopName:s&&s.name});
        }
        // PAYMENT NOTE: simulated mode only (no Razorpay keys). Trusts the customer's "I've paid" tap.
        if(j.status==='created'){j.status='paid';save()}return J({status:j.status});
      }
      if((r=p.match(/^\/api\/jobs\/(\w+)\/verify$/))&&m==='POST'){
        const o=RZP_ON&&db.orders.find(x=>x.id===b.razorpay_order_id&&x.kind==='job'&&x.jobId===r[1]);
        if(!o||!sigOk(b))return J({error:'Payment could not be verified.'},400);
        settleOrder(o,b.razorpay_payment_id);return J({status:'paid'});
      }
      if(p.startsWith('/api/admin/')){
        if(!me||!me.isAdmin)return J({error:'Admin only'},403);
        const st=k=>!k.activatedAt?'waiting':live(k)?'active':'expired';
        const email=i=>(db.users.find(x=>x.id===i)||{}).email||'';
        if(p==='/api/admin/data'){
          const printed=db.jobs.filter(j=>j.status==='printed');
          return J({
            prices:PRICES,
            stats:{users:db.users.filter(x=>!x.isAdmin).length,keys:db.keys.length,activeKeys:db.keys.filter(k=>st(k)==='active').length,shops:db.shops.length,jobs:printed.length,sales:db.keys.reduce((a,k)=>a+(k.price||0),0),volume:printed.reduce((a,j)=>a+j.amount,0)},
            users:db.users.map(x=>({id:x.id,name:x.name,email:x.email,isAdmin:!!x.isAdmin,demoUsed:x.demoUsed,keys:db.keys.filter(k=>k.userId===x.id).length})),
            keys:db.keys.map(k=>({key:k.key,plan:k.plan,planName:NAMES[k.plan],email:email(k.userId),price:k.price||0,status:st(k),createdAt:k.createdAt,expiresAt:k.expiresAt})).reverse(),
            shops:db.shops.map(s=>{const k=db.keys.find(x=>x.key===s.keyId);return{id:s.id,name:s.name,owner:k?email(k.userId):'',mode:s.mode,upi:s.upi,active:shopActive(s),jobs:db.jobs.filter(j=>j.shopId===s.id&&j.status==='printed').length}}),
            jobs:db.jobs.slice(-100).reverse().map(j=>({id:j.id,shop:(db.shops.find(s=>s.id===j.shopId)||{}).name,filename:j.filename,pages:j.pages,amount:j.amount,status:j.status,createdAt:j.createdAt}))
          });
        }
        if(p==='/api/admin/issue'&&m==='POST'){
          const usr=db.users.find(x=>x.email===(b.email||'').trim().toLowerCase());
          if(!usr)return J({error:'No user has that email.'},400);
          if(!DUR[b.plan])return J({error:'Unknown plan'},400);
          const k={key:'PQR-'+[0,1,2].map(()=>rid(2).toUpperCase()).join('-'),userId:usr.id,plan:b.plan,price:0,createdAt:Date.now(),extraMs:Math.max(0,parseInt(b.days)||0)*864e5};
          db.keys.push(k);save();return J(k);
        }
        if(p==='/api/admin/key'&&m==='POST'){
          const k=db.keys.find(x=>x.key===b.key);if(!k)return J({error:'Key not found'},404);
          if(b.action==='revoke'){k.activatedAt=k.activatedAt||Date.now();k.expiresAt=Date.now()}
          else if(b.action==='extend'){const d=(parseInt(b.days)||30)*864e5;if(k.expiresAt)k.expiresAt=Math.max(k.expiresAt,Date.now())+d;else k.extraMs=(k.extraMs||0)+d}
          else return J({error:'Unknown action'},400);
          save();return J({ok:1});
        }
        if(p==='/api/admin/prices'&&m==='POST'){
          ['3m','6m','12m'].forEach(x=>{const v=Number(b.prices&&b.prices[x]);if(isFinite(v)&&v>=0)PRICES[x]=v});
          save();return J(PRICES);
        }
        return J({error:'Not found'},404);
      }
      return J({error:'Not found'},404);
    }
    let f=path.join(PUB,path.normalize(p==='/'?'/index.html':p));
    if(!f.startsWith(PUB)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);return res.end('Not found')}
    res.writeHead(200,{'Content-Type':ext[path.extname(f)]||'application/octet-stream'});res.end(fs.readFileSync(f));
  }catch(e){J({error:e.message},500)}
}).listen(PORT,()=>console.log('PrintQR server running at http://localhost:'+PORT));
