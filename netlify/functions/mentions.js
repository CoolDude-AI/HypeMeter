const DEFAULT_WINDOW_MIN = 60;
const FETCH_TIMEOUT_MS = 10_000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

const NAME_BY_TICKER = {
  NVDA:"NVIDIA",AAPL:"Apple",MSFT:"Microsoft",AMZN:"Amazon",GOOGL:"Alphabet",META:"Meta",TSLA:"Tesla",AMD:"AMD",PLTR:"Palantir",
  NFLX:"Netflix",COIN:"Coinbase",GME:"GameStop",AMC:"AMC",RIVN:"Rivian",SNAP:"Snap",UBER:"Uber",SPOT:"Spotify",SHOP:"Shopify",DIS:"Disney",NIO:"NIO"
};
const cache = new Map();
const sleep = (ms) => new Promise(r=>setTimeout(r,ms));

function timespanParam(m){ return m%60===0?`${m/60}h`:`${m}m`; }
function httpRes(code,body){ return { statusCode:code, headers:{'Content-Type':'application/json',...CORS}, body:JSON.stringify(body)}; }

const withTimeout=(url,opts={},ms=FETCH_TIMEOUT_MS)=>{
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),ms);
  return fetch(url,{...opts,signal:ctrl.signal}).finally(()=>clearTimeout(t));
};

async function fetchGdelt(url,attempt=1){
  try{
    const res=await withTimeout(url);
    if(!res.ok) throw new Error(res.status);
    return await res.json().catch(()=>({}));
  }catch(e){
    if(attempt<3){await sleep(300*attempt);return fetchGdelt(url,attempt+1);}
    return {};
  }
}
function sumTimeline(j){return (j?.timeline?.[0]?.data||[]).reduce((a,d)=>a+(+d?.value||0),0);}

exports.handler=async e=>{
  if(e.httpMethod==='OPTIONS') return httpRes(200,{ok:true});
  try{
    const u=new URL(e.rawUrl);
    const tickers=(u.searchParams.get('tickers')||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    const windowMin=Math.max(1,Math.min(1440,+u.searchParams.get('window')||DEFAULT_WINDOW_MIN));
    if(!tickers.length) return httpRes(400,{error:'tickers required'});

    const key=`${tickers.join(',')}|${windowMin}`, now=Date.now(), c=cache.get(key);
    if(c && now-c.ts<60_000) return httpRes(200,c.data);

    const results={}, MAX=4; let i=0;
    async function worker(){
      while(i<tickers.length){
        const t=tickers[i++], name=NAME_BY_TICKER[t]||t, span=timespanParam(windowMin);
        try{
          const q1=encodeURIComponent(`(${t} OR "${name}" OR "$${t}") AND sourcelang:english`);
          let j=await fetchGdelt(`https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=TimelineVol&timespan=${span}&query=${q1}`);
          let v=sumTimeline(j);
          if(!v){
            const q2=encodeURIComponent(`(${t} OR "${name}" OR "$${t}")`);
            j=await fetchGdelt(`https://api.gdeltproject.org/api/v2/doc/doc?format=json&mode=TimelineVol&timespan=${span}&query=${q2}`);
            v=sumTimeline(j);
          }
          results[t]=Number.isFinite(v)?Math.max(0,Math.floor(v)):0;
          await sleep(80);
        }catch{ results[t]=0; await sleep(120); }
      }
    }
    await Promise.all(Array.from({length:Math.min(MAX,tickers.length)},worker));
    cache.set(key,{ts:now,data:results});
    return httpRes(200,results);
  }catch(err){return httpRes(500,{error:'mentions failed',detail:String(err?.message||err)})}
};
