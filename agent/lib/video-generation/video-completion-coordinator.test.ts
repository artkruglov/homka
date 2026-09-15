import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({get:vi.fn(),claim:vi.fn(),claimOne:vi.fn(),defer:vi.fn(),finish:vi.fn(),resume:vi.fn()}));
vi.mock('./video-operation-repository.js',()=>({videoOperationRepository:{get:m.get}}));
vi.mock('./video-completion-queue.js',()=>({videoCompletionQueue:{claim:m.claim,claimOne:m.claimOne,defer:m.defer,finish:m.finish}}));
vi.mock('./video-completion-runtime.js',()=>({resumeQueuedVideo:m.resume}));
import {resumeCoordinatedVideo,dispatchQueuedVideos} from './video-completion-coordinator.js';
const access={workspaceId:'root',actorTelegramId:'998',targetKey:'998:0',scope:'personal' as const};
const operation={status:'submitted',completionOrigin:{},deliveryState:'pending'};
const job={operationKey:'job',leaseToken:'lease',origin:{}};
beforeEach(()=>{vi.resetAllMocks();m.get.mockResolvedValue(operation);m.claimOne.mockResolvedValue(null);});
it('does not resume a job while a worker already owns it',async()=>{
  expect(await resumeCoordinatedVideo('job',access)).toEqual({status:'pending',operationKey:'job'});
  expect(m.resume).not.toHaveBeenCalled();
});
it('checks the current requester before acquiring a backend lease',async()=>{
  m.get.mockResolvedValue(null);
  await expect(resumeCoordinatedVideo('someone-else',access)).rejects.toThrow('NOT_FOUND');
  expect(m.claimOne).not.toHaveBeenCalled();expect(m.resume).not.toHaveBeenCalled();
});
it('uses the same completion and settlement path for a human status and the minute pass',async()=>{
  m.claimOne.mockResolvedValue(job);m.resume.mockResolvedValue({status:'completed',delivery:{delivered:true}});
  m.finish.mockImplementation(async()=>{m.get.mockResolvedValue({...operation,deliveryState:'delivered',file:{path:'video.mp4'}});});
  expect(await resumeCoordinatedVideo('job',access)).toMatchObject({status:'completed',delivery:{delivered:true}});
  expect(m.finish).toHaveBeenCalledWith(job,'delivered',expect.any(Date));
  m.claim.mockResolvedValue([job]);await dispatchQueuedVideos();expect(m.resume).toHaveBeenCalledTimes(2);
});
it('does not turn a delivery failure into another paid request',async()=>{
  m.get.mockResolvedValue({...operation,deliveryState:'failed',completionErrorCode:'AGENT_WORKSPACE_FILE_DELIVERY_AMBIGUOUS'});
  await expect(resumeCoordinatedVideo('job',access)).rejects.toThrow('DELIVERY_AMBIGUOUS');
  expect(m.resume).not.toHaveBeenCalled();
});
