/** DeepSeek wire compatibility for native search errors and object-only tool unions. */
import type { FetchFunction } from '@ai-sdk/provider-utils';
import { AppError } from '../app-error.js';
type Direction = 'request' | 'response';
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function objectToolRoot(tool: unknown): unknown {
  if (!record(tool) || !record(tool.input_schema)) return tool;
  const schema = tool.input_schema;
  if (schema.type !== undefined) return tool;
  // Zod unions already require an object in every branch. DeepSeek additionally requires
  // that same type at the root; retaining all branches preserves the validation contract.
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : schema.oneOf;
  if (!Array.isArray(branches) || branches.length === 0 ||
      !branches.every(branch => record(branch) && branch.type === 'object')) return tool;
  return {...tool, input_schema: {...schema, type: 'object'}};
}
function block(value: unknown, direction: Direction): unknown {
  if (!record(value) || value.type !== 'web_search_tool_result') return value;
  const content = value.content;
  if (direction === 'request' && record(content) && content.type === 'web_search_tool_result_error') {
    return {...value, content: [content]};
  }
  if (direction === 'response' && Array.isArray(content) && content.length === 1 &&
      record(content[0]) && content[0].type === 'web_search_tool_result_error') {
    return {...value, content:content[0]};
  }
  return value;
}
export function deepSeekSearchWire<T>(value: T, direction: Direction): T {
  if (!record(value)) return value;
  const result: RecordValue = {...value};
  if (direction === 'request' && Array.isArray(value.tools)) result.tools = value.tools.map(objectToolRoot);
  if (Array.isArray(value.messages)) result.messages = value.messages.map(message => deepSeekSearchWire(message,direction));
  if (Array.isArray(value.content)) result.content = value.content.map(part=>block(part,direction));
  if (record(value.content_block)) result.content_block = block(value.content_block,direction);
  return result as T;
}

export function deepSeekAnthropicSearchFetch(request: FetchFunction): FetchFunction {
  return async (input, init) => {
    const outgoing = typeof init?.body === 'string'
      ? {...init,body:JSON.stringify(deepSeekSearchWire(JSON.parse(init.body),'request'))}
      : init;
    const response = await request(input,outgoing);
    if (!response.ok || !response.body) return response;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    if (!headers.get('content-type')?.includes('text/event-stream')) {
      return new Response(JSON.stringify(deepSeekSearchWire(await response.json(),'response')),
        {status:response.status,headers});
    }
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';
    function line(value: string): string {
      if (!value.startsWith('data:')) return value;
      const data=value.slice(5).trim();
      if (!data || data === '[DONE]') return value;
      return 'data: '+JSON.stringify(deepSeekSearchWire(JSON.parse(data),'response'));
    }
    const stream = response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk,{stream:true});
        let end;
        while ((end=pending.indexOf('\n')) >= 0) {
          if (end > 2_000_000) throw new AppError('AGENT_DEEPSEEK_SEARCH_PAYLOAD_TOO_LARGE','Слишком большой ответ поискового сервиса');
          controller.enqueue(encoder.encode(line(pending.slice(0,end))+'\n'));
          pending=pending.slice(end+1);
        }
        if (pending.length > 2_000_000) throw new AppError('AGENT_DEEPSEEK_SEARCH_PAYLOAD_TOO_LARGE','Слишком большой ответ поискового сервиса');
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(line(pending)));
      },
    }));
    return new Response(stream,{status:response.status,headers});
  };
}
