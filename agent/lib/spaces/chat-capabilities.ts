/**
 * Карточка «что я умею в этом чате».
 *
 * Экспорт:
 * - `CAPABILITY_GROUPS`: семьи возможностей и инструменты, из которых они состоят.
 * - `chatCapabilities`: доступные семьи по фактическому набору инструментов хода.
 *
 * Список строится из настоящего набора инструментов режима, а не из текста промпта: обещание,
 * написанное словами, расходится с тем, что чат действительно умеет, ровно в тот день, когда
 * набор меняется. Инструмент без семьи — ошибка сборки, её ловит тест.
 */
export interface CapabilityGroup {
  readonly label: string;
  readonly tools: readonly string[];
}

export const CAPABILITY_GROUPS: Readonly<Record<string, CapabilityGroup>> = {
  errands: {
    label: "Личные поручения: подготовить и отправить подборку, передать свой ответ",
    tools: ["manage_errand"],
  },
  areas: {
    label: "Области, кто что видит и передача в другой чат",
    tools: ["manage_space", "manage_profile_projection", "publish_memory", "send_to_chat"],
  },
  calendar: {
    label: "Google-календарь, почта и документы",
    tools: ["execute_google_workspace", "manage_gmail_message", "manage_google_workspace_connection"],
  },
  family: {
    label: "Приглашения и настройки семьи",
    tools: [
      "list_pending_family_invitations", "manage_family_invitation", "manage_telegram_group",
      "notification_settings", "start_new_context", "manage_behavior_preference",
      "review_improvements", "manage_skill",
    ],
  },
  files: {
    label: "Файлы и вложения",
    tools: [
      "import_telegram_attachment", "inspect_workspace_image", "list_telegram_attachments",
      "send_workspace_file", "generate_image",
    ],
  },
  groceries: { label: "Продукты и корзина", tools: ["grocery_cart"] },
  memory: {
    label: "Память о семье",
    tools: [
      "export_memory", "get_memory_source", "list_memories", "list_memory_threads", "manage_memory",
      "manage_memory_conflict", "manage_memory_thread", "read_memory_thread", "read_profile_view",
      "remember", "search_memories", "search_memory_threads", "search_my_contexts",
    ],
  },
  planning: {
    label: "Дела, идеи и традиции",
    tools: ["manage_care_areas", "manage_shared_tasks", "manage_shopping_list", "read_shared_tasks", "manage_joint_decision"],
  },
  personal: {
    label: "Личное время",
    tools: ["manage_personal_time"],
  },
  signals: {
    label: "Напоминания и расписания",
    tools: [
      "list_agent_schedules", "list_proactive_deliveries", "list_reminders", "manage_agent_schedule",
      "manage_external_group_schedule", "manage_reminder",
    ],
  },
  time: { label: "Время и история чата", tools: ["get_current_time", "list_group_history", "read_scheduled_group_history"] },
  web: { label: "Поиск в интернете", tools: ["web_fetch", "web_search"] },
};

export function chatCapabilities(available: readonly string[]): { group: string; label: string }[] {
  const present = new Set(available);
  return Object.entries(CAPABILITY_GROUPS)
    .filter(([, group]) => group.tools.some((tool) => present.has(tool)))
    .map(([group, { label }]) => ({ group, label }));
}
