import {describe,expect,it,vi} from 'vitest';
import {createGenerateVideoTool,videoInput} from '../tools/generate_video.js';
import {AppError} from '../app-error.js';
describe('video tool input and dispatch',()=>{
  it('distinguishes requested parameters from unmeasured output on start and status',async()=>{
    const completed={status:'completed' as const,operationKey:'original',path:'video.mp4',delivery:{delivered:true}};
    const runtime={cancelDelivery:vi.fn(),start:vi.fn().mockResolvedValue(completed),
      resume:vi.fn().mockResolvedValue(completed),balance:vi.fn(),list:vi.fn()};
    const tool=createGenerateVideoTool(()=>runtime);
    const started=await tool.execute({action:'start',prompt:'Steam',duration:4,size:'854x480'} as any,{callId:'original'} as any);
    expect(started).toMatchObject({requestedParameters:{durationSeconds:4,size:'854x480'},
      outputMedia:{verification:'not_measured',width:null,height:null,durationSeconds:null},delivery:{delivered:true}});
    const status=await tool.execute({action:'status',jobRef:'original'} as any,{} as any);
    expect(status).toMatchObject({outputMedia:{verification:'not_measured',width:null,height:null,durationSeconds:null}});
    expect(status).not.toHaveProperty('requestedParameters');
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });
  it('returns a recoverable polling result without triggering the identical-failure guard',async()=>{
    const runtime={cancelDelivery:vi.fn(),start:vi.fn(),resume:vi.fn().mockRejectedValue(new AppError('AGENT_VIDEO_POLL_FAILED','Unavailable')),balance:vi.fn(),list:vi.fn()};
    const result=await createGenerateVideoTool(()=>runtime).execute({action:'status',jobRef:'original'} as any,{} as any);
    expect(result).toMatchObject({status:'pending',operationKey:'original',retryAfterSeconds:30,diagnosticCode:'AGENT_VIDEO_POLL_FAILED'});
    expect(runtime.start).not.toHaveBeenCalled();
  });
  it('does not accept model-authored billing identity, price or model',()=>{
    for(const field of ['actorTelegramId','price','model','scope']){
      expect(videoInput.safeParse({action:'start',prompt:'Steam',size:'1280x720',duration:5,[field]:'injected'}).success).toBe(false);
    }
    expect(videoInput.safeParse({action:'start',prompt:'Steam',referencePath:'a.png',referenceAttachmentId:'11111111-1111-4111-8111-111111111111'}).success).toBe(false);
  });
  it('uses the current call id for start and an existing job reference only for status',async()=>{
    const runtime={cancelDelivery:vi.fn(),start:vi.fn().mockResolvedValue({status:'pending',operationKey:'call-1'}),
      resume:vi.fn().mockResolvedValue({status:'completed'}),balance:vi.fn(),list:vi.fn()};
    const tool=createGenerateVideoTool(()=>runtime);
    await tool.execute({action:'start',prompt:'Steam',duration:5,size:'1280x720'} as any,{callId:'call-1'} as any);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({operationKey:'call-1'}));
    await tool.execute({action:'status',jobRef:'call-1'} as any,{callId:'different-call'} as any);
    expect(runtime.resume).toHaveBeenCalledWith('call-1');
    await tool.execute({action:'cancel_delivery',jobRef:'call-1'} as any,{callId:'cancel-call'} as any);
    expect(runtime.cancelDelivery).toHaveBeenCalledWith('call-1');
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });
});
