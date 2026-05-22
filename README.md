# MyCompare

BeyondCompare 的開源複製品，以 **Electron + Vite + Vanilla JavaScript** 打造的跨平台桌面比對工具。

---

## 下載

最新版本：[Releases](https://github.com/EddyKuo/mycompare/releases/latest)

| 平台 | 檔案 |
|------|------|
| Windows x64 | `MyCompare-Setup-X.Y.Z.exe`（NSIS 安裝程式） |
| macOS | 尚未提供（可自行 `npm run dist` 建置 DMG） |
| Linux | 尚未提供（可自行 `npm run dist` 建置 AppImage） |

> **Windows SmartScreen 警告**：目前未做 code-signing，首次執行 Windows 會跳出「已保護您的電腦」。點「其他資訊 → 仍要執行」即可。

---

## 功能特色

| 比對類型 | 說明 |
|----------|------|
| **文字比對** | Myers / Patience 雙演算法、字元級差異、忽略規則、編輯模式、三向合併 |
| **資料夾比對** | 遞迴目錄樹、同步模式、ZIP 壓縮包瀏覽、批次操作 |
| **Hex 比對** | Binary 虛擬捲動、Byte-by-byte diff 著色、Ctrl+F 搜尋、Offset 跳轉 |
| **圖片比對** | 像素級差異疊層、縮放對齊 |
| **表格比對** | CSV / Excel 欄位對齊比對 |
| **三向合併** | 3-way merge、衝突標記 |

其他功能：

- 多分頁（tab）工作區，可同時開啟多個比對
- 深色 / 淺色主題（跟隨系統或手動切換）
- HTML 報告匯出
- 右鍵快捷選單
- 完整鍵盤快捷鍵

---

## 技術棧

```
Electron 31          — 桌面應用程式殼層（main / preload / renderer 三程序架構）
electron-vite 2      — 開發伺服器 + 生產建置（Vite 5 + esbuild）
Vanilla JS ES2022+   — renderer UI（無前端框架）
highlight.js 11      — 語法高亮（文字比對）
chardet / iconv-lite — 檔案編碼自動偵測與轉換
jszip                — ZIP 壓縮包讀取（資料夾比對）
xlsx                 — Excel / CSV 解析（表格比對）
Vitest 1             — 單元測試
Playwright 1         — E2E 整合測試（Electron）
electron-builder 26  — 打包與安裝程式產生
```

---

## 目錄結構

```
MyCompare/
├── src/
│   ├── main/
│   │   └── index.js          # Electron main process（IPC handlers、native menu）
│   ├── preload/
│   │   └── index.js          # contextBridge（electronAPI 暴露給 renderer）
│   └── renderer/
│       ├── index.html         # 應用程式入口
│       └── src/
│           ├── main.js        # renderer 入口
│           ├── app.js         # 視圖路由、toolbar、tab 管理
│           ├── core/          # diff 引擎、session 管理、工具函式
│           └── views/         # 各比對視圖元件
│               ├── text-compare.js
│               ├── folder-compare.js
│               ├── hex-compare.js
│               ├── image-compare.js
│               ├── table-compare.js
│               └── three-way-compare.js
├── tests/
│   ├── unit/                  # Vitest 單元測試
│   └── e2e/                   # Playwright E2E 測試
├── resources/                 # 應用程式圖示
├── electron.vite.config.js
├── vitest.config.js
└── package.json
```

---

## 環境需求

| 工具 | 版本 |
|------|------|
| Node.js | ≥ 18 |
| npm | ≥ 9 |

---

## 安裝

```bash
git clone https://github.com/EddyKuo/mycompare.git
cd mycompare
npm install
```

> **Windows 打包前置**：`npm run dist` 解壓 `winCodeSign` 套件時會建立 macOS `.dylib` 符號連結，需開啟 Windows「開發人員模式」（設定 → 隱私權與安全性 → 開發人員專用 → 開發人員模式）或以系統管理員身分執行。

---

## 開發

啟動開發伺服器（Hot Reload）：

```bash
npm run dev
```

Electron 視窗會自動開啟，renderer 進行 HMR 熱更新，main/preload 變更後自動重啟。

---

## 建置

產生生產版本（輸出至 `out/`）：

```bash
npm run build
```

預覽生產版本（不打包成安裝程式）：

```bash
npm run preview
```

---

## 打包安裝程式

> 執行前請先確認 `resources/` 中有對應平台的圖示檔案。

```bash
# 產生安裝程式（輸出至 dist/）
npm run dist

# 僅產生未打包的目錄（速度較快，適合本機測試）
npm run dist:dir
```

| 平台 | 輸出格式 |
|------|----------|
| Windows | NSIS 安裝程式（`.exe`） |
| macOS | DMG（`.dmg`） |
| Linux | AppImage（`.AppImage`） |

---

## 測試

### 單元測試

```bash
# 執行一次
npm test

# 監看模式
npm run test:watch

# 含覆蓋率報告
npm run test:coverage
```

目前覆蓋：**571 / 571 unit tests passing**、**68 / 68 e2e tests passing**。

涵蓋範圍包含 diff 引擎、session CRUD、smart routing、編碼偵測、folder / text / hex / table / image / three-way 各視圖邏輯、安全性與記憶體洩漏檢查等 30+ 測試檔。

### E2E 測試（Playwright + Electron）

```bash
npm run test:e2e
```

E2E 測試會先執行 `npm run build`，再對生產版本執行 Playwright 測試（透過 `window.__testAPI` 注入資料，繞過 file dialog）。涵蓋 text / folder / hex / image / table / three-way / smoke / theme 等視圖。

### Lint

```bash
npm run lint
```

---

## 鍵盤快捷鍵

| 快捷鍵 | 功能 |
|--------|------|
| `Ctrl+N` | 回到首頁（新增比對） |
| `Ctrl+W` | 關閉目前分頁 |
| `F7` | 上一個差異 |
| `F8` | 下一個差異 |
| `Alt+Home` | 第一個差異 |
| `Alt+End` | 最後一個差異 |
| `Alt+←` | 複製到左側 |
| `Alt+→` | 複製到右側 |
| `Ctrl+E` | 切換編輯模式（文字比對） |
| `Ctrl+S` | 儲存左側檔案 |
| `Ctrl+Shift+S` | 儲存右側檔案 |
| `Ctrl+F` | 開啟搜尋列（各視圖內） |
| `F5` | 重新整理 |

---

## UI 色彩語意

| 狀態 | 顏色 |
|------|------|
| 相同 | 預設背景 |
| 差異 | 紅 / 粉紅 |
| 不重要差異 | 藍 / 淡藍 |
| 僅左側 | 綠 |
| 僅右側 | 橘紅 |

---

## 授權

MIT License
