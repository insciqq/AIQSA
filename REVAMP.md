# AIQSA — clean-slate UI/UX redesign brief

Дата аудита: 25 июля 2026 года
Статус: концепция, не реализация
Связанные задачи: `381-ui-ux-revamp`, `382-imagegen-provider-concepts`, `383-product-grounded-revamp-mockups`

## Короткий вывод

Текущий интерфейс не стоит «улучшать» по компонентам. Его главная проблема не в цвете, отступах или радиусах, а в экранной модели: почти каждая возможность постоянно превращена в chrome. В чате это две панели действий, инженерный composer и слабая иерархия чтения. В админке — метрики, десять равноправных вкладок, широкая таблица, row actions и бесконечный detail одновременно.

Нужна полная замена view layer и информационной архитектуры при сохранении уже сильных behavioral contracts, stores, controllers, backend и privacy boundaries.

Рекомендуемый продуктовый каркас:

- **Research Chat** — знакомый спокойный conversation workspace уровня ChatGPT/Claude;
- **Control Center** — отдельный task-led admin product, а не dashboard с горизонтальными вкладками;
- фирменная механика AIQSA — **Run receipt** под каждым ответом: компактная композиция уже существующих search/tool/citation/reasoning disclosures и перехода в реальные `Details → Branch / Events`.

Формула направления: **простота ChatGPT в основном потоке + contextual workspace Claude + проверяемость Perplexity**.

Для Control Center этого недостаточно. У текущей админки два независимых дефекта:

- визуально и композиционно она значительно слабее даже текущего chat UI;
- её базовая setup-модель заставляет одного владельца установки проходить multi-user RBAC и provider lifecycle, которые не относятся к его задаче.

Fresh-install путь вида `provider → key → model → activate → group → Model access → grant` для единственного администратора считается продуктовым дефектом, а не «power-user flexibility». Новый интерфейс должен доводить владельца от API key до первого рабочего чата без видимой работы с группами, assignments, draft/active versions или diagnostics.

## Что было сделано и что не было сделано

В код приложения изменения не внесены. Начатые до уточнения задачи component-level правки были остановлены и откатаны. В `.aiqsa/ui-revamp/` находятся только исследовательские скриншоты и изолированный статический прототип; он не импортирует компоненты приложения и не участвует в runtime/build.

В рамках концепции:

1. Зафиксированы свежие screenshots текущего chat и admin на desktop, tablet, mobile portrait и short landscape.
2. Проинвентаризированы все существующие capabilities, state owners, route aliases и privacy/access contracts.
3. Изучены актуальные interaction patterns ChatGPT, Claude, Perplexity и Gemini по официальным материалам.
4. Спроектированы новая IA, responsive model, progressive disclosure и ключевые admin workflows.
5. Собраны восемь high-fidelity static mockups, чтобы оценивать новую систему визуально до реализации.
6. Отдельно сгенерированы семь raster-концептов: Research Chat, provider index, Quick setup на desktop/mobile, success-state и Advanced provider detail.
7. После сверки с кодом собран отдельный product-grounded набор: реальные chat controls, реальные admin destinations, Personal Quick setup, Team Users/Model access и существующие Advanced provider sections. Слабые исходные генерации сохранены, исправленные варианты лежат рядом как `*-refined.png`.

Существующий code-rendered prototype и предыдущие raster-концепты сохранены без изменений. Дополнительная серия создана через разрешённый `imagegen` CLI fallback с `gpt-image-2`; использовался только локальный `OPENAI_API_KEY` из `.env`, значение ключа не копировалось в prompts или файлы. Product-grounded варианты проверялись визуально в оригинальном разрешении; когда генератор переносил выдуманную navigation из ранних concepts, создавался отдельный refined-файл вместо перезаписи исходника.

## Текущий интерфейс: честная оценка

### Итоговая оценка

| Область | Оценка | Почему |
|---|---:|---|
| Основной desktop chat | 5.5/10 | Функционален и читаем, но chrome конкурирует с разговором, composer выглядит как control panel, evidence оторван от чтения. |
| Mobile chat | 3.5/10 | Семь icon-only действий, почти нет места для title, run controls становятся отдельным dashboard внутри composer. |
| Details / branch inspection | 5/10 | Возможности сильные, но surface ощущается общей инженерной панелью, а не контекстом выбранного ответа. |
| Settings | 4/10 | Все работает, но один большой modal совмещает библиотеку, редактор, appearance и MCP; плотность и ownership неочевидны. |
| Desktop admin | 2.5/10 | Все сущности и действия доступны, но десять вкладок, KPI cards, таблица и detail wall имеют почти одинаковый визуальный вес. |
| Mobile admin | 1/10 | Это уменьшенный desktop: горизонтально обрезанные metrics/tabs/table, затем очень длинная стена selected detail. |
| Поведенческая архитектура | 8.5/10 | Stores/controllers, async ownership, guarded actions, branch/run contracts и route guards хорошо отделены от view layer. |

### Главная причина провала

Текущий UI проектировался как визуализация capability inventory: если функция существует, она получает постоянную кнопку, вкладку, card или row action. Рыночные лидеры делают обратное: постоянными остаются только location, content и primary action; вторичные возможности появляются у объекта и в момент задачи.

### Что нельзя брать в новый дизайн как основу

- текущие component boundaries и DOM composition;
- две toolbar-зоны над thread;
- model/provider/reasoning/search как набор отдельных постоянных controls;
- глобальные Copy/Branch/Share рядом с каждым другим header action;
- reserved action strip под каждым message;
- десять горизонтальных admin tabs;
- KPI cards перед любой admin-задачей;
- wide tables как единственная representation людей и групп;
- provider/MCP/email как одна бесконечная configuration page;
- текущие widths, dark palette, pills, borders и icon choices.

Это presentation debt, а не product contract.

## Зафиксированные требования к полному ревампу

### 1. Нынешний visual language отклонён целиком

Цель — не сделать текущую композицию аккуратнее. Новый shell должен восприниматься как современный conversation product уровня ChatGPT/Claude: спокойный canvas, сильная типографическая иерархия, один очевидный primary action, предсказуемая навигация и progressive disclosure. Текущие dark-control-panel palette, плотность, border/chip wall и component composition не являются основой следующей версии.

### 2. Single-member — основной setup path

Человек, который только установил AIQSA и имеет API key, не должен понимать `Groups`, `Model access`, group credentials, activation versions или diagnostics до первого вопроса. Для code-owned OpenAI, Anthropic и OpenRouter templates normal flow:

```text
Providers → provider → API key → Test & Save → Ready to chat
```

Если deterministic recommended model недоступна для этого key, единственный дополнительный шаг — компактный model picker. Нельзя автоматически брать первый элемент удалённого каталога, отправлять пользователя в общий Models/Groups workflow или сохранять частично настроенный graph.

### 3. Personal, Team и Advanced — navigation groups, не обязательный onboarding

Не вводятся искусственные коммерческие планы `Personal`, `Team`, `Enterprise`. Это уровни раскрытия одного Control Center:

- **Personal** — Providers и Usage;
- **Team** — реальные Users, Groups, Model access, Invites и Access rules;
- **Advanced** — MCP servers, Email delivery и Safety.

Полная provider configuration — не четвёртая navigation group: это explicit subview внутри Personal → Providers рядом с Quick setup.

Single-member installation сворачивает team и advanced groups по умолчанию. Existing team installations раскрывают их автоматически. Это presentation rule; admin authorization и прямые URL не меняются и capabilities не лицензируются.

### 4. Team/Enterprise UX тоже проектируется заново

Разделение не оправдывает нынешнюю админку для команды. Users, Groups и Model access должны стать task-led list/detail workflows с ясным объектом, impact preview и одной scoped primary action. Provider/MCP/Email lifecycle остаются безопасными, но внутренние revisions, validation evidence и activation mechanics не должны иметь одинаковый визуальный вес с повседневной работой.

## Визуальная база

### Текущий chat

- [Desktop thread](.aiqsa/ui-revamp/audit/chat-thread-1440x900.png)
- [Desktop thread with Details](.aiqsa/ui-revamp/audit/chat-details-1440x900.png)
- [Desktop Settings](.aiqsa/ui-revamp/audit/chat-settings-1440x900.png)
- [Desktop empty state](.aiqsa/ui-revamp/audit/chat-empty-1440x900.png)
- [Tablet 768×1024](.aiqsa/ui-revamp/audit/chat-thread-768x1024.png)
- [Mobile 390×844](.aiqsa/ui-revamp/audit/chat-thread-390x844.png)
- [Short landscape 844×390](.aiqsa/ui-revamp/audit/chat-thread-844x390.png)

### Текущий admin

- [Users desktop](.aiqsa/ui-revamp/audit/admin-users-1440x900.png)
- [Users tablet](.aiqsa/ui-revamp/audit/admin-users-768x1024.png)
- [Users mobile viewport](.aiqsa/ui-revamp/audit/admin-users-390x844.png)
- [Users mobile full page](.aiqsa/ui-revamp/audit/admin-users-390-full.png)
- [Providers desktop](.aiqsa/ui-revamp/audit/admin-providers-1440x900.png)
- [Providers mobile viewport](.aiqsa/ui-revamp/audit/admin-providers-390x844.png)
- [Providers mobile full page](.aiqsa/ui-revamp/audit/admin-providers-390-full.png)

Самые показательные свидетельства — mobile full-page captures: user detail превращается в длинный поток повторяющихся access values, а provider setup занимает множество экранов без устойчивого location/task context.

## Рыночный benchmark: что именно стоит заимствовать

Не нужно копировать брендинг, цвета или функции конкурентов. Нужна их зрелая interaction architecture.

| Pattern | ChatGPT | Claude | Perplexity | Решение для AIQSA |
|---|---|---|---|---|
| Global navigation | New chat, search, projects/history в тихом sidebar | Chats/projects/artifacts разделены по назначению | History/projects — индекс, не часть ответа | Один collapsible history/project rail; settings/admin/account внизу. |
| Empty state | Один вопрос и один composer | Composer — главный объект старта | Query box определяет homepage | Один понятный CTA: задать вопрос. Без feature card grid. |
| Composer | Tools за одним entry point; параметры сгруппированы | Model/effort доступны рядом с send, прочее раскрывается | Mode/model/sources собраны вокруг query | `Attach/Tools · Message · Run setup · Send`; полные параметры одним уровнем глубже. |
| Secondary surface | Canvas открывается по задаче | Artifact открывается справа по событию | Sources относятся к конкретному answer | Details закрыт по умолчанию и открывается от Run receipt/answer action. |
| Evidence | Sources рядом с response | Work surface связан с conversation context | Citations и source mode встроены в session | Inline citations + Run receipt + contextual evidence drawer. |
| Admin/settings | Отдельный workspace settings shell | Отдельные organization settings | Vertical settings navigation | Отдельный Control Center с grouped vertical navigation и resource routes. |

Официальные источники:

- [ChatGPT Projects: sidebar, project context and composer tools](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [ChatGPT Canvas: side-by-side contextual workspace](https://openai.com/index/introducing-canvas/)
- [ChatGPT release notes: simplified mobile sidebar](https://help.openai.com/en/articles/6825453-chatgpt-release-notes)
- [Claude Projects: left navigation and right-side project knowledge](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)
- [Claude Artifacts: on-demand right-hand work surface](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Perplexity Sessions: answer, sources and response-level actions](https://www.perplexity.ai/help-center/en/articles/10354769-what-is-a-thread)
- [Perplexity Projects: dedicated workspace and unified history](https://www.perplexity.ai/help-center/en/articles/10352961-what-are-spaces)
- [Gemini redesign: easier chat start and clearer content discovery](https://blog.google/products-and-platforms/products/gemini/gemini-3-gemini-app/)

## Новая продуктовая модель

### 1. Research Chat

Основной продукт — разговор и чтение ответа. На любом размере экрана пользователь должен мгновенно понимать:

1. где он находится;
2. какой вопрос/ответ сейчас читает;
3. как задать follow-up;
4. где проверить источники и run provenance.

Все остальное — progressive disclosure.

### 2. Control Center

Admin — самостоятельный operational product с другой задачей и плотностью. Пользователь приходит не «посмотреть dashboard», а выполнить конкретную работу: одобрить доступ, активировать provider, проверить MCP, настроить email, расследовать проблему или сделать guarded safety action.

### 3. Signature mechanism: Run receipt

После каждого ответа располагается одна тихая строка:

`Balanced · OpenAI / GPT-5.6 Terra · 2 search calls · 2 tools · 8 citations`

Она решает сразу три задачи:

- сохраняет уникальную прозрачность AIQSA;
- делает уже существующие search calls, tool activity, citations, reasoning и usage частью reading flow;
- заменяет постоянный инженерный chrome единым понятным entry point без добавления нового backend capability.

Сегменты раскрывают существующие inline disclosures `N search calls`, `Used N tools`, `Citations N`, `Reasoning N` и `Context trimmed`. Полная инспекция остаётся в существующем `Details` с двумя вкладками `Branch` и `Events`. Отдельные `Sources`, `Activity` или `Request` tabs не вводятся. Само объединение этих entry points в одну строку — proposal для нового view layer, а не уже shipped UI.

## Новая информационная архитектура

```text
AIQSA
├── Research Chat
│   ├── New Chat
│   ├── New folder
│   ├── Search chats
│   ├── Folders
│   │   └── Chat rows
│   ├── Active conversation
│   │   ├── Messages
│   │   ├── Run receipt
│   │   ├── Search / tools / citations / reasoning disclosures
│   │   └── Details
│   │       ├── Branch
│   │       └── Events
│   ├── Settings
│   │   ├── Prompts
│   │   ├── Appearance
│   │   └── MCP & tools
│   └── Account / sharing
└── Control Center
    ├── Personal
    │   ├── Providers
    │   │   └── Run profiles
    │   └── Usage
    ├── Team [collapsed for single-member]
    │   ├── Users
    │   ├── Groups
    │   ├── Model access
    │   ├── Invites
    │   └── Access rules
    └── Advanced [collapsed until configured]
        ├── MCP servers
        ├── Email delivery
        └── Safety
```

Это использует только реальные shipped destinations. `Run profiles` остаётся частью `Providers`, а не выдуманной global tab. В Control Center нет отдельных `Overview`, `Models`, `Tools`, `Delivery`, `Audit`, `Activity`, `Evaluations`, `Datasets`, `Policies`, `Monitoring`, `Governance` или admin `Settings` destinations.

Существующие admin aliases `users`, `usage`, `groups`, `model-access`, `providers`, `mcp`, `email`, `invites`, `access-rules` и `safety` должны продолжить работать во время migration. Group headings меняют только navigation hierarchy и disclosure, но не создают новые product resources.

## Screen model: Research Chat

### Navigation rail

Реальные элементы desktop sidebar, которые допускается перекомпоновать, но нельзя подменять выдуманными destinations:

- `New Chat`;
- `New folder`;
- `Search chats`;
- folders и вложенные chat rows.

Отдельного `Recent` heading и account block в shipped sidebar нет; product-grounded макеты их не добавляют. Chat/folder actions открываются через row overflow. Inline rename/move/create могут остаться interaction patterns, но не должны постоянно занимать место.

### Conversation header

Один уровень:

- sidebar toggle, когда нужен;
- folder context + conversation title;
- Share;
- conversation overflow.

Branch indicator появляется только при наличии forks. Copy thread, export, rename, move и delete живут в overflow. Settings и admin не находятся в conversation header.

### Empty state

Один headline, короткое обещание прозрачности и composer. Никаких feature tiles, onboarding dashboard или огромного брендинга.

### Messages

- user message — компактная bubble;
- assistant answer — document flow без card container;
- citations рядом с claims;
- после ответа — Run receipt;
- direct actions: `Copy`, `Regenerate`; feedback, Edit, Delete и Branch — в More;
- warnings и recovery остаются рядом с originating answer.

### Composer

Постоянная поверхность содержит только:

- attachment/tools entry point;
- message field;
- readable run summary;
- Send/Stop.

Shipped composer уже содержит `Fast`, `Balanced`, `Deep`, `Model`, `Reasoning`, `Search`, `Run settings`, `Message`, `Usage`, attachments и `Send/Stop`. `Run setup` может визуально собрать более редкие model controls, prompt, MCP readiness, temperature, max output и streaming/background, но это только новая presentation существующего state. Первый grounded chat mockup намеренно показывает реальные controls и labels до принятия решения об их дополнительном сворачивании.

### Evidence and branches

Details открывается от выбранного answer/run и поэтому всегда имеет понятный context. Внутри остаются ровно реальные `Branch` и `Events`; citations, reasoning и tool/search disclosures остаются рядом с ответом. На desktop это overlay drawer, на ultrawide — optional pinned pane, на mobile/tablet — full-height sheet/page. Run start/completion не открывает его автоматически.

### Settings

Settings становится нормальной destination/sheet с устойчивой навигацией по существующим `Prompts`, `Appearance` и `MCP & tools`. Prompt library/editor может использовать master-detail на desktop. Dirty state и autosave contracts сохраняются. WCAG и отдельная accessibility-работа отложены и не входят в acceptance текущего ревампа.

## Screen model: Control Center

### Global shell

- grouped vertical navigation;
- current section/object title;
- одна primary action на surface;
- account/return-to-workspace в устойчивом месте;
- refresh только там, где он отражает реальную data operation.

Существующие summary metrics не превращаются в отдельную выдуманную `Overview` tab и не повторяются перед каждой задачей. В Personal state они уступают место setup progress; в Team state остаются компактным attention context только там, где помогают перейти к pending users, no-access users или open invites.

### Progressive Control Center disclosure

Control Center определяет presentation state из реальной установки, а не из тарифного плана:

- **Personal:** один active admin, нет meaningful team users/invites/rules/grants/credential assignments. Primary destination — `Providers`; `Team` свёрнут.
- **Team:** существуют другие users, invites/access rules, meaningful group grants или group credential assignments. `Team` раскрыт.
- **Advanced navigation:** существующая MCP- или SMTP-конфигурация раскрывает группу `Advanced`; при неизвестном состоянии она раскрывается fail-open, а direct route всегда остаётся видимым.

Это не то же самое, что advanced configuration внутри Personal → Providers. Там custom API root, OpenAI-compatible protocol, несколько credentials, `require_assignment`, routing/capability overrides или незавершённый advanced draft переводят только выбранного provider из Quick setup в полную configuration view и не раскрывают navigation-группу `Advanced`.

Bootstrap `private-operators` с единственным acting admin и без grants/assignments не считается Team setup. Нельзя связывать presentation с mutable group name. При сомнении существующая конфигурация раскрывается, чтобы интерфейс не скрывал действующее policy.

Эта классификация приходит в shell как secret-free `AdminDashboard.navigation`: сервер учитывает acting admin, users, invite/rule history, enabled group access, group MCP grants, group credential assignments и наличие MCP/SMTP configuration. Frontend не загружает полные Providers/MCP/Email resources ради навигации и не пытается угадать состояние по названиям или скрытым lifecycle-полям. Обычный вход из Account использует существующий `?section=providers`; bare `/admin` по принятому compatibility-контракту остаётся Users.

### Common resource pattern

```text
Section index → searchable/filterable resource list → named detail route → scoped task/workflow
```

На desktop list/detail split допустим только при достаточной ширине. На mobile list и detail — отдельные views с нормальным Back behavior.

### People and access

`Users` показывает identity, verification/status, role/group summary, effective provider/model/search access и last session. Действия не повторяются четырьмя кнопками в каждой строке; selected-user detail собирает существующие group editor, effective entitlements, direct MCP permissions и session/account actions вокруг одного объекта. Новые global tabs или несуществующие direct model overrides не добавляются.

`Groups` и `Model access` остаются отдельными реальными destinations, но переход между выбранной group и её provider/model/search/MCP grants должен сохранять объект и context. Credential assignment остаётся provider authentication policy и не притворяется model entitlement.

### Providers

Для известного провайдера default path обязан быть короче любой внутренней provider lifecycle:

```text
Providers
→ выбрать OpenAI / Anthropic / OpenRouter
→ вставить API key
→ Test & Save
→ Provider is ready
```

Это не wizard и не сокращённая версия сложной формы. На базовом экране нет API root, protocol, credential label/version, group assignment, model capability matrix, routing, activation version или diagnostics. Пользователь уже пришёл с единственным необходимым input — ключом — и должен увидеть одно write-only поле и одну primary action. `Advanced configuration` остаётся вторичной disclosure-ссылкой.

`Test & Save` — новый server-side orchestration contract, а не переименование нынешней client-side последовательности:

1. разрешает Quick setup только для code-owned OpenAI, Anthropic и OpenRouter templates с canonical API root;
2. проверяет unsaved key bounded read-only catalog request без платной generation;
3. выбирает deterministic code-owned recommended deployment, а не первый remote catalog row;
4. если recommendation недоступна, ничего не сохраняет и показывает один компактный model picker;
5. атомарно создаёт/обновляет canonical connection, `Primary` credential, default credential и `use_default` policy;
6. активирует только выбранные known recommended model deployments и authoritative availability checks;
7. создаёт model-specific direct `AccessGrant` только acting admin, как прямо разрешает ADR 0022;
8. устанавливает user default только если предыдущего usable default нет, и заполняет только disabled run-profile slots;
9. возвращает `Ready` только если deployment уже присутствует в filtered current-user catalog.

Quick setup никогда не создаёт, не переименовывает и не меняет groups, memberships, group grants или group credential assignments. Bootstrap `private-operators` не появляется в этом UX. Добавление второго provider не перезаписывает существующие user/chat defaults, profile mappings или настройки первого provider.

Сохранённый secret никогда не возвращается в input: UI показывает `Key configured · updated …`, а replacement начинается с пустого `New API key`. При rotation новый key сначала тестируется; failure оставляет прежнюю active credential/version рабочей.

Честные outcome states:

- `Testing key… → Activating model… → Granting access…`;
- invalid/unreachable key: ничего не сохранено, введённое значение остаётся для retry;
- no known recommendation: один model picker, без перехода в Groups или общий advanced editor;
- partial setup: `Setup needs attention`, если ready current-user catalog получить нельзя;
- success: `Ready to chat`, точная active model и `Start chatting`.

Обычный connected-state показывает только status, active/default model, `Replace API key` и `Advanced configuration`. Никакие internal checks или draft/active counters не становятся обязательным user workflow.

`Advanced configuration` использует только существующие provider concepts: `Run profiles`, connection fields, `Credentials`, `Key assignment`, `Models` и `Diagnostics and troubleshooting`. Там остаются custom OpenAI-compatible `Responses`/`Chat Completions`, private-network policy, несколько credentials и rotation/revoke, default/required assignment policy, group overrides, upstream model ids, capability/default-parameter overrides, OpenRouter routing, explicit activation, optional paid diagnostics, enable/disable и deletion blockers.

Connection/model revision history, rollback, provider `Activity`, audit trail и provider-specific audit subsystem не существуют и не должны появляться в макетах. ADR 0022 хранит только credential-version history; connection/model используют bounded draft/active counters. MCP revisions — отдельный MCP contract и не должны визуально загрязнять provider Quick setup.

Quick setup требует отдельного backend endpoint/orchestrator; собирать эту цепочку серией browser mutations нельзя, потому что это снова создаст partially configured state. До реализации это proposal, который должен получить API tests и обновление owning contracts/ADR evidence.

### MCP servers

`MCP servers` остаётся отдельной destination в navigation-группе Advanced. Реальные import/normalize, definition/auth configuration, validation/tool inventory, activate/update, revision, best-effort rollback и rebuild capabilities оформляются как scoped tasks вокруг выбранного server. Нельзя добавлять выдуманную global `Activity`/audit поверхность. Whole-server trust warning, OAuth settlement и external/runtime effects остаются explicit, но revision mechanics не показываются в Personal provider setup.

### Email delivery

Configuration flow разбивается на connection, authentication, security, test и activation. Plaintext relay acknowledgement показывается только при соответствующем выборе. Active/draft health виден на overview, а не повторяется перед каждым field.

### Invitations and access rules

One-off invite и durable access rule остаются разными concepts. Create flow отделен от history/index. Свежий one-time URL получает explicit copy state; старые links не имитируют recoverability.

### Usage and Safety

Usage — read-only analytical document с local comparison tables на desktop. В compact/tablet/short-landscape все факты остаются inline в native rows без squeezed wide table и без выдуманного drill-down.

Safety — самостоятельная section с acting-admin context, последствиями, guardrails и confirmation-gated destructive actions.

## Responsive model

### Chat

| Viewport | Composition |
|---|---|
| `>= 1024px` | 248–264px history rail + centered 720–760px reading column. Details overlay by default. |
| `>= 1440px` | Optional 360–384px pinned Details without destroying reading measure. |
| `768–1023px` | Sidebar drawer, one-column conversation, Details as sheet. |
| `<= 767px` | Header `menu · title · more`, conversation, bottom composer. Share in More. |
| Short landscape | Compact composition regardless of width; no persistent rail/details, collapsed run summary. |

### Admin

| Viewport | Composition |
|---|---|
| `>= 1200px` | 224–240px grouped navigation + main content; list/detail only where it remains readable. |
| `768–1199px` | Collapsible admin nav; single primary page; contextual drawer where appropriate. |
| `<= 767px` | List and object detail are separate routes/views; filters in sheet; semantic summary rows. |
| Short landscape | Single-task view with compact local header; no desktop table squeeze. |

Ни primary navigation, ни document page не должны иметь horizontal overflow. Только comparison-heavy local table region может прокручиваться внутри явно названной области.

## Visual direction

Концепт намеренно light-first, чтобы визуально и психологически разорвать связь с нынешним black control panel. Это не означает отказ от dark mode; все semantic roles должны иметь parity.

### Character

Спокойный исследовательский инструмент: точный, тихий, знакомый, не «футуристичный». Admin — тот же инструмент в maintenance mode.

### Palette direction

| Role | Light concept | Dark parity direction |
|---|---|---|
| Canvas | `#FBFCFB` | `#101413` |
| Navigation | `#F3F5F3` | `#151A18` |
| Surface | `#FFFFFF` | `#1B211F` |
| Ink | `#1C211F` | `#E8ECEA` |
| Muted | `#67706C` | `#98A19D` |
| Separator | `#E0E5E2` | `#303936` |
| Evidence/action teal | `#176F65` | `#51B8A9` |
| Warning / danger | semantic amber / rose only | semantic amber / rose only |

### Typography and density

- neutral system/Inter/Geist-like sans;
- answer: 15.5–16px, line-height 1.62–1.68;
- UI: 13–14px;
- metadata: 11–12px;
- monospace only for token counts, timestamps, ids in deep inspection;
- 4px spacing base, 8/12/16px common rhythm;
- 44px coarse-input targets;
- borders and surface shifts establish depth; shadows only for composer/overlay;
- no gradients, neon, badge carpet or card wall.

## Concept screens

### Existing code-rendered set — preserved unchanged

Исходник прототипа: [.aiqsa/ui-revamp/concept/index.html](.aiqsa/ui-revamp/concept/index.html)

#### Research Chat

- [New conversation desktop](.aiqsa/ui-revamp/concept/chat-empty-1440x900.png)
- [New conversation mobile](.aiqsa/ui-revamp/concept/chat-empty-390x844.png)
- [Active conversation with contextual Details](.aiqsa/ui-revamp/concept/chat-active-details-1440x900.png)
- [Active conversation mobile](.aiqsa/ui-revamp/concept/chat-active-390x844.png)
- [Active conversation short landscape](.aiqsa/ui-revamp/concept/chat-active-844x390.png)

#### Control Center

- [Operations overview desktop](.aiqsa/ui-revamp/concept/admin-overview-1440x900.png)
- [Provider detail desktop](.aiqsa/ui-revamp/concept/admin-provider-1440x900.png)
- [User access detail mobile](.aiqsa/ui-revamp/concept/admin-user-access-390x844.png)

Эти screenshots — ранний direction prototype, а не pixel-perfect design system и не product inventory. В них могут встречаться рабочие названия и surfaces, которых нет в AIQSA; для решения о составе экранов источником является product-grounded set ниже.

### Earlier image-generated set — preserved exploratory material

Серия сохранена отдельно и не заменяет предыдущие файлы:

- [Research Chat desktop with contextual Sources & activity](output/imagegen/aiqsa-ui-concepts-v2/01-research-chat-desktop.png)
- [Providers index with immediate key entry](output/imagegen/aiqsa-ui-concepts-v2/02-providers-quick-entry-desktop.png)
- [Quick setup desktop — preferred refined version](output/imagegen/aiqsa-ui-concepts-v2/03b-provider-quick-setup-desktop-refined.png)
- [Quick setup desktop — original generation retained](output/imagegen/aiqsa-ui-concepts-v2/03-provider-quick-setup-desktop.png)
- [Quick setup mobile](output/imagegen/aiqsa-ui-concepts-v2/04-provider-quick-setup-mobile.png)
- [Advanced provider overview](output/imagegen/aiqsa-ui-concepts-v2/05-provider-advanced-desktop.png)
- [Quick setup success-state](output/imagegen/aiqsa-ui-concepts-v2/06-provider-quick-success-desktop.png)
- [Batch prompt set](output/imagegen/aiqsa-ui-concepts-v2/prompts.jsonl) and [desktop refinement prompt](output/imagegen/aiqsa-ui-concepts-v2/03b-refinement-prompt.txt)

Эта серия фиксирует понравившийся visual direction, но не является источником правды по navigation или capabilities: генератор добавил в неё `Sources & activity`, provider-local `Overview/Activity`, global Models/Profiles/Governance и другие отсутствующие surfaces. Файлы оставлены как визуальные референсы и не удалены по просьбе оператора.

### Product-grounded image-generated set — основной набор для review

Новая серия сверена с существующими chat/admin routes, labels, provider families и ADR 0022/0024. Там, где экран показывает предлагаемую orchestration, она использует существующие сущности и отдельно помечена как proposal в этом документе.

- [Active chat with real Events detail and composer controls](output/imagegen/aiqsa-product-mockups-v1/01-chat-active-events-desktop.png)
- [Fresh-install no-model state — preferred refined version](output/imagegen/aiqsa-product-mockups-v1/02-chat-no-model-admin-desktop-refined.png)
- [Fresh-install no-model state — original generation retained](output/imagegen/aiqsa-product-mockups-v1/02-chat-no-model-admin-desktop.png)
- [Personal provider Quick setup](output/imagegen/aiqsa-product-mockups-v1/03-personal-provider-quick-setup-desktop.png)
- [Personal provider success — preferred refined version](output/imagegen/aiqsa-product-mockups-v1/04-personal-provider-success-desktop-refined.png)
- [Personal provider success — original generation retained](output/imagegen/aiqsa-product-mockups-v1/04-personal-provider-success-desktop.png)
- [OpenAI Quick setup mobile — preferred refined version](output/imagegen/aiqsa-product-mockups-v1/05-openai-quick-setup-mobile-refined.png)
- [OpenAI Quick setup mobile — original generation retained](output/imagegen/aiqsa-product-mockups-v1/05-openai-quick-setup-mobile.png)
- [Team Users](output/imagegen/aiqsa-product-mockups-v1/06-team-users-desktop.png)
- [Team Model access — preferred refined version](output/imagegen/aiqsa-product-mockups-v1/07-team-model-access-desktop-refined-v4.png)
- [Team Model access — navigation-only refinement retained](output/imagegen/aiqsa-product-mockups-v1/07-team-model-access-desktop-refined.png)
- [Team Model access — original generation retained](output/imagegen/aiqsa-product-mockups-v1/07-team-model-access-desktop.png)
- [Advanced provider Credentials — preferred refined version](output/imagegen/aiqsa-product-mockups-v1/08-provider-advanced-desktop-refined.png)
- [Advanced provider Credentials — original generation retained](output/imagegen/aiqsa-product-mockups-v1/08-provider-advanced-desktop.png)
- [Prompts and review notes](output/imagegen/aiqsa-product-mockups-v1/README.md)

Основная последовательность review: fresh-install no-model → Personal Quick setup → success → Start chatting. Затем отдельно: Team Users → Team Model access и Advanced provider Credentials. Это намеренно не один onboarding funnel: Team и Advanced — раскрываемые рабочие области, а не обязательные шаги и не коммерческие планы.

В текущем продукте уже существуют показанные Chat, Users, Model access и Advanced provider capabilities. `Test & Save`, atomic recommended-model activation, direct grant acting admin, Personal/Team disclosure и no-model admin CTA — предложения для реализации; они требуют нового server-side orchestration endpoint и contract tests, описанных выше.

## Capability parity: что обязано пережить замену UI

Новый view layer может не сохранить ни один нынешний leaf component, но должен сохранить:

- все auth/invite/verification/reset/OAuth states и privacy-safe errors;
- chat search, favorites, folders/projects, persistence and row mutations;
- per-chat drafts, attachments, edit mode, all model/search/reasoning/prompt/run controls;
- cross-chat concurrent runs, streaming/recovery/cancellation and scroll ownership;
- safe Markdown, code, math, citations, reasoning, tool activity and warnings;
- regenerate/edit/delete/branch/checkout/copy/share semantics;
- Branch and Events evidence completeness;
- command palette, existing interaction behavior and confirmations;
- prompts, MCP and five appearance themes;
- sanitized immutable public share contract;
- every admin capability across Users, Usage, Groups, Model access, Providers, MCP servers, Email delivery, Invites, Access rules and Safety;
- all loading, empty, stale, unavailable, success, error and guarded destructive states;
- local persistence keys or an explicit migration for active chat, collapsed folders, Details mode and theme;
- existing admin section aliases and both MCP OAuth callback URL families.

Behavioral owners such as `workspaceStore`, `threadStore`, `composerSessionStore`, `composerControlStore`, `runLifecycleStore`, `runSurfaceStore` and admin controllers should be reused through semantic adapters. They are an asset; current markup is not.

## Recommended migration plan — only after visual sign-off

### Phase 0 — product/design validation

- использовать product-grounded set как основной объект review; ранние static/raster concepts — только как visual reference;
- keep the existing user-facing `Folders` terminology unless a separate product change is approved;
- validate Run receipt content and information priority;
- prototype full Run setup, Details sheet and one admin resource flow;
- usability test the three critical journeys: ask/inspect, one-minute provider Quick setup, user access change;
- separately test whether experts can find Advanced provider controls without exposing them in the default flow.

### Phase 1 — new foundation and shell

- introduce new semantic visual tokens and typography rhythm;
- build a parallel Research Chat shell and Control Center shell;
- preserve route guards and state owners;
- establish viewport and safe-area contracts; accessibility and reduced-motion expansion are deferred.

### Phase 2 — ask/read loop

- workspace rail and conversation header;
- message document flow and action menus;
- unified composer and Run setup;
- loading, streaming, recovery and empty states.

### Phase 3 — evidence and branching

- Run receipt;
- existing inline search/tool/citation/reasoning disclosures plus contextual `Details → Branch / Events`;
- mobile full-screen inspection;
- sharing and branch workflows.

### Phase 4 — settings, auth and public surfaces

- dedicated settings IA;
- prompts/MCP/appearance parity;
- auth family and anonymous share visual alignment.

### Phase 5 — Control Center shell

- grouped navigation and route compatibility;
- contextual attention summaries inside real destinations, without a new `Overview` route;
- shared resource index/detail patterns;
- mobile list/detail routing.
- Usage factual ledger and isolated Safety workflow.

### Phase 6 — complex admin workflows

- Users, Groups, Model access, Invites, Access rules and Email delivery;
- provider Quick setup orchestration, failure recovery and non-destructive defaults;
- Advanced provider Run profiles, Connection, Credentials, Key assignment, Models and Diagnostics lifecycle;
- MCP lifecycle.

### Phase 7 — parity audit and retirement

- capability matrix against every old flow/state;
- responsive audit at 1440×900, 768×1024, 390×844 and 844×390; no WCAG/accessibility audit in this phase;
- screenshot comparison and browser tests;
- remove old view components only after full parity is proven.

## Decisions recommended for sign-off

1. **Approve the two-product model:** Research Chat + Control Center.
2. **Approve Run receipt as the AIQSA signature.** It differentiates the product without unfamiliar interaction.
3. **Approve light-first concept with complete dark parity.** This creates the clearest visible break from the old UI.
4. **Approve route-based admin object details.** One extra navigation step is worth stable URLs, Back behavior and mobile clarity.
5. **Approve progressive Run setup.** Advanced control becomes one click deeper, while the common ask/read loop becomes dramatically clearer.
6. **Approve provider Quick setup as the admin default.** For known providers the complete normal flow is `key → Test & Save → ready`; Advanced remains available for exceptional infrastructure work.
7. **Approve Personal/Team/Advanced as disclosure, not plans.** Single-member setup не проходит группы; существующие team/advanced configurations остаются полностью доступны и автоматически раскрываются.

## Final opinion

AIQSA does not have a weak product underneath a bad interface. It has a strong, unusually transparent behavioral core hidden inside a view layer that treats every capability as equally important.

The chat is salvageable only at the behavioral level; visually it should be replaced. The admin should be rebuilt from its jobs and resource lifecycles, not from the current tabs and sections. Trying to polish the present layout would spend time preserving the exact thing that makes it feel unlike ChatGPT/Claude: permanent operational complexity around every task.

The clean-slate direction is not especially creative, and that is intentional. It uses the interaction grammar users already understand, then gives AIQSA one clear identity: every answer is calm to read and easy to verify.
