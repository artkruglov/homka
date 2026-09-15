import { describe, expect, it, vi } from 'vitest';
import { transcribeLocalVoice } from './local-voice-transcription.js';

describe('local voice transcription', () => {
  it('sends validated audio only to the fixed internal service', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({text:'Купить молоко'}));
    await expect(transcribeLocalVoice(new Uint8Array([1,2]), 'test-key', request)).resolves.toBe('Купить молоко');
    expect(request.mock.calls[0][0]).toBe('http://gigaam:8000/transcribe');
    expect(request.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');
    expect(request.mock.calls[0][1].redirect).toBe('error');
  });
  it.each([503,413,422])('does not retry a failed transcription (%s)', async status => {
    const request=vi.fn().mockResolvedValue(new Response('',{status}));
    await expect(transcribeLocalVoice(new Uint8Array([1]),'test',request)).rejects.toThrow(/AGENT_VOICE_/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects an empty transcript', async () => {
    await expect(transcribeLocalVoice(new Uint8Array([1]),'test',async()=>Response.json({text:' '}))).rejects.toThrow(/AGENT_VOICE_TRANSCRIPT_EMPTY/);
  });
});
