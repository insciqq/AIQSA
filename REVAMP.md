# AIQSA UI/UX Revamp

Актуально на 2026-07-26. Этот документ фиксирует продуктовую оценку и направление полного ревампа. Точные runtime-контракты принадлежат `agent_docs/FRONTEND.md`, `agent_docs/DESIGN_SYSTEM.md` и ADR 0028.

## Короткий вывод

Первый вариант ревампа сменил цвета и композиционные детали, но унаследовал старую экранную модель. Это не считается успешным новым UI/UX:

- provider setup оказался под искусственным `Personal`, а team/custom state превращал все провайдеры в блокирующий `Advanced`;
- Users и Groups выглядели кликабельными, но открывались только через маленькую кнопку действия;
- Groups и Model access дублировали один group-owned workflow;
- desktop admin продолжал показывать список и длинный detail одновременно;
- пустой чат оставлял главный ввод внизу вместо того, чтобы сделать его центром первого действия.

Исправление — не косметический pass. Research Chat и Control Center должны использовать новую task-first модель, сохранив backend, entitlements, provider lifecycle, QSA transparency и существующие реальные capabilities.

## Что берём у лидеров рынка

ChatGPT, Claude и Open WebUI используются как benchmark зрелости interaction architecture, а не как источник брендинга или функций.

| Pattern | Наблюдение | Решение AIQSA |
| --- | --- | --- |
| Новый чат | Главный объект старта — один центральный composer | Пустой ready chat центрирует существующий composer; после первого send тот же owner переходит вниз |
| Conversation shell | История тише текущего разговора; вторичные функции раскрываются по задаче | Workspace rail + один conversation column; Details закрыт по умолчанию |
| Provider connection | Частый путь начинается с выбора сервиса и key, а сложная topology живёт отдельно | Provider -> key -> Test & Save; Connections и Run profiles остаются видимыми peer-задачами |
| Organization settings | Вертикальная subject navigation и отдельные resource pages | Control Center без plan-like Personal/Team/Advanced и без горизонтальной стены tabs |
| Resource administration | Сначала каталог, затем отдельный object detail | Полная строка кликабельна; list и detail не показываются как обязательный split |

У лидеров taxonomy различается по владельцу policy: ChatGPT разводит Members, Groups, roles/permissions и Models по workspace settings, а Claude отделяет member administration от organization model access/custom roles. AIQSA не копирует названия вкладок буквально. Здесь membership, model/search grants и MCP grants принадлежат выбранной группе, поэтому они собраны в одном `Access & groups` destination и разведены peer-задачами внутри group detail; каталог пользователей остаётся отдельным ресурсом.

Проверенные ориентиры:

- [ChatGPT home page](https://help.openai.com/en/articles/9125172-the-chatgpt-home-page)
- [Open WebUI interface](https://github.com/open-webui/open-webui/blob/main/demo.png)
- [Open WebUI settings](https://docs.openwebui.com/getting-started/quick-start/settings/)
- [Open WebUI provider setup](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai/)
- [Open WebUI groups](https://docs.openwebui.com/features/authentication-access/rbac/groups/)
- [ChatGPT workspace management](https://help.openai.com/en/articles/8411955)
- [ChatGPT Enterprise groups](https://help.openai.com/en/articles/9083985-groups-in-chatgpt-enterprise-and-edu)
- [Claude model access](https://support.claude.com/en/articles/15694740-manage-model-access-for-your-organization)
- [Claude member management](https://support.claude.com/en/articles/13133750-manage-members-on-team-and-enterprise-plans)

## Принципы нового UX

1. **Primary task виден сразу.** Частый сценарий не начинается с disclosure, revision history или промежуточного объекта.
2. **Весь row означает переход.** Если строка выглядит как resource row, она открывает resource; отдельный `Details` для этого не нужен.
3. **Список и detail — разные состояния.** Пользователь сначала сканирует полный индекс, затем работает с одним объектом и возвращается Back.
4. **Нет автоматического первого detail.** Первый ресурс не выбирается только потому, что он первый в массиве.
5. **Internal mechanics остаются internal.** Draft/active versions, validation evidence, routing и credential assignments доступны внутри Connections, но не формируют first-run UX.
6. **Concept art не создаёт продукт.** В runtime попадают только существующие routes, entities, controls и доказуемые состояния.
7. **Один state owner.** Новый layout не создаёт второй composer, provider registry, group selection или API orchestration path.

## Research Chat

### Empty/new chat

Ready-пустой chat использует один центральный стартовый блок:

```text
What do you want to investigate?
[ existing composer with Message / Attach / Model / Profile / Search / More / Tools / Send ]
```

Никаких suggestion cards, feature dashboard, fake prompts или второго «упрощённого» composer. При начале first-chat creation или появлении optimistic/persisted message тот же mounted composer занимает thread tail. Loading, error и no-model состояния остаются честно отличимыми.

Blank state визуально prompt-first: верхняя панель не показывает Share, Details и conversation menu до появления разговора; composer оставляет прямые Model, доступные Fast/Balanced/Deep и Search, а также More, Tools, Attach и Send. More владеет полной расширенной настройкой, Usage остаётся существующим disclosure. Это уменьшает конкуренцию с первым вопросом, не создавая отдельной control model.

### Active chat

После первого сообщения разговор становится обычным reading surface:

- вопрос компактный;
- ответ идёт документным потоком;
- citations, search, tool activity и reasoning остаются рядом с породившим их ответом;
- завершённые search/citation facts и Run receipt собраны в один компактный evidence-блок и показывают только реальную persisted evidence;
- Branch и Events остаются единственными Details destinations;
- composer находится внизу и не меняет владельца draft/run controls.

### Visual character

Цель — спокойный conversation product уровня ChatGPT/Claude, но со своей прозрачностью AIQSA:

- light-first paper canvas и тихий rail;
- graphite ink и сдержанный teal/proof accent;
- границы обозначают структуру, а не каждую вложенность;
- тени только у composer/overlay, не у постоянных рядов;
- sentence case, ясные labels, минимум badges;
- существующие пять тем и новая `paper` продолжают работать через одни semantic tokens.

## Control Center

### Глобальная информационная архитектура

```text
Control Center
├── AI setup
│   └── Providers
├── Team & access
│   ├── Users
│   ├── Access & groups
│   ├── Invites
│   └── Access rules
├── Operations
│   └── Usage
├── Infrastructure
│   ├── MCP servers
│   └── Email delivery
└── Safety
    └── Safety
```

Headings статичны и служат только ориентацией. Это не планы, роли, тарифы, onboarding stages или collapsible состояние установки. Bare `/admin` открывает Providers.

Canonical section — `access`. Старые `groups` и `model-access` остаются compatibility aliases и нормализуются в Access & groups; двух видимых destinations больше нет.

### Providers: базовый путь

Главный single-member сценарий:

```text
Providers -> OpenAI / Anthropic / Gemini / OpenRouter -> API key -> Test & Save -> Ready
```

Рядом находится отдельная задача `Connect custom endpoint`, а не пятая branded provider-card и не вход в отдельный Advanced mode:

```text
API root -> manual model ID -> API key -> Test & Save -> Ready
```

Она фиксирует OpenAI-compatible Chat Completions, показывает derived `/chat/completions`, сразу создаёт direct credential assignment + model entitlement acting administrator и не требует группу. Empty key разрешён только как явный no-auth для подтверждённого private/local HTTP endpoint; hosted path остаётся endpoint + key. Names/capabilities находятся в одном тихом disclosure, а full lifecycle остаётся в Connections.

На экране сразу есть:

- четыре provider choices;
- выбранный provider;
- одно write-only поле API key;
- одна primary action `Test & Save`;
- короткое фактическое объяснение, что будет сделано;
- постоянно видимая peer-навигация `Setup` / `Connections` / `Run profiles` и контекстный `Manage provider connection` там, где уже есть конфигурация.

На compact viewport четыре provider choices складываются в короткую сетку 2 × 2; на широком экране это одна строка из четырёх. Поле key и `Test & Save` должны помещаться в первый экран после заголовка; объясняющая правая колонка появляется только когда для неё действительно есть место.

Provider никогда не получает блокирующий UI-status `Advanced` только из-за group assignments, extra models, extra credentials или другого custom connection. Existing team/custom state показывается как спокойная nonblocking информация и сохраняется без изменений.

Gemini в этом UX остаётся тем же простым key-flow, но runtime под ним полностью native Interactions v1 и не имеет OpenAI-compatible fallback. Выбранный Google Search показывает validated Search Suggestions и citations только рядом с текущим live grounded-answer; после reload остаётся честный placeholder, а такой branch нельзя публиковать через anonymous Share.

Quick setup создаёт прямой путь для acting administrator:

```text
direct user credential assignment
+ direct entitlement на все найденные code-owned current models
+ exact credential/model availability checks для каждой
```

Каталог провайдера используется только как bounded availability evidence. Quick setup устанавливает пересечение каталога с проверенным versioned policy-набором OpenAI, Anthropic, Gemini или OpenRouter и никогда не импортирует произвольные image/audio/embedding/unknown IDs. Одна рекомендованная или явно выбранная модель по-прежнему определяет user default и untouched profile; остальные проверенные модели сразу доступны без дополнительной настройки прав.

Credential selection и model entitlement остаются независимыми. Runtime precedence:

```text
direct user assignment -> unambiguous active group assignment -> allowed connection default
```

Если выбранный credential unusable, resolver fail-closed и не падает на следующий tier. Group/default setup других пользователей не переписывается.

Replacement проверяет не только рекомендуемую модель. Новый key обязан видеть upstream IDs всех моделей canonical connection, которые уже были доступны acting administrator; для каждой из них записывается exact available check нового credential version. Если таких моделей больше 64, набор изменился во время операции или хотя бы одна исчезла из catalog key, Quick setup завершается без writes и отправляет администратора в Connections.

Ready-state позволяет `Remove my key assignment` только после явного подтверждения. Это удаляет одну direct-user assignment acting administrator и ничего больше: сохранённый credential/version, grants, defaults, checks и team configuration остаются. После удаления доступ может сохраниться через applicable group/default credential либо исчезнуть; UI не обещает fallback.

Редкий конфликт допустим только когда сам canonical code-owned subgraph изменён так, что official-provider key нельзя честно связать с runtime route, или state raced и lossless commit невозможен. Это submit-time no-write error, а не состояние всех provider cards.

### Provider connections

Connections остаётся полной control plane внутри единого Providers workspace:

1. full-width Connections index;
2. клик по всей connection row;
3. dedicated full-width connection detail;
4. Back to connections;
5. horizontal peer tasks: Credentials, Authentication, Models, Diagnostics;
6. Run profiles как реальная installation-wide peer task.

Нельзя держать connection list постоянной колонкой рядом с detail и добавлять ещё одну вертикальную task-nav внутри глобального Control Center rail. Draft/test/activate, multiple credentials, group assignment, custom API root, protocol/routing/capability overrides, paid diagnostics, enable/disable и deletion blockers сохраняются.

Virgin `Not configured` connection показывается как нейтральный setup state. Warning tone и `needs attention` предназначены для сломанного или незавершённого уже используемого состояния, а не для ресурса, который ещё ни разу не настраивали.

### Users

Users открывается как полный каталог:

- search/status filters и pagination;
- identity, role, status, groups/access summary и last session;
- весь row открывает account detail;
- никакой маленькой `Details`/`Review` action для самого перехода;
- first user не открывается автоматически.

Dedicated user detail сохраняет approval/rejection, group membership, effective access, direct MCP permissions, stale-slot cleanup, account/session actions и deletion guards. Back возвращает к каталогу.

### Access & groups

Groups и Model access объединяются, потому что grants принадлежат выбранной группе. Destination сначала показывает full-width group directory, затем dedicated group detail:

- Overview;
- Members;
- Models & search;
- Tools.

Rename/archive/delete, provider-wide и explicit model grants, search grants и MCP grants сохраняются. Archived group остаётся читаемой, но её grants не применяются и mutations недоступны. Provider key assignment сюда не переносится: это отдельная Connections authentication policy.

`Full access` — одна встроенная системная группа, которая существует по умолчанию и не может быть переименована, архивирована или удалена. Первый administrator входит в неё; дальше membership явно управляется в Members, без автоматического добавления новых users. Участник получает semantic wildcard на все текущие и будущие provider connections, models и enabled search strategies, а также автоматически поддерживаемые group grants на все текущие и будущие MCP servers. В её Models & search и Tools нет фиктивных switches: UI объясняет automatic coverage. Wildcard не выбирает provider credential, не даёт MCP personal slots и не копирует OAuth/secret identity — эти setup boundaries остаются отдельными.

### Остальные destinations

Invites, Access rules, Usage, MCP servers, Email delivery и Safety сохраняют реальные capabilities. Для них применяются те же правила: один ясный task owner, action рядом с объектом, no global metric strip, bounded local scrollers для аналитики и никаких выдуманных Overview/Activity/Governance страниц.

## Responsive contract

- Desktop: persistent global rail; resource index или detail занимает остальную ширину.
- Compact: section index и active task — отдельные Back-connected состояния.
- New-chat composer центрируется и в portrait, и в short landscape, пока это ready blank state.
- Active composer остаётся над software keyboard и safe-area inset.
- Primary mobile workflow не требует hover или горизонтального drag.
- Page-level horizontal overflow запрещён; code, tables и exceptional comparisons имеют локальный scroller.

## Accessibility scope

Dedicated accessibility implementation and conformance are not being implemented now. Они требуют отдельного будущего решения оператора.

## Концепт-арты

Все предыдущие концепты сохранены. Они не входят в runtime bundle и не являются контрактом.

### Текущий основной визуальный ориентир — v2

- [Centered new chat](output/imagegen/aiqsa-product-mockups-v2/01-new-chat-centered-desktop.png)
- [Provider Quick setup](output/imagegen/aiqsa-product-mockups-v2/02-providers-quick-setup-desktop.png)
- [Users directory](output/imagegen/aiqsa-product-mockups-v2/03-users-directory-desktop.png)
- [Access group detail](output/imagegen/aiqsa-product-mockups-v2/04-access-group-detail-desktop.png)
- [Provider connection detail](output/imagegen/aiqsa-product-mockups-v2/05-provider-advanced-desktop.png)

Берём из v2 hierarchy, task flow, whitespace и спокойную цветовую систему. Не переносим буквально выдуманные counts, logos, tabs, model names, direct toggles или copy, если они не соответствуют текущему backend/UI contract.

### Сохранённые ранние наборы

- `.aiqsa/ui-revamp/` — audit screenshots и code-rendered prototype;
- `output/imagegen/aiqsa-ui-concepts-v2/` — ранний exploratory imagegen set;
- `output/imagegen/aiqsa-product-mockups-v1/` — product-grounded v1 set.

Слабые варианты не перезаписываются: refined/v2 files лежат рядом, чтобы сравнение и история решений сохранялись.

## Capability boundary

Новый UI обязан сохранить:

- chat/folder/project lifecycle, search and concurrent runs;
- exact model/profile/reasoning/search selection and per-model drafts;
- attachments, context budget, usage, Send/Stop and edit/regenerate;
- citations, tool activity, safe Markdown/math/code, Run receipt, Branch/Events;
- prompts, themes, MCP personal configuration, auth and sanitized sharing;
- all current provider, user/group access, invites/rules, Usage, MCP, SMTP and Safety operations;
- write-only secret handling, stale-write fences, atomic provider/profile operations and fail-closed authorization.

Новый UI не должен изобретать billing plans, audit feed, provider Activity, global Models, datasets/evaluations, governance, скрытое auto-enrollment пользователей, implicit secret rights или новый backend capability только для совпадения с картинкой.

## Готовность изменения

Срез считается завершённым только когда:

- базовые journeys проходят без старых лишних кликов;
- focused component/domain/API tests фиксируют новую interaction model, а не старый DOM split;
- provider setup сохраняет unrelated team/custom graph и действительно даёт acting admin модель в current-user catalog;
- desktop и compact runtime проверены на реальных компонентах;
- все темы сохраняют одну иерархию и читаемость;
- старые visible destinations, auto-selection и блокирующий `Advanced` provider state удалены;
- living docs описывают фактически работающий продукт.
