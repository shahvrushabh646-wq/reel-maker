import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

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
  if(u.pathname==='/proxy' && (req.method==='GET'||req.method==='HEAD')){
    const target=u.searchParams.get('url')||'';
    if(!(target.startsWith('http://') || target.startsWith('https://'))) return send(res,400,{'Content-Type':'application/json'},JSON.stringify({error:'Invalid media URL'}));
    try{
      const upstream=await fetch(target,{
        headers:{
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/154 Safari/537.36',
          'Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8',
          ...(req.headers.range?{'Range':req.headers.range}:{})
        },
        redirect:'follow'
      });
      if(!upstream.ok) return send(res,upstream.status,{'Content-Type':'application/json'},JSON.stringify({error:'Upstream media HTTP '+upstream.status}));
      const type=upstream.headers.get('content-type')||'application/octet-stream';
      const body=Buffer.from(await upstream.arrayBuffer());
      if(!body.length)return send(res,502,{'Content-Type':'application/json'},JSON.stringify({error:'Empty upstream media'}));
      return send(res,upstream.status,{'Content-Type':type,'Content-Length':body.length,'Cache-Control':'public,max-age=300','Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Content-Length, Content-Type, Content-Range, Accept-Ranges','Accept-Ranges':'bytes',...(upstream.headers.get('content-range')?{'Content-Range':upstream.headers.get('content-range')}:{})},body);
    }catch(e){
      return send(res,502,{'Content-Type':'application/json'},JSON.stringify({error:'Media proxy failed',detail:String(e.message||e)}));
    }
  }
  if(u.pathname==='/convert-mp4' && req.method==='POST'){
    const chunks=[]; let size=0; const max=180*1024*1024;
    const declared=Number(req.headers['content-length']||0);
    if(declared>max) return send(res,413,{'Content-Type':'application/json'},JSON.stringify({error:'Video too large',limitBytes:max}));
    for await (const chunk of req){
      size+=chunk.length;
      if(size>max) return send(res,413,{'Content-Type':'application/json'},JSON.stringify({error:'Video too large',limitBytes:max}));
      chunks.push(chunk);
    }
    if(!size) return send(res,400,{'Content-Type':'application/json'},JSON.stringify({error:'Empty video upload'}));
    const input=resolve(tmpdir(),'reel-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.webm');
    const output=resolve(tmpdir(),'reel-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.mp4');
    try{
      await writeFile(input,Buffer.concat(chunks));
      await new Promise((resolveDone,reject)=>{
        const p=spawn(ffmpegPath,[
          '-hide_banner','-loglevel','error','-y','-i',input,
          '-map','0:v:0','-map','0:a:0?',
          '-c:v','libx264','-preset','veryfast','-profile:v','high',
          '-pix_fmt','yuv420p','-r','30','-movflags','+faststart',
          '-c:a','aac','-b:a','192k',output
        ]);
        let err='',timer=setTimeout(()=>{try{p.kill('SIGKILL')}catch{};reject(new Error('FFmpeg conversion timed out'))},300000);
        p.stderr.on('data',d=>{err+=d.toString()}); p.on('error',e=>{clearTimeout(timer);reject(e)});
        p.on('close',code=>{clearTimeout(timer);code===0?resolveDone():reject(new Error(err.slice(-3000)||'FFmpeg conversion failed'))});
      });
      const data=await readFile(output);
      if(data.length<10000)throw new Error('FFmpeg produced an unexpectedly small MP4');
      if(data.subarray(4,8).toString('ascii')!=='ftyp')throw new Error('FFmpeg output is not a valid MP4 container');
      return send(res,200,{
        'Content-Type':'video/mp4',
        'Content-Length':data.length,
        'Content-Disposition':'attachment; filename="festival-of-bharat-edits-ready.mp4"',
        'Cache-Control':'no-store',
        'X-Reel-Format':'1080x1920 H.264 yuv420p 30fps'
      },data);
    }catch(e){
      return send(res,500,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify({error:'MP4 conversion failed',detail:String(e.message||e)}));
    }finally{ await Promise.allSettled([unlink(input),unlink(output)]); }
  }
  if(u.pathname==='/media-search'){
    const q=(u.searchParams.get('q')||'').trim();
    if(!q) return send(res,400,{'Content-Type':'application/json'},JSON.stringify({error:'Missing query'}));

    const results=[]; const seen=new Set(); const errors=[];
    const add=(x)=>{if(x?.url&&!seen.has(x.url)){seen.add(x.url);results.push(x)}};
    const fetchJson=async(url,options={},ms=10000)=>{
      const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),ms);
      try{
        const r=await fetch(url,{...options,signal:ctl.signal});
        const body=await r.text(); let d=null; try{d=JSON.parse(body)}catch{}
        if(!r.ok) throw new Error('HTTP '+r.status);
        return d;
      }finally{clearTimeout(timer)}
    };
    const searchWikimedia=async(searchTerm,targetKind,maxItems=100)=>{
      const collected=[]; const seenPages=new Set(); let continuation=null;
      // Keep each request bounded so Render does not sit on a long-running search.
      for(let page=0;page<4 && collected.length<maxItems;page++){
        const api=new URL('https://commons.wikimedia.org/w/api.php');
        for(const [k,v] of [
          ['action','query'],['format','json'],['formatversion','2'],['generator','search'],
          ['gsrsearch',searchTerm],['gsrnamespace','6'],['gsrlimit','100'],['gsrwhat','text'],
          ['prop','imageinfo'],['iiprop','url|mime|size'],['iiurlwidth','900'],['origin','*']
        ]) api.searchParams.set(k,v);
        if(continuation) api.searchParams.set('gsrcontinue',continuation);
        const d=await fetchJson(api,{headers:{'User-Agent':'Festival-of-Bharat-Reel-Maker/1.3','Accept':'application/json'}},8000);
        for(const x of (d?.query?.pages||[])){
          const z=x?.imageinfo?.[0],mime=String(z?.mime||'').toLowerCase();
          const kind=mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':'';
          if(kind!==targetKind||!z?.url||seenPages.has(x.pageid))continue;
          seenPages.add(x.pageid);
          collected.push({id:(kind==='video'?'wmv':'wm')+x.pageid,title:x.title||('Wikimedia Commons '+kind),source:'Wikimedia Commons',url:z.url,thumb:z.thumburl||'',kind});
          if(collected.length>=maxItems)break;
        }
        continuation=d?.continue?.gsrcontinue||null;
        if(!continuation)break;
      }
      return collected;
    };

    // Photos and videos are searched independently. We return real results as soon as
    // Wikimedia has them; the UI never invents missing assets just to reach 100.
    const [photoAttempt,videoAttempt]=await Promise.allSettled([
      searchWikimedia(q,'image',100),
      searchWikimedia(q,'video',100)
    ]);
    const consume=(attempt)=>{if(attempt.status==='fulfilled')for(const x of attempt.value||[])add(x)};
    consume(photoAttempt); consume(videoAttempt);
    if(photoAttempt.status==='rejected')errors.push('Wikimedia photos: '+String(photoAttempt.reason?.message||photoAttempt.reason));
    if(videoAttempt.status==='rejected')errors.push('Wikimedia videos: '+String(videoAttempt.reason?.message||videoAttempt.reason));

    // Openverse is only a photo fallback.
    if(!results.some(x=>x.kind==='image')){
      try{
        const api=new URL('https://api.openverse.org/v1/images/');
        api.searchParams.set('q',q); api.searchParams.set('page_size','100');
        api.searchParams.set('size','large'); api.searchParams.set('license_type','commercial,modification');
        const d=await fetchJson(api,{headers:{'User-Agent':'Festival-of-Bharat-Reel-Maker/1.2','Accept':'application/json'}},10000);
        for(const x of (d?.results||[])) if(x?.url) add({
          id:'ov'+x.id,title:x.title||'Untitled',source:'Openverse',
          url:x.url,thumb:x.thumbnail||x.url,kind:'image'
        });
      }catch(e){errors.push('Openverse photos: '+String(e.message||e))}
    }

    const photos=results.filter(x=>x.kind==='image').slice(0,100);
    const videos=results.filter(x=>x.kind==='video').slice(0,100);
    const finalResults=[...photos,...videos];
    if(!finalResults.length) return send(res,502,{'Content-Type':'application/json','Cache-Control':'no-store'},
      JSON.stringify({error:'No media found',details:errors}));
    return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},
      JSON.stringify({
        results:finalResults,
        source:videos.length?'Wikimedia Commons':'Wikimedia Commons / Openverse',
        counts:{
          wikimedia:results.filter(x=>x.source==='Wikimedia Commons').length,
          openverse:results.filter(x=>x.source==='Openverse').length,
          photos:photos.length,videos:videos.length
        },errors
      }));
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