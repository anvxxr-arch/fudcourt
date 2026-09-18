const RPC='https://bsc.publicnode.com';
async function rpc(m,p){const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});const j=await r.json();if(j.error)throw new Error(JSON.stringify(j.error));return j.result;}
const latest=parseInt(await rpc('eth_blockNumber',[]),16);
const blk=await rpc('eth_getBlockByNumber',['0x'+latest.toString(16),false]);
console.log('latest',latest,new Date(parseInt(blk.timestamp,16)*1000).toISOString());
// Sep 9 2026 00:00 UTC = ?
const target=Date.UTC(2026,8,9,0,0,0)/1000;
const now=parseInt(blk.timestamp,16);
console.log('now ts',now,'target ts',target,'secs back',now-target,'blocks est',Math.round((now-target)/0.75));
// sample to find block at target
async function blkTs(n){const b=await rpc('eth_getBlockByNumber',['0x'+n.toString(16),false]);return parseInt(b.timestamp,16);}
for(const n of [latest-200000,latest-400000,latest-600000,latest-800000,latest-1000000]){
  try{console.log(n, new Date((await blkTs(n))*1000).toISOString());}catch(e){console.log(n,'ERR',e.message.slice(0,80));}
}