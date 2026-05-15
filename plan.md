# MyCompare — 功能規劃文件

> 基於 BeyondCompare 功能分析，以 Electron + Vite 實作的桌面應用開發計劃。
> 最後更新：2026-05-14（所有 P2/P3 功能完成）

---

## 實作狀態總覽

| 優先級 | 功能 | 狀態 |
|--------|------|------|
| P0-1 | 文字比對（2-Way Text Compare） | ✅ 完成 |
| P0-2 | 雙窗格佈局框架 | ✅ 完成 |
| P0-3 | Next/Prev Difference 導航 + Copy | ✅ 完成 |
| P1-1 | 資料夾比對（Folder Compare） | ✅ 完成 |
| P1-2 | Session 管理 | ✅ 完成（Recent Sessions） |
| P1-3 | Overview Minimap | ✅ 完成 |
| P1-4 | 語法高亮 | ✅ 完成（highlight.js lazy load） |
| P1-5 | 主題切換（淺色 / 深色） | ✅ 完成 |
| P2-1 | 三向文字合併（3-Way Text Merge） | ✅ 完成 |
| P2-2 | CSV / 表格比對（Table Compare） | ✅ 完成 |
| P2-3 | 圖片比對（Image Compare） | ✅ 完成 |
| P2-4 | HTML 報告匯出 | ✅ 完成 |
| P2-5 | 文字比對直接編輯 | ✅ 完成（Ctrl+E 編輯，Ctrl+S/Ctrl+Shift+S 儲存） |
| P2-6 | 忽略規則（Importance Rules） | ✅ 完成（Regex 忽略 + 不重要差異藍色） |
| P3-1 | Hex / 二進位比對 | ✅ 完成 |
| P3-2 | 資料夾同步（Folder Sync） | ✅ 完成（預覽 + 執行同步） |
| P3-3 | Zip 虛擬資料夾 | ✅ 完成（JSZip，開啟 Zip 作為虛擬資料夾） |
| P3-4 | 鍵盤快捷鍵系統 | ✅ 完成（F5/F7/F8/Alt+Home/End/←/→/Ctrl+N/E/W） |
| P3-5 | 多分頁介面（Tabs） | ✅ 完成（Session-record tabs，Ctrl+W 關閉） |
| — | **右鍵選單（Context Menu）** | ✅ 完成（全視圖） |

---

## AI 開發團隊設定

依 `.claude/CLAUDE.md` 憲法，本專案採用以下模式：

```yaml
project_complexity: M        # Standard 常規協作
execution_mode:
  base: standard
```

啟用角色：**Orchestrator → RD（主力）→ QA（單元測試審查）**
Sprint 流程：功能 → 單元測試通過 → Orchestrator review → 合併

---

## 技術選型決策

| 決策項目 | 選擇 | 原因 |
|---------|------|------|
| 平台 | Electron + electron-vite | 完整 Node.js 檔案系統存取，無瀏覽器沙盒限制 |
| Diff 算法 | 自實作 Myers O(ND) + Patience Diff | 核心算法需完全掌控，不依賴外部套件 |
| 語法高亮 | highlight.js (lazy load) | 成熟、支援 200+ 語言 |
| 編輯器核心 | CodeMirror 6 (optional) | 若需完整編輯能力，CM6 是最佳選擇 |
| 資料夾存取 | Node.js `fs` (main process) via IPC | Electron main process 直接讀取，無限制 |
| Session 儲存 | localStorage (metadata) | 分層儲存，metadata 快速讀取 |
| 樣式架構 | CSS Variables（Light/Dark 主題） | 支援主題切換，無需框架 |
| 打包工具 | electron-vite | Electron 三進程（main/preload/renderer）一鍵打包 |
| Preload 輸出 | CJS format（非 ESM） | Electron 不支援 `.mjs` preload，需強制 CJS 輸出 |

## 測試策略

> E2E 測試（Playwright）已移除。原因：Electron smoke test 回饋慢（10–30s/run），核心正確性已由單元測試覆蓋。

| 層級 | 工具 | 覆蓋目標 |
|------|------|---------|
| **單元測試** | Vitest | diff 算法、session 邏輯、utility functions |
| **元件測試** | Vitest + jsdom（日後加入） | UI 元件的 DOM 行為、按鈕狀態、diff 渲染結果 |

```bash
npm test              # 跑所有單元測試
npm run test:watch    # watch mode
npm run test:coverage # 覆蓋率報告（需 ≥ 80%）
```

**目前狀態**：53 / 53 tests passing（diff-engine 27、session 26）

---

## P0 — 核心功能（MVP，必須先完成）

### P0-1：文字比對（2-Way Text Compare） ✅

**目標**：完整的雙窗格文字差異比對，這是整個工具最核心的功能。

#### 功能細節
- [x] **雙窗格佈局**：左右兩個文字窗格，中間為差異連接線（connector）
- [x] **Myers LCS Diff 算法**：行級別差異計算
- [x] **Patience Diff 算法**：可切換，適合程式碼重構後的比對
- [x] **差異類型色彩標注**：
  - 重要差異（紅/粉紅背景）
  - 不重要差異（藍/淡藍背景）
  - 新增行（綠色）
  - 刪除行（橘紅/淡紅）
- [x] **行內字元級 diff**：在變更行內，精確標出哪幾個字元不同（黃色高亮）
- [x] **同步滾動**：兩個窗格鎖定同步滾動，差異行對齊
- [x] **行號顯示**：每個窗格左側顯示行號
- [x] **差異 gutter**：行號右側的變色細欄，一目了然哪行有差異
- [x] **折疊相同區塊**：相同的多行折疊為一條「── N 行相同 ──」，可展開
- [x] **Next / Prev Difference 導航**：按鈕 + 鍵盤快捷鍵 (F7/F8) 跳到上/下個差異
- [x] **差異計數顯示**：「第 X / N 個差異」狀態列

#### 檔案載入
- [x] 點擊選擇本地檔案（Electron IPC → dialog.showOpenDialog）
- [ ] 拖放檔案到左/右窗格
- [ ] 貼上文字直接比對（剪貼簿輸入模式）

#### 比對選項
- [x] 忽略尾端空白（Ignore trailing whitespace）
- [x] 忽略大小寫（Case insensitive）
- [x] 忽略空白行
- [x] 選擇 diff 算法（Myers / Patience）
- [ ] 忽略行首縮排差異
- [ ] 忽略換行符號差異（CRLF vs LF）

---

### P0-2：雙窗格佈局框架 ✅

- [x] **主視窗結構**：Toolbar → Path Bar → 比對窗格 → Status Bar
- [x] **Path Bar**：顯示左/右路徑
- [x] **工具列**：Next/Prev Diff、Copy to Left/Right、Refresh、Swap 按鈕
- [x] **狀態列**：顯示差異數、目前位置
- [ ] **可調整窗格寬度**：拖曳中間分隔線改變左右比例

---

### P0-3：Next/Prev Difference 導航 + Copy 操作 ✅

- [x] Next Diff (F8) / Prev Diff (F7) / First Diff (Alt+Home) / Last Diff (Alt+End)
- [x] Copy Block to Right (Alt+Right)
- [x] Copy Block to Left (Alt+Left)
- [ ] Copy All Differences to Right/Left：批次同步所有差異
- [ ] Undo/Redo 支援

---

## P1 — 重要功能

### P1-1：資料夾比對（Folder Compare） ✅

#### 目錄存取
- [x] Electron IPC → `fs.readdir` 遞迴掃描
- [x] 支援選擇資料夾（dialog.showOpenDialog）

#### 比對功能
- [x] **雙欄樹狀視圖**：左右各一個資料夾樹，對齊顯示
- [x] **比對方式選項**：名稱 / 名稱+大小 / 名稱+時間 / 內容（hash）
- [x] **狀態色彩標注**：相同、左側較新、右側較新、僅左側、僅右側、內容不同
- [x] **欄位**：名稱、大小、修改時間
- [x] **展開/折疊**子目錄
- [x] **Flat view**：攤平顯示
- [x] 雙擊檔案列：開啟文字比對

#### 篩選器
- [x] 結果類型篩選（差異/相同/孤兒/全部）
- [x] 檔案名稱篩選（文字搜尋）

---

### P1-2：Session 管理 ✅（部分）

- [x] **Session 首頁**：開啟應用時顯示，列出已儲存的 sessions
- [x] **Session 類型**：Text Compare、Folder Compare（可從首頁點擊新建）
- [x] **Recent Sessions**：最近開啟的 sessions，可刪除
- [x] **儲存至 localStorage**
- [ ] **Session 資料夾組織**：群組/資料夾分類
- [ ] **匯出/匯入 Sessions**：JSON 格式備份

---

### P1-3：Overview Minimap（差異總覽捲軸） ✅

- [x] 文字比對視圖右側的垂直 minimap
- [x] 每個差異以對應顏色的小方塊標示位置
- [x] 點擊 minimap 快速跳到對應位置
- [x] 顯示目前視窗在整份文件中的位置（視窗指示器）

---

### P1-4：語法高亮 ✅

- [x] 整合 highlight.js（lazy load，`/* @vite-ignore */`）
- [x] 自動偵測語言（由副檔名推斷）
- [x] 支援常見語言：JavaScript, TypeScript, Python, Java, C/C++, C#, Go, Rust, HTML, CSS, JSON, YAML, XML, SQL, Markdown, Shell
- [x] 語法高亮不干擾差異高亮
- [x] 可關閉語法高亮

---

### P1-5：主題切換（淺色 / 深色） ✅

- [x] 淺色主題（預設）
- [x] 深色主題
- [x] CSS Variables 驅動，主題切換無需重繪
- [ ] 跟隨系統 prefers-color-scheme

---

## P2 — 延伸功能

### P2-1：三向文字合併（3-Way Text Merge） ✅

**需求**：左側（Left）、基底（Base）、右側（Right）三個輸入 + 底部輸出窗格（Output）

- [x] 三窗格顯示（Left | Base | Right），下方輸出窗格
- [x] 自動合併非衝突變更到輸出
- [x] 衝突區塊以紅色 + 特殊圖示標注（`<<<<<<< LEFT` / `||||||| BASE` / `=======` / `>>>>>>> RIGHT`）
- [x] 衝突解決操作：使用左側/右側/基底版本、手動編輯
- [x] 輸出窗格完整可編輯
- [x] 儲存合併結果（Electron dialog.showSaveDialog）

---

### P2-2：CSV / 表格比對（Table Compare） ✅

- [x] 解析 CSV / TSV 為表格結構（狀態機 parser，自動偵測分隔符）
- [x] 以表格形式並排顯示（列 diff）
- [x] 識別標題行（Header row）
- [x] **Key column 指定**：按指定欄位的值對齊列（不依位置）
- [x] 欄位差異高亮（cell-diff）
- [x] 忽略欄位順序選項
- [x] Phantom rows 對齊孤兒列
- [ ] 支援排序列後再比對

---

### P2-3：圖片比對（Image Compare） ✅

- [x] 左右並排顯示兩張圖片（Canvas）
- [x] **同步縮放/平移**：兩個圖片窗格同步操作
- [x] **差異疊加層**：以紅色標出像素級差異（Canvas pixel diff）
- [x] 差異敏感度調整（threshold slider）
- [x] 顯示圖片基本資訊（寬高、檔案大小）
- [x] 支援格式：JPEG, PNG, GIF, WebP, BMP
- [ ] 差異通道視圖（只顯示有差異的像素）
- [ ] SVG 支援

---

### P2-4：HTML 報告匯出 ✅

- [x] 文字比對：匯出 HTML 報告（左右並排，含色彩差異，self-contained 單一 HTML 檔）
- [x] 資料夾比對：匯出差異清單 HTML（狀態/名稱/大小/時間欄）
- [x] 直接下載 HTML 檔案（Electron dialog.showSaveDialog）

---

### P2-5：文字比對直接編輯 ✅

- [x] 兩個比對窗格均可直接打字編輯（Ctrl+E 切換編輯模式，textarea overlay）
- [x] 編輯後即時重新計算 diff（debounce 300ms）
- [x] Ctrl+S 儲存左側 / Ctrl+Shift+S 儲存右側（Electron dialog.showSaveDialog）
- [x] 顯示「已修改」狀態（path bar ✎ 標記）

---

### P2-6：忽略規則（Importance Rules） ✅

- [x] 忽略行首/尾空白、空白行、大小寫不敏感（比對選項）
- [x] 自訂正規表達式忽略模式（每行一條 Regex，忽略行設為相同）
- [x] 不重要差異顯示為藍色（Unimportant patterns → 藍色而非紅色）
- [x] 工具列 ⚙ 開啟忽略規則 Modal，套用後即時重新計算

---

## P3 — 進階功能

### P3-1：Hex / 二進位比對 ✅

- [x] 十六進位 dump 視圖：`Offset | Hex Bytes | ASCII`
- [x] 兩個 hex 窗格並排，對齊差異 bytes
- [x] 差異 bytes 以顏色標注（diff / left-only / right-only）
- [x] 支援大型檔案（虛擬化捲動，ROW_HEIGHT=20px，只渲染可見列）
- [x] 最大支援 10MB
- [x] 同步捲動（左右窗格連動）
- [ ] 比對算法切換：Fast（線性）/ Complete（LCS-based）
- [ ] 依 Offset 跳轉
- [ ] 點擊 hex byte 同步到 ASCII 欄位

---

### P3-2：資料夾同步（Folder Sync） ✅

- [x] 預覽模式：顯示所有即將執行的操作（copy/skip），不立即執行
- [x] 同步規則：Left→Right / Right→Left / 雙向同步（選擇最新版本）
- [x] 執行同步操作（Electron IPC `copy-file` 批次寫入）
- [x] 工具列 ⇔ 同步 按鈕開啟同步面板

---

### P3-3：Zip 虛擬資料夾 ✅

- [x] 使用 JSZip（dynamic import）將 .zip 解析為虛擬資料夾
- [x] 可在資料夾比對中直接比對 zip vs 資料夾，或 zip vs zip
- [x] Zip 路徑格式：`zipPath::relativePath`（與實體路徑相容）
- [x] 工具列「開啟 Zip…」按鈕（左/右各一）

---

### P3-4：鍵盤快捷鍵系統 ✅（部分）

| 操作 | 快捷鍵 | 狀態 |
|------|--------|------|
| 下一個差異 | F8 | ✅ |
| 上一個差異 | F7 | ✅ |
| 第一個差異 | Alt+Home | ✅ |
| 最後一個差異 | Alt+End | ✅ |
| 複製到右側 | Alt+Right | ✅ |
| 複製到左側 | Alt+Left | ✅ |
| 重新整理 | F5 | ✅ |
| 新 Session | Ctrl+N | ✅ |
| 切換編輯模式 | Ctrl+E | ✅ |
| 儲存左側 | Ctrl+S | ✅ |
| 儲存右側 | Ctrl+Shift+S | ✅ |
| 關閉分頁 | Ctrl+W | ✅ |
| 復原 | Ctrl+Z | ⬜ |
| 重做 | Ctrl+Y | ⬜ |
| 尋找 | Ctrl+F | ⬜ |

- [ ] 快捷鍵可由使用者自訂（Settings 頁面）

---

### P3-5：多分頁介面（Tabs） ✅

- [x] 多個 session 以分頁形式開啟（TabManager session-record 模式）
- [x] Ctrl+W 關閉分頁，關閉後自動切換至相鄰分頁或回到 Session Home
- [x] 分頁標題顯示 session 類型與比對路徑
- [ ] 分頁可拖曳排序

---

### 右鍵選單（Context Menu） ✅

**共用元件**：`src/renderer/src/core/context-menu.js` + `styles/context-menu.css`
- 自訂 HTML 選單，CSS Variables 主題支援（Light / Dark）
- 自動修正視窗邊界溢出、Escape 鍵關閉、外點關閉

**新增 Electron IPC**（`main/index.js` + `preload/index.js`）：

| IPC 名稱 | 說明 |
|---------|------|
| `show-in-explorer` | `shell.showItemInFolder` — 在 OS 檔案總管中顯示 |
| `copy-file` | `fs.copyFile(src, dest)` — 複製檔案 |
| `delete-file` | `fs.unlink(path)` — 刪除檔案 |

**各視圖右鍵項目**：

| 視圖 | 右鍵觸發位置 | 選單項目 |
|------|------------|---------|
| **資料夾比對** | `.fc-row` 每列 | 開啟比對、在檔案總管中顯示（左/右）、複製左→右 / 右→左（覆蓋）、複製到對側（孤兒檔）、刪除（含確認） |
| **文字比對** | 左/右文字窗格 | 複製選取文字、全選、複製此差異→右側 / 複製此差異→左側（點在差異行時才顯示） |
| **表格比對** | 左/右表格 | 複製儲存格、複製整列（CSV）、複製整列（Tab 分隔） |
| **Hex 比對** | 左/右 Hex 窗格 | 複製 Hex（此列）、複製 ASCII（此列）、複製 Offset |

---

## 實作順序建議

```
Phase 1 (MVP)：P0-1 → P0-2 → P0-3                          ✅ 完成
Phase 2 (Core)：P1-1 → P1-2 → P1-3 → P1-4 → P1-5          ✅ 完成
Phase 3 (Extended)：P2-1 → P2-2 → P2-3 → P2-4 → P2-5 → P2-6  ✅ 完成
Phase 4 (Advanced)：P3-1 → P3-2 → P3-3 → P3-5  ✅ 完成  |  P3-4 部分 ✅
UX 強化：右鍵選單（全視圖）✅
```

---

## 已知技術限制（Electron）

| 限制 | 原因 | 應對策略 |
|------|------|---------|
| Preload 不支援 ESM | Electron 限制 | electron.vite.config.js 強制 CJS 輸出 |
| 大型二進位檔案效能 | DOM 限制 | 虛擬化捲動（Virtual Scroll）— 已實作於 Hex Compare |
| 圖片 diff 大圖效能 | Canvas drawImage 受限 | 縮圖後比對，原圖僅顯示 |

---

## 外部依賴清單（最小化原則）

| 套件 | 用途 | 狀態 |
|------|------|------|
| highlight.js | 語法高亮 | ✅ 已整合（lazy load） |
| JSZip | Zip 虛擬資料夾 | ✅ 已整合（main process dynamic import） |
| electron-vite | 開發/打包工具 | ✅ 已使用 |
| Vitest | 單元測試 | ✅ 已整合（53/53 passing） |

> 核心 diff 算法、UI 元件、Session 管理皆自行實作，不依賴外部 diff 庫。
