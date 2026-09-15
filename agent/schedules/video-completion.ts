/** Finish accepted video jobs independently of a model turn; never submit a new paid job. */
import {defineSchedule} from 'eve/schedules';
import {dispatchQueuedVideos} from '../lib/video-generation/video-completion-coordinator.js';
export default defineSchedule({cron:'* * * * *',run({waitUntil}){waitUntil(dispatchQueuedVideos());}});
