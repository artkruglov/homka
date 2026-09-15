import {describe,expect,it} from 'vitest';
import {quoteSeedanceVideo,videoBudgetMonth,usdToMicros} from './video-pricing.js';

const model={id:'bytedance/seedance-2.5',supported_sizes:['1280x720','720x1280'],
  supported_durations:[4,5,10,30],supported_frame_images:['first_frame'],
  pricing_skus:{video_tokens:'0.0000107'}};
describe('video pricing and budget periods',()=>{
  it('covers the measured 854x480 four-second provider charge including the endpoint frame',()=>{
    const measured={...model,supported_sizes:['854x480']};
    const quote=quoteSeedanceVideo(measured,{size:'854x480',duration:4,firstFrame:false});
    // Production receipt on 2026-09-13: USD 0.415481.
    expect(quote.reservedMicros).toBeGreaterThanOrEqual(415481);
  });
  it('reserves exact dimensions including the endpoint frame and rounds up',()=>{
    expect(quoteSeedanceVideo(model,{size:'1280x720',duration:10,firstFrame:false}))
      .toMatchObject({reservedMicros:2320830,model:'bytedance/seedance-2.5'});
    expect(quoteSeedanceVideo(model,{size:'720x1280',duration:10,firstFrame:true}).reservedMicros).toBe(2320830);
  });
  it.each([
    {...model,id:'other/model'}, {...model,pricing_skus:{}},
    {...model,pricing_skus:{video_tokens:'NaN'}}, {...model,supported_sizes:[]},
    {...model,supported_frame_images:[]},
  ])('refuses unknown pricing or unsupported requested input',m=>{
    expect(()=>quoteSeedanceVideo(m,{size:'1280x720',duration:10,firstFrame:true})).toThrow();
  });
  it('uses the Moscow calendar month rather than chat or UTC boundaries',()=>{
    expect(videoBudgetMonth(new Date('2026-09-30T20:59:59Z'))).toBe('2026-09');
    expect(videoBudgetMonth(new Date('2026-09-30T21:00:00Z'))).toBe('2026-10');
  });
  it('never rounds a positive charge down and rejects invalid provider costs',()=>{
    expect(usdToMicros(0.0000001)).toBe(1);
    expect(usdToMicros(2.3112)).toBe(2311200);
    for(const invalid of [NaN,Infinity,-1])expect(()=>usdToMicros(invalid)).toThrow();
  });
});
