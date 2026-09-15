import {describe,expect,it,vi} from 'vitest';
import {AppError} from '../app-error.js';
import {createVideoGenerationService,createVideoResumptionService} from './video-generation-service.js';
import {SEEDANCE_MODEL} from './video-pricing.js';
const request={operationKey:'call-1',prompt:'A kettle steaming',duration:5,size:'1280x720'};
const access={workspaceId:'workspace-1',targetKey:'private:123',actorTelegramId:'123',scope:'personal' as const};
function setup(){
  let operation:any=null;
  const authorize=vi.fn().mockResolvedValue(access);
  const operations={
    begin:vi.fn(async(input:any)=>{
      const execute=!operation;
      operation??={...input,status:'started',jobId:null,file:null,errorCode:null};
      return {execute,operation};
    }),
    get:vi.fn(async()=>operation),
    submitted:vi.fn(async(_key:string,jobId:string)=>{operation={...operation,status:'submitted',jobId};}),
    complete:vi.fn(async(_key:string,file:any)=>{operation={...operation,status:'completed',file};}),
    fail:vi.fn(async(_key:string,status:string,errorCode:string)=>{operation={...operation,status,errorCode};}),
  };
  const client={assertConfigured:vi.fn(),quote:vi.fn().mockResolvedValue({reservedMicros:1155600}),
    submit:vi.fn().mockResolvedValue({jobId:'job-1'}),
    inspectStatus:vi.fn().mockResolvedValue({status:'pending',actualCostMicros:0}),
    download:vi.fn().mockResolvedValue(Buffer.from('mp4'))};
  const budget={settle:vi.fn()};
  const files={find:vi.fn().mockResolvedValue(null),write:vi.fn(async(_access:any,input:any)=>({
    path:input.path,scope:access.scope,mediaType:'video/mp4',byteSize:3,
    contentSha256:'a'.repeat(64),updatedAt:'2026-09-13T00:00:00Z'})),deliver:vi.fn().mockResolvedValue({delivered:true})};
  const service=createVideoGenerationService({authorize,operations,client,budget,files});
  return {service,authorize,operations,client,budget,files};
}
describe('recoverable video generation',()=>{
  it('releases an unspent hold when cancellation arrives after reservation but before submit',async()=>{
    const s=setup();const begin=s.operations.begin.getMockImplementation()!;
    s.operations.begin.mockImplementationOnce(async input=>{
      const result=await begin(input);
      s.authorize.mockRejectedValue(new AppError('AGENT_VIDEO_TURN_CANCELLED','Cancelled'));
      return result;
    });
    await expect(s.service.start(request)).rejects.toMatchObject({code:'AGENT_VIDEO_TURN_CANCELLED'});
    expect(s.client.submit).not.toHaveBeenCalled();
    expect(s.operations.fail).toHaveBeenCalledWith('call-1','failed','AGENT_VIDEO_TURN_CANCELLED');
    expect(s.budget.settle).toHaveBeenCalledWith('call-1',0);
  });
  it('retains a job accepted during cancellation for a later status request without recharging',async()=>{
    const s=setup();s.client.submit.mockImplementation(async()=>{
      s.authorize.mockRejectedValue(new AppError('AGENT_VIDEO_TURN_CANCELLED','Cancelled'));
      return {jobId:'job-1'};
    });
    await expect(s.service.start(request)).rejects.toMatchObject({code:'AGENT_VIDEO_TURN_CANCELLED'});
    expect(s.operations.submitted).toHaveBeenCalledWith('call-1','job-1');
    expect(s.budget.settle).not.toHaveBeenCalled();expect(s.files.deliver).not.toHaveBeenCalled();
    s.authorize.mockResolvedValue(access);
    expect(await s.service.resume('call-1')).toMatchObject({status:'pending',operationKey:'call-1'});
    expect(s.client.submit).toHaveBeenCalledTimes(1);
  });
  it('does not quote or reserve without current authorization',async()=>{
    const s=setup();s.authorize.mockRejectedValue(new Error('Denied'));
    await expect(s.service.start(request)).rejects.toThrow('Denied');
    expect(s.client.quote).not.toHaveBeenCalled();expect(s.operations.begin).not.toHaveBeenCalled();
  });
  it('never repeats submit after the provider answered but job persistence failed',async()=>{
    const s=setup();s.operations.submitted.mockRejectedValue(new Error('Database unavailable'));
    await expect(s.service.start(request)).rejects.toMatchObject({code:'AGENT_VIDEO_STATUS_UNKNOWN'});
    await expect(s.service.start(request)).rejects.toMatchObject({code:'AGENT_VIDEO_STATUS_UNKNOWN'});
    expect(s.client.submit).toHaveBeenCalledTimes(1);
    expect(s.budget.settle).not.toHaveBeenCalled();
  });
  it('submits once and resumes pending jobs without settling provisional zero cost',async()=>{
    const s=setup();
    expect(await s.service.start(request)).toMatchObject({status:'pending',operationKey:'call-1'});
    await s.service.resume('call-1');
    expect(s.client.submit).toHaveBeenCalledTimes(1);
    expect(s.client.submit).toHaveBeenCalledWith(expect.objectContaining({model:SEEDANCE_MODEL}));
    expect(s.budget.settle).not.toHaveBeenCalled();
  });
  it('keeps an ambiguous submission reserved and never retries it',async()=>{
    const s=setup();s.client.submit.mockRejectedValue(new AppError('AGENT_VIDEO_STATUS_UNKNOWN','Unknown'));
    await expect(s.service.start(request)).rejects.toMatchObject({code:'AGENT_VIDEO_STATUS_UNKNOWN'});
    await expect(s.service.resume('call-1')).rejects.toMatchObject({code:'AGENT_VIDEO_STATUS_UNKNOWN'});
    expect(s.client.submit).toHaveBeenCalledTimes(1);
    expect(s.budget.settle).not.toHaveBeenCalled();
  });
  it('releases a confirmed rejected submit but keeps unknown terminal job charges reserved',async()=>{
    const s=setup();s.client.submit.mockRejectedValue(new AppError('AGENT_VIDEO_REJECTED','Rejected'));
    await expect(s.service.start(request)).rejects.toMatchObject({code:'AGENT_VIDEO_REJECTED'});
    expect(s.budget.settle).toHaveBeenCalledWith('call-1',0);
    const t=setup();await t.service.start(request);
    t.client.inspectStatus.mockResolvedValue({status:'failed'});
    await expect(t.service.resume('call-1')).rejects.toMatchObject({code:'AGENT_VIDEO_FAILED'});
    expect(t.budget.settle).not.toHaveBeenCalled();
  });
  it('reuses saved results and one delivery identity after a polling continuation',async()=>{
    const s=setup();await s.service.start(request);
    s.client.inspectStatus.mockResolvedValue({status:'completed',actualCostMicros:1100000});
    expect(await s.service.resume('call-1')).toMatchObject({status:'completed'});
    await s.service.resume('call-1');
    expect(s.client.submit).toHaveBeenCalledTimes(1);
    expect(s.client.download).toHaveBeenCalledTimes(1);
    expect(s.files.write).toHaveBeenCalledTimes(1);
    expect(s.files.deliver.mock.calls.map(call=>call[2])).toEqual(['video-delivery:call-1','video-delivery:call-1']);
    expect(s.budget.settle).toHaveBeenCalledWith('call-1',1100000);
  });
  it('checks current rights after a download before writing or delivering',async()=>{
    const s=setup();await s.service.start(request);
    s.client.inspectStatus.mockResolvedValue({status:'completed',actualCostMicros:1100000});
    s.client.download.mockImplementation(async()=>{s.authorize.mockRejectedValue(new Error('Access revoked'));return Buffer.from('mp4');});
    await expect(s.service.resume('call-1')).rejects.toThrow('Access revoked');
    expect(s.files.write).not.toHaveBeenCalled();expect(s.files.deliver).not.toHaveBeenCalled();
    expect(s.client.submit).toHaveBeenCalledTimes(1);
  });
});

it('resumes accepted work through an adapter with no quote, reserve or submit capability',async()=>{
  const s=setup();
  await s.service.start(request);
  const resume=createVideoResumptionService({authorize:s.authorize,
    operations:{get:s.operations.get,complete:s.operations.complete,fail:s.operations.fail},
    budget:s.budget,client:{inspectStatus:s.client.inspectStatus,download:s.client.download},files:s.files});
  expect(await resume('call-1')).toMatchObject({status:'pending'});
  expect(s.client.submit).toHaveBeenCalledTimes(1);
  expect(s.client.quote).toHaveBeenCalledTimes(1);
  expect(s.operations.begin).toHaveBeenCalledTimes(1);
});
