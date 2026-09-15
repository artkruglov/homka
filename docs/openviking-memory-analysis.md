# OpenViking: анализ и направления развития памяти Osinara

Дата исследования: 8 августа 2026 года.

Статус: historical research context. Описания прежних extraction/brief mechanisms не являются
текущим runtime-контрактом.

Исследованный upstream:

- официальный репозиторий: [volcengine/OpenViking](https://github.com/volcengine/OpenViking);
- версия: [`v0.4.13`](https://github.com/volcengine/OpenViking/releases/tag/v0.4.13);
- исследованный commit: [`3087f94`](https://github.com/volcengine/OpenViking/tree/3087f943a2dd41f6d0bde4742832d368d021f47b);
- официальная документация: [docs.openviking.ai](https://docs.openviking.ai/en/getting-started/01-introduction);
- состояние проекта: `Alpha`, основной server/runtime распространяется под AGPL-3.0.

Этот документ отвечает не на вопрос «следует ли заменить память Osinara на OpenViking», а на
вопрос «какие инженерные идеи OpenViking полезно перенести в Osinara, не ослабляя её более строгие
границы авторизации, provenance и durability».

---

## 1. Краткий вывод

OpenViking является одновременно document RAG, долговременной памятью агента, хранилищем skills и
системой сборки контекста. Термин `context database` обозначает составную прикладную архитектуру:

```text
virtual context filesystem
+ document ingestion and parsing
+ L0/L1/L2 semantic representations
+ dense/sparse vector index
+ hierarchical retrieval and reranking
+ session archive and memory extraction
+ trajectories, experiences and optional skill evolution
```

OpenViking не является заменой PostgreSQL и не даёт Osinara достаточных гарантий для хранения
семейной памяти. Его модель ориентирована на контекстные файлы, которые модель может обновлять,
объединять и удалять. Osinara хранит атомарные claims, evidence, source identity и trust-zone
relations, поэтому сильнее в областях, где ошибка означает раскрытие личных данных или потерю
проверяемого происхождения утверждения.

Главный архитектурный вывод:

> Osinara должна сохранить текущий claim/evidence memory plane и добавить отдельный resource/context
> plane с L0/L1/L2, иерархическим retrieval, token budgeting и наблюдаемым context assembly.

Предлагаемая целевая композиция:

```text
Authoritative human memory
claims + evidence + profiles + conflicts + threads + outcomes
                            |
                            | authorized references only
                            v
Resource context plane
documents + workspaces + skills + L0/L1/L2 semantic tree
                            |
                            v
Authorized hierarchical retrieval + context budget assembler
                            |
                            v
Optional evaluated experience learning
trajectories + experiences + regression gate + rollback
```

Не следует:

- заменять текущие memory tables файловой памятью OpenViking;
- передавать OpenViking raw personal/family Telegram timeline;
- использовать OpenViking как authorization boundary;
- разрешать модели destructive merge claims или автоматическое разрешение конфликтов;
- включать self-evolution без confirmed outcomes, оценки качества и rollback;
- импортировать AGPL runtime внутрь Osinara без отдельного юридического решения.

---

## 2. Что такое OpenViking

### 2.1 Не только RAG

OpenViking объединяет три типа контекста:

| Тип | Назначение |
| --- | --- |
| `resource` | Документы, каталоги, сайты, код, таблицы и другие внешние материалы |
| `memory` | Профиль, предпочтения, события, entities, trajectories и experiences |
| `skill` | Агентные skills и инструкции, доступные через semantic discovery |

Контекст адресуется URI вида:

```text
viking://resources/...
viking://user/memories/...
viking://skills/...
```

За URI находится не одна база данных, а несколько согласуемых подсистем:

- content backend: local filesystem, S3 или memory;
- metadata, queue и lock backends;
- dense/sparse vector index;
- ingestion workers;
- summary and memory extraction providers;
- HTTP, Python SDK, CLI, MCP и WebDAV surfaces.

Поэтому OpenViking корректнее называть context platform, а не новым типом СУБД.

### 2.2 L0/L1/L2

Каждый контекст представлен на трёх уровнях:

| Уровень | Физическое представление | Примерный объём | Назначение |
| --- | --- | ---: | --- |
| L0 | `.abstract.md` | около 100 токенов | Быстрый vector search и первичный отбор |
| L1 | `.overview.md` | до 2000 токенов | Rerank, понимание структуры и навигация |
| L2 | оригинальный файл или поддерево | не ограничен | Полное содержание по запросу |

L0 и L1 индексируются отдельно. L2 не загружается в prompt автоматически: агент сначала находит
подходящую ветку по краткому представлению, затем углубляется до нужной детали.

Официальное описание: [Context Layers](https://docs.openviking.ai/en/concepts/03-context-layers).

### 2.3 Ingestion

OpenViking поддерживает Markdown, plain text, PDF, HTML, Word, PowerPoint, Excel, EPUB, media, ZIP,
исходный код и директории. Упрощённый pipeline:

```text
source
  -> accessor
  -> parser
  -> temporary semantic tree
  -> final URI tree
  -> L0/L1 generation
  -> embedding queue
  -> dense/sparse vector index
```

Это существенно шире текущей памяти Osinara, которая намеренно сосредоточена на Telegram timeline,
claims, profiles и threads, а не на универсальном knowledge ingestion.

Официальное описание: [Context Extraction](https://docs.openviking.ai/en/concepts/06-extraction).

### 2.4 Retrieval

OpenViking предоставляет два основных режима:

- `find()` выполняет один быстрый query без session context;
- `search()` использует session summary и последние сообщения, строит до пяти typed queries,
  выбирает стартовые точки, обходит semantic tree и rerank-ит результаты.

Заявленный pipeline:

```text
Query
  -> intent analysis
  -> typed queries
  -> starting points
  -> recursive directory retrieval
  -> rerank
  -> context assembly
```

В текущем коде фактический режим зависит от конфигурации reranker:

- без reranker автоматически выбирается `QUICK`, то есть глобальный dense/sparse search;
- `THINKING` выполняет hierarchical traversal;
- ошибка reranker приводит к возврату исходных vector scores.

Документация описывает hierarchical retrieval шире, чем гарантирует default runtime, поэтому при
оценке OpenViking следует проверять реальную provider configuration, а не только diagram.

Официальное описание: [Retrieval Mechanism](https://docs.openviking.ai/en/concepts/07-retrieval).

### 2.5 Session memory

Session commit разделён на две фазы.

Фаза 1 выполняется синхронно:

- блокирует authoritative session state;
- повторно читает сообщения;
- отделяет archive range от retained messages;
- записывает raw `messages.jsonl` и recoverable marker;
- ставит Phase 2 в durable queue;
- только после этого возвращает `task_id`.

Фаза 2 выполняется асинхронно:

- создаёт archive summary;
- извлекает memories;
- обновляет relations;
- сохраняет usage records;
- запускает evolution outputs, если они включены.

При включённой auto-commit policy defaults составляют 10 000 pending tokens, 50 live messages и
24 часа idle timeout. Threshold-triggered commit удерживает два последних сообщения. Дополнительный
`turn_budget` mode сохраняет последние три turn, до 12 000 токенов и обязательный tail ответа.

Официальное описание: [Session Management](https://docs.openviking.ai/en/concepts/08-session).

### 2.6 Memory types

OpenViking хранит несколько типов памяти:

| Тип | Семантика |
| --- | --- |
| `profile` | Mutable профиль со stable user-confirmed attributes |
| `preferences` | Предпочтения пользователя |
| `entities` | Упоминаемые сущности |
| `events` | События и временные факты |
| `cases` | Задача, вход, rubric и evidence для последующей оценки |
| `trajectories` | Timestamped последовательности действий и outcomes |
| `experiences` | Обобщённые рекомендации `Situation -> Approach -> Reflect` |
| `skills` | Инструкции и возможности агента |

Memory schemas задают field-level merge operations:

- `patch`;
- `replace`;
- `sum`;
- `immutable`.

Тип памяти может быть `upsert`, `add_only` или `update_only`.

В отличие от Osinara, overlapping proposals могут канонизироваться LLM merge, после чего
проигравший URI удаляется. Для knowledge/context files это допустимая стратегия. Для claims о людях
она недостаточна, потому что может уничтожить evidence и скрыть реальный конфликт источников.

### 2.7 Self-evolution

Self-evolution не меняет веса модели или retrieval algorithm. Он изменяет контекст, который получит
следующий turn:

```text
session commit
  -> cases
  -> trajectories
  -> LLM semantic gradients
  -> updated experiences
  -> optional skill changes
  -> reindex
  -> different future recall
```

Функция выключена по умолчанию. Offline training pipeline умеет считать rubric scores, pre/post
delta и выполнять rollout evaluation. Streaming commit flow применяет изменения без обязательного
score-improvement gate. Автоматического rollback при ухудшении нет; snapshot можно восстановить
вручную как новый forward commit.

Следовательно, OpenViking self-evolution является полезной экспериментальной моделью experience
learning, но не production-safe механизмом самоулучшения без дополнительных gates.

Официальное описание: [Agent Evolution](https://docs.openviking.ai/en/api/19-agent-evolution).

---

## 3. Сильные стороны OpenViking

### 3.1 Универсальный resource plane

OpenViking умеет принимать и структурировать документы разных типов. Osinara пока не имеет
отдельного application-owned knowledge plane, аналогичного claims/evidence memory plane.

Это главный функциональный пробел Osinara относительно OpenViking.

### 3.2 Иерархическая навигация

Обычный chunk RAG теряет структуру документа и отношения между разделами. L0/L1/L2 сохраняет
семантическую иерархию и позволяет сначала выбрать каталог или раздел, а затем загрузить точный L2.

### 3.3 Context budgeting

OpenViking рассматривает retrieval и prompt assembly как одну задачу: найденный материал должен
поместиться в бюджет и оставить место для текущего диалога и tool loop.

### 3.4 Retrieval observability

В системе есть observers и traces, позволяющие понять:

- какие typed queries были построены;
- какие стартовые узлы выбраны;
- по каким веткам прошёл retrieval;
- где применялся reranker;
- сколько токенов занял собранный контекст.

### 3.5 Skills как индексируемый контекст

OpenViking индексирует skills семантически и умеет находить их по задаче. Osinara сильнее в
execution-time capability security, но discovery остаётся в основном policy/config driven.

### 3.6 Experience memory

Trajectories и experiences позволяют хранить не только знания о мире, но и знания о том, как агент
успешно или неуспешно решал задачу. В Osinara confirmed outcomes и threads уже создают безопасную
основу для такого слоя, но автоматическая генерализация опыта пока отсутствует.

### 3.7 Интеграционная поверхность

OpenViking предоставляет HTTP API, Python SDK, Go SDK, CLI, MCP и WebDAV. Это облегчает подключение
редакторов, automation и внешних агентов.

---

## 4. Где Osinara сильнее

### 4.1 Trust zones и live authorization

Osinara выводит personal, family и group scopes только из Telegram update и PostgreSQL. Каждый
execution-time read повторно проверяет актуальное membership или exact group registration.

OpenViking имеет generic account/user/peer tenancy, но в текущей версии подтверждена cross-user
утечка через debug vector endpoints: [issue #3724](https://github.com/volcengine/OpenViking/issues/3724).

### 4.2 Provenance

Osinara хранит normalized `claim_evidence`:

- primary/supporting role;
- firsthand/reported/inferred kind;
- фактического source author;
- subject отдельно от автора;
- conversation и timeline coordinates;
- source snapshot и observation time.

OpenViking provenance в большей степени привязан к archive/run/file и не заменяет claim-level
evidence graph.

### 4.3 Sensitive HITL

Osinara связывает approval с verified identity, session, exact tool call, tool name и full input hash.
OpenViking prompt policy может запрещать sensitive information, но аналогичного execution-time
approval contract для memory mutations не обнаружено.

### 4.4 Недеструктивные corrections и conflicts

Osinara создаёт новую evidenced correction version, сохраняет предыдущую версию и переносит thread
membership. Unresolved conflict возвращается только обеими сторонами или скрывается полностью.

OpenViking ориентирован на canonical context file и допускает merge/delete loser URI.

### 4.5 Profiles как projections

В Osinara profile не является отдельной мутируемой истиной. Он является bounded read projection над
authoritative claims и provenance. Это исключает расхождение profile file и evidence.

### 4.6 Threads и confirmed outcomes

Osinara имеет scoped projects, root/subthreads, typed entries, confirmed outcomes, completion
episodes, source-backed briefs и явный lifecycle. Прямого эквивалента этого нормализованного слоя в
OpenViking нет.

### 4.7 Side-effect durability

Osinara ставит durable start markers до платных provider calls и Telegram sends. Неоднозначный crash
не приводит к скрытому повтору. OpenViking имеет сильную Phase 1/Phase 2 commit recovery, но его
общая модель filesystem + queue + vector index не является одной PostgreSQL ACID-транзакцией.

---

## 5. Сравнительная матрица

| Область | OpenViking | Osinara | Текущий вывод |
| --- | --- | --- | --- |
| Document ingestion | Много форматов и semantic tree | Нет универсального resource plane | Улучшить Osinara |
| L0/L1/L2 | Нативная модель | Нет общего механизма | Заимствовать |
| Hierarchical retrieval | Есть QUICK/THINKING | Hybrid claim retrieval без document tree | Заимствовать для resources |
| Intent decomposition | До пяти typed queries | До трёх model-guided reformulations | Расширить после eval |
| Context budgeting | Встроенный assembler | Bounded blocks по отдельным подсистемам | Унифицировать |
| Retrieval traces | Есть observers | Есть diagnostics, но нет полного trace | Расширить |
| Knowledge RAG | Сильный | Ограниченный | OpenViking сильнее |
| Human memory | File-oriented | Claim/evidence-oriented | Osinara сильнее |
| Author/subject identity | Ограниченная модель | Нормализованная identity | Osinara сильнее |
| Sensitive approval | Prompt-level policy | Exact identity-bound HITL | Osinara сильнее |
| Conflict semantics | Canonical merge/delete | Нормализованный unresolved conflict | Osinara сильнее |
| Profiles | Mutable file | Reproducible projection | Osinara сильнее |
| Threads/outcomes | Trajectories/experiences | Normalized threads + confirmed outcomes | Разные задачи |
| Skill discovery | Семантический | Policy-scoped | Объединить идеи |
| Skill authorization | Generic tenancy | Live capability checks | Osinara сильнее |
| Experience learning | Есть | Нет генерализации | Добавить с gates |
| Multi-tenancy | Generic account/user/peer | Family/group trust zones | Osinara сильнее в домене |
| API ecosystem | HTTP/SDK/CLI/MCP/WebDAV | Eve tools и внутренние repositories | OpenViking шире |
| Production maturity | Alpha, `0.x` | Domain-specific release gates | Не заменять backend |

---

## 6. Benchmark claims и ограничения

### 6.1 LoCoMo

Опубликованные результаты:

| Harness | Native accuracy | С OpenViking |
| --- | ---: | ---: |
| OpenClaw | 24,20% | 82,08% |
| Hermes | 33,38% | 82,86% |
| Claude Code | 57,21% | 80,32% |

Оговорки:

- adversarial category 5 исключена;
- judge считает ответ правильным при совпадении одного элемента списка;
- допускается временная погрешность до 14 дней;
- raw result artifacts не опубликованы;
- сравниваются разные harness и схемы token accounting;
- результаты относятся к OpenViking `0.3.22`, а не к текущему `0.4.13`.

Это полезный vendor signal, но не независимое доказательство точности.

Официальный отчёт: [OpenViking benchmark results](https://blog.openviking.ai/post/openviking-benchmark-results/).

### 6.2 tau2-bench

| Dataset | Без памяти | С experience memory | Улучшение |
| --- | ---: | ---: | ---: |
| Retail | 70,94% | 77,81% | +6,87 pp |
| Airline | 54,38% | 66,25% | +11,87 pp |

Этот benchmark методологически сильнее: используется один LLM, paired seeds, temperature `0` и
внешний scorer. Но отсутствуют confidence intervals, raw run artifacts и доказательство
статистической значимости.

### 6.3 Knowledge-base QA

HotpotQA:

| Метод | Accuracy | Tokens/QA | Retrieval latency |
| --- | ---: | ---: | ---: |
| Naive RAG | 62,50% | 1 290 | 0,11 s |
| OpenViking top-5 | 72,75% | 3 154 | 0,22 s |
| OpenViking top-20 | 91,00% | 12 533 | 0,23 s |
| LightRAG | 89,00% | 28 443 | 75 s |

Aggregate FinanceBench, NaturalQuestions, ClapNQ, Qasper и SyllabusQA:

| Метод | Average accuracy | Index tokens | Tokens/QA | Retrieval |
| --- | ---: | ---: | ---: | ---: |
| Naive RAG | 53,93% | 2,76M | 1 435 | 0,13 s |
| LightRAG | 76,00% | 62,71M | 27 035 | 9,19 s |
| OpenViking | 66,87% | 8,67M | 3 060 | 0,19 s |

OpenViking не показывает абсолютное лидерство по quality, но даёт интересный баланс accuracy,
index cost, query tokens и latency.

---

## 7. Production-риски OpenViking

### 7.1 Alpha maturity

- проект создан в январе 2026 года;
- latest server release на момент исследования: `v0.4.13`;
- PyPI classifier: `Development Status :: 3 - Alpha`;
- changelog отстаёт от releases;
- основной reusable full-suite временно не запускает полный `pytest tests/`;
- API и memory schemas продолжают быстро изменяться.

Большое число stars показывает интерес сообщества, но не production maturity.

### 7.2 Подтверждённые дефекты

- [#3724](https://github.com/volcengine/OpenViking/issues/3724): cross-user exposure через debug
  vector endpoints;
- [#3660](https://github.com/volcengine/OpenViking/issues/3660): удаление пользователя не удаляет
  AGFS/vector data, повторно созданный ID получает старое состояние;
- [#3640](https://github.com/volcengine/OpenViking/issues/3640): SessionCommit может оставить tree без
  parent vector records;
- [#3598](https://github.com/volcengine/OpenViking/issues/3598): recall budget расходуется на verbatim
  transcripts;
- [#3508](https://github.com/volcengine/OpenViking/issues/3508): extraction может завершиться успешно,
  сохранив пустой `adds`.

Первые два дефекта являются release blockers для любых personal/family данных Osinara.

### 7.3 Deployment defaults

Документированный Helm chart:

- запускает одну replica;
- по умолчанию использует generic `uv` image;
- устанавливает OpenViking при старте без immutable release pin;
- не создаёт PVC для local workspace;
- может потерять local data при пересоздании Pod.

Для production потребовались бы отдельные external storage, VectorDB, secret manager, backup/restore,
immutable images и собственный deployment audit.

### 7.4 Лицензия

Основной server/runtime распространяется под AGPL-3.0. Commercial use разрешён, но модифицированный
server, доступный пользователям по сети, требует предоставления Corresponding Source.

Для Osinara менее рискован отдельный неизменённый HTTP service. Импорт или тесная линковка runtime в
основное приложение требует отдельной юридической оценки. Публичного commercial-license exception
в open-source repository не найдено.

---

## 8. Что улучшить в Osinara

### 8.1 P1: отдельный resource context plane

#### Проблема

Текущая память Osinara хорошо моделирует claims о людях, семье, событиях и продолжающихся темах, но
не является универсальной knowledge base для документов, сайтов, таблиц и больших workspace trees.

Попытка хранить document chunks как `memory_items` смешала бы разные семантики:

- human claims требуют provenance, endorsement, sensitivity и conflict lifecycle;
- documents требуют parser identity, content version, section hierarchy и source checksum;
- skills требуют code-review status и capability policy;
- workspace artifacts требуют path authorization и file lifecycle.

#### Предложение

Добавить отдельные сущности:

```text
context_resources
context_resource_versions
context_nodes
context_node_representations
context_index_jobs
context_access_bindings
```

Минимальная модель:

```text
context_resource
  id
  family_id
  owner_user_id | group_id
  scope
  source_kind
  source_locator
  content_hash
  parser_version
  active_version_id

context_node
  id
  resource_version_id
  parent_node_id
  node_path
  node_kind
  ordinal

context_node_representation
  node_id
  level: l0 | l1 | l2
  content
  content_hash
  generator_version
  embedding_status
```

#### Security invariants

- `family_id`, `scope`, owner и group выводятся только application code;
- resource search применяет live membership/group registration до ranking;
- external group имеет только собственные resources;
- symlink и workspace path policy остаются в существующих wrappers;
- model-visible DTO использует opaque `resourceRef` и `nodeRef`;
- document resource никогда автоматически не становится human claim;
- extraction из документа в claims требует отдельного evidence-aware workflow.

#### Acceptance criteria

- PDF/Markdown/plain text ingestion сохраняет исходный immutable version;
- изменение файла создаёт новую version, а не перезаписывает старую;
- удаление trust zone физически удаляет resource, index и derived summaries;
- cross-family и cross-group retrieval tests fail closed;
- stale turn после revocation не получает ни L0, ни L1, ни L2;
- parser или embedding failure не публикует partial active version.

### 8.2 P1: L0/L1/L2 semantic hierarchy

#### Проблема

Текущий retrieval хорошо работает с атомарными claims, но большие документы нельзя эффективно
представлять одинаковыми chunks. Flat chunking теряет разделы, parent context и возможность сначала
оценить релевантность ветки.

#### Предложение

Для каждого context node хранить:

- L0: deterministic или model-generated abstract до именованного лимита;
- L1: bounded overview с child map и source references;
- L2: authoritative original content или точный source slice.

Retrieval должен идти сверху вниз:

```text
authorized root candidates
  -> L0 hybrid retrieval
  -> branch threshold
  -> L1 rerank
  -> bounded child expansion
  -> selected L2 slices
```

#### Отличия от OpenViking

- authorization выполняется в каждом SQL expansion query;
- L0/L1 являются derived cache и не источником истины;
- каждый summary хранит source node refs и generator version;
- L2 никогда не подменяется generated summary;
- provider failure не приводит к fallback на неавторизованный или соседний resource;
- дерево версионируется атомарно на уровне active resource version.

#### Acceptance criteria

- retrieval trace объясняет каждый переход parent -> child;
- ни один child не может выйти за authorized resource version;
- summary без source refs не индексируется;
- stale L0/L1 инвалидируется при смене active L2 version;
- eval сравнивает hierarchy с текущим flat baseline при одинаковом token budget.

### 8.3 P1: единый context budget assembler

#### Проблема

Osinara имеет отдельные лимиты для retrieved claims, profile blocks, thread briefs, episodes и Eve
history. Нет единого слоя, который распределяет общий token budget между всеми источниками.

#### Предложение

Ввести `ContextBudgetPlan`:

```text
total available tokens
  - permanent instructions reserve
  - current turn reserve
  - tool loop reserve
  - safety reserve
= retrievable context budget
```

Retrievable budget распределять между:

- authoritative memory claims;
- unresolved conflicts;
- active thread briefs;
- profile projection;
- resource L1/L2;
- skill guidance;
- recent conversation bootstrap.

Приоритеты должны задаваться application config, а не prompt:

```text
mandatory conflict closure
> current-turn source evidence
> active thread goals
> high-confidence claims
> directly requested resource detail
> broader resource overview
> historical episodes
```

#### Acceptance criteria

- assembler никогда не обрезает одну сторону conflict pair;
- source ref и warning остаются вместе с claim;
- каждый block сообщает estimated tokens и reason for inclusion;
- overflow приводит к deterministic lower-priority eviction;
- reserved output/tool budget не расходуется retrieval;
- одинаковые inputs дают одинаковый budget plan.

### 8.4 P1: retrieval trace и diagnostics

#### Проблема

Текущие diagnostics показывают branch scores и ошибки, но не формируют единый model-independent
trace context assembly.

#### Предложение

Хранить bounded trace:

```text
retrieval_run
retrieval_query_variant
retrieval_candidate
retrieval_branch_transition
retrieval_rerank_decision
retrieval_context_block
```

Trace не должен содержать plaintext sensitive content. Достаточно opaque refs, score components,
policy branch, exclusion code, token estimate и selected flag.

Пример stable exclusion codes:

```text
MEMORY_RETRIEVAL_SCOPE_DENIED
MEMORY_RETRIEVAL_MEMBERSHIP_REVOKED
RESOURCE_RETRIEVAL_BRANCH_BELOW_THRESHOLD
RESOURCE_RETRIEVAL_TOKEN_BUDGET_EXCEEDED
RESOURCE_RETRIEVAL_STALE_VERSION
CONTEXT_BLOCK_DUPLICATE_SOURCE
```

#### Acceptance criteria

- оператор может объяснить, почему найден или исключён конкретный ref;
- traces имеют retention policy и удаляются вместе с trust zone;
- trace не раскрывает candidate из недоступной области;
- eval runner может воспроизвести ranking из сохранённых score components;
- observability не меняет authorization decisions.

### 8.5 P2: intent decomposition для complex retrieval

#### Проблема

Osinara инструктирует модель выполнять до трёх reformulated `search_memories`, но decomposition
остаётся внутри agent loop и плохо наблюдается.

#### Предложение

Добавить bounded typed query planner для смешанного memory/resource retrieval:

```text
query type: exact | entity | temporal | semantic | resource_navigation
target plane: memory | thread | profile | resource | skill
scope constraint: application supplied and immutable
query text: model generated but untrusted
```

Planner не получает и не может менять family, group, user, scope или sensitivity policy.

#### Acceptance criteria

- максимум именованного числа query variants;
- `maxRetries: 0`;
- schema rejects unknown target planes;
- empty/invalid output завершает retrieval безопасно, без broad fallback;
- planner оценивается против single-query baseline при одинаковом суммарном budget;
- improvement принимается только при росте recall без роста unauthorized exposure.

### 8.6 P2: semantic skill discovery поверх live capability policy

#### Проблема

Osinara безопасно выдаёт skills по verified mode и group allowlist, но выбор из разрешённого набора
может быть статическим или зависеть от model-visible списка.

#### Предложение

Разделить:

```text
authorization: какие skills могут существовать в текущем turn
discovery: какие из уже разрешённых skills релевантны задаче
loading: загрузка content после повторной live authorization
```

Индексировать только code-reviewed metadata:

- skill name;
- reviewed description;
- input/output capabilities;
- trust-zone compatibility;
- version and source hash.

Никогда не индексировать как инструкции непроверенный group content.

#### Acceptance criteria

- retrieval работает только по предварительно авторизованному candidate set;
- disabled/revoked skill не имеет descriptor и не попадает в result;
- load повторно проверяет текущий allowlist;
- dynamic group skill не превращается в static Eve skill;
- semantic score не может повысить privilege.

### 8.7 P2: trajectories и experiences на confirmed outcomes

#### Проблема

Threads и confirmed outcomes уже фиксируют, что происходило и чем завершилось, но Osinara не
генерализует успешные и неуспешные способы решения задач.

#### Предложение

Добавить отдельный неавторитетный learning plane:

```text
agent_trajectories
agent_trajectory_steps
agent_experience_candidates
agent_experience_versions
agent_experience_evaluations
```

Trajectory должна ссылаться только на проверяемые events:

- tool call/result;
- source refs;
- confirmed outcome;
- explicit user correction;
- stable error code;
- completion or failure state.

Experience candidate:

```text
Situation
Preconditions
Approach
Expected observations
Failure signals
Rollback or escalation
Supporting trajectory refs
```

#### Обязательные gates

- нет confirmed outcome или explicit correction -> нет learning candidate;
- generated experience не получает authority менять scopes, tools или HITL;
- candidate сначала имеет статус `proposed`;
- offline evaluator сравнивает baseline и candidate при одинаковом budget;
- promotion требует положительного результата на нескольких независимых cases;
- regression переводит version в `rejected`, а не перезаписывает предыдущую;
- rollback является переключением active version, а не обратным LLM patch;
- sensitive source content не переносится в generalized experience.

#### Acceptance criteria

- experience имеет immutable supporting refs;
- одна успешная trajectory не может автоматически стать global rule;
- user/family/group experiences разделены или явно application-global;
- promotion и rollback аудитируются;
- evaluation dataset не используется одновременно для генерации и финального scoring;
- online use можно полностью отключить без потери source trajectories.

### 8.8 P2: versioned snapshots для resource и experience planes

OpenViking предлагает git-style snapshots context filesystem. Для Osinara полезна не буквальная
filesystem snapshot, а versioned activation:

```text
immutable resource version -> active version pointer
immutable experience version -> active version pointer
```

Требования:

- snapshot не заменяет PostgreSQL backup;
- activation выполняется транзакционно;
- embedding/index соответствует exact content hash active version;
- rollback не удаляет newer version;
- trust-zone deletion удаляет все versions и derived indexes;
- model не выбирает version pointer без typed approval policy.

### 8.9 P3: внешние API и MCP

Расширять API следует только после появления стабильного resource plane. MCP или external SDK не
должны становиться вторым путем авторизации.

Любой внешний adapter обязан:

- принимать application-issued principal, а не model-supplied scope;
- использовать те же repositories и live predicates;
- возвращать opaque refs;
- иметь bounded pagination и request limits;
- не предоставлять debug endpoints с raw vector scroll;
- аудитировать mutation calls;
- поддерживать physical erasure.

---

## 9. Предлагаемый порядок реализации

### Этап A. Resource foundation

Результат:

- отдельная schema resources/versions/nodes;
- ingestion Markdown, text и PDF;
- immutable L2 source;
- opaque refs;
- live authorization;
- physical trust-zone erasure;
- deterministic status/error model.

Не включать на этом этапе:

- self-evolution;
- MCP;
- broad web crawling;
- automatic document-to-human-claim extraction;
- mutable LLM canonical files.

### Этап B. L0/L1/L2 retrieval

Результат:

- versioned L0/L1 representations;
- authorized hierarchical retrieval;
- current E5 + lexical baseline comparison;
- parent/child trace;
- resource context blocks with source refs.

### Этап C. Unified context budget

Результат:

- единый deterministic budget plan;
- memory/thread/profile/resource arbitration;
- conflict-safe eviction;
- retrieval trace and token accounting.

### Этап D. Typed query planning и skill discovery

Результат:

- observable bounded query decomposition;
- semantic discovery внутри предварительно разрешённого skill set;
- no broad fallback;
- eval against single-query baseline.

### Этап E. Evaluated experience learning

Результат:

- trajectories из durable tool/outcome events;
- proposed experiences;
- offline evaluation;
- promotion, versioning и rollback;
- no automatic authority escalation.

---

## 10. Evaluation plan

### 10.1 Dataset classes

Нужны собственные domain datasets:

- точный personal fact recall;
- family fact с несколькими авторами;
- unresolved conflict;
- temporal correction;
- revoked family membership;
- external-group isolation;
- long document navigation;
- cross-document multi-hop question;
- skill discovery;
- active thread continuation;
- completed outcome recall;
- irrelevant query с ожидаемым empty result.

### 10.2 Метрики

Оценивать не только answer accuracy:

| Метрика | Почему важна |
| --- | --- |
| Authorized recall | Релевантное найдено внутри разрешённой области |
| Unauthorized exposure | Должно быть строго 0 |
| Evidence completeness | Claim возвращён вместе с необходимым provenance |
| Conflict completeness | Обе стороны либо ни одной |
| Source precision | Контекст действительно поддерживает ответ |
| Context tokens | Стоимость assembled context |
| Provider tokens | Полная стоимость planning/rerank/generation |
| Retrieval latency | P50/P95/P99 |
| Empty precision | Нерелевантный запрос не получает шум |
| Revocation latency | Stale turn сразу теряет доступ |
| Reproducibility | Одинаковый deterministic input даёт тот же plan |

### 10.3 Сравниваемые варианты

```text
Baseline A: текущий memory retrieval
Baseline B: flat resource chunks + hybrid retrieval
Treatment C: L0/L1/L2 hierarchical retrieval
Treatment D: hierarchy + typed query planner
Treatment E: hierarchy + planner + unified budget assembler
```

Условия сравнения:

- одинаковые source documents;
- одинаковая embedding model;
- одинаковый context token budget;
- одинаковая answer model;
- фиксированные seeds, где provider позволяет;
- отдельные development и final evaluation sets;
- confidence intervals;
- полный raw artifact для воспроизводимости.

### 10.4 Release gates

Новая архитектура допускается в production только если:

- unauthorized exposure остаётся 0 во всех тестах;
- current memory regression suite проходит полностью;
- document recall статистически лучше flat baseline либо даёт сопоставимое качество при существенно
  меньшем token/latency budget;
- stale membership/group tests проходят для каждого нового retrieval path;
- physical erasure подтверждён для content, summaries, vectors, traces и caches;
- provider crash не публикует partial resource version;
- rollback tested на реальной previous version;
- generated experience не может изменить capability surface.

---

## 11. Варианты использования самого OpenViking

### 11.1 Не рекомендуется: заменить память Osinara

Причины:

- слабее claim/evidence provenance;
- слабее family/group trust-zone model;
- destructive merge semantics;
- нет эквивалента exact HITL;
- подтверждённые isolation и erasure defects;
- alpha maturity;
- AGPL boundary;
- дополнительная distributed consistency между PostgreSQL и OpenViking.

### 11.2 Допустимый эксперимент: isolated document service

Если нужен быстрый spike, OpenViking можно запускать как отдельный restricted Docker service только
для несекретных документов.

Ограничения эксперимента:

- никакого raw Telegram timeline;
- никаких personal/family claims;
- никакого доступа к Osinara PostgreSQL;
- отдельный namespace или service instance на trust zone;
- debug vector endpoints отключены edge allowlist;
- self-evolution отключён;
- document content передаётся только после application authorization;
- результаты считаются недоверенными resource candidates;
- source URI повторно проверяется Osinara перед prompt injection;
- deployment использует immutable image и persistent storage;
- данные эксперимента можно полностью удалить.

Такой spike нужен только для измерения L0/L1/L2 и hierarchical retrieval. Он не должен становиться
новым memory source of truth.

### 11.3 Предпочтительный вариант: native implementation

Для долгосрочной архитектуры предпочтительно реализовать resource plane нативно рядом с текущими
application repositories:

- одна PostgreSQL authorization model;
- единый trust-zone lifecycle;
- общие opaque refs;
- общий audit;
- единый Docker deployment;
- отсутствие AGPL runtime dependency;
- возможность использовать существующие E5, workers и queue patterns.

---

## 12. Решение

### Принять

- L0/L1/L2 context hierarchy;
- отдельный resource plane;
- hierarchical retrieval;
- unified context budgeting;
- retrieval traces;
- semantic skill discovery после authorization;
- trajectories и experiences как отдельный evaluated layer;
- versioned activation и rollback.

### Адаптировать

- session commit patterns к существующей durable Telegram timeline;
- intent analysis к typed bounded planner;
- context filesystem к PostgreSQL resource tree и opaque refs;
- self-evolution к confirmed outcomes, offline eval и promotion gate;
- snapshots к immutable versions и active pointers.

### Не принимать

- OpenViking как memory source of truth;
- LLM destructive merge для human claims;
- prompt-level authorization;
- shared generic tenant boundary вместо family/group policy;
- автоматическую evolution без regression gate;
- debug vector surfaces;
- неприкреплённые runtime dependencies;
- local ephemeral production storage.

Финальная рекомендация:

> Развивать Osinara в сторону context platform, но не ослаблять её как evidence-backed семейную
> memory system. OpenViking следует использовать как источник архитектурных паттернов для resources,
> retrieval и experience learning, а не как готовую замену существующего memory backend.

---

## 13. Основные источники

- [OpenViking repository](https://github.com/volcengine/OpenViking)
- [Architecture](https://docs.openviking.ai/en/concepts/01-architecture)
- [Context Layers](https://docs.openviking.ai/en/concepts/03-context-layers)
- [Viking URI](https://docs.openviking.ai/en/concepts/04-viking-uri)
- [Storage Architecture](https://docs.openviking.ai/en/concepts/05-storage)
- [Context Extraction](https://docs.openviking.ai/en/concepts/06-extraction)
- [Retrieval Mechanism](https://docs.openviking.ai/en/concepts/07-retrieval)
- [Session Management](https://docs.openviking.ai/en/concepts/08-session)
- [Transactions and Recovery](https://docs.openviking.ai/en/concepts/09-transaction)
- [Multi-Tenancy](https://docs.openviking.ai/en/concepts/11-multi-tenant)
- [Memory API](https://docs.openviking.ai/en/api/16-memory)
- [Agent Evolution](https://docs.openviking.ai/en/api/19-agent-evolution)
- [Snapshots](https://docs.openviking.ai/en/guides/15-snapshot)
- [Official benchmark report](https://blog.openviking.ai/post/openviking-benchmark-results/)
- [Security issue #3724](https://github.com/volcengine/OpenViking/issues/3724)
- [User deletion issue #3660](https://github.com/volcengine/OpenViking/issues/3660)
- [Session tree issue #3640](https://github.com/volcengine/OpenViking/issues/3640)
- [Recall budget issue #3598](https://github.com/volcengine/OpenViking/issues/3598)
- [Empty extraction issue #3508](https://github.com/volcengine/OpenViking/issues/3508)
