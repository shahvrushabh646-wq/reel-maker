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
let serverMediaCache=new Map();
const send=(res,status,headers,body)=>{res.writeHead(status,headers);res.end(body)};
const server=createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/health') return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify({ok:true,service:'festival-of-bharat-reel-maker'}));
  if(u.pathname==='/'||u.pathname==='/index.html'){
    try { const html=await readFile(resolve(root,'index.html'),'utf8'); return send(res,200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'},html); }
    catch(e){ return send(res,500,{'Content-Type':'text/plain'},'Could not read index.html'); }
  }
  if(u.pathname==='/proxy' && (req.method==='GET'||req.method==='HEAD')){
    const target=u.searchParams.get('url');
    if(!target) return send(res,400,{'Content-Type':'text/plain'},'Missing url');
    try{
      const t=new URL(target);
      const host=t.hostname.toLowerCase().replace(/^\[|\]$/g,'');
      const privateHost=host==='localhost'||host==='0.0.0.0'||host==='::1'||host.endsWith('.local')||/^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host)||/^172\.(1[6-9]|2\\d|3[0-1])\./.test(host);
      if(!['http:','https:'].includes(t.protocol)||privateHost) return send(res,400,{'Content-Type':'text/plain'},'Unsupported url');
      const headers={
        'User-Agent':'FestivalOfBharatReelMaker/1.4 (cultural reel studio; https://commons.wikimedia.org/)',
        'Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,video/*,*/*;q=0.8'
      };
      if(req.headers.range) headers.Range=req.headers.range;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      let r;
      try{r=await fetch(t,{redirect:'follow',headers,signal:controller.signal})}finally{clearTimeout(timer)}
      if(!r.ok) return send(res,r.status,{'Content-Type':'text/plain'},'Upstream '+r.status);
      const h={
        'Access-Control-Allow-Origin':'*',
        'Access-Control-Expose-Headers':'Accept-Ranges, Content-Length, Content-Range, Content-Type',
        'Accept-Ranges':r.headers.get('accept-ranges')||'bytes',
        'Cache-Control':'public, max-age=3600',
        'Content-Type':r.headers.get('content-type')||'application/octet-stream'
      };
      for(const x of ['content-length','content-range']){
        const v=r.headers.get(x);
        if(v) h[x==='content-length'?'Content-Length':'Content-Range']=v;
      }
      const status=r.status===206?206:200;
      if(req.method==='HEAD') return send(res,status,h);
      if(!r.body) return send(res,502,{'Content-Type':'text/plain'},'Upstream media body missing');
      res.writeHead(status,h);
      const reader=r.body.getReader();
      req.on('close',()=>{try{reader.cancel()}catch{}});
      while(true){
        const {done,value}=await reader.read();
        if(done) break;
        if(!res.write(Buffer.from(value))) await new Promise(resolve=>res.once('drain',resolve));
      }
      return res.end();
    }catch(e){
      return send(res,502,{'Content-Type':'text/plain'},'Proxy failed: '+String(e.message||e));
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
    const raw=(u.searchParams.get('q')||'').trim();
    const offset=Math.max(0,Number(u.searchParams.get('offset')||0)||0);
    if(!raw) return send(res,400,{'Content-Type':'application/json'},JSON.stringify({error:'Missing query'}));
    const query=raw.replace(/\s+/g,' ').trim().slice(0,180);
    const cacheKey=query.toLowerCase()+'|'+offset;
    serverMediaCache=serverMediaCache||new Map();
    const cached=serverMediaCache.get(cacheKey);
    if(cached&&Date.now()-cached.at<120000&&cached.body?.results?.length)return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(cached.body));
    const errors=[];
    const hints=[
      [/ganesh|ganapati|chaturthi|chinchpokli/i,['Ganesh Chaturthi festival','Ganapati visarjan India','Ganesh idol procession']],
      [/navratri|garba|durga/i,['Navratri garba','Durga Puja festival','Navratri festival India']],
      [/shivaratri|shivratri|mahashiv/i,['Mahashivratri','Shiva temple night India']],
      [/holi/i,['Holi festival India','Holi colors']],
      [/diwali|deepavali/i,['Diwali festival India','Deepavali lamps']],
      [/girnar/i,['Girnar mountain temple','Girnar Jain temple']],
      [/janmashtami|krishna/i,['Krishna Janmashtami','Dahi handi']],
      [/pongal|onam|baisakhi|lohri|bihu/i,['India harvest festival']]
    ];
    const extra=(hints.find(x=>x[0].test(query))||[])[1]||[];
    // Match the supplied ZIP's research variant order exactly:
    // original query -> generic India/festival/temple expansion -> topic-specific hints.
    const variants=[query];
    if(!/india|festival|temple/i.test(query))variants.push(query+' festival India');
    for(const item of extra){
      if(!variants.some(v=>v.toLowerCase()===item.toLowerCase())) variants.push(item);
    }
    const researchVariants=variants.slice(0,3);
    const rejectTitle=t=>/(icon|logo|pictogram|coat of arms|locator map|flag of|diagram|watermark|symbol|svg\b|banner\b)/i.test(String(t||''));
    const fetchJson=async(url,ms=12000)=>{
      let last='request failed',wait=350;
      for(let attempt=0;attempt<3;attempt++){
        const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),ms);
        try{
          const rr=await fetch(url,{headers:{'User-Agent':'FestivalOfBharatReelMaker/1.4 (cultural reel studio; https://commons.wikimedia.org/)','Accept':'application/json'},signal:ctl.signal});
          const body=await rr.text();
          if(rr.status===429||rr.status>=500){last='HTTP '+rr.status;await new Promise(x=>setTimeout(x,wait));wait*=2;continue}
          if(!rr.ok)throw new Error('HTTP '+rr.status);
          return JSON.parse(body);
        }catch(e){last=String(e?.message||e);if(attempt<2)await new Promise(x=>setTimeout(x,wait)),wait*=2}
        finally{clearTimeout(timer)}
      }
      throw new Error(last);
    };
    const searchCommons=async(term,fileType)=>{
      const api=new URL('https://commons.wikimedia.org/w/api.php');
      const params={action:'query',format:'json',formatversion:'2',origin:'*',generator:'search',gsrsearch:term+' filetype:'+fileType,gsrnamespace:'6',gsrlimit:fileType==='video'?'20':'30',gsrwhat:'text',prop:'imageinfo',iiprop:'url|size|mime|mediatype|extmetadata',iiextmetadatafilter:'LicenseShortName|Artist|LicenseUrl',iiurlwidth:'1400'};
      if(offset>0)params.gsroffset=String(offset);
      Object.entries(params).forEach(([k,v])=>api.searchParams.set(k,v));
      try{
        const d=await fetchJson(api.toString(),12000);
        const items=[];
        for(const x of d?.query?.pages||[]){
          const z=x?.imageinfo?.[0],mime=String(z?.mime||'').toLowerCase();
          const kind=mime.startsWith('video/')?'video':mime.startsWith('image/')?'image':'';
          const title=String(x.title||'Untitled').replace(/^File:/,'');
          if(!x.pageid||!z?.url||kind!==(fileType==='video'?'video':'image')||mime.includes('svg')||z.mediatype==='AUDIO'||z.mediatype==='TEXT'||rejectTitle(title))continue;
          if(kind==='image'&&z.width&&z.width<640)continue;
          if(kind==='video'&&z.size&&z.size>90000000)continue;
          const clean=v=>String(v?.value||'').replace(/<[^>]+>/g,'').trim();
          items.push({id:'wm-'+x.pageid,title,source:'Wikimedia Commons',kind,url:z.url,originalUrl:z.url,thumb:z.thumburl||z.url,playUrl:kind==='image'?(z.thumburl||z.url):z.url,width:Number(z.width||0),height:Number(z.height||0),mime,license:clean(z.extmetadata?.LicenseShortName),licenseUrl:clean(z.extmetadata?.LicenseUrl),author:clean(z.extmetadata?.Artist),pageUrl:z.descriptionurl||'https://commons.wikimedia.org/wiki/Special:Redirect/file/'+encodeURIComponent(title)});
        }
        return {items,more:!!d?.continue?.gsroffset};
      }catch(e){return {items:[],more:false,error:'Wikimedia '+fileType+': '+String(e?.message||e)}}
    };
    const searchOpenverse=async(term)=>{
      const api=new URL('https://api.openverse.org/v1/images/');
      api.searchParams.set('q',term);api.searchParams.set('page_size','30');
      try{
        const d=await fetchJson(api.toString(),10000),items=[];
        for(const x of d?.results||[]){
          if(!x?.url||!x?.id||(x.width&&x.width<640)||rejectTitle(x.title))continue;
          items.push({id:'ov'+x.id,title:x.title||'Untitled',source:'Openverse',kind:'image',url:x.url,originalUrl:x.url,thumb:x.thumbnail||x.url,width:Number(x.width||0),height:Number(x.height||0),license:x.license||'',licenseUrl:x.license_url||'',author:x.creator||'',pageUrl:x.foreign_landing_url||''});
        }
        return {items};
      }catch(e){return {items:[],error:'Openverse photos: '+String(e?.message||e)}}
    };
    const [photos,videos]=await Promise.all(researchVariants.slice(0,1).map(t=>Promise.all([searchCommons(t,'bitmap'),searchCommons(t,'video')]))).then(x=>x[0]);
    if(photos.error)errors.push(photos.error);if(videos.error)errors.push(videos.error);
    let images=photos.items;
    if(offset===0&&images.length<8&&researchVariants[1]){
      const extraResult=await searchCommons(researchVariants[1],'bitmap');if(extraResult.error)errors.push(extraResult.error);images=images.concat(extraResult.items);
    }
    if(offset===0&&images.length<4){
      const ov=await searchOpenverse(researchVariants[0]||query);if(ov.error)errors.push(ov.error);images=images.concat(ov.items);
    }
    const seen=new Set(),resultsOut=[];
    const add=x=>{const key=x.kind+'|'+String(x.originalUrl||x.url).split('?')[0]+'|'+String(x.title).toLowerCase();if(!seen.has(x.id)&&!seen.has(key)){seen.add(x.id);seen.add(key);resultsOut.push(x)}};
    images.filter(x=>x.kind==='image').forEach(add);videos.items.filter(x=>x.kind==='video').forEach(add);
    const photosCount=resultsOut.filter(x=>x.kind==='image').length,videosCount=resultsOut.filter(x=>x.kind==='video').length;
    const payload={results:resultsOut.slice(0,80),nextOffset:(photos.more||videos.more)?offset+30:null,source:videosCount&&photosCount?'Wikimedia Commons':photosCount?'Wikimedia Commons / Openverse':'Wikimedia Commons',counts:{photos:photosCount,videos:videosCount},errors,message:resultsOut.length?undefined:(errors[0]||'No suitable media found for this search.'),error:resultsOut.length?undefined:(errors[0]||'No suitable Wikimedia media found for this search.')};
    if(resultsOut.length)serverMediaCache.set(cacheKey,{at:Date.now(),body:payload});
    return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(payload));
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
  send(res,404,{'Content-Type':'text/plain'},'Not found');
});
const port=Number(process.env.PORT||4173);
server.listen(port,'0.0.0.0',()=>console.log('Festival of Bharat Reel Maker listening on '+port));