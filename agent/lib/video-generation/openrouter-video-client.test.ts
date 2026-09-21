import { describe, expect, it, vi } from 'vitest';
import { createOpenRouterVideoClient } from './openrouter-video-client.js';

const input = { model: 'minimax/hailuo-3-max', prompt: 'A kettle steaming', duration: 5,
  resolution: '480p', aspectRatio: '16:9' } as const;
const catalog = {data: [{id: input.model, supported_durations: [5,6],
  supported_resolutions: ['480p','768p'], supported_aspect_ratios: ['16:9','1:1']}]};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {status});
const submitRefusal = async (fetch: typeof globalThis.fetch): Promise<Error> => {
  try { await createOpenRouterVideoClient({apiKey:'secret-key',fetch}).submit(input); }
  catch (refusal) { return refusal as Error; }
  throw new Error('submit resolved instead of refusing');
};

describe('OpenRouter video jobs', () => {
  it('retains confirmed usage and recognizes terminal cancelled or expired jobs',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(json({id:'job_abc',status:'completed',usage:{cost:1.1556}}))
      .mockResolvedValueOnce(json({id:'job_abc',status:'expired'}));
    const client=createOpenRouterVideoClient({apiKey:'key',fetch});
    expect(await client.inspectStatus('job_abc')).toEqual({status:'completed',actualCostMicros:1155600});
    expect(await client.inspectStatus('job_abc')).toEqual({status:'failed'});
  });
  it('transmits a supplied first frame and exact dimensions rather than only its description',async()=>{
    const fetch=vi.fn().mockResolvedValue(json({id:'job_photo'},202));
    await createOpenRouterVideoClient({apiKey:'key',fetch}).submit({...input,model:'bytedance/seedance-2.5',
      size:'1280x720',firstFrame:{bytes:Buffer.from('photo'),mediaType:'image/png'}});
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({model:'bytedance/seedance-2.5',prompt:input.prompt,
      duration:5,size:'1280x720',frame_images:[{type:'image_url',frame_type:'first_frame',image_url:{url:'data:image/png;base64,cGhvdG8='}}]});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('validates the live model contract before one billable POST and ignores foreign polling URLs', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(catalog)).mockResolvedValueOnce(json({
      id: 'job_abc', status: 'pending', polling_url: 'https://foreign.example/key-theft',
    },202)).mockResolvedValueOnce(json({id:'job_abc',status:'completed'}));
    const client = createOpenRouterVideoClient({apiKey:'test-key',fetch});
    await client.validate(input);
    expect(await client.submit(input)).toEqual({jobId:'job_abc'});
    expect(await client.status('job_abc')).toBe('completed');
    expect(fetch.mock.calls.map(x=>x[0])).toEqual([
      'https://openrouter.ai/api/v1/videos/models',
      'https://openrouter.ai/api/v1/videos',
      'https://openrouter.ai/api/v1/videos/job_abc',
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({model:input.model,prompt:input.prompt,
      duration:5,resolution:'480p',aspect_ratio:'16:9'});
    expect(fetch.mock.calls[1][1]).toMatchObject({method:'POST',redirect:'error'});
  });
  it('rejects unsupported settings without submitting', async () => {
    const fetch = vi.fn().mockResolvedValue(json(catalog));
    await expect(createOpenRouterVideoClient({apiKey:'key',fetch}).validate({...input,resolution:'720p'}))
      .rejects.toMatchObject({code:'AGENT_VIDEO_PARAMETERS_UNSUPPORTED'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([new Error('network'),json({},503),json({},408),json({status:'pending'},202)])(
    'never repeats an ambiguous submission', async response => {
      const fetch=vi.fn();
      if(response instanceof Error) fetch.mockRejectedValue(response); else fetch.mockResolvedValue(response);
      await expect(createOpenRouterVideoClient({apiKey:'key',fetch}).submit(input))
        .rejects.toMatchObject({code:'AGENT_VIDEO_STATUS_UNKNOWN'});
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  it('quotes why the provider refused the job instead of guessing about the balance', async () => {
    const fetch=vi.fn().mockImplementation(async()=>json({error:{message:'Duration 3s is not supported for this model',
      code:400,metadata:{failed_routing_step:'Validate Video Parameters'}}},400));
    const refusal=await submitRefusal(fetch);
    expect(refusal).toMatchObject({code:'AGENT_VIDEO_REJECTED'});
    expect(refusal.message).toContain('Duration 3s is not supported for this model');
    expect(refusal.message).toContain('Validate Video Parameters');
  });
  it('keeps a refusal readable without leaking the key when the body is not JSON', async () => {
    const fetch=vi.fn().mockResolvedValue(new Response(`<html>\n  bad request for secret-key\n</html>`,{status:422}));
    const refusal=await submitRefusal(fetch);
    expect(refusal.message).toContain('bad request for ***');
    expect(refusal.message).not.toContain('secret-key');
  });
  it('treats a refused job as definitive and validates job identifiers before fetching', async () => {
    const fetch=vi.fn().mockResolvedValue(json({},402));
    const client=createOpenRouterVideoClient({apiKey:'key',fetch});
    await expect(client.submit(input)).rejects.toMatchObject({code:'AGENT_VIDEO_REJECTED'});
    await expect(client.status('../secret')).rejects.toMatchObject({code:'AGENT_VIDEO_JOB_INVALID'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched job responses and non-video content', async () => {
    const fetch=vi.fn().mockResolvedValueOnce(json({id:'other',status:'completed'}))
      .mockResolvedValueOnce(new Response('<html>error</html>',{headers:{'content-type':'video/mp4'}}));
    const client=createOpenRouterVideoClient({apiKey:'key',fetch});
    await expect(client.status('job_abc')).rejects.toMatchObject({code:'AGENT_VIDEO_POLL_FAILED'});
    await expect(client.download('job_abc')).rejects.toMatchObject({code:'AGENT_VIDEO_CONTENT_INVALID'});
  });
  it('bounds streamed content even without a content-length header', async () => {
    const fetch=vi.fn().mockResolvedValue(new Response(new Uint8Array(50*1024*1024+1)));
    await expect(createOpenRouterVideoClient({apiKey:'key',fetch}).download('job_abc'))
      .rejects.toMatchObject({code:'AGENT_VIDEO_CONTENT_TOO_LARGE'});
  });
});
