import { describe, expect, it, vi } from "vitest";
import { createOpenRouterImageClient } from "./openrouter-image-client.js";

const input = { prompt: 'A yellow house', size: '1536x1024', quality: 'auto', background: 'auto' } as const;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1sAAAAASUVORK5CYII=', 'base64');
describe('OpenRouter image transport', () => {
  it('passes the actual reference bytes to the image endpoint in one request', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({data:[{b64_json:png.toString('base64')}]}));
    const reference = {bytes: png, mediaType: 'image/png' as const};
    await createOpenRouterImageClient({apiKey:'key',model:'openai/gpt-image-2.5-sunburst',fetch})
      .generate({...input, references:[reference]});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetch.mock.calls[0]![1].body).input_references).toEqual([
      {type:'image_url',image_url:{url:`data:image/png;base64,${png.toString('base64')}`}},
    ]);
  });
  it('uses one dedicated image request and returns validated raster bytes', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({data:[{b64_json:png.toString('base64')}]}));
    const client = createOpenRouterImageClient({apiKey:'test-key',model:'google/gemini-3.1-flash-image',fetch});
    const result = await client.generate(input);
    expect(result.mediaType).toBe('image/png');
    expect(result.bytes).toEqual(png);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url,init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse(init.body)).toEqual({model:'google/gemini-3.1-flash-image',prompt:input.prompt,n:1,aspect_ratio:'3:2'});
  });
  it.each([401,402,403,429])('classifies HTTP %s as a definitive rejection', async status => {
    const fetch = vi.fn().mockResolvedValue(new Response('',{status}));
    await expect(createOpenRouterImageClient({apiKey:'key',model:'a/b',fetch}).generate(input))
      .rejects.toMatchObject({code:'AGENT_IMAGE_GENERATION_REJECTED'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['network','500','invalid-json','svg','oversize','multiple'])('never retries ambiguous %s outcomes', async kind => {
    const fetch = vi.fn();
    if(kind==='network') fetch.mockRejectedValue(new Error('secret transport detail'));
    else if(kind==='500') fetch.mockResolvedValue(new Response('',{status:500}));
    else if(kind==='invalid-json') fetch.mockResolvedValue(new Response('{'));
    else if(kind==='oversize') fetch.mockResolvedValue(new Response('{}',{headers:{'content-length':'999999999'}}));
    else fetch.mockResolvedValue(Response.json({data:kind==='multiple' ? [{b64_json:png.toString('base64')},{b64_json:png.toString('base64')}] : [{b64_json:Buffer.from('<svg/>').toString('base64')}]}));
    await expect(createOpenRouterImageClient({apiKey:'key',model:'a/b',fetch}).generate(input))
      .rejects.toMatchObject({code:'AGENT_IMAGE_GENERATION_STATUS_UNKNOWN'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('requires explicit key and model before making any request', async () => {
    const fetch=vi.fn();
    await expect(createOpenRouterImageClient({apiKey:'',model:'',fetch}).generate(input))
      .rejects.toMatchObject({code:'AGENT_IMAGE_GENERATION_CONFIG_INVALID'});
    expect(fetch).not.toHaveBeenCalled();
  });
});
