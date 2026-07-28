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
| **文字比對** | Myers / Patience / Histogram 演算法、字元級差異、忽略規則（含手動逐行標記）、文法感知比對、編輯模式、可逆摺疊、書籤、Find & Replace、Patch 檢視器、HTML 網頁檢視 |
| **資料夾比對** | 遞迴目錄樹、11 種顯示模式、欄位選擇與排序、虛擬捲動、同步模式、三向資料夾合併、封存檔瀏覽、移動／互換／Touch、版本／檢查碼／版本控制狀態／擁有者欄位、Source Control 子選單（git）、上下層導覽 |
| **Hex 比對** | 虛擬捲動、Fast / Complete 兩種 byte diff、行內編輯與 undo/redo、18 種數值判讀面板（大小端各一組，64 位元以 BigInt 計算）、位址讀數、標尺、差異篩選 |
| **中繼資料比對** | MP3 的 ID3 標籤與 Windows PE 版本資源，逐欄位並排比對；`.mp3` 自動路由，`.exe`／`.dll` 會問要用 Hex 還是版本資源 |
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
- 統一的選項對話框（一般 / 顯示 / 差異導航 / 備份 / 快捷鍵 / 色彩與字型 /
  資料夾檢視 / 圖片比對 / 文字編輯 / 封存檔類型 / 開啟方式 / 進階調整）
- 深色 / 淺色主題（跟隨系統或手動切換），差異色彩與字型可自訂
- 設定匯出／匯入（快捷鍵、偏好、色彩、具名設定、工作區、Session；不含任何密碼）
- 刪除預設走資源回收桶；備份支援四種命名規則與自訂位置
- HTML / 純文字報告匯出、Unified Diff、列印與 PDF
- 檔案遮罩篩選（BeyondCompare 語法：`;` 多重、`-` 排除、`[a-z]`、`...\` 等）
- 壓縮檔瀏覽：zip / jar / war / ear、tar、gzip、tar.gz、bzip2、tar.bz2、xz、tar.xz、
  7z（含 BCJ2）、cab（MSZIP / LZX / 未壓縮）、rar（RAR4 與 RAR5）
- 遠端連線：FTP / FTPS / SFTP / S3 / Dropbox / OneDrive（連線設定檔、密碼與 refresh token
  以系統金鑰庫保存）。SFTP 一定會驗證主機金鑰：沒見過的金鑰會顯示指紋讓你確認，
  金鑰變更則直接拒絕連線。Dropbox 與 OneDrive 走 OAuth 2.0 + PKCE，需自行申請應用程式
  憑證（這是這類服務的規定，介面內有申請說明）
- MP3 標籤（ID3v1 / v2.3 / v2.4）與 Windows 版本資源比對：可在資料夾比對中作為內容判定，
  也有獨立的逐欄位比對視圖
- 多視窗：可開新視窗，分頁能以右鍵移出或直接拖曳到另一個視窗（拖到視窗外會另開新視窗）
- 登錄檔比對：鍵值格狀檢視，逐值標示型別與「只存在於一側」，可修改、複製到另一側、
  刪除、重新命名、新增機碼與值，寫出成 .reg 或直接套用回登錄檔（僅 Windows）。
  三種來源任意配對：本機即時機碼、**另一台電腦的登錄檔**（`\電腦名稱\HKLM\…`，
  遠端限 HKLM 與 HKU，這是 Windows 的限制）、.reg 檔
- 手動指定檔案編碼；存檔時保留原始編碼並自動備份
- 可自訂鍵盤快捷鍵
- 拖放檔案或資料夾即可開始比對
- 右鍵快捷選單

### 壓縮格式的驗收範圍

**zip 與 7z 即為達標**，其餘格式是額外的。實際會遇到的封存檔幾乎都是這兩種，
而且大多數人只裝 7-Zip；為了冷門格式投入與其使用率不成比例的工夫並不划算。

以這個標準衡量，目前的支援已經超出：zip、7z（含 BCJ2）、tar、gzip、bzip2、xz
及其 tar 組合、cab（MSZIP／LZX／未壓縮）、rar（RAR4 與 RAR5 容器）。

下面列的是**這條線以外**的殘餘項目，記錄下來是為了誠實，不是待辦清單。

### 尚未實作

- **CAB Quantum**：本程式自己不解這個方法。它的產生器（Diamond.exe ≤ 1.00.0530）在 1996 年
  就被 Microsoft 移除，`makecab` 與 1997 年 Cabinet SDK 的工具都拒絕這個選項，本機 686 個
  cab、cabextract 自身的測試語料裡也沒有一個——拿不到樣本就無法驗證自己寫的解碼器。
  改為**在裝有 7-Zip 時交給它解壓**（7-Zip 讀得懂 Quantum），沒裝則具名報錯。
  這樣就不必猜測無法查證的位元組
- **RAR 的壓縮演算法**：容器（RAR4 / RAR5）本身已支援，未壓縮（stored）項目由本程式直接
  讀取。壓縮過的項目若機器上裝了 **7-Zip**（或 WinRAR）就交給它解壓並驗證 CRC，沒裝則
  列出內容並具名報錯。優先用 7-Zip 是因為它讀得懂兩代 RAR，而且安裝率遠高於 WinRAR——
  不該為了一件既有工具做得到的事，要求使用者再裝第二個。
  不自行實作解壓器的理由是授權：RAR 壓縮沒有公開規格，唯一的描述是 UnRAR 原始碼，
  而其授權禁止用該原始碼做出相容 RAR 的軟體
- **加密壓縮檔**：7z 與 RAR 的加密封存、以及 BCJ2 套在本版本沒有解碼器的 sub-coder 上，
  一律具名報錯

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
│   │   ├── index.js          # Electron main process（IPC handlers、native menu）
│   │   ├── archive.js        # 壓縮檔統一入口（格式偵測、上限、路徑穿越防護）
│   │   ├── cab.js  rar.js    # 手寫解碼器：CAB（MSZIP/LZX）、RAR4/RAR5 容器
│   │   ├── sevenzip.js       # 7z（含 BCJ2 多輸入 filter）
│   │   ├── bzip2.js lzma.js  # bzip2、LZMA/LZMA2/xz
│   │   ├── archive-delegate.js # 選用：把自己不解的方法交給已安裝的 7-Zip／UnRAR
│   │   ├── ssh-transport.js  # 手寫 SSH-2 傳輸層
│   │   ├── remote-*.js       # FTP / FTPS / SFTP / S3 / Dropbox / OneDrive
│   │   ├── vcs.js            # git 狀態與 Source Control 操作
│   │   └── metadata.js       # ID3 與 PE 版本資源解析
│   ├── preload/
│   │   └── index.js          # contextBridge（electronAPI 暴露給 renderer）
│   └── renderer/
│       ├── index.html         # 應用程式入口
│       └── src/
│           ├── main.js        # renderer 入口
│           ├── app.js         # 視圖路由、toolbar、tab 管理
│           ├── core/          # diff 引擎、session 管理、對話框、視窗管理、工具函式
│           └── views/         # 各比對視圖元件
│               ├── text-compare.js
│               ├── folder-compare.js
│               ├── hex-compare.js
│               ├── image-compare.js
│               ├── table-compare.js
│               ├── metadata-compare.js
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

目前覆蓋：**4291 / 4291 unit tests passing**、**395 / 395 e2e tests passing**，
共 152 個單元測試檔與 58 個 e2e 檔。

涵蓋範圍包含 diff 引擎、session CRUD、smart routing、編碼偵測與往返、檔案遮罩、
各視圖邏輯與導航、欄位比對規則、路徑沙箱（含 symlink 逃逸）、命令列與腳本語法、
快照格式、壓縮檔（含 Zip Slip 與比例炸彈）、ID3 與 PE 解析、登錄檔格式、
SSH 傳輸層、OAuth PKCE、文法系統的病態輸入防護等。

**手寫的解析器一律對外部參考驗證，不跟自己的假資料對答案。**
SSH 對 paramiko 互通測試；CAB 對 `makecab` 與 `expand.exe`；7z / BCJ2 對 `7z.exe`；
RAR 對 RARLAB 自己的 `Rar.exe`；壓縮格式的 fixture 由 Python 的 `bz2` / `lzma` /
`tarfile` 產生；PE 版本資源對 Windows 的版本 API 比對 772 個真實 binary；
CRC 與雜湊對公開測試向量。CAB 解析另外對本機 686 個真實 cab 抽樣，逐位元組比對 7-Zip 的輸出。

另有一組測試專防「實作完整但沒有呼叫端」——這個專案最常犯的錯，歷次稽核共找到十次以上：

| 測試 | 防的是什麼 |
|------|-----------|
| `preload-orphans` | IPC 方法**雙向**都要接上：暴露了沒人呼叫是死碼，呼叫了沒暴露是執行期 TypeError |
| （同上，模組層） | 沒有任何檔案 import 的模組——它會讓上面那條檢查失效，因為模組本身就會「提到」那些方法名 |
| `options-bc-pages` | 每個偏好設定都要有**讀取端**，不能只有寫入的控制項 |
| `css-variables` | 每個 `var(--x)` 都要有定義；`var(--x, fallback)` 永遠取 fallback 時畫面看起來完全正常 |
| `modal-prompt-wiring` | 沒有任何一處還在呼叫全域 `prompt()`——它在 Electron 會直接拋例外 |
| `menu-wiring` / `menu-accelerators` / `menu-window-target` | 選單項目有處理常式、顯示的快捷鍵真的有人綁、指令送到**目前聚焦**的視窗 |
| `text-menu-commands` | 指令表、dispatch、選單三處一致 |
| `remote-kinds-offered` | 設定介面提供的連線類型與後端支援的一致 |

### E2E 測試（Playwright + Electron）

```bash
npm run test:e2e
```

E2E 測試會先執行 `npm run build`，再對生產版本執行 Playwright 測試（透過 `window.__testAPI` 注入資料，繞過 file dialog）。涵蓋 text / folder / hex / image / table / three-way / metadata / smoke / theme 等視圖。

每個 worker 使用獨立的 Electron profile（`--user-data-dir` 指向暫存目錄）。在此之前所有 e2e
共用開發者本人的 profile：一條測試改掉的設定會留給下一條、留到下一次執行、也留給實際的
應用程式。除了讓測試相依於執行順序，它還曾經蓋掉一個真的 bug——改好的預設值讀出來仍是舊的，
因為舊值已被前一次執行寫進儲存，而儲存的設定優先於預設值。

另有一支 `packaged-smoke` 直接啟動 `dist/win-unpacked` 裡打包好的執行檔，檢查 asar 與 preload
在打包後仍然正常（其餘 e2e 跑的是 `out/`，不是使用者實際安裝的東西）。沒有 `dist/` 時自動跳過。

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
| `Ctrl+Shift+R` | 從磁碟重新載入目前視圖 |
| `F11` | 全螢幕 |

以上為預設值，全部可在「選項 → 快捷鍵」重新綁定。原生選單列顯示的快捷鍵只是提示，
實際按鍵一律由 renderer 處理，因此重新綁定後選單上的提示也會跟著更新，不會兩邊各按一次。

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
