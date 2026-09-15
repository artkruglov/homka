/**
 * Replace only the network I/O: Telegram Bot API and the embedding service. Every other request
 * goes to the network, and an unexpected Telegram method fails the test instead of being faked.
 */
import { database } from "../../../../agent/lib/database.js";
import assert from "node:assert/strict";

const networkFetch = globalThis.fetch;
globalThis.fetch = async (request, init) => {
  const url = new URL(request instanceof Request ? request.url : String(request));
  if (url.hostname === "api.deepseek.com") {
    assert.equal(url.pathname,"/anthropic/v1/messages");
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.tools,[{type:"web_search_20250305",name:"web_search",max_uses:3}]);
    assert.equal(body.tool_choice.type,"auto");
    const userInput=body.messages.filter((message:{role:string})=>message.role === "user");
    assert.deepEqual(userInput,[{role:"user",content:[{type:"text",text:"Парки на выходные"}]}]);
    assert.ok(!JSON.stringify(body).includes("conversation-errand-1"));
    const started=(await database().query("SELECT state FROM errand_research_runs")).rows;
    assert.deepEqual(started,[{state:"started"}],"paid request starts only after the durable claim");
    return Response.json({id:"msg_research",type:"message",role:"assistant",model:"deepseek-v4-flash",stop_reason:"end_turn",stop_sequence:null,
      content:[{type:"server_tool_use",id:"search_1",name:"web_search",input:{query:"Парки"}},
        {type:"web_search_tool_result",tool_use_id:"search_1",content:[{type:"web_search_result",url:"https://example.org/park",title:"Парк",encrypted_content:"test",page_age:null}]},
        {type:"text",text:"Парк у реки — площадка для детей"}],
      usage:{input_tokens:20,output_tokens:40}});
  }
  if (url.hostname === "memory-test" && url.pathname === "/v1/embeddings") {
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: body.model, data: body.input.map((_text: string, index: number) => ({
      index, embedding: [1, ...Array.from({ length: 383 }, () => 0)],
    })) });
  }
  if (url.hostname !== "api.telegram.org") return networkFetch(request, init);
  const method = url.pathname.split("/").at(-1);
  const body = JSON.parse(String(init?.body ?? "{}"));
  if (method === "getChat") {
    return Response.json({ ok: true, result: { id: Number(body.chat_id), type: "supergroup", available_reactions: [] } });
  }
  if (method === "sendChatAction" || method === "setMessageReaction") return Response.json({ ok: true, result: true });
  // Подтверждение действия дорисовывает своё сообщение и закрывает нажатие кнопки: без этих двух
  // методов ход с подтверждением падал бы на транспорте, а не проверял сам механизм.
  if (method === "answerCallbackQuery") return Response.json({ ok: true, result: true });
  if (method === "editMessageText" || method === "editMessageReplyMarkup") {
    return Response.json({ ok: true, result: {
      message_id: Number(body.message_id ?? 1),
      chat: { id: Number(body.chat_id), type: Number(body.chat_id) > 0 ? "private" : "supergroup" },
      date: Math.floor(Date.now() / 1_000),
    } });
  }
  if (method !== "sendMessage" && method !== "sendRichMessage") {
    throw new Error(`TEST_UNEXPECTED_TELEGRAM_METHOD: ${method}`);
  }
  const result = await database().query<{ id: number }>(
    "INSERT INTO telegram_conversation_test_deliveries (body) VALUES ($1) RETURNING id",
    [body],
  );
  return Response.json({ ok: true, result: {
    message_id: result.rows[0]!.id,
    chat: { id: Number(body.chat_id), type: Number(body.chat_id) > 0 ? "private" : "supergroup" },
    date: Math.floor(Date.now() / 1_000),
  } });
};
