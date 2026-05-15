/**
 * electron-builder afterPack hook.
 * Embeds the icon into the exe using rcedit after packaging,
 * before the ASAR integrity step causes conflicts.
 */
const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const rcedit = path.join(
    process.env.LOCALAPPDATA,
    'electron-builder',
    'Cache',
    'winCodeSign',
    'winCodeSign-2.6.0',
    'rcedit-x64.exe'
  )

  if (!fs.existsSync(rcedit)) {
    console.log('[afterPack] rcedit not found, skipping icon embed')
    return
  }

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productName}.exe`)
  const ico = path.resolve('resources/icon.ico')

  if (!fs.existsSync(exe)) {
    console.log('[afterPack] exe not found:', exe)
    return
  }

  try {
    execSync(`"${rcedit}" "${exe}" --set-icon "${ico}"`, { stdio: 'pipe' })
    console.log('[afterPack] icon embedded successfully')
  } catch (e) {
    console.warn('[afterPack] icon embed warning (non-fatal):', e.message)
  }
}
