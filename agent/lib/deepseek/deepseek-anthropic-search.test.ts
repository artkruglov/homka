import {describe,it,expect} from 'vitest';
import {deepSeekSearchWire} from './deepseek-anthropic-search.js';
import {z} from 'zod';
import {errandToolInput} from '../errands/errand-contract.js';

describe('DeepSeek object tool schema compatibility',()=>{
 it('accepts the real errand union without changing its branches or runtime validation',()=>{
  const schema=z.toJSONSchema(errandToolInput,{io:'input'});
  const body={tools:[{name:'manage_errand',input_schema:schema}]};
  const result=deepSeekSearchWire(body,'request');
  expect(result.tools[0].input_schema).toEqual({...schema,type:'object'});
  expect(schema.type).toBeUndefined();
  expect(errandToolInput.safeParse({action:'research'}).success).toBe(false);
  expect(errandToolInput.safeParse({action:'research',id:'f9630612-a105-43e1-99a2-f8f330bdf621',version:1,text:'injected result'}).success).toBe(false);
 });
 it('adds the root type to object-only oneOf and discriminated unions',()=>{
  for(const key of ['anyOf','oneOf']){
   const schema={[key]:[{type:'object',properties:{action:{const:'start'}}},{type:'object',properties:{action:{const:'status'}}}]};
   const tool={name:'example',input_schema:schema};
   expect(deepSeekSearchWire({tools:[tool]},'request').tools[0].input_schema).toEqual({...schema,type:'object'});
  }
 });
 it('does not narrow arbitrary schemas, alter native search tools, or rewrite tool data',()=>{
  for(const schema of [{type:'object',properties:{}},{anyOf:[{type:'object'},{type:'string'}]},
   {anyOf:[{$ref:'#/$defs/example'}]}, {anyOf:[]}, {type:'string'}, {}]){
   const body={tools:[{name:'example',input_schema:schema},{type:'web_search_20250305',name:'web_search'}]};
   expect(deepSeekSearchWire(body,'request')).toEqual(body);
   expect(deepSeekSearchWire(body,'response')).toEqual(body);
  }
  const data={content:[{type:'tool_result',content:{tools:[{input_schema:{anyOf:[{type:'object'}]}}]}}]};
  expect(deepSeekSearchWire(data,'request')).toEqual(data);
 });
});

describe('DeepSeek Anthropic search error compatibility',()=>{
 const error={type:'web_search_tool_result_error',error_code:'unavailable'};
 it('wraps the SDK error object for DeepSeek replay without changing history',()=>{
  const body={messages:[{role:'assistant',content:[{type:'web_search_tool_result',tool_use_id:'s1',content:error}]}]};
  expect(deepSeekSearchWire(body,'request').messages[0].content[0].content).toEqual([error]);
  expect(body.messages[0].content[0].content).toEqual(error);
 });
 it('normalizes provider error arrays for the SDK, including SSE blocks',()=>{
  const block={type:'web_search_tool_result',tool_use_id:'s1',content:[error]};
  expect(deepSeekSearchWire({content_block:block},'response').content_block.content).toEqual(error);
 });
 it('preserves successful results and ordinary tool JSON',()=>{
  const body={content:[{type:'web_search_tool_result',content:[{type:'web_search_result',url:'https://example.org',encrypted_content:'opaque'}]},{type:'tool_result',content:{type:'web_search_tool_result_error'}}]};
  expect(deepSeekSearchWire(body,'response')).toEqual(body);
 });
});

import {deepSeekAnthropicSearchFetch} from './deepseek-anthropic-search.js';
it('adapts a replay request and fragmented SSE without losing successful search data',async()=>{
 const error={type:'web_search_tool_result_error',error_code:'max_uses_exceeded'};
 const event={type:'content_block_start',index:1,content_block:{type:'web_search_tool_result',tool_use_id:'s1',content:[error]}};
 const source='event: content_block_start\r\ndata: '+JSON.stringify(event)+'\r\n\r\ndata: [DONE]\n\n';
 let sent:unknown;
 const fetch=deepSeekAnthropicSearchFetch(async(_input,init)=>{
  sent=JSON.parse(String(init?.body));
  const bytes=new TextEncoder().encode(source);
  return new Response(new ReadableStream({start(controller){
   for(let i=0;i<bytes.length;i+=7) controller.enqueue(bytes.slice(i,i+7));
   controller.close();
  }}),{headers:{'content-type':'text/event-stream'}});
 });
 const history={messages:[{role:'assistant',content:[{type:'web_search_tool_result',tool_use_id:'s0',content:error}]}]};
 const response=await fetch('https://api.deepseek.com/anthropic/messages',{body:JSON.stringify(history)});
 expect(sent).toEqual(deepSeekSearchWire(history,'request'));
 const output=await response.text();
 expect(output).toContain('event: content_block_start\r\n');
 expect(output).toContain('data: [DONE]');
 const data=output.split('\n').find(line=>line.startsWith('data: {'))!;
 expect(JSON.parse(data.slice(6)).content_block.content).toEqual(error);
});
