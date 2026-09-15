import { describe, expect, it, vi } from "vitest";
import { createConfiguredLanguageModel } from "../model-transport.js";
import { runErrandResearch } from "./errand-research-runner.js";

const selection={text:"Парк у реки",sources:[{url:"https://example.org/park",checkedAt:"2026-09-13T12:00:00Z"}]};
function response(search=true){return Response.json({
  id:"msg_research",type:"message",role:"assistant",model:"deepseek-v4-flash",stop_reason:"end_turn",stop_sequence:null,
  content:[...(search?[
    {type:"server_tool_use",id:"search_1",name:"web_search",input:{query:"Парки"}},
    {type:"web_search_tool_result",tool_use_id:"search_1",content:[{type:"web_search_result",url:"https://example.org/park",title:"Парк",encrypted_content:"test",page_age:null}]}
  ]:[]),{type:"text",text:selection.text}],
  usage:{input_tokens:20,output_tokens:40},
});}
function model(fetch:typeof globalThis.fetch){return createConfiguredLanguageModel({
  apiKey:"unused-test",modelId:"deepseek-v4-flash",maxOutputTokens:4096,fetch,
  transport:{protocol:"anthropic-messages",baseUrl:"https://api.deepseek.com/anthropic/v1",authentication:"api-key",reasoning:{type:"none"}},
});}
describe("isolated research provider request",()=>{
  it("uses the configured native transport and only the brief with server search",async()=>{
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));
      expect(body.tools).toEqual([{type:"web_search_20250305",name:"web_search",max_uses:3}]);
      expect(body.tool_choice).toMatchObject({type:"auto"});
      expect(body.thinking).toEqual({type:"disabled"});
      expect(body.messages).toEqual(expect.arrayContaining([expect.objectContaining({role:"user",content:expect.arrayContaining([expect.objectContaining({text:"Парки на выходные"})])})]));
      expect(JSON.stringify(body)).not.toContain("Личная причина");
      return response();
    });
    expect(await runErrandResearch(model(fetch),"Парки на выходные")).toMatchObject({text:selection.text,sources:[{url:selection.sources[0]!.url}]});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves authored paragraphs and Markdown without requiring generated JSON",async()=>{
    const authored="**Подборка**\n\nПервый парк.\n\n- Второй парк\n- Третий парк";
    const fetch=async()=>{const body=await response().json();body.content[2].text=authored;return Response.json(body);};
    expect((await runErrandResearch(model(fetch),"Парки")).text).toBe(authored);
  });
  it("preserves a detailed searched result beyond the chat-sized limit without another paid call",async()=>{
    const longText="Подробная проверенная подборка. ".repeat(180);
    const fetch=vi.fn(async()=>{const body=await response().json();body.content[2].text=longText;return Response.json(body);});
    expect((await runErrandResearch(model(fetch),"Парки")).text).toBe(longText.trim());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a token-limited partial selection even when it has text and sources",async()=>{
    const fetch=vi.fn(async()=>{const body=await response().json();body.stop_reason="max_tokens";return Response.json(body);});
    await expect(runErrandResearch(model(fetch),"Парки")).rejects.toThrow("AGENT_MODEL_OUTPUT_TRUNCATED");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry a 5xx",async()=>{
    const fetch=vi.fn(async()=>Response.json({error:{message:"unavailable"}},{status:503}));
    await expect(runErrandResearch(model(fetch),"Парки")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects a plausible answer without actual provider search",async()=>{
    await expect(runErrandResearch(model(async()=>response(false)),"Парки")).rejects.toThrow("AGENT_ERRAND_SEARCH_NOT_EXECUTED");
  });
  it("takes source URLs from the provider rather than the authored text",async()=>{
    const fetch=async()=>{
      const body=await response().json();
      body.content[1].content[0].url="https://example.org/another";
      return Response.json(body);
    };
    expect((await runErrandResearch(model(fetch),"Парки")).sources.map(s=>s.url)).toEqual(["https://example.org/another"]);
  });
});
