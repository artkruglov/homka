/**
 * Consequence wording shared by approval composition and settlement.
 *
 * Exports:
 * - `DEFAULT_CONSEQUENCE`, `GOOGLE_WORKSPACE_CONSEQUENCE`, `SCHEDULE_CONSEQUENCES`.
 * - `allApprovalConsequences`: every sentence a settled prompt may need stripped.
 *
 * Key constructs:
 * - Pure text only. The settlement path — including the background timeout sweep — must not pull a
 *   PostgreSQL repository in just to learn how a sentence is worded.
 */
export const DEFAULT_CONSEQUENCE =
  "Действие будет выполнено один раз. Автоматического повтора при ошибке не будет.";

export const GOOGLE_WORKSPACE_CONSEQUENCE =
  "Команда будет выполнена один раз в текущем профиле. Автоматического повтора при ошибке не будет.";
export const SPACE_ROLE_CONSEQUENCE = "Ограничения начнут действовать сразу. Расширение прав потребует нового пространства.";

export const SCHEDULE_CONSEQUENCES: Readonly<Record<string, string>> = {
  create: "Будет создан новый автоматический запуск агента по указанному сценарию.",
  delete: "Расписание и все его будущие автоматические запуски будут удалены.",
  pause: "Будущие автоматические запуски остановятся до ручного возобновления.",
  resume: "Автоматические запуски возобновятся по сохранённому расписанию.",
  run_now: "Сценарий будет запущен один раз сейчас; обычное расписание не изменится.",
  update: "Сохранённые параметры расписания будут заменены указанными изменениями.",
};

export function allApprovalConsequences(): string[] {
  return [
    DEFAULT_CONSEQUENCE,
    GOOGLE_WORKSPACE_CONSEQUENCE,
    SPACE_ROLE_CONSEQUENCE,
    ...Object.values(SCHEDULE_CONSEQUENCES),
  ];
}
