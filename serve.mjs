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
      const privateHost=host==='localhost'||host==='0.0.0.0'||host==='::1'||host.endsWith('.local')||/^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host)||/^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
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
    const q=(u.searchParams.get('q')||'').replace(/\s+/g,' ').trim().slice(0,180);
    const offset=Math.max(0,Number(u.searchParams.get('offset')||0)||0);
    if(!q) return send(res,400,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify({
      results:[],nextOffset:null,source:'Wikimedia Commons',
      counts:{photos:0,videos:0},errors:['Missing query'],error:'Missing query'
    }));

    const cacheKey=q.toLowerCase()+'|'+offset;
    const cached=serverMediaCache.get(cacheKey);
    if(cached && Date.now()-cached.at<120000 && cached.body?.results?.length){
      return send(res,200,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(cached.body));
    }

    const UA='FestivalOfBharatReelMaker/1.4 (cultural reel studio; https://commons.wikimedia.org/)';
    const HINTS=[
      [/ganesh|ganapati|chaturthi|chinchpokli/i,['Ganesh Chaturthi festival','Ganapati visarjan India','Ganesh idol procession']],
      [/navratri|garba|durga/i,['Navratri garba','Durga Puja festival','Navratri festival India']],
      [/shivaratri|shivratri|mahashiv/i,['Mahashivratri','Shiva temple night India']],
      [/holi/i,['Holi festival India','Holi colors']],
      [/diwali|deepavali/i,['Diwali festival India','Deepavali lamps']],
      [/girnar/i,['Girnar mountain temple','Girnar Jain temple']],
      [/janmashtami|krishna/i,['Krishna Janmashtami','Dahi handi']],
      [/pongal|onam|baisakhi|lohri|bihu/i,['India harvest festival']]
    ];
    const variantsFor=query=>{
      const clean=query.replace(/\s+/g,' ').trim();
      const extra=(HINTS.find(([pattern])=>pattern.test(clean))||[])[1]||[];
      const list=[clean];
      if(!/india|festival|temple/i.test(clean)) list.push(clean+' festival India');
      for(const item of extra) if(!list.some(v=>v.toLowerCase()===item.toLowerCase())) list.push(item);
      return list.slice(0,3);
    };
    const rejectTitle=title=>/(icon|logo|pictogram|coat of arms|locator map|flag of|diagram|watermark|symbol|svg\b|banner\b)/i.test(title);
    const stripHtml=value=>String(value||'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'\"').replace(/&#039;|'/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim().slice(0,180);

    const fetchJson=async(url,ms=12000)=>{
      const started=Date.now(); let last='request failed'; let wait=350;
      for(let attempt=0;attempt<3;attempt++){
        try{
          const response=await fetch(url,{headers:{'User-Agent':UA,'Accept':'application/json'},signal:AbortSignal.timeout(ms)});
          const text=await response.text();
          if(response.status===429||response.status>=500){
            last='HTTP '+response.status;
            await new Promise(resolve=>setTimeout(resolve,wait)); wait*=2; continue;
          }
          if(!response.ok) throw new Error('HTTP '+response.status);
          try{return JSON.parse(text)}catch{throw new Error('response was not JSON')}
        }catch(error){
          last=error instanceof Error?error.message:'request failed';
          if(attempt===2) break;
          await new Promise(resolve=>setTimeout(resolve,wait)); wait*=2;
        }
      }
      throw new Error(last);
    };

    const mapPage=(page)=>{
      const info=page?.imageinfo?.[0];
      if(!info?.url||!page?.pageid)return null;
      const mime=String(info.mime||'').toLowerCase();
      const kind=mime.startsWith('video/')?'video':mime.startsWith('image/')?'image':'';
      if(!kind||mime.includes('svg')||info.mediatype==='AUDIO'||info.mediatype==='TEXT')return null;
      if(kind==='image'&&info.width&&info.width<640)return null;
      if(kind==='video'&&info.size&&info.size>90000000)return null;
      const title=String(page.title||'Untitled').replace(/^File:/,'');
      if(rejectTitle(title))return null;
      const thumb=info.thumburl||info.url;
      if(!thumb)return null;
      return {
        id:'wm-'+page.pageid,title,source:'Wikimedia Commons',kind,
        url:info.url,originalUrl:info.url,thumb,
        playUrl:kind==='image'?thumb:info.url,
        width:info.width,height:info.height,mime,
        license:stripHtml(info.extmetadata?.LicenseShortName?.value),
        licenseUrl:stripHtml(info.extmetadata?.LicenseUrl?.value),
        author:stripHtml(info.extmetadata?.Artist?.value),
        pageUrl:info.descriptionurl
      };
    };

    const searchCommons=async(term,kind)=>{
      const fileType=kind==='video'?'video':'bitmap';
      const query=term+' filetype:'+fileType;
      const api=new URL('https://commons.wikimedia.org/w/api.php');
      for(const [k,v] of [
        ['action','query'],['format','json'],['formatversion','2'],['origin','*'],
        ['generator','search'],['gsrsearch',query],['gsrnamespace','6'],
        ['gsrlimit',kind==='video'?'20':'30'],['gsrwhat','text'],
        ['prop','imageinfo'],['iiprop','url|size|mime|mediatype|extmetadata'],
        ['iiextmetadatafilter','LicenseShortName|Artist|LicenseUrl'],['iiurlwidth','1400']
      ])api.searchParams.set(k,v);
      if(offset>0)api.searchParams.set('gsroffset',String(offset));
      try{
        const body=await fetchJson(api.toString(),12000);
        const items=(body?.query?.pages||[]).map(mapPage).filter(x=>x&&x.kind===kind);
        return {items,more:typeof body?.continue?.gsroffset==='number'};
      }catch(error){
        return {items:[],more:false,error:'Wikimedia '+kind+': '+String(error?.message||error)};
      }
    };

    const searchOpenverse=async term=>{
      const api=new URL('https://api.openverse.org/v1/images/');
      api.searchParams.set('q',term);api.searchParams.set('page_size','30');
      try{
        const body=await fetchJson(api.toString(),10000),items=[];
        for(const row of body?.results||[]){
          if(!row?.url||!row?.id)continue;
          if(row.width&&row.width<640)continue;
          const title=row.title||'Untitled';
          if(rejectTitle(title))continue;
          items.push({
            id:'ov-'+row.id,title,source:'Openverse',kind:'image',
            url:row.url,originalUrl:row.url,thumb:row.thumbnail||row.url,playUrl:row.url,
            width:row.width,height:row.height,license:row.license||'',
            licenseUrl:row.license_url||'',author:row.creator||'',pageUrl:row.foreign_landing_url||''
          });
        }
        return {items};
      }catch(error){return {items:[],error:'Openverse photos: '+String(error?.message||error)}}
    };

    const searchCommonsBroad=async term=>{
      const api=new URL('https://commons.wikimedia.org/w/api.php');
      for(const [k,v] of [['action','query'],['format','json'],['formatversion','2'],['origin','*'],['generator','search'],['gsrsearch',term],['gsrnamespace','6'],['gsrlimit','40'],['prop','imageinfo'],['iiprop','url|size|mime|mediatype'],['iiurlwidth','1400']])api.searchParams.set(k,v);
      try{
        const body=await fetchJson(api.toString(),12000);
        return (body?.query?.pages||[]).map(mapPage).filter(Boolean);
      }catch(error){return []}
    };

    const variants=variantsFor(q),primary=variants[0]||q;
    const [photos,videos]=await Promise.all([searchCommons(primary,'image'),searchCommons(primary,'video')]);
    const errors=[photos.error,videos.error].filter(Boolean);
    let images=photos.items;
    if(offset===0&&images.length<8&&variants[1]){
      const extra=await searchCommons(variants[1],'image');
      if(extra.error)errors.push(extra.error);
      images=images.concat(extra.items);
    }
    if(images.length<8 || videos.items.length<2){
      const broad=await searchCommonsBroad(primary);
      for(const item of broad){if(item.kind==='image')images.push(item);else if(item.kind==='video')videos.items.push(item)}
    }
    if(offset===0&&images.length<8){
      for(const term of variants.slice(0,2)){
        const extra=await searchOpenverse(term);
        if(extra.error)errors.push(extra.error);
        images=images.concat(extra.items);
        if(images.length>=12)break;
      }
    }

    const seen=new Set(),results=[];
    const add=asset=>{
      if(!asset?.url)return;
      const key=asset.kind+'|'+String(asset.originalUrl||asset.url).split('?')[0]+'|'+String(asset.title||'').toLowerCase();
      if(seen.has(asset.id)||seen.has(key))return;
      seen.add(asset.id);seen.add(key);results.push(asset);
    };
    for(const asset of images)if(asset.kind==='image')add(asset);
    for(const asset of videos.items)if(asset.kind==='video')add(asset);

    const photoCount=results.filter(x=>x.kind==='image').length;
    const videoCount=results.filter(x=>x.kind==='video').length;
    const payload={
      results:results.slice(0,80),
      nextOffset:(photos.more||videos.more)?offset+30:null,
      source:videoCount&&photoCount?'Wikimedia Commons':photoCount?'Wikimedia Commons / Openverse':'Wikimedia Commons',
      counts:{photos:photoCount,videos:videoCount},
      errors,
      message:results.length?undefined:(errors[0]||'No suitable media found for this search.'),
      error:results.length?undefined:(errors[0]||'No suitable Wikimedia media found for this search.')
    };
    if(results.length)serverMediaCache.set(cacheKey,{at:Date.now(),body:payload});
    return send(res,results.length?200:502,{'Content-Type':'application/json','Cache-Control':'no-store'},JSON.stringify(payload));
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