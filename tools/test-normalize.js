const fs=require('fs');
const wf=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const code=wf.nodes.find(n=>n.name==='Normalize Lead Payload').parameters.jsCode;
const run=(items)=>{ const fn=new Function('$input','$execution', code); return fn({all:()=>items.map(j=>({json:j}))},{id:'exec_1'}); };

const cases={
 'inbound SMS':      {body:{MessageSid:'SM123',From:'+15551234567',To:'+15559998888',Body:'Tuesday at 2 works for me!',NumMedia:'0'}},
 'SMS with media':   {body:{MessageSid:'SM124',From:'+1 (555) 123-4567',To:'+15559998888',Body:'',NumMedia:'2'}},
 'missed call':      {body:{CallSid:'CA1',CallStatus:'no-answer',From:'+15551112222',To:'+15559998888',CallDuration:'0',FromCity:'AUSTIN'}},
 'completed 0s':     {body:{CallSid:'CA2',CallStatus:'completed',From:'+15551112222',To:'+15559998888',CallDuration:'0'}},
 'web form':         {body:{name:'Dana Ruiz',phone:'555-444-3333',email:'d@x.com',message:'Need a quote',client_phone:'+15559998888'}},
 'imap email':       {from:{text:'"Sam Lee" <sam@lead.com>'},subject:'New Lead',textPlain:'Call me at (555) 777-6666',to:{value:[{address:'leads@biz.com'}]},messageId:'<m1>'},
};
for(const [k,v] of Object.entries(cases)){
  try{ const r=run([v])[0].json;
    console.log(k.padEnd(16),'| ch='+r.channel_source.padEnd(12),'lead='+String(r.lead_phone).padEnd(13),'tenant='+String(r.client_id_or_number).padEnd(13),'| '+String(r.raw_message).slice(0,52));
  }catch(e){ console.log(k.padEnd(16),'| THROW: '+e.message.slice(0,90)); }
}
