# MyCompare — BeyondCompare Clone (Electron + Vite)

## 專案概述

桌面版 BeyondCompare 複製品，使用 Electron + electron-vite + Vanilla JavaScript (ES2022+) 實作。
支援文字比對、資料夾比對、Hex 比對、圖片比對、表格比對、三向合併六種比對模式。

---

## 技術棧（Section 7 — 全域技術棧）

```yaml
project:
  name: MyCompare
  version: 0.1.0
  type: desktop_app
  description: Electron-based BeyondCompare clone with 6 compare modes

language:
  backend: JavaScript ES2022+ (Electron main process, Node.js IPC)
  frontend: HTML5 + Vanilla JavaScript ES2022+ (Electron renderer process)

framework:
  backend: Electron 31 + electron-vite 2 (main/preload/renderer 三程序架構)
  frontend: Vanilla JS（無框架）

dependencies:
  highlight.js: "^11"       # 語法高亮（lazy load）
  chardet: "^2"             # 編碼自動偵測
  iconv-lite: "^0.7"        # 編碼轉換
  jszip: "^3"               # ZIP 虛擬資料夾
  xlsx: "^0.18"             # CSV / Excel 解析

infrastructure:
  database_primary: none
  database_cache: localStorage（Session metadata）
  message_queue: none
  container: none
  cloud_provider: none

deployment:
  target_env: Electron desktop (Windows / macOS / Linux)
  ci_cd: GitHub Actions（規劃中）
  packaging: electron-builder 26（NSIS / DMG / AppImage）

non_functional_requirements:
  availability: N/A (single-user desktop app)
  latency_p95: diff render < 300ms for files ≤ 1MB
  throughput: N/A
  concurrent_users: 1 (desktop single-user)
  data_retention: session stored in localStorage
  compliance: none
```

### 專案複雜度

```yaml
project_complexity: M
execution_mode:
  base: standard
```

---

## AI 開發團隊設定

本專案使用 `.claude/CLAUDE.md` 定義的團隊框架（v2.2.1, M-Standard 模式）。

### 啟用角色

| 角色 | 定義檔 | 職責 |
|------|--------|------|
| Orchestrator | `.claude/agents/orchestrator.md` | Sprint 規劃、角色協調 |
| RD | `.claude/agents/rd.md` | 實作 src/ + tests/ |
| QA | `.claude/agents/qa.md` | 測試驗收 |

### RD 應載入的 Skills

| Skill | 路徑 | 說明 |
|-------|------|------|
| `rd-lang-typescript-node` | `.claude/skills/rd/lang-typescript-node/SKILL.md` | Node.js/JS 開發規範（Electron main process 適用） |
| `rd-algorithm-diff` | `.claude/skills/rd/algorithm-diff/SKILL.md` | Myers / Patience diff 演算法規範 |
| `qa-framework-vitest` | `.claude/skills/qa/framework-vitest/SKILL.md` | Vitest 單元測試規範 |
| `qa-framework-playwright` | `.claude/skills/qa/framework-playwright/SKILL.md` | Playwright E2E 測試規範 |

### Agent prompt 範例前綴

```
你是本專案的 RD（Software Engineer）。
先讀 .claude/agents/rd.md，再載入 .claude/skills/rd/lang-typescript-node/SKILL.md
與 .claude/skills/qa/framework-vitest/SKILL.md，然後執行以下任務：
```

---

## 目錄結構（electron-vite 三程序架構）

```
MyCompare/
├── src/
│   ├── main/
│   │   ├── index.js              ← Electron main process（IPC handlers、native menu）
│   │   ├── encoding.js           ← chardet + iconv-lite 編碼偵測與轉換
│   │   └── file-hash.js          ← MD5/SHA256 檔案雜湊（資料夾比對用）
│   ├── preload/
│   │   └── index.js              ← contextBridge（electronAPI 暴露）
│   └── renderer/
│       ├── index.html            ← 應用程式入口 HTML
│       └── src/
│           ├── main.js           ← renderer 入口（import initApp）
│           ├── app.js            ← 視圖路由、toolbar、TabManager、快捷鍵
│           ├── core/
│           │   ├── diff-engine.js      ← Myers O(ND) / Patience diff 算法
│           │   ├── session.js          ← Session CRUD（純資料）
│           │   ├── session-store.js    ← localStorage 持久化
│           │   ├── session-home-ui.js  ← Recent Sessions UI
│           │   ├── context-menu.js     ← 自訂右鍵選單元件
│           │   ├── file-type.js        ← Smart Routing（副檔名 → 視圖類型）
│           │   ├── eol-detect.js       ← 行尾符號偵測（CRLF / LF / CR）
│           │   └── utils.js            ← el()、debounce()、formatSize() 等工具
│           ├── views/
│           │   ├── text-compare.js     ← 文字比對（虛擬捲動、字元級 diff、編輯模式）
│           │   ├── folder-compare.js   ← 資料夾比對（遞迴掃描、同步、ZIP）
│           │   ├── hex-compare.js      ← Hex 比對（虛擬捲動、byte diff、Ctrl+F）
│           │   ├── image-compare.js    ← 圖片比對（Canvas pixel diff、同步縮放）
│           │   ├── table-compare.js    ← 表格比對（CSV / Excel、key column）
│           │   └── three-way-compare.js← 三向合併（衝突解決、輸出編輯）
│           └── styles/
│               ├── variables.css       ← CSS 自訂屬性（Light / Dark 主題）
│               ├── main.css            ← 全域樣式
│               ├── session-home.css
│               ├── folder-compare.css
│               ├── hex-compare.css
│               ├── image-compare.css
│               ├── table-compare.css
│               └── context-menu.css
├── tests/
│   ├── unit/                     ← Vitest 單元測試（286 tests，全通過）
│   │   ├── diff-engine.test.js
│   │   ├── session.test.js
│   │   ├── smart-routing.test.js
│   │   ├── three-way-merge-logic.test.js
│   │   ├── folder-compare-logic.test.js
│   │   ├── hex-utils.test.js
│   │   ├── table-compare-logic.test.js
│   │   ├── text-compare-logic.test.js
│   │   └── ...（共 20 個測試檔）
│   └── e2e/                      ← Playwright E2E 測試
│       ├── helpers/electron-app.js
│       ├── hex-compare.spec.js
│       ├── text-compare.spec.js
│       ├── folder-compare.spec.js
│       ├── smoke.spec.js
│       └── theme.spec.js
├── resources/                    ← 應用程式圖示（icon.ico / .icns / .png / .svg）
├── scripts/
│   └── afterPack.cjs             ← electron-builder 後處理腳本
├── .claude/                      ← AI 開發團隊框架（agents / skills / sprint）
├── electron.vite.config.js
├── vitest.config.js
├── playwright.config.js
├── plan.md                       ← 功能規劃與實作狀態
└── package.json
```

---

## Electron IPC API

Renderer 透過 `window.electronAPI.*` 呼叫，所有 IPC 定義於 `preload/index.js`：

| electronAPI 方法 | IPC channel | 說明 |
|-----------------|-------------|------|
| `openFile()` | `open-file` | dialog.showOpenDialog + fs.readFile（文字） |
| `openFileBinary()` | `open-file-binary` | dialog + fs.readFile → base64 回傳 |
| `readFile(path)` | `read-file` | 指定路徑讀文字（含編碼轉換） |
| `readFileBinary(path)` | `read-file-binary` | 指定路徑讀 binary → base64 |
| `saveFile(path, content)` | `save-file` | fs.writeFile（儲存文字） |
| `openFolder()` | `open-folder` | dialog.showOpenDialog({openDirectory}) |
| `readDir(path)` | `read-dir` | fs.readdir + stat（一層） |
| `copyFile(src, dest)` | `copy-file` | fs.copyFile |
| `deleteFile(path)` | `delete-file` | fs.unlink |
| `renameFile(old, new)` | `rename-file` | fs.rename |
| `mkdirFolder(parent, name)` | `mkdir-folder` | fs.mkdir |
| `showInExplorer(path)` | `show-in-explorer` | shell.showItemInFolder |
| `toggleFullScreen()` | `toggle-fullscreen` | BrowserWindow.setFullScreen 切換 |
| `onOpenFiles(cb)` | `open-files` | CLI 引數傳入檔案路徑 |

---

## Sprint 歷程

### Sprint 1 ✅ — P0 MVP 文字比對
- 雙窗格文字比對（Myers diff、行級差異）
- Next / Prev / First / Last 差異導航（F7/F8/Alt+Home/End）
- Copy Block Left / Right（Alt+←/→）
- Path Bar、Toolbar、Status Bar 框架
- **測試**：diff-engine 27 tests、session 26 tests → **53 passing**

### Sprint 2 ✅ — P1 重要功能
- 資料夾比對（雙欄樹狀、遞迴掃描、結果篩選）
- Session 管理（首頁、Recent Sessions、localStorage）
- Overview Minimap（差異總覽、點擊跳轉）
- 語法高亮（highlight.js，lazy load）
- 主題切換（Light / Dark，CSS Variables）
- **測試**：89 passing（↑ 36）

### Sprint 3 ✅ — P2 延伸功能
- 三向文字合併（3-Way Text Merge，衝突標記）
- CSV / 表格比對（key column 對齊、cell diff）
- 圖片比對（Canvas pixel diff、同步縮放）
- HTML 報告匯出（文字比對 + 資料夾比對）
- **測試**：170 passing（↑ 81）

### Sprint 4 ✅ — P2 編輯 & 忽略規則
- 文字比對直接編輯（Ctrl+E 切換、Ctrl+S/Shift+S 儲存）
- 忽略規則 Modal（Regex 忽略 + 不重要差異藍色標注）
- 字元級 diff 強化（行內精確高亮）
- 編碼自動偵測（chardet + iconv-lite）
- **測試**：198 passing（↑ 28）

### Sprint 5 ✅ — P3 進階功能
- Hex 比對（虛擬捲動、byte-by-byte diff、同步捲動）
- 資料夾同步（Folder Sync，Left→Right / Right→Left / 雙向）
- ZIP 虛擬資料夾（JSZip，zip vs 資料夾比對）
- 多分頁介面（TabManager，Ctrl+W 關閉）
- 鍵盤快捷鍵系統（Ctrl+N/W/E/S、F5/F7/F8）
- **測試**：220 passing（↑ 22）

### Sprint 6 ✅ — UX 強化
- Center Gutter（canvas 梯形連接線、◀▶ copy 按鈕、hover 顯示）
- Smart Routing（雙擊資料夾列依副檔名自動選視圖：text/image/hex/table）
- Three-Way 互動式衝突解決（逐 hunk 接受左/右/兩者，衝突卡片 UI）
- 全視圖右鍵選單（文字/資料夾/表格/Hex 各自定制選單項目）
- **測試**：286 passing（↑ 66）、BC 功能覆蓋率 ~98%

### Sprint 7 ✅ — 文字比對搜尋 & 編輯進階
- T42 Find & Replace（Ctrl+H 切換 replace bar、Regex 支援含 backreference、Replace One / All）
- T43 Bookmarks（Ctrl+F2 切換、F2/Shift+F2 next/prev、Set 持久化、行號欄藍色標記）
- T44 Go To Line（Ctrl+G dialog、Enter 跳轉、Escape 關閉）
- T45 Convert File（Trim Trailing Whitespace、Tabs↔Spaces、CRLF/LF/CR 三向轉換）
- **測試**：423 passing（↑ 137；其中 30 個為 Sprint 7 新增）、BC 功能覆蓋率 ~99%

### Sprint 8 ✅ — 文字比對 View & Display 控制
- T46 Show 篩選按鈕（All / Diff / Same / None，toolbar 4 按鈕同步 active）
- T47 Visible Whitespace（空格 → `·`、Tab → `→`，純函式 `applyVisibleWhitespace`）
- T48 Line Numbers 開關（toggle `.hide-line-numbers` class）
- T49 字型大小控制（Ctrl+=/-/0，CSS 變數 `--tc-font-size` + `--tc-row-height`，[10, 24] 鉗制）
- T50 Over/Under 佈局（side-by-side ↔ 上下堆疊，CSS grid 切換 + 按鈕文字 `⬛ Side` ↔ `⊟ Over`）
- **測試**：431 passing（↑ 8 整合測試，原 38 個既存單元測試）、BC 功能覆蓋率 ~99.5%

### Sprint 9 ✅ — 資料夾比對強化
- T51 選取進階（Select Newer Left/Right/Both、Select Orphans Left/Right、Invert Selection；下拉選單 UI）
- T52 Rename 檔案（右鍵 `重新命名…` → `prompt` → `renameFile` IPC；失敗 alert + 不 refresh）
- T53 New Folder（右鍵 `新建資料夾（左/右側）…` → `mkdirFolder` IPC；雙側獨立）
- T54 Find Filename（即時 find bar，F3/Shift+F3 跳轉，`.fc-row--match` 高亮）
- T55 View 篩選擴充（`_showLeftNewer` / `_showRightNewer` 獨立切換，整合 `_isRowVisible`）
- T56 Expand/Collapse All（工具列按鈕、`_expanded: Set<string>` 全展開 / 全收合）
- **新增 IPC**：`rename-file`、`mkdir-folder`（main + preload + electronAPI 三層串接）
- **測試**：441 passing（↑ 10 邊角測試，原 46 個既存測試）

### Sprint 10 ✅ — 圖片比對強化（首次純新功能開發）
- T57 Zoom 鍵盤控制（Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+Shift+F；MIN=0.1 / MAX=10；工具列 🔍+ 🔍- 1:1 ⬜）
- T58 Rotate & Flip（rotateCW/CCW 90°、flipHorizontal/Vertical、resetTransform；CSS 合成 `scale rotate scaleX scaleY`；左右同步）
- T59 Blend Mode（廢除 `_showDiffOverlay`，改為 `_blendMode ∈ {'normal','difference','blend'}` 三態 select；`mix-blend-mode: difference` CSS）
- T60 Full Screen（F11 全域，新增 `toggle-fullscreen` IPC、`electronAPI.toggleFullScreen`、`BrowserWindow.setFullScreen()`）
- **新增 IPC**：`toggle-fullscreen`
- **檔案影響**：`image-compare.js` 887 → 1200 行（+313）、`image-compare.css`、`main/index.js`、`preload/index.js`、`app.js`
- **測試**：462 passing（↑ 21 新測試；首次有 image-compare 測試覆蓋）

### Sprint 11 ✅ — Session 設定 / HTML 報告強化 / Workspaces（全 plan 落地）
- T61 Session Settings Dialog（命名設定儲存/載入；新 `core/named-config-store.js`、`mycompare:namedConfigs` localStorage；`getConfig()` / `applyConfig()` on TextCompare；🔧 工具列 + `#config-modal`）
- T62 HTML Report 強化（stats 摘要：text `新增 / 刪除 / 變更 / 相同`；folder `相同 / 不同 / 左右側獨有 / 較新`；`@media print` + `Ctrl+P` blob 列印 / PDF）
- T63 Workspaces（新 `core/workspace-store.js`、`mycompare:workspaces` localStorage；`TabManager.getSerialisableTabs()` 過濾 heavy state；批次關閉 → 重建 tabs 並重讀檔案；merge3 暫未支援）
- **新增 localStorage keys**：`mycompare:namedConfigs`、`mycompare:workspaces`
- **檔案影響**：~705 production + ~265 test LOC，新檔 `named-config-store.js`、`workspace-store.js`、`sprint11.test.js`
- **測試**：484 passing（↑ 22 新測試）

---

## 已實作功能總覽

| 優先級 | 功能 | 狀態 |
|--------|------|------|
| P0-1 | 文字比對（Myers + Patience diff） | ✅ Sprint 1 |
| P0-2 | 雙窗格佈局框架（Toolbar/PathBar/StatusBar） | ✅ Sprint 1 |
| P0-3 | Next/Prev/Copy Diff 導航 | ✅ Sprint 1 |
| P1-1 | 資料夾比對（遞迴樹狀、篩選、展開折疊） | ✅ Sprint 2 |
| P1-2 | Session 管理（Recent Sessions，localStorage） | ✅ Sprint 2 |
| P1-3 | Overview Minimap | ✅ Sprint 2 |
| P1-4 | 語法高亮（highlight.js，200+ 語言） | ✅ Sprint 2 |
| P1-5 | 主題切換（Light / Dark，跟隨系統） | ✅ Sprint 2 |
| P2-1 | 三向合併（3-Way Text Merge，互動衝突解決） | ✅ Sprint 3+6 |
| P2-2 | 表格比對（CSV / Excel，key column） | ✅ Sprint 3 |
| P2-3 | 圖片比對（Canvas pixel diff，同步縮放） | ✅ Sprint 3 |
| P2-4 | HTML 報告匯出 | ✅ Sprint 3 |
| P2-5 | 文字比對直接編輯（Ctrl+E/S） | ✅ Sprint 4 |
| P2-6 | 忽略規則（Regex 忽略 + 不重要差異） | ✅ Sprint 4 |
| P3-1 | Hex 比對（虛擬捲動，Ctrl+F 搜尋，Offset 跳轉） | ✅ Sprint 5 |
| P3-2 | 資料夾同步（Folder Sync，預覽 + 執行） | ✅ Sprint 5 |
| P3-3 | ZIP 虛擬資料夾（JSZip） | ✅ Sprint 5 |
| P3-4 | 鍵盤快捷鍵系統 | ✅ Sprint 5（部分） |
| P3-5 | 多分頁介面（TabManager，Ctrl+W） | ✅ Sprint 5 |
| —— | Center Gutter（canvas 梯形 + copy 按鈕） | ✅ Sprint 6 |
| —— | Smart Routing（副檔名 → 視圖自動選擇） | ✅ Sprint 6 |
| —— | 全視圖右鍵選單 | ✅ Sprint 6 |

---

## 後續工作（plan.md sprint 1–11 全部完成後）

| 方向 | 說明 |
|------|------|
| **e2e 測試擴充** | image / table / merge3 目前無 e2e 覆蓋；hex / text / folder / theme / smoke 已覆蓋 |
| **plan.md 殘餘 ⬜ 項目** | P0-3 Undo/Redo、P1-2 Session 群組分類、P3-1 Hex 比對算法切換、T49 可由使用者自訂快捷鍵 |
| **跨視圖一致性** | T61 `getConfig/applyConfig` 目前只 TextCompare 實作，可擴展至其他 view |
| **新需求** | 待討論 |

---

## 測試策略

| 層級 | 工具 | 覆蓋目標 |
|------|------|---------|
| **單元測試** | Vitest 1 | diff 算法、session 邏輯、utility functions |
| **E2E 測試** | Playwright 1 + Electron | 視圖掛載、資料注入、跨進程 IPC |

```bash
npm test              # 單元測試（Vitest）
npm run test:watch    # 單元測試 watch 模式
npm run test:coverage # 覆蓋率報告（目標 ≥ 80%）
npm run test:e2e      # E2E 測試（先 build，再跑 Playwright）
```

**目前狀態（Sprint 11 完成 — 全部 plan 落地）**：484 / 484 unit tests passing；7 / 7 e2e tests passing

### E2E 測試注意事項

- E2E 測試對象為 **生產版本**（`out/main/index.js`），每次需先 `npm run build`
- 透過 `window.__testAPI` 注入測試資料（繞過 file dialog）
- 禁止使用 `/** @type {T} */ (variable)` 在獨立行做 JSDoc 類型轉換：
  esbuild 會把下一行的 `(variable).prop` 解析為函式呼叫，造成生產版本 TDZ 錯誤
  ✅ 正確做法：將 `/** @type {T} */` 寫在 `const` 宣告的同一行

---

## 開發規範

### 程式碼規範
- 使用 ES2022+（class fields、optional chaining、nullish coalescing）
- 型別以 JSDoc 標注，零 `any`
- 每個比對視圖為獨立 Class 模組，掛載至容器 DOM
- 禁止全域變數汙染 `window`（`__testAPI` 為 E2E 測試唯一例外）
- 禁止內聯 `onclick`，改用 `addEventListener`

### 差異算法
- 預設：Myers O(ND) LCS 算法（效能均衡）
- 可選：Patience Diff（程式碼重構場景更準確）
- 字元級 diff 僅對變更行套用，不全文掃描

### UI 色彩語意（固定，不得隨意更動）

| 狀態 | 色彩 |
|------|------|
| 相同 | 預設背景（白 / 深色） |
| 重要差異 | 紅 / 粉紅 |
| 不重要差異 | 藍 / 淡藍 |
| 僅左側 | 綠 |
| 僅右側 | 橘紅 |
| 衝突（三向） | 紅 + 特殊圖示 |

### Electron File System 存取
- 禁止在 renderer process 直接使用 Node.js `fs`（`contextIsolation: true`）
- 所有檔案操作透過 `window.electronAPI.*` → IPC → main process 執行
- binary 檔案（image / hex）以 base64 字串在 IPC 間傳遞

### Session 持久化
- `localStorage` 儲存 Session metadata（名稱、路徑、設定）
- Session 格式為 JSON，schema 版本需向後相容

---

## 已知技術限制

| 限制 | 原因 | 應對策略 |
|------|------|---------|
| Preload 不支援 ESM | Electron 限制 | `electron.vite.config.js` 強制 CJS 輸出 |
| 大型二進位檔案效能 | DOM 操作瓶頸 | Virtual Scroll（ROW_HEIGHT=20px，只渲染可見列） |
| 大圖 pixel diff 效能 | Canvas drawImage 受限 | 縮圖後比對，原圖僅顯示 |
| esbuild TDZ 誤判 | JSDoc 類型轉換被解析為函式呼叫 | 見「E2E 測試注意事項」|

---

## 禁止事項
- 禁止向外部伺服器傳送使用者的檔案內容
- 禁止使用 `document.write()`
- 禁止使用 `eval()`
- 禁止引入超過必要的第三方依賴
- 禁止在單行內用 `/** @type {T} */ (variable).prop = value` 模式（esbuild TDZ bug）
