// PrintQR shop agent: local app window + background print worker. Windows, Node 18+.
const http=require('http'),fs=require('fs'),os=require('os'),path=require('path'),{exec}=require('child_process');
const QR=require('qrcode'),ptp=require('pdf-to-printer');
const PORT=4010,DIR=path.join(process.env.APPDATA||os.homedir(),'PrintQR-Agent'),CF=path.join(DIR,'config.json');
fs.mkdirSync(DIR,{recursive:true});
let cfg={};try{cfg=JSON.parse(fs.readFileSync(CF))}catch(e){}

// Read bundled server URL if present in agent folder:
let bundledUrl='';
try{
  const uf=path.join(__dirname,'server_url.txt'),cf=path.join(__dirname,'config.json');
  if(fs.existsSync(uf))bundledUrl=fs.readFileSync(uf,'utf8').trim();
  else if(fs.existsSync(cf)){const j=JSON.parse(fs.readFileSync(cf,'utf8'));bundledUrl=(j.serverUrl||'').trim()}
}catch(e){}

// Automatically pre-fill serverUrl if not yet set or not activated:
if(bundledUrl&&(!cfg.serverUrl||!cfg.key)){
  cfg.serverUrl=bundledUrl;
}
const saveCfg=()=>fs.writeFileSync(CF,JSON.stringify(cfg,null,1));
const log=[];const note=(t)=>{log.unshift({t:new Date().toLocaleTimeString(),m:t});log.length=Math.min(log.length,12)};
const remote=async(p,method='GET',b)=>{
  const r=await fetch(cfg.serverUrl+p,{method,headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});
  const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Server error '+r.status);return j;
};
const readBody=req=>new Promise(ok=>{let s='';req.on('data',d=>s+=d);req.on('end',()=>{try{ok(JSON.parse(s||'{}'))}catch(e){ok({})}})});

function pick(o,sl){if(o.color==='col')return sl.color||sl.bw;if(o.duplex)return sl.duplex||sl.bw;return sl.bw||sl.duplex||sl.color}
async function work(){
  if(!cfg.key)return;
  try{
    const jobs=await remote('/api/agent/jobs?key='+cfg.key);
    for(const j of jobs){
      const f=path.join(os.tmpdir(),'printqr-'+j.id+'.pdf');
      try{
        const r=await fetch(cfg.serverUrl+'/api/agent/file/'+j.id+'?key='+cfg.key);
        fs.writeFileSync(f,Buffer.from(await r.arrayBuffer()));
        const o=j.options,printer=pick(o,cfg.shop.slots||{});
        const opt={copies:o.copies,side:o.duplex?'duplex':'simplex',monochrome:o.color==='bw'};
        if(printer)opt.printer=printer;if(o.range)opt.pages=o.range.replace(/\s/g,'');
        await ptp.print(f,opt);
        await remote('/api/agent/jobs/'+j.id+'?key='+cfg.key,'POST',{status:'printed'});
        note('Printed '+j.filename+' ('+j.pages+' pages x '+o.copies+')');
      }catch(e){await remote('/api/agent/jobs/'+j.id+'?key='+cfg.key,'POST',{status:'failed'}).catch(()=>{});note('Failed: '+j.filename+' - '+e.message)}
      fs.unlink(f,()=>{});
    }
  }catch(e){note('Server: '+e.message)}
}
setInterval(work,3000);

http.createServer(async(req,res)=>{
  const p=req.url.split('?')[0],J=(o,c=200)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
  try{
    if(p==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(fs.readFileSync(path.join(__dirname,'ui.html')))}
    if(p==='/local/state')return J({activated:!!cfg.key,cfg:{serverUrl:cfg.serverUrl,shop:cfg.shop,user:cfg.user,plan:cfg.plan,expiresAt:cfg.expiresAt},log});
    if(p==='/local/printers'){try{return J((await ptp.getPrinters()).map(x=>x.name))}catch(e){return J([])}}
    if(p==='/local/activate'){
      const b=await readBody(req);cfg.serverUrl=(b.serverUrl||'').replace(/\/+$/,'');
      const r=await remote('/api/activate','POST',{key:b.key});
      Object.assign(cfg,{key:r.key,shop:r.shop,user:r.user,plan:r.plan,expiresAt:r.expiresAt});saveCfg();note('Activated');return J({ok:1});
    }
    if(p==='/local/settings'){
      const b=await readBody(req);const s=await remote('/api/agent/settings','POST',{key:cfg.key,...b});
      cfg.shop=s;saveCfg();return J({ok:1});
    }
    if(p==='/local/qr'){
      const url=cfg.serverUrl+'/?shopId='+cfg.shop.id;
      return J({url,img:await QR.toDataURL(url,{width:700,margin:1,errorCorrectionLevel:'M'})});
    }
    if(p==='/local/logout'){cfg={serverUrl:cfg.serverUrl};saveCfg();return J({ok:1})}
    res.writeHead(404);res.end();
  }catch(e){J({error:e.message},400)}
}).listen(PORT,'127.0.0.1',()=>{
  console.log('PrintQR agent running. Keep this window open to receive print jobs.');
  exec('start "" msedge --app=http://127.0.0.1:'+PORT+' --window-size=1100,780',err=>{if(err)exec('start "" http://127.0.0.1:'+PORT)});
});
