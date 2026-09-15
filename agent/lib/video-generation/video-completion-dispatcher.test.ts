import {it,expect,vi} from 'vitest';
import {AppError} from '../app-error.js';
import {createVideoCompletionDispatcher} from './video-completion-dispatcher.js';
const now=new Date('2026-09-13T12:00:00Z');
const job={operationKey:'already-paid',leaseToken:'lease',origin:{}};
function setup(){
  const queue={claim:vi.fn().mockResolvedValue([job]),defer:vi.fn(),finish:vi.fn()};
  const resume=vi.fn();
  return {queue,resume,dispatch:createVideoCompletionDispatcher({queue,resume})};
}
it('defers pending work instead of asking the model to order again',async()=>{
  const s=setup();s.resume.mockResolvedValue({status:'pending'});
  await s.dispatch(now);
  expect(s.resume).toHaveBeenCalledWith(job);
  expect(s.queue.defer).toHaveBeenCalledWith(job,new Date(now.getTime()+60000),null);
  expect(s.queue.finish).not.toHaveBeenCalled();
});
it('finishes only after a confirmed Telegram delivery',async()=>{
  const s=setup();s.resume.mockResolvedValue({status:'completed',delivery:{delivered:true,persistenceCompleted:false}});
  await s.dispatch(now);expect(s.queue.finish).toHaveBeenCalledWith(job,'delivered',now);
});
it('does not retry an ambiguous send or an unconfirmed completion',async()=>{
  for(const result of [new AppError('AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS','unknown'),{status:'completed',delivery:{delivered:false}}]){
    const s=setup();if(result instanceof Error)s.resume.mockRejectedValue(result);else s.resume.mockResolvedValue(result);
    await s.dispatch(now);expect(s.queue.defer).not.toHaveBeenCalled();
    expect(s.queue.finish.mock.calls[0]![1]).toBe('failed');
  }
});
it('poll and download failures retry only the existing operation',async()=>{
  for(const code of ['AGENT_VIDEO_POLL_FAILED','AGENT_VIDEO_DOWNLOAD_FAILED','AGENT_VIDEO_MIGRATION_AUDIENCE_PENDING']){
    const s=setup();s.resume.mockRejectedValue(new AppError(code,'transient'));
    await s.dispatch(now);expect(s.queue.defer).toHaveBeenCalledWith(job,new Date(now.getTime()+60000),code);
  }
});
it('stale leases cannot settle or cancel another worker’s job',async()=>{
  const s=setup();s.resume.mockRejectedValue(new AppError('AGENT_VIDEO_COMPLETION_LEASE_STALE','stale'));
  await s.dispatch(now);expect(s.queue.defer).not.toHaveBeenCalled();expect(s.queue.finish).not.toHaveBeenCalled();
});
