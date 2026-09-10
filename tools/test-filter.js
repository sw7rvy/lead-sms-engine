const fs=require('fs');
const wf=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const conds=wf.nodes.find(n=>n.name==='IF Actionable Inbound SMS').parameters.conditions.conditions;
const exprs=conds.map(c=>c.leftValue.replace(/^=\{\{/,'').replace(/\}\}$/,''));
const pass=(body,numMedia)=>exprs.every(e=>new Function('$json','return ('+e+')')({body:{Body:body,NumMedia:numMedia||'0'}}));
const t=[['Tuesday at 2 works!',1],['YES',1],['yes please',1],['Yes',1],['no',1],['STOP',0],['stop.',0],['Stop!',0],['UNSUBSCRIBE',0],['cancel',0],['HELP',0],['start',0],['',0],['   ',0],['I want to stop by at 3pm',1]];
let fail=0;
for(const [b,want] of t){ const got=pass(b)?1:0; if(got!==want){fail++;console.log('MISMATCH '+JSON.stringify(b)+' want='+want+' got='+got);} }
console.log('media-only empty body passes: '+pass('','2'));
console.log(fail===0?'opt-out filter: 15/15 OK':'opt-out filter: '+fail+' mismatches');
