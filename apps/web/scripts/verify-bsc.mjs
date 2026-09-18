import fs from 'node:fs';
const RPCS = ['https://bsc-dataseed.bnbchain.org','https://bsc.publicnode.com','https://bsc-dataseed1.defibit.io','https://binance.llamarpc.com'];
const USDT='0x55d398326f99059ff775485246999027b3197955';
const TRANSFER='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
async function rpc(m,p){
  for(const u of RPCS){
    try{
      const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});
      const j=await r.json();
      if(j.result!==undefined) return j.result;
    }catch(e){}
  }
  return null;
}
const pad=a=>'0x'+a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const txt=fs.readFileSync('/home/dwizzy/wallet_combined_2months_enriched.csv','utf8').replace(/\r/g,'');
const lines=txt.split('\n').filter(l=>l.trim());
const hdr=lines[0].split(',');
const recs=lines.slice(1).map(l=>{const p=l.split(',');const o={};hdr.forEach((h,i)=>o[h]=p[i]);return o;});
const targets=recs.filter(r=>/Binance-Peg/.test(r.asset||'') && r.time>='2026-09-09' && Number(r.usd_value||0)>0);
console.log('targets:',targets.length);
const out=[];
for(const t of targets){
  const h=t.hash;
  if(!h||!h.startsWith('0x')){ out.push({t,err:'no hash'}); continue; }
  const tx=await rpc('eth_getTransactionByHash',[h]);
  const rc=await rpc('eth_getTransactionReceipt',[h]);
  if(!tx||!rc){ out.push({t,err:'rpc fail'}); continue; }
  const logs=(rc.logs||[]).filter(l=>l.address.toLowerCase()===USDT && l.topics[0]===TRANSFER);
  const tr=logs.map(l=>({
    from:'0x'+l.topics[1].slice(26),
    to:'0x'+l.topics[2].slice(26),
    value:(Number(BigInt(l.data))/1e18).toFixed(6)
  }));
  out.push({time:t.time,type:t.type,dir:t.direction,amount:t.amount,usd:t.usd_value,hash:h,
    from:tx.from,to:tx.to,status:rc.status,tr});
}
fs.writeFileSync('/tmp/bsc_verified.json',JSON.stringify(out,null,1));
for(const o of out){
  console.log('\n---',o.time,o.type,o.dir,o.amount,'USDT=$'+o.usd);
  console.log('   hash',o.hash);
  if(o.err){console.log('   ERR',o.err);continue;}
  console.log('   tx.from',o.from,'-> to',o.to,'status',o.status);
  for(const x of o.tr) console.log('   USDT',x.value,'| from',x.from,'-> to',x.to);
}