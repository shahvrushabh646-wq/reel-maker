import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

if (existsSync(resolve('.env'))) {
  for (const line of readFileSync(resolve('.env'),'utf8').split(/\r?\n/)) {
    const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
  }
}
const root=resolve('.');
const send=(res,status,headers,body)=>{res.writeHead(status,headers);res.end(body)};
const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health') return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify({ok:true,service:'festival-of-bharat-reel-maker'}));
  if(u.pathname==='/'||u.pathname==='/index.html'){
    try { const html=await readFile(resolve(root,'index.html'),'utf8'); return send(res,200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'},html); }
    catch(e){ return send(res,500,{'Content-Type':'text/plain'},'Could not read index.html'); }
  }
  if(u.pathname==='/music-search'){
    const client=process.env.JAMENDO_CLIENT_ID||'', q=u.searchParams.get('q')||'';
    if(!client) return send(res,503,{'Content-Type':'application/json'},JSON.stringify({error:'Licensed music search is not configured. Add JAMENDO_CLIENT_ID in Render environment variables.'}));
    if(!q.trim()) return send(res,400,{'Content-Type':'application/json'},JSON.stringify({error:'Missing query'}));
    try{
      const api=new URL('https://api.jamendo.com/v3.0/tracks/');
      for(const [k,v] of [['client_id',client],['format','json'],['limit','20'],['search',q],['order','relevance'],['audioformat','mp32'],['include','musicinfo'],['prolicensing','true'],['type','single albumtrack']]) api.searchParams.set(k,v);
      const r=await fetch(api); const body=await r.text();
      if(!r.ok) throw Error(body.slice(0,400));
      return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},body);
    }catch(e){return send(res,502,{'Content-Type':'application/json'},JSON.stringify({error:e.message}));}
  }
  if(u.pathname==='/google-images'){
    const key=process.env.GOOGLE_CSE_KEY||'',cx=process.env.GOOGLE_CSE_ID||'',q=u.searchParams.get('q')||'';
    if(!key||!cx) return send(res,503,{'Content-Type':'application/json'},JSON.stringify({error:'Google image search is not configured'}));
    if(!q.trim()) return send(res,400,{'Content-Type':'application/json'},JSON.stringify({error:'Missing query'}));
    try{
      const api=new URL('https://www.googleapis.com/customsearch/v1');
      for(const [k,v] of [['key',key],['cx',cx],['q',q],['searchType','image'],['num','10'],['safe','active'],['imgSize','large'],['rights','cc_publicdomain,cc_attribute,cc_sharealike']]) api.searchParams.set(k,v);
      const r=await fetch(api); const body=await r.text();
      if(!r.ok) throw Error(body.slice(0,300));
      return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},body);
    }catch(e){return send(res,502,{'Content-Type':'application/json'},JSON.stringify({error:e.message}));}
  }
  if(u.pathname==='/proxy'){
    const target=u.searchParams.get('url'); if(!target) return send(res,400,{'Content-Type':'text/plain'},'Missing url');
    try{
      const t=new URL(target); if(!['http:','https:'].includes(t.protocol)) return send(res,400,{'Content-Type':'text/plain'},'Unsupported protocol');
      const headers={'User-Agent':'Festival-of-Bharat-Reel-Maker/1.0'}; if(req.headers.range) headers.Range=req.headers.range;
      const r=await fetch(t,{redirect:'follow',headers}); if(!r.ok||!r.body) return send(res,r.status,{'Content-Type':'text/plain'},'Upstream '+r.status);
      const h={'Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Accept-Ranges, Content-Length, Content-Range, Content-Type','Accept-Ranges':r.headers.get('accept-ranges')||'bytes','Cache-Control':'public, max-age=3600','Content-Type':r.headers.get('content-type')||'application/octet-stream'};
      for(const x of ['content-length','content-range']){const v=r.headers.get(x);if(v)h[x==='content-length'?'Content-Length':'Content-Range']=v}
      res.writeHead(r.status===206?206:200,h); const reader=r.body.getReader(); while(true){const {done,value}=await reader.read();if(done)break;res.write(Buffer.from(value))} res.end();
    }catch(e){send(res,502,{'Content-Type':'text/plain'},'Proxy failed: '+e.message)}
    return;
  }
  send(res,404,{'Content-Type':'text/plain'},'Not found');
});
const port=Number(process.env.PORT||4173);
server.listen(port,'0.0.0.0',()=>console.log('Festival of Bharat Reel Maker listening on '+port));