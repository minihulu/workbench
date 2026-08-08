# 系统设计：认知资产重构 + 英语助手（聚焦版）

> 输入：team-lead 补发的聚焦版 PRD ｜ 架构师：高见远 ｜ 原则：单文件原生 JS 真相、server.py 复用既有 LLM 基建、零新依赖、≤5 任务
> 类图/时序图另存 `docs/class-diagram.mermaid`、`docs/sequence-diagram.mermaid`。

## 0. 代码实读结论（先摆事实，后谈设计）

| # | 事实（已逐行核对源码，非推测） | 位置 | 对设计的影响 |
|---|---|---|---|
| F1 | `server.py` 已具备 `LLM_OPENER`(独立 opener，国内直连)、`RateLimiter`、`llm_chat(base,key,model,messages,timeout)`、`LLM_API_KEY/LLM_BASE_URL/LLM_MODEL(默认 deepseek-chat)/LLM_TIMEOUT` | L288 / L294 / L470 / L164-168 | 翻译端点**零新依赖**，直接复用 |
| F2 | `api_search_rerank` 是现成 AI 代理范式：限流→读 key→`llm_chat`→失败统一 `200+{ok:false,fallback:true,reason}` | L676-727 | 新 `/api/ai/translate` 镜像此结构 |
| F3 | `do_POST` 路由范式：`if p=="/api/x": return self.api_x(body)`，限流命中返回 **429** | L1258-1302 | 翻译端点加一行路由即可 |
| F4 | sync 白名单 `new_payload` 已含 `cog_*` 全部键 + `settings` 键；合并逻辑 `{**cur, **{k:v for k,v in inc if v}}` | L1085-1100 | 查词/翻译无状态，**不新增顶层键**；⚠️ falsy 不覆盖（见 §9-4） |
| F5 | 前端 `showSelToolbar` 现有 5 按钮（高亮/评论/想法/复制/✕），`placeFloatAbove` 已处理视口夹取 | L5650 / L5624 | 加「🔍查词」「🌐翻译」两按钮即可 |
| F6 | `showVocab`(L5972) 仅服务 `cogExpr` 自带 `words`，**无通用本地词典** | L5972-5988 | R2 本地词典为全新 vendored 资源 |
| F7 | `renderCogHome` 的 `#cogNavTiles` 渲染 6 个 tile（read/book/thought/review/anno/expr） | L4081-4090 | R5 改造为「书架+英语助手」常驻 + 其余「更多」折叠 |
| F8 | `callAI` 走 Cloudflare 侧 `/api/ai/ask`；`apiHeaders()` 带 Bearer | L5991-6000 / L6067 | 新翻译走 server.py，与旧通道并存，不冲突 |

## 1. 实现方案与框架选型

- **前端**：原生 JS，单文件 `workbench.html` 真相，不改技术栈；改完必 `cp workbench.html index.html` 字节级一致。
- **后端**：`server.py` 新增 `POST /api/ai/translate`，复用 `llm_chat`/`LLM_OPENER`/`RateLimiter`/`LLM_*` 环境变量；`urllib` 出站，**零新依赖**。
- **本地词典**：vendored 静态资源 `vendor/ecdict.min.js`（暴露 `window.ECDICT={word:{phonetic,pos,meaning}}`），**首次查词懒加载 + IndexedDB 缓存**，绝不内联进 `workbench.html`。
- **翻译触发**：默认手动（选中→浮层点「翻译」）；设置页新增默认 OFF 的「自动翻译选中文本」开关，仅本地持久化（`settings.autoTranslate`）。
- **模块收起**：`renderCogHome` 仅突出「📚书架」「🧠英语助手」；思想/复盘/阅读记录/我的思考折叠进「更多」；代码数据不删。旧 `cogExpr` 屏7 更名「英语助手」、不删屏不删数据。

## 2. 文件列表（相对路径）

| 文件 | 动作 | 改动点 |
|---|---|---|
| `workbench.html` | 改 | `showSelToolbar` 加 2 按钮；新增 `DictLoader`/`lookupWord`/`showDictPop`/`translateSelection`；`settings` 对象 + 自动翻译开关；`renderCogHome` hub 重构；`cogExpr` 更名「英语助手」；popover CSS |
| `index.html` | cp 镜像 | 与 workbench.html 字节级一致（铁律） |
| `server.py` | 改 | +`translate_limiter=RateLimiter(20,60)`；+`api_ai_translate(body)`；`do_POST` 加 `if p=="/api/ai/translate"` 路由 |
| `vendor/ecdict.min.js` | 新 | 本地词典，暴露 `window.ECDICT` |
| `tests/test_translate.py` | 新 | 翻译端点单测（限流/正常/失败降级） |
| `tests/test_cog_english.test.mjs` | 新 | 浮层/设置/hub 回归（含 `cp` 一致性） |
| `docs/design-cog-english.md` | 新 | 本设计 |

## 3. 数据结构与接口（类图见 `docs/class-diagram.mermaid`）

**前端 DictLoader（新增）**
- `ensureLoaded(): Promise<void>` — 首次查词动态 `<script src="vendor/ecdict.min.js">` 或 `fetch`；结果缓存 IndexedDB；失败兜底提示。
- `lookupWord(word): {word,phonetic,pos,meaning} | null` — 归一化（小写、去标点/数字）后查 `window.ECDICT`。

**前端 TranslateService（新增）**
- `callTranslate(text, level="cet4/6"): Promise<{ok:true,translation,level} | {ok:false,fallback:true,reason,retry?}>` — `POST /api/ai/translate`。

**前端 Settings（新增轻量对象）**
- `settings = {autoTranslate:false}`；`LS.get/set("wb_settings")` 持久化；随 sync `payload.settings` 合并。

**后端 `/api/ai/translate`**
- 请求：`POST {text:string, level?:string}`
- 响应：`200 {ok:true, translation:string, level:string}` ｜ `200 {ok:false, fallback:true, reason:"rate_limited|llm_not_configured|upstream_error|timeout|parse_failed", retry?:int}` ｜ `429 {error:"..."}`（限流）。

## 4. 程序调用流程（时序图见 `docs/sequence-diagram.mermaid`）

- **查词分支（本地/离线）**：选中→`showSelToolbar` 显示浮层→点「🔍查词」→`DictLoader.ensureLoaded()`（懒加载 `vendor/ecdict.min.js`→IndexedDB 缓存）→`lookupWord`→`showDictPop`；未命中给提示。
- **翻译分支（AI）**：选中→点「🌐翻译」（或 `settings.autoTranslate=true` 自动触发）→`TranslateService.callTranslate`→`POST /api/ai/translate`→`Handler.do_POST`→`translate_limiter.allow`→`llm_chat(base,key,model,messages,timeout)` via `LLM_OPENER`→DeepSeek→回显译文/降级提示。

## 5. 任务列表（有序，≤5，按层分组，每个 ≥3 文件）

| ID | 任务 | 源文件 | 依赖 | 优先级 |
|---|---|---|---|---|
| **T01** | 本地词典资源 + 加载器（基础设施） | `vendor/ecdict.min.js`、`workbench.html`(DictLoader/lookupWord/IndexedDB 缓存)、`index.html`(镜像) | — | P0 |
| **T02** | 后端 AI 翻译代理 | `server.py`(路由+api_ai_translate+translate_limiter)、`tests/test_translate.py`、`wb.env.example`(注明 DEEPSEEK 变量) | — | P0 |
| **T03** | 浮层 UI：查词 + 翻译 | `workbench.html`(showSelToolbar 加按钮+showDictPop+translateSelection+popover CSS)、`vendor/ecdict.min.js`(引用)、`index.html`(镜像) | T01, T02 | P0 |
| **T04** | 设置开关 + 模块收起 | `workbench.html`(settings 对象+autoTranslate 开关+renderCogHome hub 重构+cogExpr 更名)、`index.html`(镜像)、`tests/test_cog_english.test.mjs` | — | P0 |
| **T05** | 降级提示 + 移动端适配 + 联调 | `workbench.html`(R7 降级/R8 移动端)、`index.html`(镜像)、`tests/`(回归) | T02, T03, T04 | P1 |

> 规则遵循：T01 为基础设施（新资源层）；任务按层分组非单文件拆分；除 T05 集成任务外依赖链短（T03 仅依赖 T01/T02）。

## 6. 依赖包

- `server.py`：**零新依赖**（`urllib`/`json` 等标准库已 import）。
- 前端：**零依赖**；本地词典为 vendored 静态资源，不进 npm。

## 7. 共享知识（跨文件约定）

- **字节级一致铁律**：`workbench.html` ↔ `index.html` 任一改动后必 `cp`，CI/测试应校验两文件 MD5。
- **server.py 路由与限流约定**：`do_POST` 内 `if p=="/api/x": return self.api_x(body)`；限流命中返回 `429`；LLM/上游失败统一 `200+{ok:false,fallback:true,reason}`；复用 `LLM_*` 环境变量与 `LLM_OPENER`（国内直连，不继承系统代理）。
- **词典加载约定**：首次查词懒加载 `vendor/ecdict.min.js` → `window.ECDICT`；`lookupWord` 归一化（小写、去标点/数字）；结果缓存 IndexedDB，加载失败兜底提示、绝不阻塞阅读。
- **settings 字段命名**：`settings.autoTranslate`（bool，默认 false）；前端 `settings` 对象随 sync `payload.settings` 合并。
- **不新增 sync 顶层键**（本期）：查词/翻译无状态，不碰 `new_payload` 白名单。

## 8. 待明确（假设，已标注于设计）

1. **词典数据源**：推荐 ECDICT 精简版（word/phonetic/translation），体积 2–4MB；若过大则改首字母分片 `json` 懒加载。
2. **DeepSeek 模型名**：沿用 `LLM_MODEL` 默认 `deepseek-chat`（环境变量可覆盖）；prompt 约束「四六级水准、简洁中文」。
3. **长文截断阈值**：翻译接口对 `text` 截断至 **2000 字符**，超限截断并提示。
4. **自动翻译跨端一致性**：server `settings` 合并 `{k:v if v}` 会丢弃 falsy → `autoTranslate:false` **不跨端覆盖**（本期仅保证本地持久化）。需跨端一致则改 server 合并为 `{**cur, **inc}`（后续小改，不计入本期 R4 的 server 改动范围，因 R4 仅新增 translate 端点）。
5. **`cogExpr` 屏7 与 `/api/ai/ask`**：本期不删屏/不删数据，首页「英语助手」tile 指向屏7并更名；`/api/ai/ask` 暂保留（仅服务于既有表达生成），若后续彻底下架表达生成再移除。
