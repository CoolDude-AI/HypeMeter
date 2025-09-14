const API='https://finnhub.io/api/v1';
const KEY=process.env.FINNHUB_API_KEY;
const FETCH_TIMEOUT_MS=10_000;
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type'};
const cache=new Map();

function httpRes(c,b){return{statusCode:c,headers:{'Content-Type':'application/json',...CORS},body:JSON.stringify(b)}};
const withTimeout=(url,opts={},ms=FETCH_TIMEOUT_MS)=>{const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),ms);return fetch(url,{...opts,signal:ctrl.signal}).finally(()=>clearTimeout(t))};
const num=(v,d=0)=>{const n=Number(v);return Number.isFinite(n)?n:d};

async function getQuote(t){
  const res=await withTimeout(`${API}/quote?symbol=${encodeURIComponent(t)}&token=${KEY}`);
  if(!res.ok) throw new Error(`quote ${t} ${res.status}`);
  const j=await res.json().catch(()=>({}));
  return { c:num(j.c,NaN), pc:num(j.pc,NaN), v:num(j.v,NaN) };
}
async function getMetrics(t){
  const res=await withTimeout(`${API}/stock/metric?symbol=${encodeURIComponent(t)}&metric=all&token=${KEY}`);
  if(!res.ok) throw new Error(`metric ${t} ${res.status}`);
  const j=await res.json().catch(()=>({}));
  const m=j?.metric||{};
  const avgVol = num(m['10DayAverageTradingVolume'],NaN) || num(m['3MonthAverageTradingVolume'],NaN) || num(m['52WeekAverageVolume'],NaN) || NaN;
  return { avgVol };
}
const computeChgPct=(c,pc)=> (!Number.isFinite(c)||!Number.isFinite(pc)||pc===0)?0:((c-pc)/pc)*100;
const computeVolRel=(today,avg)=>{
  if(!Number.isFinite(today)||today<=0) return 1;
  if(!Number.isFinite(avg)||avg<=0) return 1;
  const r=today/avg;
  return Math.max(0.3,Math.min(3,r));
};

exports.handler=async (e)=>{
  if(e.httpMethod==='OPTIONS') return httpRes(200,{ok:true});
  try{
    if(!KEY) return httpRes(500,{error:'Missing FINNHUB_API_KEY env var'});
    const u=new URL(e.rawUrl);
    const tickers=(u.searchParams.get('tickers')||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    if(!tickers.length) return httpRes(400,{error:'tickers required, e.g. ?tickers=NVDA,AAPL'});

    const out={}, now=Date.now(), MAX=4; let i=0;
    async function worker(){
      while(i<tickers.length){
        const t=tickers[i++];
        try{
          const cached=cache.get(t);
          if(cached && now-cached.ts<30_000){ out[t]=cached.data; continue; }
          const [qRes,mRes]=await Promise.allSettled([getQuote(t),getMetrics(t)]);
          const quote=qRes.status==='fulfilled'?qRes.value:{c:NaN,pc:NaN,v:NaN};
          const metrics=mRes.status==='fulfilled'?mRes.value:{avgVol:NaN};
          const chgPct=num(computeChgPct(quote.c,quote.pc),0);
          const volRel=num(computeVolRel(quote.v,metrics.avgVol),1);
          const data={chgPct,volRel};
          out[t]=data;
          cache.set(t,{ts:now,data});
        }catch{
          out[t]={chgPct:0,volRel:1};
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(MAX,tickers.length)},worker));
    return httpRes(200,out);
  }catch(err){
    return httpRes(500,{error:'quotes failed',detail:String(err?.message||err)});
  }
};
