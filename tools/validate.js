const fs=require('fs');
const wf=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
let bad=0;
for(const n of wf.nodes){
  if(n.type==='n8n-nodes-base.code'){
    try{ new Function(n.parameters.jsCode); }
    catch(e){ bad++; console.log('SYNTAX FAIL ['+n.name+']: '+e.message); }
  }
}
// expression sanity
const walk=(o,p)=>{ if(typeof o==='string'){ if(o.startsWith('=')){ const b=(o.match(/\{\{/g)||[]).length, e=(o.match(/\}\}/g)||[]).length; if(b!==e) console.log('UNBALANCED '+p+': '+o.slice(0,80)); if(b===0) console.log('NO-EXPR-BODY '+p+': '+o.slice(0,60)); } return;} if(o&&typeof o==='object'){ for(const k of Object.keys(o)) walk(o[k],p+'.'+k);} };
for(const n of wf.nodes) walk(n.parameters,n.name);
// error-output arity check
for(const n of wf.nodes){
  const c=wf.connections[n.name];
  if(n.onError==='continueErrorOutput'){
    if(!c||c.main.length<2){bad++;console.log('MISSING ERROR BRANCH: '+n.name);}
  }
  // Node types that legitimately expose more than one main output.
  const MULTI_OUT=['n8n-nodes-base.if','n8n-nodes-base.switch','n8n-nodes-base.splitInBatches'];
  if(c && n.onError!=='continueErrorOutput' && c.main.length>1 && !MULTI_OUT.includes(n.type)){
    bad++;
    console.log('UNEXPECTED SECOND OUTPUT: '+n.name);
  }
}
// reachability
const reach=new Set(['Typeform Onboarding Webhook','Twilio Voice Status Webhook','Email Lead Trigger (IMAP)','Web Form Webhook','Twilio Inbound SMS Webhook','Cold Lead Sweep Schedule','Workflow Error Trigger']);
let ch=true; while(ch){ch=false;for(const [s,c] of Object.entries(wf.connections)){ if(!reach.has(s))continue; for(const o of c.main) for(const t of o) if(!reach.has(t.node)){reach.add(t.node);ch=true;} }}
for(const n of wf.nodes) if(n.type!=='n8n-nodes-base.stickyNote'&&!reach.has(n.name)){bad++;console.log('UNREACHABLE: '+n.name);}
console.log(bad===0?'code-nodes: OK':'findings: '+bad);
console.log('nodes reachable: '+reach.size);
// Exit non-zero on any finding so CI actually fails.
process.exit(bad===0?0:1);
