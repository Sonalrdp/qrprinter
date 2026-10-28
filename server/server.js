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
        if (process.env[m[1]] === undefined) process.env[m[1]] = v;
      }
    });
    return true;
  }
  return false;
});

const PORT=process.env.PORT||3000;
// ---- EDIT YOUR PRICES (INR) ----
const DUR={demo:48*36e5,'3m':90*864e5,'6m':180*864e5,'12m':365*864e5};
const NAMES={demo:'48-hour demo','3m':'3 months','6m':'6 months','12m':'12 months'};
const DBF=path.join(__dirname,'data.json'),UP=path.join(__dirname,'uploads'),PUB=path.join(__dirname,'public');
fs.mkdirSync(UP,{recursive:true});
let db={users:[],sessions:{},keys:[],shops:[],jobs:[]};
try{db=Object.assign(db,JSON.parse(fs.readFileSync(DBF)))}catch(e){}
const save=()=>fs.writeFileSync(DBF,JSON.stringify(db,null,1));
const rid=n=>crypto.randomBytes(n).toString('hex');
const hash=(p,s)=>crypto.scryptSync(p,s,32).toString('hex');
// Plan prices (INR). Admin can change them from the admin dashboard.
db.settings=db.settings||{};
const PRICES=db.settings.prices=Object.assign({'3m':999,'6m':1799,'12m':2999},db.settings.prices||{});
// Admin account. Set ADMIN_EMAIL and ADMIN_PASSWORD before first start.
if(!db.users.find(x=>x.isAdmin)){
  const salt=rid(8),em=(process.env.ADMIN_EMAIL||'admin@printqr.local').toLowerCase(),pw=process.env.ADMIN_PASSWORD||'admin123';
  db.users.push({id:rid(6),name:'Admin',email:em,salt,hash:hash(pw,salt),demoUsed:true,isAdmin:true});save();
  console.log('Admin account created: '+em+(process.env.ADMIN_PASSWORD?'':'  password: admin123  (CHANGE THIS: set ADMIN_PASSWORD and delete data.json)'));
}
const body=req=>new Promise((ok,no)=>{let c=[],n=0;req.on('data',d=>{n+=d.length;if(n>40e6){no(new Error('File too large'));req.destroy();return}c.push(d)});req.on('end',()=>{try{ok(JSON.parse(Buffer.concat(c).toString()||'{}'))}catch(e){ok({})}})});
const live=k=>k&&k.expiresAt&&Date.now()<k.expiresAt;
const shopActive=s=>live(db.keys.find(k=>k.key===s.keyId));
const pub=s=>({id:s.id,name:s.name,mode:s.mode,defaults:s.defaults,rates:s.rates,upi:s.upi,active:shopActive(s)});
const full=s=>({...pub(s),slots:s.slots});
function count(range,total){if(!range)return total;const set=new Set();range.split(',').forEach(p=>{const m=p.trim().match(/^(\d+)(?:-(\d+))?$/);if(!m)return;let a=+m[1],b=+(m[2]||m[1]);for(let i=a;i<=Math.min(b,total);i++)if(i>0)set.add(i)});return set.size||total}
const ext={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.zip':'application/zip','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x'),p=u.pathname,m=req.method;
  const J=(o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
  try{
    if(p.startsWith('/api/')){
      const b=m==='POST'?await body(req):{};
      const me=db.users.find(x=>x.id===db.sessions[(req.headers.authorization||'').replace('Bearer ','')]);
      const ak=db.keys.find(k=>k.key===(u.searchParams.get('key')||b.key)&&k.shopId&&live(k));
      const ashop=ak&&db.shops.find(s=>s.id===ak.shopId);
      let r;
      if(p==='/api/signup'&&m==='POST'){
        if(!b.name||!/^\S+@\S+\.\S+$/.test(b.email||'')||(b.password||'').length<6)return J({error:'Enter your name, a valid email and a password of 6+ characters.'},400);
        const email=b.email.toLowerCase();
        if(db.users.find(x=>x.email===email))return J({error:'This email already has an account. Log in instead.'},400);
        const salt=rid(8),usr={id:rid(6),name:b.name,email,salt,hash:hash(b.password,salt),demoUsed:false};
        db.users.push(usr);const t=rid(24);db.sessions[t]=usr.id;save();return J({token:t});
      }
      if(p==='/api/login'&&m==='POST'){
        const usr=db.users.find(x=>x.email===(b.email||'').toLowerCase());
        if(!usr||usr.hash!==hash(b.password||'',usr.salt))return J({error:'Email or password is wrong.'},401);
        const t=rid(24);db.sessions[t]=usr.id;save();return J({token:t,admin:!!usr.isAdmin});
      }
      if(p==='/api/me'){if(!me)return J({error:'Log in first'},401);return J({name:me.name,email:me.email,demoUsed:me.demoUsed,prices:PRICES,names:NAMES})}
      if(p==='/api/buy'&&m==='POST'){
        if(!me)return J({error:'Log in first'},401);
        if(b.plan==='demo'){if(me.demoUsed)return J({error:'You have already used your 48-hour demo.'},400);me.demoUsed=true}
        else if(!PRICES[b.plan])return J({error:'Unknown plan'},400);
        // PAYMENT NOTE: add your payment gateway check here before creating the key.
        const k={key:'PQR-'+[0,1,2].map(()=>rid(2).toUpperCase()).join('-'),userId:me.id,plan:b.plan,price:PRICES[b.plan]||0,createdAt:Date.now()};
        db.keys.push(k);save();return J(k);
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
        ['name','mode','upi','rates','defaults','slots'].forEach(f=>{if(b[f]!==undefined)ashop[f]=b[f]});
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
        // PAYMENT NOTE: this trusts the customer's "I've paid" tap. Replace with a gateway webhook (Razorpay, Cashfree...) before real use.
        const j=db.jobs.find(x=>x.id===r[1]);if(!j)return J({error:'No job'},404);
        if(j.status==='created'){j.status='paid';save()}return J({status:j.status});
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
