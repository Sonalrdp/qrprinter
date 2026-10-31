// PrintQR server: website, accounts, keys, shops, print jobs. Zero dependencies (Node 18+).
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');

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
const GS_URL=(process.env.GOOGLE_SCRIPT_URL||'https://script.google.com/macros/s/AKfycbwMLzEq4MJ4wCabzpo80mbiH7UnpmoZO7X3DiSCEytiH15kXvitAtttuhTjg1fQUE7v/exec').trim();

// In-memory OTP storage: key = email or phone, val = { otp, expiresAt } (1 minute expiry)
const otpStore=new Map();
const createOTP=k=>{const o=String(Math.floor(100000+Math.random()*900000));otpStore.set(k,{otp:o,expiresAt:Date.now()+6e4});return o};
const verifyOTPLocal=(k,o)=>{const e=otpStore.get(k);if(!e)return false;if(Date.now()>e.expiresAt){otpStore.delete(k);return false}if(e.otp===String(o).trim()){otpStore.delete(k);return true}return false};

const syncToGoogleScript=async(action,payload)=>{
  if(!GS_URL)return null;
  try{
    const r=await fetch(GS_URL,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action,...payload}),
      redirect:'follow'
    });
    return await r.json().catch(()=>({}));
  }catch(e){
    console.warn('[Google Script Sync Warning]', e.message);
    return null;
  }
};

function getShopRzpKeys(shop){
  if(shop){
    if(shop.rzpKeyId&&shop.rzpKeySecret){
      return {keyId:shop.rzpKeyId,keySecret:shop.rzpKeySecret,webhookSecret:shop.rzpWebhookSecret||''};
    }
    const k=db.keys.find(x=>x.key===shop.keyId);
    const u=k&&db.users.find(x=>x.id===k.userId);
    if(u&&u.rzpKeyId&&u.rzpKeySecret){
      return {keyId:u.rzpKeyId,keySecret:u.rzpKeySecret,webhookSecret:u.rzpWebhookSecret||''};
    }
  }
  if(RZP_ON){
    return {keyId:RZP_ID,keySecret:RZP_SECRET,webhookSecret:RZP_WH};
  }
  return null;
}

const rzpWithKeys=async(method,url,payload,idem,keys)=>{
  const kId=(keys&&keys.keyId)||RZP_ID;
  const kSec=(keys&&keys.keySecret)||RZP_SECRET;
  if(!kId||!kSec)throw new Error('Razorpay keys not configured');
  const auth='Basic '+Buffer.from(kId+':'+kSec).toString('base64');
  const r=await fetch('https://api.razorpay.com'+url,{
    method,
    headers:{'Content-Type':'application/json',Authorization:auth,...(idem?{'Idempotency-Key':idem}:{})},
    body:payload?JSON.stringify(payload):undefined
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error((j.error&&j.error.description)||'Razorpay error '+r.status);
  return j;
};
const rzp=(method,url,payload,idem)=>rzpWithKeys(method,url,payload,idem,null);

const hmac=(s,k)=>crypto.createHmac('sha256',k).update(s).digest('hex');
const same=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const sigOk=(b,sec)=>{
  const k=sec||RZP_SECRET;
  return !!(k&&b.razorpay_order_id&&b.razorpay_payment_id&&b.razorpay_signature&&same(hmac(b.razorpay_order_id+'|'+b.razorpay_payment_id,k),b.razorpay_signature));
};
const sigOkRaw=(rawBuf,sig,sec)=>!!(sec&&sig&&same(hmac(rawBuf,sec),sig));
console.log(RZP_ON?'Razorpay ON ('+(RZP_TEST?'TEST':'LIVE')+' mode)':'NOTE: Platform Razorpay keys not set - users can still use their own keys.');
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
const pub=s=>({id:s.id,name:s.name,mode:s.mode,defaults:s.defaults,rates:s.rates,upi:s.upi,active:shopActive(s),hasCustomRzp:!!(s.rzpKeyId&&s.rzpKeySecret)});
const full=s=>({...pub(s),slots:s.slots,ownerName:s.ownerName||'',phone:s.phone||'',payoutReady:!!(s.linkedAccountId||(s.rzpKeyId&&s.rzpKeySecret)),rzpKeyId:s.rzpKeyId||'',hasRzpSecret:!!s.rzpKeySecret,rzpWebhookSecret:s.rzpWebhookSecret||''});
function newKey(userId,plan,price,extra){
  const k={key:'PQR-'+[0,1,2].map(()=>rid(2).toUpperCase()).join('-'),userId,plan,price,createdAt:Date.now(),...extra};
  db.keys.push(k);
  const u=db.users.find(x=>x.id===userId);
  syncToGoogleScript('add_key',{key:{...k,userEmail:u?u.email:'',planName:NAMES[plan]}});
  return k;
}
async function createOrder(o,receipt,transfers,keys){
  const activeKeys=keys||(RZP_ON?{keyId:RZP_ID,keySecret:RZP_SECRET}:null);
  try{
    const r=await rzpWithKeys('POST','/v1/orders',{amount:o.amount,currency:'INR',receipt,notes:{kind:o.kind},...(transfers?{transfers}:{})},undefined,activeKeys);
    o.id=r.id;
    if(activeKeys){o.rzpKeyId=activeKeys.keyId;o.rzpKeySecret=activeKeys.keySecret;}
    db.orders.push(o);save();return{id:r.id,amount:o.amount,currency:'INR'};
  }catch(e){
    if(transfers&&(e.message||'').toLowerCase().includes('route')){
      console.warn('[Razorpay Route Warning] Retrying without transfers:', e.message);
      const r=await rzpWithKeys('POST','/v1/orders',{amount:o.amount,currency:'INR',receipt,notes:{kind:o.kind}},undefined,activeKeys);
      o.id=r.id;
      if(activeKeys){o.rzpKeyId=activeKeys.keyId;o.rzpKeySecret=activeKeys.keySecret;}
      db.orders.push(o);save();return{id:r.id,amount:o.amount,currency:'INR'};
    }
    throw e;
  }
}
// Safe to call twice (browser verify + webhook): the second call does nothing.
function settleOrder(o,paymentId){
  if(o.status==='paid')return;
  if(o.kind==='plan'){const k=newKey(o.userId,o.plan,o.amount/100,{paymentId});o.keyId=k.key}
  else{const j=db.jobs.find(x=>x.id===o.jobId);if(j&&j.status==='created'){j.status='paid';syncToGoogleScript('update_print_job',{id:j.id,status:'paid'})}}
  o.status='paid';o.paymentId=paymentId;save();
}
async function webhook(req,res){
  const c=[];for await(const d of req)c.push(d);const raw=Buffer.concat(c);
  const sig=req.headers['x-razorpay-signature']||'';
  let ev;try{ev=JSON.parse(raw.toString())}catch(e){res.writeHead(400);return res.end('invalid json')}
  let verified=false;
  if(RZP_WH&&sigOkRaw(raw,sig,RZP_WH))verified=true;
  const pay=ev.payload&&ev.payload.payment&&ev.payload.payment.entity;
  const o=pay&&pay.order_id&&db.orders.find(x=>x.id===pay.order_id);
  if(!verified&&o){
    const j=o.jobId&&db.jobs.find(x=>x.id===o.jobId);
    const s=j&&db.shops.find(x=>x.id===j.shopId);
    const keys=getShopRzpKeys(s);
    if(keys?.webhookSecret&&sigOkRaw(raw,sig,keys.webhookSecret))verified=true;
    else if(keys?.keySecret&&sigOkRaw(raw,sig,keys.keySecret))verified=true;
    else if(o.rzpKeySecret&&sigOkRaw(raw,sig,o.rzpKeySecret))verified=true;
  }
  if(!verified&&sig){
    for(const u of db.users){
      if(u.rzpWebhookSecret&&sigOkRaw(raw,sig,u.rzpWebhookSecret)){verified=true;break}
      if(u.rzpKeySecret&&sigOkRaw(raw,sig,u.rzpKeySecret)){verified=true;break}
    }
  }
  if(!verified&&(RZP_WH||(o&&(o.rzpKeySecret||o.rzpKeyId)))){
    res.writeHead(400);return res.end('bad signature');
  }
  try{
    if(ev.event==='payment.captured'||ev.event==='order.paid'){
      if(o&&pay&&pay.amount===o.amount)settleOrder(o,pay.id);
    }
  }catch(e){}
  res.writeHead(200);res.end('ok');
}
function count(range,total){if(!range)return total;const set=new Set();range.split(',').forEach(p=>{const m=p.trim().match(/^(\d+)(?:-(\d+))?$/);if(!m)return;let a=+m[1],b=+(m[2]||m[1]);for(let i=a;i<=Math.min(b,total);i++)if(i>0)set.add(i)});return set.size||total}
const ext={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.zip':'application/zip','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};

function makeZipBuffer(files){
  const parts=[],cdParts=[];let offset=0;
  for(const f of files){
    const nameBuf=Buffer.from(f.name);
    const dataBuf=Buffer.isBuffer(f.data)?f.data:Buffer.from(f.data);
    const crc=zlib.crc32(dataBuf);
    const comp=zlib.deflateRawSync(dataBuf);
    const useComp=comp.length<dataBuf.length;
    const finalData=useComp?comp:dataBuf;
    const method=useComp?8:0;

    const lh=Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0);
    lh.writeUInt16LE(20,4);
    lh.writeUInt16LE(0,6);
    lh.writeUInt16LE(method,8);
    lh.writeUInt16LE(0,10);
    lh.writeUInt16LE(0,12);
    lh.writeUInt32LE(crc,14);
    lh.writeUInt32LE(finalData.length,18);
    lh.writeUInt32LE(dataBuf.length,22);
    lh.writeUInt16LE(nameBuf.length,26);
    lh.writeUInt16LE(0,28);
    parts.push(lh,nameBuf,finalData);

    const cd=Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50,0);
    cd.writeUInt16LE(20,4);
    cd.writeUInt16LE(20,6);
    cd.writeUInt16LE(0,8);
    cd.writeUInt16LE(method,10);
    cd.writeUInt16LE(0,12);
    cd.writeUInt16LE(0,14);
    cd.writeUInt32LE(crc,16);
    cd.writeUInt32LE(finalData.length,20);
    cd.writeUInt32LE(dataBuf.length,24);
    cd.writeUInt16LE(nameBuf.length,28);
    cd.writeUInt16LE(0,30);
    cd.writeUInt16LE(0,32);
    cd.writeUInt16LE(0,34);
    cd.writeUInt16LE(0,36);
    cd.writeUInt32LE(0,38);
    cd.writeUInt32LE(offset,42);
    cdParts.push(cd,nameBuf);
    offset+=lh.length+nameBuf.length+finalData.length;
  }
  const cdBuf=Buffer.concat(cdParts);
  const eocd=Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0);
  eocd.writeUInt16LE(0,4);
  eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(files.length,8);
  eocd.writeUInt16LE(files.length,10);
  eocd.writeUInt32LE(cdBuf.length,12);
  eocd.writeUInt32LE(offset,16);
  eocd.writeUInt16LE(0,20);
  return Buffer.concat([...parts,cdBuf,eocd]);
}

function buildAgentZip(serverUrl){
  const agentDir=path.join(__dirname,'..','agent');
  const files=[];
  ['package.json','agent.js','ui.html','install-and-run.bat'].forEach(n=>{
    const p=path.join(agentDir,n);
    if(fs.existsSync(p))files.push({name:'PrintQR-Agent/'+n,data:fs.readFileSync(p)});
  });
  files.push({name:'PrintQR-Agent/server_url.txt',data:Buffer.from(serverUrl)});
  files.push({name:'PrintQR-Agent/config.json',data:Buffer.from(JSON.stringify({serverUrl,autoConfigured:true},null,2))});
  return makeZipBuffer(files);
}

function getPublicServerUrl(req,u){
  const originQuery=u&&u.searchParams&&u.searchParams.get('origin');
  if(originQuery&&/^https?:\/\//i.test(originQuery))return originQuery.replace(/\/+$/,'');
  if(process.env.PUBLIC_SERVER_URL)return process.env.PUBLIC_SERVER_URL.replace(/\/+$/,'');
  if(process.env.SERVER_URL)return process.env.SERVER_URL.replace(/\/+$/,'');
  const proto=(req.headers['x-forwarded-proto']||(req.socket.encrypted?'https':'http')).split(',')[0].trim();
  const host=(req.headers['x-forwarded-host']||req.headers.host||('localhost:'+PORT)).split(',')[0].trim();
  return proto+'://'+host;
}

// Update static agent zip on disk at startup
try{
  const dlDir=path.join(PUB,'downloads');
  fs.mkdirSync(dlDir,{recursive:true});
  fs.writeFileSync(path.join(dlDir,'PrintQR-Agent.zip'),buildAgentZip('http://localhost:'+PORT));
}catch(e){}

http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://x'),p=u.pathname,m=req.method;
  const J=(o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
  try{
    if(p==='/downloads/PrintQR-Agent.zip'||p==='/api/download-agent'){
      const srvUrl=getPublicServerUrl(req,u);
      const zipBuf=buildAgentZip(srvUrl);
      res.writeHead(200,{
        'Content-Type':'application/zip',
        'Content-Disposition':'attachment; filename="PrintQR-Agent.zip"',
        'Content-Length':zipBuf.length,
        'Cache-Control':'no-cache, no-store, must-revalidate'
      });
      return res.end(zipBuf);
    }
    if((p==='/api/razorpay/webhook'||p==='/api/webhook/razorpay'||(p==='/'&&req.headers['x-razorpay-signature']))&&m==='POST')return webhook(req,res);
    if(p.startsWith('/api/')){
      const b=m==='POST'?await body(req):{};
      const me=db.users.find(x=>x.id===db.sessions[(req.headers.authorization||'').replace('Bearer ','')]);
      const ak=db.keys.find(k=>k.key===(u.searchParams.get('key')||b.key)&&k.shopId&&live(k));
      const ashop=ak&&db.shops.find(s=>s.id===ak.shopId);
      let r;
      if(p==='/api/config'){
        const sid=u.searchParams.get('shopId');
        const s=sid&&db.shops.find(x=>x.id===sid);
        const keys=getShopRzpKeys(s);
        if(keys)return J({keyId:keys.keyId,test:keys.keyId.startsWith('rzp_test_'),custom:keys.keyId!==RZP_ID});
        return J({keyId:RZP_ON?RZP_ID:null,test:RZP_TEST,custom:false});
      }
      if(p==='/api/user/rzp'&&m==='GET'){
        if(!me)return J({error:'Log in first'},401);
        return J({
          keyId:me.rzpKeyId||'',
          hasSecret:!!me.rzpKeySecret,
          webhookSecret:me.rzpWebhookSecret||'',
          isConfigured:!!(me.rzpKeyId&&me.rzpKeySecret)
        });
      }
      if(p==='/api/user/rzp'&&m==='POST'){
        if(!me)return J({error:'Log in first'},401);
        const keyId=(b.keyId||'').trim();
        const keySecret=(b.keySecret||'').trim();
        const webhookSecret=(b.webhookSecret||'').trim();
        if(!keyId)return J({error:'Please enter your Razorpay Key ID.'},400);
        if(!keyId.startsWith('rzp_live_')&&!keyId.startsWith('rzp_test_')){
          return J({error:'Invalid Key ID. Must start with rzp_live_ or rzp_test_.'},400);
        }
        if(!me.rzpKeySecret&&!keySecret){
          return J({error:'Please enter your Razorpay Key Secret.'},400);
        }
        me.rzpKeyId=keyId;
        if(keySecret)me.rzpKeySecret=keySecret;
        if(webhookSecret!==undefined)me.rzpWebhookSecret=webhookSecret;

        // Sync to all shops owned by this user
        const userKeys=db.keys.filter(k=>k.userId===me.id).map(k=>k.key);
        db.shops.forEach(s=>{
          if(userKeys.includes(s.keyId)){
            s.rzpKeyId=me.rzpKeyId;
            s.rzpKeySecret=me.rzpKeySecret;
            s.rzpWebhookSecret=me.rzpWebhookSecret;
          }
        });
        save();
        syncToGoogleScript('update_rzp',{
          email:me.email,
          rzpKeyId:me.rzpKeyId,
          rzpKeySecret:me.rzpKeySecret,
          rzpWebhookSecret:me.rzpWebhookSecret
        });
        return J({ok:1,isConfigured:true,keyId:me.rzpKeyId,webhookSecret:me.rzpWebhookSecret||''});
      }
      if(p==='/api/otp/send'&&m==='POST'){
        const email=(b.email||'').trim().toLowerCase();
        const phone=String(b.phone||'').trim();
        const name=(b.name||'Valued User').trim();
        const purpose=(b.purpose||'Verification').trim();
        const password=String(b.password||'');
        if(!email&&!phone)return J({error:'Email or mobile number is required.'},400);

        const key=email||phone;
        const otp=createOTP(key);
        if(phone&&email)otpStore.set(phone,{otp,expiresAt:Date.now()+6e4});

        let hashVal='', saltVal='';
        if(password&&password.length>=6){
          saltVal=rid(8);
          hashVal=hash(password,saltVal);
        }

        // Send OTP to email via Google Apps Script MailApp and store user data in Google Sheet Users tab BEFORE OTP verification!
        if(GS_URL&&email){
          const gsRes=await syncToGoogleScript('send_otp',{email,phone,name,purpose,otp,hash:hashVal,salt:saltVal});
          if(gsRes&&!gsRes.ok&&gsRes.error){
            console.warn('[Google Script send_otp error]', gsRes.error);
            return J({error:gsRes.error},400);
          }
        }else{
          console.log(`[OTP NOTICE] Generated OTP ${otp} for ${email||phone} (${purpose})`);
        }
        return J({ok:1,message:'OTP sent to your email.'});
      }
      if(p==='/api/otp/verify'&&m==='POST'){
        const ident=((b.email||b.phone||'').trim()).toLowerCase();
        const enteredOtp=String(b.otp||'').trim();
        if(!ident||!enteredOtp)return J({error:'Enter the OTP.'},400);

        let valid=false;
        if(GS_URL){
          const gsRes=await syncToGoogleScript('verify_otp',{email:b.email,phone:b.phone,otp:enteredOtp});
          if(gsRes&&gsRes.ok)valid=true;
        }
        if(!valid&&verifyOTPLocal(ident,enteredOtp))valid=true;
        if(!valid&&(b.email&&verifyOTPLocal(b.email.toLowerCase(),enteredOtp)))valid=true;
        if(!valid&&(b.phone&&verifyOTPLocal(b.phone,enteredOtp)))valid=true;

        if(!valid)return J({error:'Invalid or expired OTP. Please try again.'},400);
        return J({ok:1,verified:true});
      }
      if(p==='/api/signup'&&m==='POST'){
        if(!b.name||!/^\S+@\S+\.\S+$/.test(b.email||'')||(b.password||'').length<6)return J({error:'Enter your name, a valid email and a password of 6+ characters.'},400);
        const email=b.email.toLowerCase().trim();
        const phone=String(b.phone||'').trim();
        if(!phone||phone.length<10)return J({error:'Please enter a valid 10-digit mobile number.'},400);

        const enteredOtp=String(b.otp||'').trim();
        if(!enteredOtp)return J({error:'Please enter the OTP sent to your email.'},400);

        let otpValid=false;
        if(GS_URL){
          const gsRes=await syncToGoogleScript('verify_otp',{email,phone,otp:enteredOtp});
          if(gsRes&&gsRes.ok)otpValid=true;
        }
        if(!otpValid&&verifyOTPLocal(email,enteredOtp))otpValid=true;
        if(!otpValid&&verifyOTPLocal(phone,enteredOtp))otpValid=true;

        if(!otpValid)return J({error:'Invalid or expired OTP. Please verify and try again.'},400);

        if(db.users.find(x=>x.email===email||(phone&&x.phone===phone)))return J({error:'This email or phone already has an account. Log in instead.'},400);

        const salt=rid(8),usr={id:rid(6),name:b.name.trim(),email,phone,salt,hash:hash(b.password,salt),demoUsed:false,rzpKeyId:'',rzpKeySecret:'',rzpWebhookSecret:''};
        db.users.push(usr);
        const t=rid(24);
        db.sessions[t]=usr.id;
        save();

        // Dual-storage: record user in Google Sheet
        await syncToGoogleScript('signup_user',{user:usr});

        return J({token:t});
      }
      if(p==='/api/forgot-password'&&m==='POST'){
        const ident=(b.identifier||b.email||b.phone||'').trim().toLowerCase();
        const enteredOtp=String(b.otp||'').trim();
        const newPass=String(b.newPassword||'');
        if(!ident)return J({error:'Enter your email or mobile number.'},400);
        if(!enteredOtp)return J({error:'Enter the OTP.'},400);
        if(newPass.length<6)return J({error:'New password must be at least 6 characters.'},400);

        let otpValid=false;
        if(GS_URL){
          const gsRes=await syncToGoogleScript('verify_otp',{email:ident,phone:ident,otp:enteredOtp});
          if(gsRes&&gsRes.ok)otpValid=true;
        }
        if(!otpValid&&verifyOTPLocal(ident,enteredOtp))otpValid=true;

        if(!otpValid)return J({error:'Invalid or expired OTP.'},400);

        let usr=db.users.find(x=>!x.isAdmin&&(x.email===ident||(x.phone&&x.phone===ident)));
        if(!usr&&GS_URL){
          const gsUser=await syncToGoogleScript('get_user',{email:ident,phone:ident});
          if(gsUser&&gsUser.user){
            usr=gsUser.user;
            db.users.push(usr);
          }
        }
        if(!usr)return J({error:'No account found with this email or phone.'},404);

        usr.salt=rid(8);
        usr.hash=hash(newPass,usr.salt);
        save();

        syncToGoogleScript('reset_password',{email:usr.email,phone:usr.phone,hash:usr.hash,salt:usr.salt});
        return J({ok:1,message:'Password reset successful! You can now log in.'});
      }
      if(p==='/api/login'&&m==='POST'){
        const ident = (b.email || b.phone || '').trim().toLowerCase();
        const pass = String(b.password || '');

        // If credentials in .env are configured for admin, enforce strictly with .env id and password:
        if (ADMIN_EMAIL && ADMIN_PASSWORD) {
          if (ident === ADMIN_EMAIL) {
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

        let usr = db.users.find(x => !x.isAdmin && (x.email === ident || (x.phone && x.phone === ident)));
        // Dual-storage fallback: if user not found in local server data, query Google Sheet!
        if (!usr && GS_URL) {
          try {
            const gsUser = await syncToGoogleScript('get_user', { email: ident, phone: ident });
            if (gsUser && gsUser.user) {
              const u = gsUser.user;
              usr = {
                id: u.id || rid(6),
                name: u.name || 'User',
                email: u.email,
                phone: u.phone || '',
                salt: u.salt,
                hash: u.hash,
                demoUsed: !!u.demoUsed,
                rzpKeyId: u.rzpKeyId || '',
                rzpKeySecret: u.rzpKeySecret || '',
                rzpWebhookSecret: u.rzpWebhookSecret || ''
              };
              db.users.push(usr);
              save();
              console.log(`[Dual-Storage Recovery] Restored user ${usr.email} from Google Sheet!`);
            }
          } catch (e) {
            console.warn('[Google Sheet Recovery Error]', e.message);
          }
        }

        if (!usr || usr.hash !== hash(pass, usr.salt)) return J({ error: 'Email or password is wrong.' }, 401);
        const t = rid(24);
        db.sessions[t] = usr.id;
        save();
        return J({ token: t, admin: !!usr.isAdmin });
      }
      if(p==='/api/me'){if(!me)return J({error:'Log in first'},401);return J({name:me.name,email:me.email,demoUsed:me.demoUsed,prices:PRICES,names:NAMES,hasRzp:!!(me.rzpKeyId&&me.rzpKeySecret),rzpKeyId:me.rzpKeyId||''})}
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
      if(p==='/api/user/jobs'){
        if(!me)return J({error:'Log in first'},401);
        const myKeys=db.keys.filter(k=>k.userId===me.id).map(k=>k.key);
        const myShops=db.shops.filter(s=>myKeys.includes(s.keyId));
        const myShopIds=myShops.map(s=>s.id);
        const jobs=db.jobs.filter(j=>myShopIds.includes(j.shopId)).slice(-500).reverse().map(j=>{
          const sh=myShops.find(s=>s.id===j.shopId);
          return {
            id:j.id,
            shopName:sh?sh.name:'',
            filename:j.filename,
            pages:j.pages,
            copies:(j.options&&j.options.copies)||1,
            color:(j.options&&j.options.color)||'bw',
            duplex:!!(j.options&&j.options.duplex),
            amount:j.amount,
            status:j.status,
            createdAt:j.createdAt
          };
        });
        return J(jobs);
      }
      if(p==='/api/activate'&&m==='POST'){
        const k=db.keys.find(x=>x.key===(b.key||'').trim().toUpperCase());
        if(!k)return J({error:'This key was not found. Check it and try again.'},400);
        if(k.expiresAt&&Date.now()>=k.expiresAt)return J({error:'This key has expired. Buy a new plan in your dashboard.'},400);
        const usr=db.users.find(x=>x.id===k.userId);
        if(!k.activatedAt){
          k.activatedAt=Date.now();k.expiresAt=k.activatedAt+DUR[k.plan]+(k.extraMs||0);
          const s={id:rid(4),keyId:k.key,name:usr.name+"'s shop",mode:'default',upi:'',rates:{bw:2,color:10},defaults:{color:'bw',copies:1,duplex:false,range:''},slots:{bw:'',color:'',duplex:'',photo:''},rzpKeyId:usr.rzpKeyId||'',rzpKeySecret:usr.rzpKeySecret||'',rzpWebhookSecret:usr.rzpWebhookSecret||''};
          db.shops.push(s);k.shopId=s.id;
        }else{
          const s=db.shops.find(x=>x.id===k.shopId);
          if(s&&usr&&usr.rzpKeyId&&!s.rzpKeyId){
            s.rzpKeyId=usr.rzpKeyId;s.rzpKeySecret=usr.rzpKeySecret;s.rzpWebhookSecret=usr.rzpWebhookSecret;
          }
        }
        save();return J({shop:full(db.shops.find(s=>s.id===k.shopId)),user:{name:usr.name,email:usr.email},plan:NAMES[k.plan],expiresAt:k.expiresAt,key:k.key});
      }
      if(p==='/api/agent/settings'&&m==='POST'){
        if(!ashop)return J({error:'Key not valid'},401);
        ['name','mode','upi','rates','defaults','slots','ownerName','phone','rzpKeyId','rzpKeySecret','rzpWebhookSecret'].forEach(f=>{if(b[f]!==undefined)ashop[f]=b[f]});
        const kk=db.keys.find(x=>x.key===ashop.keyId),own=kk&&db.users.find(x=>x.id===kk.userId);
        if(own){
          if(b.rzpKeyId)own.rzpKeyId=b.rzpKeyId;
          if(b.rzpKeySecret)own.rzpKeySecret=b.rzpKeySecret;
          if(b.rzpWebhookSecret!==undefined)own.rzpWebhookSecret=b.rzpWebhookSecret;
        }
        const hasOwnKeys=!!(ashop.rzpKeyId&&ashop.rzpKeySecret);
        const sig=[ashop.upi,ashop.ownerName,ashop.phone].join('|');
        if(!hasOwnKeys&&RZP_ON&&!RZP_TEST&&ashop.upi&&sig!==ashop.rzpFor){
          const nm=(ashop.ownerName||'').trim(),ph=String(ashop.phone||'').replace(/\D/g,'').slice(-10);
          if(nm.length>=4&&ph.length===10&&own){
            const ref='shop_'+ashop.id+'_'+rid(3);
            try{
              const a=await rzp('POST','/v2/accounts',{type:'route',tnc_accepted:true,reference_id:ref,legal_business_name:nm,business_type:'individual',email:own.email,phone:'+91'+ph,
                settlement_accounts:[{method:'upi',upi:{vpa:ashop.upi,beneficiary_name:nm,currency:'INR',is_default:true}}]},ref);
              ashop.linkedAccountId=a.id;ashop.rzpFor=sig;
            }catch(e){
              console.warn('[Razorpay Route Warning]', e.message);
              ashop.rzpFor=sig;
            }
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
        const j=db.jobs.find(x=>x.id===r[1]&&x.shopId===ashop.id);
        if(j){j.status=b.status==='printed'?'printed':'failed';save();syncToGoogleScript('update_print_job',{id:j.id,status:j.status});}
        return J({ok:1});
      }
      if(p==='/api/agent/history'){
        if(!ashop)return J({error:'Key not valid'},401);
        const jobs=db.jobs.filter(j=>j.shopId===ashop.id).slice(-500).reverse().map(j=>({
          id:j.id,
          filename:j.filename,
          pages:j.pages,
          copies:(j.options&&j.options.copies)||1,
          color:(j.options&&j.options.color)||'bw',
          duplex:!!(j.options&&j.options.duplex),
          amount:j.amount,
          status:j.status,
          createdAt:j.createdAt
        }));
        return J(jobs);
      }
      if(p==='/api/agent/rzp'&&m==='POST'){
        if(!ashop||!ak)return J({error:'Key not valid'},401);
        const own=db.users.find(x=>x.id===ak.userId);
        const action=b.action||'get';
        if(action==='reset'){
          ashop.rzpKeyId='';
          ashop.rzpKeySecret='';
          ashop.rzpWebhookSecret='';
          if(own){
            own.rzpKeyId='';
            own.rzpKeySecret='';
            own.rzpWebhookSecret='';
            syncToGoogleScript('update_rzp',{email:own.email,rzpKeyId:'',rzpKeySecret:'',rzpWebhookSecret:''});
          }
          save();
          return J({ok:1,keyId:'',hasSecret:false,webhookSecret:'',isConfigured:false,message:'Razorpay credentials reset successfully.'});
        }
        if(action==='update'){
          if(b.keyId!==undefined)ashop.rzpKeyId=(b.keyId||'').trim();
          if(b.keySecret)ashop.rzpKeySecret=(b.keySecret||'').trim();
          if(b.webhookSecret!==undefined)ashop.rzpWebhookSecret=(b.webhookSecret||'').trim();
          if(own){
            if(b.keyId!==undefined)own.rzpKeyId=(b.keyId||'').trim();
            if(b.keySecret)own.rzpKeySecret=(b.keySecret||'').trim();
            if(b.webhookSecret!==undefined)own.rzpWebhookSecret=(b.webhookSecret||'').trim();
            syncToGoogleScript('update_rzp',{email:own.email,rzpKeyId:own.rzpKeyId,rzpKeySecret:own.rzpKeySecret,rzpWebhookSecret:own.rzpWebhookSecret});
          }
          save();
          const kid=ashop.rzpKeyId||(own?own.rzpKeyId:'')||'';
          const hasSec=!!(ashop.rzpKeySecret||(own&&own.rzpKeySecret));
          const wh=ashop.rzpWebhookSecret||(own?own.rzpWebhookSecret:'')||'';
          return J({ok:1,keyId:kid,hasSecret:hasSec,webhookSecret:wh,isConfigured:!!(kid&&hasSec)});
        }
        // action === 'get'
        const kid=ashop.rzpKeyId||(own?own.rzpKeyId:'')||'';
        const hasSec=!!(ashop.rzpKeySecret||(own&&own.rzpKeySecret));
        const wh=ashop.rzpWebhookSecret||(own?own.rzpWebhookSecret:'')||'';
        return J({ok:1,keyId:kid,hasSecret:hasSec,webhookSecret:wh,isConfigured:!!(kid&&hasSec)});
      }
      if((r=p.match(/^\/api\/shop\/(\w+)$/))){const s=db.shops.find(x=>x.id===r[1]);return s?J(pub(s)):J({error:'Shop not found'},404)}
      if((r=p.match(/^\/api\/shop\/(\w+)\/jobs$/))&&m==='POST'){
        const s=db.shops.find(x=>x.id===r[1]);
        if(!s||!shopActive(s))return J({error:'This shop is offline right now.'},400);
        const shopKeys=getShopRzpKeys(s);
        if(!s.upi&&!shopKeys&&!RZP_ON)return J({error:'The shop has not configured payments yet.'},400);
        const buf=Buffer.from(b.data||'','base64');
        if(buf.slice(0,4).toString()!=='%PDF')return J({error:'Only PDF files can be printed.'},400);
        const o=s.mode==='locked'?{...s.defaults}:{color:b.options?.color==='col'?'col':'bw',copies:Math.min(99,Math.max(1,parseInt(b.options?.copies)||1)),duplex:!!b.options?.duplex,range:/^[0-9,\-\s]*$/.test(b.options?.range||'')?(b.options.range||''):''};
        const total=Math.max(1,parseInt(b.pages)||1),n=count(o.range,total);
        const j={id:rid(5),shopId:s.id,filename:String(b.filename||'file.pdf').slice(0,80),options:o,pages:n,amount:n*o.copies*(o.color==='col'?s.rates.color:s.rates.bw),status:'created',createdAt:Date.now()};
        fs.writeFileSync(path.join(UP,j.id+'.pdf'),buf);db.jobs.push(j);save();
        syncToGoogleScript('add_print_job',{job:{...j,shopName:s.name,color:o.color,copies:o.copies}});
        return J({id:j.id,amount:j.amount,pages:n});
      }
      if((r=p.match(/^\/api\/jobs\/(\w+)$/))){const j=db.jobs.find(x=>x.id===r[1]);return j?J({status:j.status,amount:j.amount}):J({error:'No job'},404)}
      if((r=p.match(/^\/api\/jobs\/(\w+)\/pay$/))&&m==='POST'){
        const j=db.jobs.find(x=>x.id===r[1]);if(!j)return J({error:'No job'},404);
        const s=db.shops.find(x=>x.id===j.shopId);
        const shopKeys=getShopRzpKeys(s);
        if(shopKeys){
          // Real payment: create a Razorpay order using the shop's keys
          if(j.status!=='created')return J({status:j.status});
          const paise=Math.round(j.amount*100);let transfers;
          const isPlatformKey=shopKeys.keyId===RZP_ID;
          if(isPlatformKey&&!RZP_TEST&&s&&s.linkedAccountId){
            transfers=[{account:s.linkedAccountId,amount:paise-Math.round(paise*FEE_PCT/100),currency:'INR',notes:{job:j.id}}];
          }
          const o={kind:'job',jobId:j.id,amount:paise,status:'created',createdAt:Date.now()};
          return J({order:await createOrder(o,'job_'+j.id,transfers,shopKeys),keyId:shopKeys.keyId,shopName:s&&s.name});
        }
        // PAYMENT NOTE: simulated mode only (no Razorpay keys). Trusts the customer's "I've paid" tap.
        if(j.status==='created'){j.status='paid';save()}return J({status:j.status});
      }
      if((r=p.match(/^\/api\/jobs\/(\w+)\/verify$/))&&m==='POST'){
        const o=db.orders.find(x=>x.id===b.razorpay_order_id&&x.kind==='job'&&x.jobId===r[1]);
        if(!o)return J({error:'Payment order not found.'},400);
        const j=db.jobs.find(x=>x.id===r[1]);
        const s=j&&db.shops.find(x=>x.id===j.shopId);
        const shopKeys=getShopRzpKeys(s);
        const secret=o.rzpKeySecret||(shopKeys&&shopKeys.keySecret)||RZP_SECRET;
        if(!sigOk(b,secret))return J({error:'Payment could not be verified.'},400);
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
