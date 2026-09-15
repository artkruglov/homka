# Промпты для Flux (Cloudflare klein-4b с переходом на NeuralDeep)

Картинки рисует `generate_image`. Первый провайдер Cloudflare Workers AI, модель FLUX.2 klein-4b,
при отказе или исчерпании квоты запрос уходит в NeuralDeep Flux. Одна генерация 512×512 стоит
мало; не запрашивай варианты без просьбы.

## Промпт

- На английском, 40–80 слов.
- Порядок: объект → окружение → композиция и ракурс → свет → стиль и материалы → ограничения.
- Один главный объект. Перечисление пяти объектов даёт кашу.
- Ограничения в конце: `no text, no watermark, no logo, no people` (что применимо).

## Что запрещено

- Бренды, марки, названия компаний и моделей (Porsche, iPhone, Lego): фильтр Cloudflare
  отклоняет запрос. Опиши объект словами: «silver mid-engine sports coupe».
- Известные люди и персонажи с именами.
- Текст на картинке: Flux рисует его с ошибками. Подпись, имя, дату добавляй в подпись к файлу
  при отправке через `send_workspace_file`.

## Размеры

| Задача | size |
| --- | --- |
| Открытка, аватар, карточка блюда | `512x512` |
| Баннер, пейзаж, обложка чата | `1536x1024` (даёт 768×512) |
| Постер, обложка для телефона | `1024x1536` (даёт 512×768) |

## Шаблоны

Открытка к празднику:
`Warm greeting card illustration for [holiday], [one central motif: a cake with candles / a fir
tree with lights / spring tulips], soft pastel background, gentle depth of field, cozy handmade
paper texture, centered composition with empty space at the bottom, no text, no watermark, no logo.`

Иллюстрация к сказке:
`Storybook illustration of [character described by looks, not by name] in [place], evening light,
watercolor and ink style, friendly mood, wide shot, soft edges, no text, no watermark.`

Карточка блюда:
`Overhead food photo of [dish], on a rustic wooden table, natural window light, shallow depth of
field, a few fresh ingredients around the plate, photorealistic, no text, no watermark, no hands.`

## Проверка

- На картинке нет текста и логотипов; главный объект узнаваем; размер соответствует задаче.
- Если провайдер отклонил запрос, убери бренды и имена, не повторяй тот же промпт.
