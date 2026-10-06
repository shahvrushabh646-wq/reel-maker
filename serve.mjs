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
    const q=u.searchParams.get('q')||'';
    if(!q.trim()) return send(res,400,{'Content-Type':'application/json'},JSON.stringify({error:'Missing query'}));
    const normalizeJamendo=(data)=>{
      if(data?.headers?.status!=='success') throw Error(data?.headers?.error_message||'Jamendo API returned an error');
      return (data.results||[]).filter(x=>x?.audio).map(x=>({
        id:'jamendo-'+x.id,name:x.name,artist_name:x.artist_name||'Unknown artist',
        duration:+x.duration||0,audio:x.audio,license:x.license_ccurl||'Jamendo Pro',
        license_ccurl:x.license_ccurl||'',audiodownload_allowed:!!x.audiodownload_allowed,
        album_image:x.album_image||x.image||'',source:'Jamendo',landing:x.shareurl||''
      }));
    };
    const searchJamendo=async()=>{
      const client=process.env.JAMENDO_CLIENT_ID;
      if(!client) return [];
      const api=new URL('https://api.jamendo.com/v3.0/tracks/');
      for(const [k,v] of [['client_id',client],['format','json'],['limit','100'],['search',q],['order','relevance'],['audioformat','mp32'],['include','licenses musicinfo'],['type','single albumtrack']]) api.searchParams.set(k,v);
      // Ask Jamendo for commercial tracks when the account supports Pro licensing.
      api.searchParams.set('prolicensing','true');
      const r=await fetch(api,{headers:{'User-Agent':'Festival-of-Bharat-Reel-Maker/1.0'}});
      const body=await r.text();
      if(!r.ok) throw Error('Jamendo HTTP '+r.status);
      return normalizeJamendo(JSON.parse(body));
    };
    const searchOpenverse=async()=>{
      const queries=[q, q+' devotional', q+' festival', q+' india'];
      const all=[];
      for(const term of queries){
        try{
          const api=new URL('https://api.openverse.org/v1/audio/');
          api.searchParams.set('q',term);
          api.searchParams.set('page_size','50');
          api.searchParams.set('page','1');
          const rr=await fetch(api,{headers:{'User-Agent':'Festival-of-Bharat-Reel-Maker/1.0','Accept':'application/json'}});
          const body=await rr.text();
          if(!rr.ok) continue;
          const data=JSON.parse(body);
          for(const x of (data?.results||[])){
            const audio=x.url||x.audio_url||x.file;
            if(audio && !all.some(y=>y.id===x.id)) all.push({...x,url:audio});
          }
        }catch(e){ console.warn('Openverse query failed:',term,e.message); }
      }
      return all.slice(0,80).map(x=>({
        id:'openverse-'+x.id,name:x.title||'Untitled audio',
        artist_name:x.creator||'Unknown creator',duration:Math.round((+x.duration||0)/1000)||0,
        audio:'/proxy?url='+encodeURIComponent(x.url),original_audio:x.url,
        license:x.license||'',license_ccurl:x.license_url||'',
        audiodownload_allowed:true,source:'Openverse',landing:x.foreign_landing_url||x.detail_url||''
      }));
    };
    try{
      const searchYouTube=async()=>{
      const key=process.env.YOUTUBE_API_KEY;
      if(!key) return [];
      const api=new URL('https://www.googleapis.com/youtube/v3/search');
      for(const [k,v] of [['part','snippet'],['q',q],['type','video'],['maxResults','25'],['videoCategoryId','10'],['regionCode','IN'],['key',key]]) api.searchParams.set(k,v);
      const r=await fetch(api); const d=await r.json();
      if(!r.ok) throw Error(d?.error?.message||'YouTube API error');
      return (d.items||[]).map(x=>({id:'youtube-'+x.id.videoId,name:x.snippet?.title||'YouTube Music',artist_name:x.snippet?.channelTitle||'YouTube',duration:0,audio:null,source:'YouTube',landing:'https://www.youtube.com/watch?v='+x.id.videoId,thumbnail:x.snippet?.thumbnails?.high?.url||x.snippet?.thumbnails?.medium?.url||''}));
    };
    const searchSpotify=async()=>{
      const id=process.env.SPOTIFY_CLIENT_ID, secret=process.env.SPOTIFY_CLIENT_SECRET;
      if(!id||!secret) return [];
      const token=Buffer.from(id+':'+secret).toString('base64');
      const tr=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:'Basic '+token,'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
      const td=await tr.json(); if(!tr.ok||!td.access_token) throw Error(td?.error_description||'Spotify auth failed');
      const api=new URL('https://api.spotify.com/v1/search');
      for(const [k,v] of [['q',q],['type','track'],['limit','25'],['market','IN']]) api.searchParams.set(k,v);
      const r=await fetch(api,{headers:{Authorization:'Bearer '+td.access_token}});
      const d=await r.json(); if(!r.ok) throw Error(d?.error?.message||'Spotify API error');
      return (d.tracks?.items||[]).map(x=>({id:'spotify-'+x.id,name:x.name,artist_name:(x.artists||[]).map(a=>a.name).join(', '),duration:Math.round((x.duration_ms||0)/1000),audio:x.preview_url||null,source:'Spotify',landing:x.external_urls?.spotify||('https://open.spotify.com/track/'+x.id),thumbnail:x.album?.images?.[0]?.url||''}));
    };
    const merged=[];
      const seen=new Set();
      const addMany=(items,src)=>{for(const x of (items||[])){if(x?.audio&&!seen.has(x.id)){seen.add(x.id);merged.push(x)}}};
      let jamendo=[];
      if(process.env.JAMENDO_CLIENT_ID){
        try{jamendo=await searchJamendo();}catch(e){console.warn('Jamendo music search failed:',e.message)}
      }
      let openverse=[], youtube=[], spotify=[];
      try{openverse=await searchOpenverse();}catch(e){console.warn('Openverse music search failed:',e.message)}
      try{youtube=await searchYouTube();}catch(e){console.warn('YouTube music search failed:',e.message)}
      try{spotify=await searchSpotify();}catch(e){console.warn('Spotify music search failed:',e.message)}
      addMany(jamendo,'Jamendo');
      addMany(openverse,'Openverse');
      addMany(youtube,'YouTube');
      addMany(spotify,'Spotify');
      if(!merged.length) return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify({results:[],source:'Multiple catalogs',message:'No playable licensed tracks matched this search.'}));
      return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify({results:merged.slice(0,160),source:'Jamendo + Openverse',counts:{jamendo:jamendo.length,openverse:openverse.length,youtube:youtube.length,spotify:spotify.length}}));
    }catch(e){
      return send(res,502,{'Content-Type':'application/json'},JSON.stringify({error:'Music catalog unavailable: '+e.message}));
    }
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