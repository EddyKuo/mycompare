/**
 * Application menu.
 *
 * Mirrors Beyond Compare's menu structure (Session / File / Edit / Search /
 * View / Tools / Help). Items carry a command id which is forwarded to the
 * renderer over the `menu-action` channel; app.js owns the dispatch table so
 * the main process stays ignorant of view internals.
 */

import { Menu, shell, app, BrowserWindow } from 'electron'

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} command
 * @param {unknown} [payload]
 */
function send(win, command, payload) {
  // The menu is application-global, but this template was built bound to one
  // window. With a second window open, every menu command would drive whichever
  // window happened to be created first — the focused one would ignore its own
  // menu while another acted on it. So the focused window wins, and the bound
  // one is only the fallback for when focus is elsewhere entirely.
  const focused = BrowserWindow.getFocusedWindow()
  const target = focused && !focused.isDestroyed() ? focused : win
  if (target && !target.isDestroyed()) {
    target.webContents.send('menu-action', { command, payload })
  }
}

/**
 * Drop hidden commands, then repair what their absence leaves behind.
 *
 * Removing an item is the easy half. A menu that loses its last command must
 * not stay as an empty heading the user can open onto nothing, and separators
 * around a removed item become leading, trailing, or doubled rules — visible
 * damage that reads as a rendering bug rather than a preference.
 *
 * @param {import('electron').MenuItemConstructorOptions[]} items
 * @param {Set<string>} hidden
 * @returns {import('electron').MenuItemConstructorOptions[]}
 */
function pruneHidden(items, hidden) {
  const kept = []
  for (const it of items) {
    if (typeof it.id === 'string' && hidden.has(it.id)) continue
    if (Array.isArray(it.submenu)) {
      const sub = pruneHidden(it.submenu, hidden)
      // A submenu emptied by hiding takes its parent with it; one that still
      // has commands is kept with the pruned contents.
      if (sub.length === 0) continue
      kept.push({ ...it, submenu: sub })
      continue
    }
    kept.push(it)
  }

  const out = []
  for (const it of kept) {
    const isSep = it.type === 'separator'
    // Skip a separator that would lead, or that follows another separator.
    if (isSep && (out.length === 0 || out[out.length - 1].type === 'separator')) continue
    out.push(it)
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop()
  return out
}

/**
 * Build and install the application menu.
 * @param {import('electron').BrowserWindow} win
 * @param {readonly string[]} [hiddenCommands] command ids the user turned off
 * @returns {import('electron').Menu}
 */
export function buildAppMenu(win, hiddenCommands = []) {
  const isMac = process.platform === 'darwin'

  /**
   * A command item.
   *
   * `registerAccelerator: false` matters: the renderer owns every keystroke,
   * through a user-customisable binding table (core/settings-store.js). If the
   * menu also registered these keys, both paths would run — pressing F8 would
   * skip two differences instead of one — and user rebindings would be
   * shadowed by the hard-coded menu ones. The accelerator here is therefore a
   * label only, and must mirror what the renderer actually binds.
   *
   * @param {string} label
   * @param {string} command
   * @param {string} [accelerator] display-only hint
   * @returns {import('electron').MenuItemConstructorOptions}
   */
  const item = (label, command, accelerator) => ({
    id: command,
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send(win, command)
  })

  /** @type {import('electron').MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: '工作階段(&S)',
      submenu: [
        {
          // The toolbar's 新增比對 button opens a chooser, so its menu
          // counterpart is this whole group rather than any one entry. Hiding
          // the command has to take the group with it, which needs an id here.
          id: 'session.new',
          label: '新增工作階段',
          submenu: [
            item('文字比對', 'session.new.text'),
            item('資料夾比對', 'session.new.folder'),
            item('表格比對', 'session.new.table'),
            item('十六進位比對', 'session.new.hex'),
            item('圖片比對', 'session.new.image'),
            item('中繼資料比對', 'session.new.metadata'),
            item('登錄檔比對', 'session.new.registry'),
            item('三向合併', 'session.new.merge3')
          ]
        },
        { type: 'separator' },
        item('工作階段首頁', 'session.home', 'CmdOrCtrl+N'),
        item('工作階段設定…', 'session.settings'),
        item('工作區…', 'session.workspaces'),
        { type: 'separator' },
        item('建立資料夾快照…', 'session.snapshot.create'),
        item('建立快照（含內容雜湊）…', 'session.snapshot.createCrc'),
        item('開啟快照比對…', 'session.snapshot.open'),
        { type: 'separator' },
        item('匯出登錄機碼…', 'session.registry.export'),
        item('開啟 .reg 檔比對…', 'session.registry.open'),
        item('比對即時登錄機碼…', 'session.registry.live'),
        { type: 'separator' },
        item('遠端連線設定…', 'session.remote.profiles'),
        item('開啟遠端資料夾…', 'session.remote.open'),
        { type: 'separator' },
        item('另存 Session…', 'session.saveAs'),
        item('清空 Session', 'session.clear'),
        item('鎖定 Session', 'session.locked'),
        { type: 'separator' },
        item('比對上層資料夾', 'session.compareParentFolders'),
        item('以其他方式比對…', 'session.compareUsing'),
        item('合併上層資料夾', 'session.merge.parentFolders'),
        {
          label: '三向資料夾合併',
          submenu: [
            item('切換三向合併模式', 'session.folder.merge.toggle'),
            item('開啟基準資料夾…', 'session.folder.merge.openBase'),
            item('設定輸出資料夾…', 'session.folder.merge.openOutput'),
            { type: 'separator' },
            item('上一個衝突', 'session.folder.merge.prevConflict'),
            item('下一個衝突', 'session.folder.merge.nextConflict'),
            item('只顯示衝突', 'view.folder.merge.onlyConflicts'),
            { type: 'separator' },
            item('未決衝突全部採用左側', 'session.folder.merge.resolveAll.left'),
            item('未決衝突全部採用基準', 'session.folder.merge.resolveAll.base'),
            item('未決衝突全部採用右側', 'session.folder.merge.resolveAll.right'),
            item('未決衝突全部刪除', 'session.folder.merge.resolveAll.delete'),
            item('清除所有手動決議', 'session.folder.merge.clearResolutions'),
            { type: 'separator' },
            item('預覽輸出…', 'session.folder.merge.preview'),
            item('執行合併…', 'session.folder.merge.apply')
          ]
        },
        {
          label: '與合併輸出比對',
          submenu: [
            item('左側', 'session.merge.compareOutput.left'),
            item('基準', 'session.merge.compareOutput.base'),
            item('右側', 'session.merge.compareOutput.right')
          ]
        },
        item('文字比對資訊…', 'text.info'),
        item('不重要文字規則…', 'text.unimportantText'),
        item('對齊選項…', 'text.alignmentOptions'),
        item('編輯器選項…', 'text.editorOptions'),
        item('單側獨有的行一律視為重要', 'text.orphansImportant'),
        item('資料夾比對資訊', 'session.folder.info'),
        { type: 'separator' },
        item('交換兩側', 'session.swap'),
        item('重新比對', 'session.recompare', 'F5'),
        { type: 'separator' },
        item('比對內容（選取項目）', 'view.folder.compareContentsSelected'),
        item('比對內容（全部）', 'view.folder.compareContentsAll'),
        item('快速比對選取項目', 'folder.quickCompare'),
        item('快速比對全部', 'folder.quickCompareAll'),
        item('左側比對至…', 'folder.compareToLeft'),
        item('右側比對至…', 'folder.compareToRight'),
        { type: 'separator' },
        item('移動選取到其他資料夾…', 'session.folder.moveToFolder'),
        item('封存檔比對設定…', 'session.folder.archiveOptions'),
        { type: 'separator' },
        item('上一層資料夾', 'session.folder.up', 'Alt+Up'),
        item('上一頁', 'session.folder.back', 'Alt+Left'),
        item('下一頁', 'session.folder.forward', 'Alt+Right'),
        { type: 'separator' },
        item('關閉分頁', 'session.close', 'CmdOrCtrl+W'),
        isMac ? { role: 'close' } : { role: 'quit', label: '結束' }
      ]
    },
    {
      label: '檔案(&F)',
      submenu: [
        item('開啟左側…', 'file.openLeft'),
        item('開啟右側…', 'file.openRight'),
        { type: 'separator' },
        item('複製到指定資料夾…', 'file.copyTo'),
        {
          label: '同步時間戳',
          submenu: [
            item('左 → 右', 'file.touch.leftToRight'),
            item('右 → 左', 'file.touch.rightToLeft')
          ]
        },
        { type: 'separator' },
        // One item, not one per view. The key is bound once in the renderer
        // and routed to whichever view is active, so three entries all showing
        // the same accelerator would suggest three different commands.
        item('從磁碟重新載入檔案', 'file.reload', 'CmdOrCtrl+Shift+R'),
        { type: 'separator' },
        item('在檔案總管顯示左側（表格）', 'file.table.explorerLeft'),
        item('在檔案總管顯示右側（表格）', 'file.table.explorerRight'),
        { type: 'separator' },
        item('列印預覽…', 'file.printPreview'),
        { type: 'separator' },
        item('開啟封存檔（左側）…', 'file.openArchiveLeft'),
        item('開啟封存檔（右側）…', 'file.openArchiveRight'),
        { type: 'separator' },
        item('儲存左側', 'file.saveLeft', 'CmdOrCtrl+S'),
        item('儲存右側', 'file.saveRight', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        {
          label: '以指定編碼重新載入',
          submenu: [
        {
          label: '左側',
          submenu: [
            item('UTF-8', 'file.encoding.left.UTF-8'),
            item('UTF-16LE', 'file.encoding.left.UTF-16LE'),
            item('UTF-16BE', 'file.encoding.left.UTF-16BE'),
            item('Big5', 'file.encoding.left.Big5'),
            item('GBK', 'file.encoding.left.GBK'),
            item('GB18030', 'file.encoding.left.GB18030'),
            item('Shift_JIS', 'file.encoding.left.Shift_JIS'),
            item('EUC-JP', 'file.encoding.left.EUC-JP'),
            item('EUC-KR', 'file.encoding.left.EUC-KR'),
            item('windows-1252', 'file.encoding.left.windows-1252'),
            item('ISO-8859-1', 'file.encoding.left.ISO-8859-1')
          ]
        },
        {
          label: '右側',
          submenu: [
            item('UTF-8', 'file.encoding.right.UTF-8'),
            item('UTF-16LE', 'file.encoding.right.UTF-16LE'),
            item('UTF-16BE', 'file.encoding.right.UTF-16BE'),
            item('Big5', 'file.encoding.right.Big5'),
            item('GBK', 'file.encoding.right.GBK'),
            item('GB18030', 'file.encoding.right.GB18030'),
            item('Shift_JIS', 'file.encoding.right.Shift_JIS'),
            item('EUC-JP', 'file.encoding.right.EUC-JP'),
            item('EUC-KR', 'file.encoding.right.EUC-KR'),
            item('windows-1252', 'file.encoding.right.windows-1252'),
            item('ISO-8859-1', 'file.encoding.right.ISO-8859-1')
          ]
        }
          ]
        },
        { type: 'separator' },
        item('匯出 HTML 報告…', 'file.exportHtml'),
        item('匯出純文字報告…', 'file.exportText'),
        item('匯出 Unified Diff…', 'file.exportPatch'),
        item('列印 / 匯出 PDF…', 'file.print', 'CmdOrCtrl+P')
      ]
    },
    {
      label: '編輯(&E)',
      submenu: [
        item('復原', 'edit.undo', 'CmdOrCtrl+Z'),
        item('取消復原', 'edit.redo', 'CmdOrCtrl+Y'),
        { type: 'separator' },
        { role: 'cut', label: '剪下' },
        { role: 'copy', label: '複製' },
        { role: 'paste', label: '貼上' },
        { role: 'selectAll', label: '全選' },
        { type: 'separator' },
        item('切換編輯模式', 'edit.toggleEditMode', 'CmdOrCtrl+E'),
        { type: 'separator' },
        {
          label: '行編輯',
          submenu: [
            item('複製此行到右側', 'text.copyLineRight', 'Alt+Shift+Right'),
            item('複製此行到左側', 'text.copyLineLeft', 'Alt+Shift+Left'),
            item('複製此行到對側', 'text.copyLineOther', 'Alt+Shift+O'),
            item('複製此區塊到對側', 'text.copyOtherSide', 'Alt+O'),
            { type: 'separator' },
            item('在上方插入一行', 'text.insertLineBefore', 'CmdOrCtrl+Shift+Enter'),
            item('在下方插入一行', 'text.insertLineAfter', 'CmdOrCtrl+Enter'),
            { type: 'separator' },
            item('刪除整行', 'text.deleteLine', 'CmdOrCtrl+D'),
            item('刪除至行首', 'text.deleteToStartOfLine', 'CmdOrCtrl+Shift+Backspace'),
            item('刪除至行尾', 'text.deleteToEndOfLine', 'CmdOrCtrl+Shift+Delete'),
            item('刪除一個字', 'text.deleteWord', 'CmdOrCtrl+Delete'),
            { type: 'separator' },
            item('增加縮排', 'text.increaseIndent', 'CmdOrCtrl+]'),
            item('減少縮排', 'text.decreaseIndent', 'CmdOrCtrl+[')
          ]
        },
        {
          label: '資料夾選取',
          submenu: [
            item('選取全部檔案（不含資料夾）', 'edit.folder.selectAllFiles'),
            item('選取兩側孤兒', 'edit.folder.selectOrphansBoth')
          ]
        },
        {
          label: '表格編輯',
          submenu: [
            item('跳至列／欄…', 'edit.table.goto', 'CmdOrCtrl+G'),
            item('全選（表格）', 'edit.table.selectAll', 'CmdOrCtrl+A'),
            item('複製選取（表格）', 'edit.table.copy', 'CmdOrCtrl+C'),
            item('剪下儲存格', 'edit.table.cut', 'CmdOrCtrl+X'),
            item('貼上儲存格', 'edit.table.paste', 'CmdOrCtrl+V'),
            item('刪除選取內容', 'edit.table.delete', 'Delete'),
            item('下一個編輯位置（表格）', 'search.table.nextEdit'),
            item('上一個編輯位置（表格）', 'search.table.prevEdit'),
            item('複製整列到右側', 'edit.table.copyToRight', 'Alt+Right'),
            item('複製整列到左側', 'edit.table.copyToLeft', 'Alt+Left'),
            item('插入空白列', 'edit.table.insertRow', 'CmdOrCtrl+I')
          ]
        },
        {
          label: '選取與對齊',
          submenu: [
            item('選取目前差異區塊', 'text.selectSection', 'Alt+S'),
            item('全選', 'text.selectAll', 'CmdOrCtrl+A'),
            { type: 'separator' },
            item('對齊此兩行', 'text.alignWith', 'CmdOrCtrl+Alt+A'),
            item('清除手動對齊', 'text.clearAlignAnchors', 'CmdOrCtrl+Alt+Shift+A'),
            item('單獨比對選取範圍', 'text.isolate', 'CmdOrCtrl+Alt+I')
          ]
        },
        { type: 'separator' },
        item('複製區塊到左側', 'edit.copyToLeft', 'Alt+Left'),
        item('複製區塊到右側', 'edit.copyToRight', 'Alt+Right'),
        item('複製全部差異到左側', 'edit.copyAllToLeft'),
        item('複製全部差異到右側', 'edit.copyAllToRight'),
        { type: 'separator' },
        {
          label: '三向合併：全部採用',
          submenu: [
            item('左側', 'merge.resolveAll.left'),
            item('中間（Base）', 'merge.resolveAll.base'),
            item('右側', 'merge.resolveAll.right'),
            item('兩者', 'merge.resolveAll.both')
          ]
        }
      ]
    },
    {
      label: '搜尋(&R)',
      submenu: [
        item('尋找…', 'search.find', 'CmdOrCtrl+F'),
        item('取代…', 'search.replace', 'CmdOrCtrl+H'),
        item('跳至行號…', 'search.gotoLine', 'CmdOrCtrl+G'),
        { type: 'separator' },
        item('下一個差異', 'search.nextDiff', 'F8'),
        { type: 'separator' },
        item('搜尋並取代位元組…', 'search.hex.replace', 'CmdOrCtrl+H'),
        { type: 'separator' },
        item('下一個行內差異', 'text.nextInlineDiff', 'CmdOrCtrl+F8'),
        item('上一個行內差異', 'text.prevInlineDiff', 'CmdOrCtrl+F7'),
        item('下一個編輯位置', 'text.nextEdit', 'Alt+F8'),
        { type: 'separator' },
        {
          label: '跳至書籤',
          submenu: [
            item('書籤 1', 'search.gotoBookmark1'),
            item('書籤 2', 'search.gotoBookmark2'),
            item('書籤 3', 'search.gotoBookmark3'),
            item('書籤 4', 'search.gotoBookmark4'),
            item('書籤 5', 'search.gotoBookmark5'),
            item('書籤 6', 'search.gotoBookmark6'),
            item('書籤 7', 'search.gotoBookmark7'),
            item('書籤 8', 'search.gotoBookmark8'),
            item('書籤 9', 'search.gotoBookmark9')
          ]
        },
        item('上一個編輯位置', 'text.prevEdit', 'Alt+F7'),
        item('上一個差異', 'search.prevDiff', 'F7'),
        item('第一個差異', 'search.firstDiff', 'Alt+Home'),
        item('最後一個差異', 'search.lastDiff', 'Alt+End'),
        { type: 'separator' },
        item('切換書籤', 'search.toggleBookmark', 'CmdOrCtrl+F2'),
        item('下一個書籤', 'search.nextBookmark', 'F2'),
        item('上一個書籤', 'search.prevBookmark', 'Shift+F2')
      ]
    },
    {
      label: '檢視(&V)',
      submenu: [
        {
          label: '文字比對面板',
          submenu: [
            item('詳細資料：文字', 'view.text.details.text'),
            item('詳細資料：十六進位', 'view.text.details.hex'),
            item('詳細資料：對齊', 'view.text.details.alignment'),
            item('關閉詳細資料', 'view.text.details.off'),
            { type: 'separator' },
            item('語法高亮', 'text.toggleSyntax'),
            item('檔案格式…', 'text.fileFormat'),
            {
              label: '空白比對方式',
              submenu: [
                item('不忽略', 'text.whitespaceMode.none'),
                item('忽略全部空白', 'text.whitespaceMode.all'),
                item('忽略行首空白', 'text.whitespaceMode.leading'),
                item('忽略行尾空白', 'text.whitespaceMode.trailing'),
                item('忽略空白數量差異', 'text.whitespaceMode.amount')
              ]
            },
            item('標尺', 'view.text.ruler'),
            item('以網頁方式檢視', 'view.text.webpages'),
            item('檔案資訊', 'view.text.fileInfo'),
            item('說明欄', 'view.text.description'),
            { type: 'separator' },
            item('鎖定左側（唯讀）', 'view.text.readOnly.left'),
            item('鎖定右側（唯讀）', 'view.text.readOnly.right'),
            { type: 'separator' },
            item('字型：預設', 'view.text.font.default'),
            item('字型：Consolas', 'view.text.font.consolas'),
            item('字型：Cascadia Code', 'view.text.font.cascadia'),
            item('字型：Fira Code', 'view.text.font.fira'),
            item('字型：Courier New', 'view.text.font.courier'),
            item('字型：JetBrains Mono', 'view.text.font.jetbrains')
          ]
        },
        {
          label: '十六進位比對面板',
          submenu: [
            item('詳細資料', 'view.hex.details'),
            item('檔案資訊', 'view.hex.fileInfo'),
            item('標尺', 'view.hex.ruler'),
            item('一律顯示資料夾', 'view.folder.alwaysShowFolders'),
            item('暫停所有篩選', 'view.folder.suppressFilters'),
            item('快速篩選使用正規表示式', 'view.folder.filterRegex'),
            item('圖例', 'view.folder.legend'),
            item('記錄面板', 'view.folder.log'),
            { type: 'separator' },
            item('顯示列號（表格）', 'view.table.rowNumbers'),
            item('放大字型（表格）', 'view.table.fontLarger'),
            item('縮小字型（表格）', 'view.table.fontSmaller'),
            item('重設字型（表格）', 'view.table.fontReset'),
            item('整檔差異縮圖（文字）', 'view.text.thumbnail'),
            { type: 'separator' },
            item('顯示基準窗格（三向）', 'view.merge.toggleBasePane'),
            item('放大輸出窗格', 'view.merge.maximizeOutput'),
            item('放大來源窗格', 'view.merge.maximizeSources'),
            item('顯示行號（三向）', 'view.merge.lineNumbers'),
            item('重設窗格版面', 'view.merge.resetLayout'),
            item('整檔差異縮圖', 'view.hex.thumbnail'),
            item('上下堆疊佈局', 'view.hex.layout')
          ]
        },
        {
          label: '表格比對面板',
          submenu: [
            item('詳細資料', 'view.table.details'),
            item('檔案資訊', 'view.table.fileInfo'),
            item('顯示空白字元', 'view.table.whitespace'),
            item('差異程度色階', 'view.table.severity'),
            item('縮圖', 'view.table.thumbnail')
          ]
        },
        {
          label: '資料夾比對',
          submenu: [
            item('只比對檔案', 'view.folder.filesOnly'),
            item('攤平比對（忽略資料夾結構）', 'view.folder.flatten'),
            item('忽略不重要差異', 'view.folder.ignoreUnimportant')
          ]
        },
        item('圖片資訊', 'view.image.info'),
        { type: 'separator' },
        item('顯示工具列', 'view.toggleToolbar'),
        item('顯示狀態列', 'view.toggleStatusBar'),
        { type: 'separator' },
        item('顯示全部', 'view.showAll'),
        item('只顯示差異', 'view.showDiff'),
        item('只顯示相同', 'view.showSame'),
        item('全部隱藏', 'view.showNone'),
        {
          label: '資料夾顯示模式',
          submenu: [
            item('顯示孤兒', 'view.folder.orphans'),
            item('不顯示孤兒', 'view.folder.noOrphans'),
            item('差異但不含孤兒', 'view.folder.diffNoOrphans'),
            item('左側較新', 'view.folder.leftNewer'),
            item('右側較新', 'view.folder.rightNewer'),
            item('僅左側孤兒', 'view.folder.leftOrphans'),
            item('僅右側孤兒', 'view.folder.rightOrphans')
          ]
        },
        { type: 'separator' },
        item('忽略不重要差異', 'view.toggleIgnoreUnimportant'),
        { type: 'separator' },
        item('行號', 'view.toggleLineNumbers'),
        item('顯示空白字元', 'view.toggleWhitespace'),
        item('自動換行', 'view.toggleWordWrap'),
        item('切換並排 / 上下佈局', 'view.toggleLayout'),
        item('三向合併：只顯示衝突', 'view.merge.conflictsOnly'),
        { type: 'separator' },
        item('放大', 'view.zoomIn', 'CmdOrCtrl+='),
        item('縮小', 'view.zoomOut', 'CmdOrCtrl+-'),
        item('重設縮放', 'view.zoomReset', 'CmdOrCtrl+0'),
        { type: 'separator' },
        item('切換主題', 'view.toggleTheme'),
        item('全螢幕', 'view.fullScreen', 'F11'),
        { type: 'separator' },
        { role: 'reload', label: '重新載入' },
        { role: 'toggleDevTools', label: '開發者工具' }
      ]
    },
    {
      label: '工具(&T)',
      submenu: [
        item('選項…', 'tools.options'),
        item('自訂指令…', 'tools.customizeCommands'),
        { type: 'separator' },
        item('比對規則（忽略設定）…', 'tools.ignoreRules'),
        item('文法定義…', 'tools.grammar'),
        item('已命名設定…', 'tools.namedConfigs'),
        item('自訂快捷鍵…', 'tools.shortcuts'),
        { type: 'separator' },
        item('匯出全部設定…', 'tools.settings.export'),
        item('匯入設定…', 'tools.settings.import'),
        { type: 'separator' },
        {
          label: '比對演算法',
          submenu: [
            item('Myers', 'tools.algorithm.myers'),
            item('Patience', 'tools.algorithm.patience'),
            item('Histogram', 'tools.algorithm.histogram')
          ]
        }
      ]
    },
    {
      label: '說明(&H)',
      submenu: [
        {
          label: '專案首頁',
          click: () => { void shell.openExternal('https://github.com/') }
        },
        item('關於 MyCompare', 'help.about')
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(pruneHidden(template, new Set(hiddenCommands)))
  Menu.setApplicationMenu(menu)
  return menu
}
