/** Local GigaAM route within the existing authorized durable voice pipeline. */
import { AppError } from './app-error.js';

export async function transcribeLocalVoice(
  audio: Uint8Array,
  apiKey: string | undefined,
  request: typeof fetch = fetch,
): Promise<string> {
  if (!apiKey?.trim()) throw new AppError('AGENT_VOICE_NOT_CONFIGURED', 'Локальное распознавание голосовых не настроено');
  let response: Response;
  try {
    response = await request('http://gigaam:8000/transcribe', {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'audio/ogg' },
      body: Buffer.from(audio), signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new AppError('AGENT_VOICE_SERVICE_UNAVAILABLE', 'Сервис распознавания не ответил. Автоматический повтор не выполнялся; попробуйте позже');
  }
  if (response.status === 413) throw new AppError('AGENT_VOICE_FILE_TOO_LARGE', 'Голосовое слишком длинное. Отправьте запись не длиннее трёх минут');
  if (!response.ok) throw new AppError('AGENT_VOICE_TRANSCRIPTION_FAILED', 'Не удалось распознать голосовое сообщение. Попробуйте позже или напишите текстом');
  const value: unknown = await response.json();
  const text = value && typeof value === 'object' && 'text' in value ? value.text : null;
  if (typeof text !== 'string' || !text.trim() || text.length > 40_000) {
    throw new AppError('AGENT_VOICE_TRANSCRIPT_EMPTY', 'Не удалось разобрать речь. Попробуйте записать сообщение ещё раз');
  }
  return text.trim();
}
