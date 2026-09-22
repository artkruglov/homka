/**
 * Уведомление о том, что адресовано человеку и ждёт его ответа.
 *
 * Экспорт:
 * - `PartnerAlertKind`: вид ожидающего пункта.
 * - `PartnerAlertItem`: строка для сообщения, собранная из структуры, а не из переписки.
 * - `formatPartnerAlert`: текст уведомления или `null`, когда писать не о чем.
 *
 * До 22 сентября 2026 вторая половина каждой совместной функции не работала: поручение, передача
 * дела, предложенная область заботы и совместное решение никому не сообщались. Человек, от
 * которого ждали ответа, не знал, что его ждут, и функции выглядели сломанными.
 *
 * Это не вопрос о жизни, а дело, адресованное человеку, поэтому уведомление не зависит от согласия
 * на коуча и подчиняется только общим правилам инициативы. Текст собирает код: модель не
 * пересказывает чужие формулировки и ничего не решает за человека.
 */

export type PartnerAlertKind =
  | "task_proposed"
  | "task_transfer"
  | "care_area_proposed"
  | "decision_open";

export interface PartnerAlertItem {
  readonly kind: PartnerAlertKind;
  readonly subjectId: string;
  readonly title: string;
  /** Имя того, кто адресовал: человек должен видеть, с кем говорить, а не только что решать. */
  readonly from: string;
  /** Пункт ждёт ответа неделю и попадает в уведомление второй и последний раз. */
  readonly repeated: boolean;
}

/** Больше пяти пунктов в одном сообщении читаются как свалка, а не как просьба ответить. */
export const PARTNER_ALERT_MAX_ITEMS = 5;
const MAX_TITLE = 120;

const LINE: Record<PartnerAlertKind, { label: string; action: string }> = {
  care_area_proposed: { action: "взять целиком или отказаться", label: "Область заботы" },
  decision_open: { action: "за, против или обсудить", label: "Решение" },
  task_proposed: { action: "принять или отказаться", label: "Дело" },
  task_transfer: { action: "взять или вернуть", label: "Передача дела" },
};

function title(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

export function formatPartnerAlert(items: readonly PartnerAlertItem[], pending = 0): string | null {
  if (items.length === 0) return null;
  const lines = items.map((item) => {
    const { action, label } = LINE[item.kind];
    const again = item.repeated ? ", уже спрашивала неделю назад" : "";
    // Имя стоит в скобках: склонять чужие имена по падежам надёжно нельзя, а ошибка в имени
    // читается как небрежность.
    return `${label} (${item.from}): «${title(item.title)}» — ${action}${again}.`;
  });
  return [
    "Тебе адресовано, и я об этом ещё не писала.",
    "",
    ...lines,
    ...(pending > 0 ? [`…и ещё ${pending}, покажу по просьбе.`] : []),
    "",
    "Ответь здесь своими словами. Молчание я согласием не считаю.",
    "«Не пиши мне первым» — перестану.",
  ].join("\n");
}
