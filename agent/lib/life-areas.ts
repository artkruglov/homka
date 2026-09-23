/**
 * Сферы жизни: коды в базе, человеческие названия в тексте.
 *
 * Экспорт:
 * - `LIFE_AREAS`: допустимые коды.
 * - `LifeArea`: тип кода.
 * - `lifeAreaTitle`: название сферы для человека.
 *
 * Метка необязательна и прав не даёт: область доступа по-прежнему определяется чатом. «Мои дела» и
 * «Когда-нибудь» сюда не входят — это виды списка, а не сферы, и добавлять их кодами нельзя.
 */
export const LIFE_AREAS = ["self", "couple", "kids", "home", "work"] as const;

export type LifeArea = typeof LIFE_AREAS[number];

const TITLES: Record<LifeArea, string> = {
  couple: "Мы вдвоём",
  home: "Дом и забота",
  kids: "Семья и дети",
  self: "Для себя",
  work: "Работа",
};

export function lifeAreaTitle(area: LifeArea): string {
  return TITLES[area];
}
