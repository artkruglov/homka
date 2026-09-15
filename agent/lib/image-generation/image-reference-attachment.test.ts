import {describe, expect, it, vi} from 'vitest';
import {createImageReferenceAttachmentReader} from './image-reference-attachment.js';

describe('image reference attachment access',()=>{
  it('does not download after a revoked or foreign journal reference',async()=>{
    const find=vi.fn().mockRejectedValue(new Error('access denied'));
    const download=vi.fn();
    await expect(createImageReferenceAttachmentReader({find,download})({} as never,'foreign')).rejects.toThrow('access denied');
    expect(download).not.toHaveBeenCalled();
  });
  it('rejects oversized metadata before downloading',async()=>{
    const find=vi.fn().mockResolvedValue({attachment:{size:9*1024*1024}});
    const download=vi.fn();
    await expect(createImageReferenceAttachmentReader({find,download})({} as never,'photo')).rejects.toMatchObject({code:'AGENT_IMAGE_REFERENCE_INVALID'});
    expect(download).not.toHaveBeenCalled();
  });
});
