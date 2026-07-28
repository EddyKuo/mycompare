/**
 * @file registry-query.js
 * @description Reading a registry key on another computer.
 *
 *   `reg export` is documented "local machine only", so the export path that
 *   serves local keys cannot reach another machine. Two routes remain.
 *
 *   The obvious one, `reg query \\Machine\HKLM\... /s`, was implemented first
 *   and measured against `reg export` on 466,767 values across 178 real keys.
 *   It disagreed on 127 of them, in two ways that could not be repaired on
 *   this side of the pipe:
 *
 *   - **Console code page.** reg.exe writes a pipe in the OEM code page, and
 *     characters it cannot represent are best-fit substituted at the source —
 *     `©` arrived as `c` on this machine. The bytes are gone before any
 *     decoder sees them. This is the same trap that once made a measurement in
 *     this project report `®` as `R`.
 *   - **REG_MULTI_SZ is ambiguous.** `reg query` separates components with a
 *     literal `\0`, so a component whose text contains `\0` cannot be told
 *     apart from two components.
 *
 *   Both are silent: a wrong value, reported as success. So this module uses
 *   the registry API instead, through PowerShell's .NET access, which returns
 *   the values themselves rather than a rendering of them. The script is a
 *   constant and its parameters arrive in the environment, so nothing the user
 *   types is ever parsed as script.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Windows itself only serves these roots over the network. */
export const REMOTE_ROOTS = Object.freeze([
  'HKLM', 'HKEY_LOCAL_MACHINE', 'HKU', 'HKEY_USERS',
])

/** .NET hive name for each accepted root. */
const HIVE_OF = Object.freeze({
  HKLM: 'LocalMachine',
  HKEY_LOCAL_MACHINE: 'LocalMachine',
  HKU: 'Users',
  HKEY_USERS: 'Users',
})

/** Full root name to put in the reported key paths. */
const ROOT_NAME = Object.freeze({
  HKLM: 'HKEY_LOCAL_MACHINE',
  HKEY_LOCAL_MACHINE: 'HKEY_LOCAL_MACHINE',
  HKU: 'HKEY_USERS',
  HKEY_USERS: 'HKEY_USERS',
})

/** A remote read of a large subtree is slow; stop rather than hang forever. */
const QUERY_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * Split a target into an optional machine and a key path.
 *
 * BC writes these as `reg:\\Machine\HKEY_LOCAL_MACHINE\Key`; the `reg:` prefix
 * is optional here because the field already means "a registry key".
 *
 * @param {string} target
 * @returns {{ machine: string, keyPath: string }}
 * @throws {Error} when either half is unusable
 */
export function parseRegistryTarget(target) {
  const raw = String(target ?? '').trim().replace(/^reg:/i, '')
  if (!raw) throw new Error('登錄機碼路徑不可為空')
  if (!raw.startsWith('\\\\')) return { machine: '', keyPath: raw }

  const rest = raw.slice(2)
  const cut = rest.indexOf('\\')
  if (cut <= 0) throw new Error('遠端登錄機碼要寫成 \\\\電腦名稱\\HKLM\\...')

  const machine = validateMachineName(rest.slice(0, cut))
  const keyPath = rest.slice(cut + 1)
  if (!keyPath) throw new Error('遠端登錄機碼缺少機碼路徑')
  if (/[\r\n\0]/.test(keyPath)) throw new Error('登錄機碼路徑含有不允許的字元')

  const root = keyPath.split('\\')[0].toUpperCase()
  if (!REMOTE_ROOTS.includes(root)) {
    // Not this program's restriction: Windows serves only these two remotely.
    throw new Error(`遠端登錄檔只能存取 HKLM 與 HKU，不能存取 ${root}`)
  }
  return { machine, keyPath }
}

/**
 * A machine name reaches a child process, so it must not be able to carry
 * arguments or path syntax of its own.
 *
 * @param {string} name
 * @returns {string}
 * @throws {Error}
 */
export function validateMachineName(name) {
  const n = String(name ?? '').trim()
  if (!n) throw new Error('電腦名稱不可為空')
  if (n.length > 64) throw new Error('電腦名稱過長')
  // Hostnames and NetBIOS names only; nothing that could be read as a switch
  // or reopen a UNC path.
  if (!/^[A-Za-z0-9._-]+$/.test(n)) throw new Error(`電腦名稱含有不允許的字元：${n}`)
  if (n.startsWith('-')) throw new Error('電腦名稱不可以開關字元開頭')
  return n
}

/**
 * The script run on the remote read.
 *
 * A constant — every parameter arrives in the environment, so nothing the user
 * types is ever parsed as PowerShell. The result comes back base64-encoded so
 * the console code page cannot touch it, which is the whole reason this exists
 * rather than a `reg query` call.
 *
 * Value rendering matches `parseRegValue` in registry.js exactly, or a key read
 * from a machine would not compare against the same key read from a file.
 */
const REMOTE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$hive = [Microsoft.Win32.RegistryHive]::($env:MC_HIVE)
$base = [Microsoft.Win32.RegistryKey]::OpenRemoteBaseKey($hive, $env:MC_MACHINE)
$root = $base.OpenSubKey($env:MC_KEY)
if ($null -eq $root) { throw "找不到機碼 $($env:MC_KEY)" }

$out = New-Object System.Collections.ArrayList

function Read-Key($key, $path) {
  $vals = New-Object System.Collections.ArrayList
  foreach ($n in $key.GetValueNames()) {
    $kind = $key.GetValueKind($n)
    $raw = $key.GetValue($n, $null, 'DoNotExpandEnvironmentNames')
    switch ("$kind") {
      'Binary'       { $t = 'REG_BINARY';     $v = (($raw | ForEach-Object { $_.ToString('X2') }) -join ' ') }
      'None'         { $t = 'REG_NONE';       $v = (($raw | ForEach-Object { $_.ToString('X2') }) -join ' ') }
      'MultiString'  { $t = 'REG_MULTI_SZ';   $v = ($raw -join ' | ') }
      'ExpandString' { $t = 'REG_EXPAND_SZ';  $v = ([string]$raw).TrimEnd([char]0) }
      'String'       { $t = 'REG_SZ';         $v = ([string]$raw).TrimEnd([char]0) }
      'DWord'        {
        $t = 'REG_DWORD'
        # A cast would throw on a negative DWord — .NET hands these back as a
        # signed Int32, and half the registry's flags have the top bit set.
        # Reinterpreting the bytes is what the .reg reader effectively does.
        $u = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$raw), 0)
        $v = ('0x{0:x8} ({1})' -f $u, $u)
      }
      'QWord'        { $t = 'REG_QWORD';      $v = (([BitConverter]::GetBytes([int64]$raw) | ForEach-Object { $_.ToString('X2') }) -join ' ') }
      default {
        # Windows' managed API does not report the number behind a type it has
        # no name for, so the bytes are kept and the type is reported as
        # REG_NONE. Reading the same value from a .reg file names it
        # REG_TYPE_<n>, so such a value shows as a difference — visible, rather
        # than a wrong value that looks right.
        $t = 'REG_NONE'
        if ($raw -is [byte[]]) { $v = (($raw | ForEach-Object { $_.ToString('X2') }) -join ' ') }
        else { $v = [string]$raw }
      }
    }
    [void]$vals.Add(@{ n = $n; t = $t; v = $v })
  }
  [void]$out.Add(@{ p = $path; v = $vals })
  foreach ($sub in $key.GetSubKeyNames()) {
    $child = $key.OpenSubKey($sub)
    if ($null -ne $child) { Read-Key $child "$path\\$sub" }
  }
}

Read-Key $root "$($env:MC_ROOT)\\$($env:MC_KEY)"
$json = $out | ConvertTo-Json -Depth 8 -Compress
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
`

/**
 * Read a key and everything under it from another computer.
 *
 * @param {string} machine
 * @param {string} keyPath  e.g. HKLM\\SOFTWARE\\Example
 * @returns {Promise<{ format: string, keys: Array<{path: string, values: Array<object>}> }>}
 */
export async function queryRemoteKey(machine, keyPath) {
  if (process.platform !== 'win32') {
    throw new Error('登錄檔比對僅適用於 Windows')
  }
  validateMachineName(machine)

  const parts = String(keyPath).split('\\')
  const root = parts[0].toUpperCase()
  const hive = HIVE_OF[root]
  if (!hive) throw new Error(`遠端登錄檔只能存取 HKLM 與 HKU，不能存取 ${root}`)

  let stdout
  try {
    ;({ stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', REMOTE_SCRIPT],
      {
        windowsHide: true,
        timeout: QUERY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: {
          ...process.env,
          MC_MACHINE: machine,
          MC_HIVE: hive,
          MC_ROOT: ROOT_NAME[root],
          MC_KEY: parts.slice(1).join('\\'),
        },
      },
    ))
  } catch (err) {
    const detail = String(err?.stderr || err?.message || err).trim().split('\n')[0]
    throw new Error(`讀取遠端登錄機碼失敗：${detail || '未知錯誤'}`)
  }

  return parseRemoteResult(stdout)
}

/**
 * Decode what the script printed.
 *
 * @param {string} base64
 * @returns {{ format: string, keys: Array<{path: string, values: Array<object>}> }}
 */
export function parseRemoteResult(base64) {
  const text = Buffer.from(String(base64 ?? '').trim(), 'base64').toString('utf-8')
  if (!text) return { format: 'remote', keys: [] }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('遠端登錄檔回應無法解析')
  }
  // ConvertTo-Json collapses a one-element array to an object.
  const list = Array.isArray(parsed) ? parsed : [parsed]

  return {
    format: 'remote',
    keys: list.map((k) => ({
      path: String(k?.p ?? ''),
      values: toArray(k?.v).map((v) => ({
        name: String(v?.n ?? ''),
        type: String(v?.t ?? 'REG_UNKNOWN'),
        value: String(v?.v ?? ''),
      })),
    })),
  }
}

/**
 * @param {unknown} v
 * @returns {Array<any>}
 */
function toArray(v) {
  if (Array.isArray(v)) return v
  return v == null ? [] : [v]
}
