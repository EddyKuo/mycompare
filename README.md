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
| **文字比對** | Myers / Patience / Histogram 演算法、字元級差異、忽略規則（含手動逐行標記）、文法感知比對、編輯模式、可逆摺疊、書籤、Find & Replace、Patch 檢視器 |
| **資料夾比對** | 遞迴目錄樹、11 種顯示模式、欄位選擇與排序、虛擬捲動、同步模式、封存檔瀏覽、移動／互換／Touch、版本欄位、上下層導覽 |
| **Hex 比對** | 虛擬捲動、Fast / Complete 兩種 byte diff、行內編輯與 undo/redo、18 種數值判讀面板、標尺、差異篩選 |
| **圖片比對** | 像素級差異、Auto Scale 尺寸對齊、差異強度分級、旋轉翻轉、同步縮放 |
| **表格比對** | CSV / Excel 多工作表 / HTML 表格、虛擬捲動、儲存格編輯與 undo/redo、數值與日期容差比對、多欄複合 key、欄位顯示與排除 |
| **三向合併** | 3-way merge、八種顯示篩選、可調脈絡行數、Favor Left/Right、演算法選擇、衝突導航、批次解決 |

其他功能：

- 完整選單列（Session / File / Edit / Search / View / Tools / Help）
- 命令列開關（`/fv` `/filters` `/qc` `/iu` `/expandall` `/?` 等）
- 腳本執行（`/script=<檔案>` 預設為預演，加 `/execute` 才實際寫檔）
- 資料夾快照（記錄結構與時間戳供日後比對，可選內容雜湊）
- Session 資料夾分類
- 多分頁（tab）工作區與工作區儲存
- 統一的選項對話框（一般 / 顯示 / 差異導航 / 備份 / 快捷鍵 / 色彩與字型）
- 深色 / 淺色主題（跟隨系統或手動切換），差異色彩與字型可自訂
- 設定匯出／匯入（快捷鍵、偏好、色彩、具名設定、工作區、Session；不含任何密碼）
- 刪除預設走資源回收桶；備份支援四種命名規則與自訂位置
- HTML / 純文字報告匯出、Unified Diff、列印與 PDF
- 檔案遮罩篩選（BeyondCompare 語法：`;` 多重、`-` 排除、`[a-z]`、`...\` 等）
- 壓縮檔瀏覽：zip / jar / war / ear、tar、gzip、tar.gz、bzip2、tar.bz2、xz、tar.xz、7z
- 遠端連線：FTP / FTPS / SFTP / S3（連線設定檔、密碼以系統金鑰庫保存）。
  SFTP 一定會驗證主機金鑰：沒見過的金鑰會顯示指紋讓你確認，金鑰變更則直接拒絕連線
- MP3 標籤（ID3v1 / v2.3 / v2.4）與 Windows 版本資源比對
- 登錄檔比對（.reg 檔，或以 reg.exe 匯出即時機碼；僅 Windows）
- 手動指定檔案編碼；存檔時保留原始編碼並自動備份
- 可自訂鍵盤快捷鍵
- 拖放檔案或資料夾即可開始比對
- 右鍵快捷選單

### 尚未實作

- **Dropbox / OneDrive**：需要 OAuth 流程與各自的 API，並須自行申請應用程式憑證
- **RAR**：RARLAB 公開的只有封存結構，壓縮演算法本身是專有的。更關鍵的是這台機器上
  沒有任何 RAR 工具可以產生測試檔——無法對照參考實作驗證的二進位解析器，比不做更糟
- **7z 部分編碼**：BCJ2 等多輸入 filter、以及加密壓縮檔會明確報錯而非誤解碼

---

## 技術棧

```
Electron 33          — 桌面應用程式殼層（main / preload / renderer 三程序架構）
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

目前覆蓋：**1523 / 1523 unit tests passing**、**107 / 107 e2e tests passing**。

涵蓋範圍包含 diff 引擎、session CRUD、smart routing、編碼偵測與往返、檔案遮罩、
各視圖邏輯與導航、欄位比對規則、路徑沙箱（含 symlink 逃逸）、命令列與腳本語法、
快照格式、壓縮檔（含 Zip Slip 與比例炸彈）、ID3 與 PE 解析、登錄檔格式等 52 個測試檔。

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
