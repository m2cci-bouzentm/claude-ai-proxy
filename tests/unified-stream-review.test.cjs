const {test}=require('node:test');const assert=require('node:assert/strict');const express=require('express');
const {createToolRouter}=require('../dist/routes/tools');
const service=require('../dist/services/tool.service');const {toolRequestSchema}=require('../dist/schemas/tool.schema');
test('unified route streams text before completion and retains cache/usage and images',async()=>{
 let release;const encoder=new TextEncoder();const encode=e=>encoder.encode('event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n');
 const response=new Response(new ReadableStream({start(c){
  for(const e of [{type:'message_start',message:{id:'m',type:'message',role:'assistant',model:'claude-sonnet-4-6',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0,cache_read_input_tokens:7}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'EARLY'}}])c.enqueue(encode(e));
  release=()=>{for(const e of [{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}])c.enqueue(encode(e));c.close();};
 }}),{headers:{'content-type':'text/event-stream'}});
 const app=express();app.use(express.json());let upstream;
 app.use(createToolRouter(async body=>{upstream=body;return response;},'claude-sonnet-4-6'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1500);
  let reader,first;
  try{const r=await fetch(`http://127.0.0.1:${server.address().port}/chat/completions`,{signal:controller.signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'claude-sonnet-4-6',stream:true,stream_options:{include_usage:true},messages:[{role:'user',content:[{type:'text',text:'hi'},{type:'image_url',image_url:{url:'https://example.com/image.png'}}]}]})});reader=r.body.getReader();first=new TextDecoder().decode((await reader.read()).value);}finally{clearTimeout(timer);}
  assert.match(first,/EARLY/);assert.doesNotMatch(first,/\[DONE\]/);release();release=null;
  let rest='';for(;;){const r=await reader.read();if(r.done)break;rest+=new TextDecoder().decode(r.value);}assert.match(rest,/cached_tokens":7/);assert.match(rest,/\[DONE\]/);
  assert.equal(upstream.messages[0].content[1].type,'image');assert.ok(upstream.cache_control);assert.deepEqual(upstream.thinking,{type:'adaptive'});
 }finally{release?.();server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('unified thinking policy never enables adaptive thinking for forced tool calls',()=>{
 const body=toolRequestSchema.parse({model:'claude-sonnet-4-6',messages:[{role:'user',content:'hi'}],tools:[{type:'function',function:{name:'echo',parameters:{type:'object'}}}],tool_choice:'required'});
 assert.equal(service.prepareToolRequest(body,'fallback').request.thinking,undefined);
});
test('adaptive thinking omits incompatible sampling parameters',()=>{
 const body=toolRequestSchema.parse({model:'claude-sonnet-4-6',messages:[{role:'user',content:'hi'}],temperature:0.2,top_p:0.9});
 const request=service.prepareToolRequest(body,'fallback').request;
 assert.deepEqual(request.thinking,{type:'adaptive'});
 assert.equal(request.temperature,undefined);
 assert.equal(request.top_p,undefined);
});

test('unified endpoint preserves max_tokens precedence when both output limits are supplied',()=>{
 const body=toolRequestSchema.parse({model:'claude-sonnet-4-6',messages:[{role:'user',content:'hi'}],max_tokens:128,max_completion_tokens:256});
 assert.equal(service.prepareToolRequest(body,'fallback').request.max_tokens,128);
});
