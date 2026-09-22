/**
 * Сообщение, начатое ботом, попадает в журнал доставок личного чата.
 *
 * Экспорт:
 * - `recordInitiativeDelivery`: запись отправленного обзора, недельного обзора или вопроса коуча.
 *
 * Без этой записи ответ человека приходит в ход, который не видел вопроса: на «первое сделала»
 * после утреннего обзора бот переспрашивал, что именно. Журнал доставок уже показывает следующему
 * ходу напоминания и расписания в `<recent_proactive_deliveries>`, второго пути здесь нет.
 */
import { proactiveDeliveryRepository } from "../proactive-deliveries/proactive-delivery-repository.js";

export interface InitiativeDelivery {
  readonly sourceKind: "coach" | "daily_overview" | "partner_alert" | "weekly_review";
  readonly familyId: string;
  readonly userId: string;
  readonly telegramUserId: string;
  /** `initiative_messages.delivery_ref` заявки, под которой ушло сообщение. */
  readonly deliveryRef: string;
  readonly messageId: string;
  readonly text: string;
  readonly at: Date;
}

const TITLES = {
  coach: "Вопрос коуча", daily_overview: "Утренний обзор",
  partner_alert: "Ждёт твоего ответа", weekly_review: "Обзор недели",
} as const;

export async function recordInitiativeDelivery(delivery: InitiativeDelivery): Promise<void> {
  await proactiveDeliveryRepository.record({
    content: delivery.text,
    deliveredAt: delivery.at,
    familyId: delivery.familyId,
    groupId: null,
    messageThreadId: null,
    ownerUserId: delivery.userId,
    scheduledFor: delivery.at,
    scope: "personal",
    sourceId: delivery.deliveryRef,
    sourceKind: delivery.sourceKind,
    telegramChatId: delivery.telegramUserId,
    telegramMessageId: delivery.messageId,
    title: TITLES[delivery.sourceKind],
  });
}
