# MyCompare — BeyondCompare Clone (Electron + Vite)

## 專案概述

桌面版 BeyondCompare 複製品，使用 Electron + electron-vite + Vanilla JavaScript (ES2022+) 實作，支援本機檔案比對、資料夾比對、多種比對方法等核心功能。

## 技術棧（Section 7 — 全域技術棧）

```yaml
project:
  name: MyCompare
  type: desktop_app          # Electron 桌面應用程式
  description: Electron-based BeyondCompare clone with file/folder diff capabilities

language:
  backend: JavaScript ES2022+ (Electron main process, Node.js IPC)
  frontend: HTML5 + Vanilla JavaScript ES2022+ (Electron renderer process)

framework:
  backend: Electron 31 + electron-vite 2 (main/preload/renderer 三程序架構)
  frontend: Vanilla JS（無框架；highlight.js 語法高亮）

infrastructure:
  database_primary: none
  database_cache: localStorage（Session metadata）/ IndexedDB（大型資料，未來擴充）
  message_queue: none
  container: none
  cloud_provider: none

deployment:
  target_env: Electron desktop (Windows / macOS / Linux)
  ci_cd: GitHub Actions

non_functional_requirements:
  availability: N/A (single-user desktop app)
  latency_p95: diff render < 300ms for files ≤ 1MB
  throughput: N/A
  concurrent_users: 1 (desktop single-user)
  data_retention: session stored in localStorage
  compliance: none
```

## 專案複雜度

```yaml
project_complexity: M
execution_mode:
  base: standard
```

## AI 開發團隊設定

本專案使用 `.claude/CLAUDE.md` 定義的團隊框架（v2.2.1, M-Standard 模式）。

### 啟用角色
| 角色 | 定義檔 | 職責 |
|------|--------|------|
| Orchestrator | `.claude/agents/orchestrator.md` | Sprint 規劃、角色協調 |
| RD | `.claude/agents/rd.md` | 實作 src/ + tests/ |
| QA | `.claude/agents/qa.md` | 測試驗收 |

### RD 應載入的 Skills（依 `.claude/CLAUDE.md` Section 5 規則）

| Skill | 路徑 | 說明 |
|-------|------|------|
| `rd-lang-typescript-node` | `.claude/skills/rd/lang-typescript-node/SKILL.md` | Node.js/JS 開發規範（最接近的後端 lang skill；Electron main process 適用） |
| `qa-framework-vitest` | `.claude/skills/qa/framework-vitest/SKILL.md` | Vitest 測試規範（直接適用） |

> **缺少的 Skill**：`.claude/skills/rd/` 目前無 `lang-javascript-electron` skill。  
> 下次 Skill Manager 掃描時可建立。在此之前，RD 以 `rd-lang-typescript-node` 為基礎，  
> 將所有 TypeScript 規範對應到 JSDoc 型別標注（零 `any`）。

### 對 Claude Code 的指令

當以 **Agent 工具** 派發 RD 實作任務時，prompt 中必須包含：
1. 讀取 `.claude/agents/rd.md`（角色職責）
2. 載入 `.claude/skills/rd/lang-typescript-node/SKILL.md`（Node.js 規範）
3. 載入 `.claude/skills/qa/framework-vitest/SKILL.md`（測試規範）

範例前綴（加在 agent prompt 開頭）：
```
你是本專案的 RD（Software Engineer）。
先讀 .claude/agents/rd.md，再載入 .claude/skills/rd/lang-typescript-node/SKILL.md
與 .claude/skills/qa/framework-vitest/SKILL.md，然後執行以下任務：
```

## 目錄結構（electron-vite 三程序架構）

```
MyCompare/
├── src/
│   ├── main/
│   │   └── index.js              ← Electron main process（IPC handlers）
│   ├── preload/
│   │   └── index.js              ← contextBridge（electronAPI 暴露）
│   └── renderer/
│       ├── index.html            ← 應用程式入口 HTML
│       └── src/
│           ├── main.js           ← renderer 入口（import initApp）
│           ├── app.js            ← 應用程式路由與 toolbar 協調
│           ├── core/
│           │   ├── diff-engine.js      ← Myers / Patience diff 算法
│           │   ├── session.js          ← Session CRUD（純資料）
│           │   ├── session-store.js    ← localStorage 持久化
│           │   └── session-home-ui.js  ← Recent Sessions UI
│           ├── views/
│           │   ├── text-compare.js     ← 雙窗格文字比對（P0 完成）
│           │   └── folder-compare.js   ← 資料夾比對（P0 完成）
│           └── styles/
│               ├── variables.css       ← CSS 自訂屬性（主題變數）
│               ├── main.css            ← 全域樣式
│               ├── session-home.css
│               └── folder-compare.css
├── tests/
│   └── unit/
│       ├── diff-engine.test.js   ← 27 tests（全通過）
│       └── session.test.js       ← 26 tests（全通過）
├── electron.vite.config.js
├── vitest.config.js
└── package.json
```

## 開發規範

### 程式碼規範
- 使用 ES2022+ (class fields, optional chaining, nullish coalescing)
- 型別以 JSDoc 標注（或 TypeScript d.ts），零 any
- 模組化：每個比對視圖為獨立 Web Component 或模組
- 禁止全域變數汙染 window
- 禁止內聯 onclick，改用 addEventListener

### 差異算法
- 預設：Myers LCS 算法（效能均衡）
- 可選：Patience Diff（程式碼重構場景更準確）
- 字元級 diff 僅對變更行套用，不全文掃描

### UI 色彩語意（固定，不得隨意更動）
| 狀態 | 色彩 |
|------|------|
| 相同 | 預設背景 (白/深色) |
| 重要差異 | 紅/粉紅 |
| 不重要差異 | 藍/淡藍 |
| 僅左側 | 綠 |
| 僅右側 | 橘紅 |
| 衝突（三向） | 紅 + 特殊圖示 |

### Session 持久化
- 使用 `localStorage` 儲存 Session metadata（名稱、路徑、設定）
- 大型資料（如資料夾樹快取）使用 `IndexedDB`
- Session 格式為 JSON，schema 版本需向後相容

### Electron File System 存取
- 單一檔案：`electronAPI.openFile()` → `dialog.showOpenDialog` + `fs.readFile`（main process IPC）
- 資料夾：`electronAPI.openFolder()` → `dialog.showOpenDialog({openDirectory})`
- 目錄樹：`electronAPI.readDir(path)` → `readdir + stat`（一層，深層由 folder-compare 遞迴呼叫）
- 指定路徑讀檔：`electronAPI.readFile(path)` → `fs.readFile`
- 禁止在 renderer process 直接使用 Node.js fs（contextIsolation: true）

## 禁止事項
- 禁止向外部伺服器傳送使用者的檔案內容
- 禁止使用 `document.write()`
- 禁止使用 `eval()`
- 禁止引入超過必要的第三方依賴

## 開發優先順序
依 plan.md 中的優先級 P0 → P1 → P2 → P3 順序實作。
