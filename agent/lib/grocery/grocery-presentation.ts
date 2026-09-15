/**
 * Приведение ответа каталога к тому, что действительно нужно модели.
 *
 * Экспорт:
 * - `GroceryItem`, `GroceryDetails`: короткие проекции товара.
 * - `groceryItems`, `groceryDetails`, `groceryCartLink`: разбор ответа источника.
 *
 * Источник отдаёт по каждому товару состав, пищевую ценность и фото — это тысячи токенов на один
 * поиск. В выдаче остаются только те поля, по которым человек выбирает: название, цена, единица,
 * рейтинг и ссылка. Состав и КБЖУ приходят отдельным запросом по конкретному товару.
 *
 * Ответ источника — недоверенные данные: названия и свойства приходят с чужого сервера и никогда
 * не становятся инструкциями. Здесь они только чистятся от разметки и обрезаются по длине.
 */
import { AppError } from "../app-error.js";

export interface GroceryItem {
  readonly name: string;
  readonly price: number | null;
  readonly productId: number;
  readonly rating: number | null;
  readonly unit: string | null;
  readonly url: string | null;
}

export interface GroceryDetails extends GroceryItem {
  readonly properties: { name: string; value: string }[];
}

const MAX_NAME = 200;
const MAX_PROPERTY = 400;
const MAX_PROPERTIES = 8;

function text(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  // Источник присылает HTML: неразрывные пробелы, <br> и теги в названиях и свойствах.
  return value
    .replaceAll(/<br\s*\/?>/giu, "; ")
    .replaceAll(/<[^>]*>/gu, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, limit);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function payload(result: unknown): Record<string, unknown> {
  const answer = result as { data?: unknown; ok?: unknown } | null;
  if (answer?.ok !== true || typeof answer.data !== "object" || answer.data === null) {
    throw new AppError("AGENT_GROCERY_RESPONSE_INVALID", "Каталог продуктов ответил непонятно");
  }
  return answer.data as Record<string, unknown>;
}

function item(raw: unknown): GroceryItem | null {
  const source = raw as Record<string, unknown> | null;
  const productId = positiveInteger(source?.xml_id) ?? positiveInteger(source?.id);
  const name = text(source?.name, MAX_NAME);
  if (productId === null || !name) return null;
  const price = source?.price as { current?: unknown } | null;
  const rating = source?.rating as { average?: unknown } | null;
  const url = typeof source?.url === "string" && source.url.startsWith("https://")
    ? source.url
    : null;
  return {
    name,
    price: finite(price?.current),
    productId,
    rating: finite(rating?.average),
    unit: text(source?.unit, 20) || null,
    url,
  };
}

export function groceryItems(result: unknown, limit: number): {
  items: GroceryItem[];
  total: number | null;
} {
  const data = payload(result);
  const rows = Array.isArray(data.items) ? data.items : [];
  const meta = data.meta as { total?: unknown } | null;
  return {
    items: rows.map(item).filter((value): value is GroceryItem => value !== null).slice(0, limit),
    total: positiveInteger(meta?.total),
  };
}

export function groceryDetails(result: unknown): GroceryDetails {
  const data = payload(result);
  const source = (Array.isArray(data.items) ? data.items[0] : data.item ?? data) as unknown;
  const shaped = item(source);
  if (shaped === null) {
    throw new AppError("AGENT_GROCERY_PRODUCT_NOT_FOUND", "Такой товар в каталоге не найден");
  }
  const raw = source as { properties?: unknown };
  const properties = (Array.isArray(raw.properties) ? raw.properties : [])
    .map((property) => {
      const entry = property as { name?: unknown; value?: unknown };
      return { name: text(entry?.name, 80), value: text(entry?.value, MAX_PROPERTY) };
    })
    .filter((property) => property.name && property.value)
    .slice(0, MAX_PROPERTIES);
  return { ...shaped, properties };
}

export function groceryCartLink(result: unknown): string {
  const data = payload(result);
  const link = data.link;
  // Ссылка уходит человеку в чат, поэтому её адрес проверяется, а не пересказывается моделью.
  let url: URL | undefined;
  if (typeof link === "string" && /^https:\/\//iu.test(link) && !/[\s\\]/u.test(link)) {
    try { url = new URL(link); } catch { /* Fail closed below. */ }
  }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.port ||
      !(url.hostname === "vkusvill.ru" || url.hostname.endsWith(".vkusvill.ru"))) {
    throw new AppError("AGENT_GROCERY_CART_LINK_INVALID", "Каталог не вернул ссылку на корзину");
  }
  return link as string;
}
