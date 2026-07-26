/**
 * Application menu.
 *
 * Mirrors Beyond Compare's menu structure (Session / File / Edit / Search /
 * View / Tools / Help). Items carry a command id which is forwarded to the
 * renderer over the `menu-action` channel; app.js owns the dispatch table so
 * the main process stays ignorant of view internals.
 */

import { Menu, shell, app } from 'electron'

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} command
 * @param {unknown} [payload]
 */
function send(win, command, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('menu-action', { command, payload })
  }
}

/**
 * Build and install the application menu.
 * @param {import('electron').BrowserWindow} win
 * @returns {import('electron').Menu}
 */
export function buildAppMenu(win) {
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
          label: '新增工作階段',
          submenu: [
            item('文字比對', 'session.new.text'),
            item('資料夾比對', 'session.new.folder'),
            item('表格比對', 'session.new.table'),
            item('十六進位比對', 'session.new.hex'),
            item('圖片比對', 'session.new.image'),
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
        { type: 'separator' },
        item('交換兩側', 'session.swap'),
        item('重新比對', 'session.recompare', 'F5'),
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
        item('比對規則（忽略設定）…', 'tools.ignoreRules'),
        item('已命名設定…', 'tools.namedConfigs'),
        item('自訂快捷鍵…', 'tools.shortcuts'),
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

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
  return menu
}
