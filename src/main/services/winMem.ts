/*
 * winMem —— galgame「BGM / 章节」只读内存识别的底层后端（Windows / koffi FFI）
 *
 * ★★★ 安全红线（严格遵守）★★★
 * 本文件【只读】。通过 koffi 绑定的 Windows API 只有这些，没有别的：
 *   - OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, FALSE, pid)
 *   - ReadProcessMemory / VirtualQueryEx
 *   - CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS / TH32CS_SNAPMODULE|TH32CS_SNAPMODULE32)
 *     + Process32FirstW / Process32NextW + Module32FirstW / Module32NextW
 *   - EnumWindows + GetWindowThreadProcessId + IsWindowVisible + GetWindowTextW
 *   - CloseHandle / GetLastError
 * koffi 只是 FFI 绑定层：这段代码能对别的进程做什么，完全由上面的函数原型决定 ——
 * 这里根本没有改动目标进程的能力，也没有任何 hook / 注入 / 远程线程手段。
 * 本服务只做两件事：识别正在播放的 BGM 文件名候选、识别当前章节名候选。
 *
 * 为什么用 koffi 而不是自写 N-API 插件（native/galmem 已在本轮删除）：
 * 自写 .node 必须本机有 MSVC（cl.exe）才能编译，编译不了功能就等于不存在；
 * koffi 自带预编译二进制，装完即用，不需要任何工具链。
 *
 * 本文件刻意**不 import electron 或主进程其它模块**：
 * 1) scripts/test-galmem.js 可以在纯 node 下直接加载它做只读扫描验证；
 * 2) 以后想复用它的人不必被 Electron 绑住。日志由调用方（services/galgameMem）负责。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

// ---------------- 加载 koffi（失败必须优雅降级，绝不能让主进程崩） ----------------

/** 只用到 koffi 的几个入口，自己描述一份最小结构，避免把 koffi 的类型当硬依赖 */
type KoffiType = unknown
type NativeFn = (...args: any[]) => any
interface KoffiLibrary {
  func(definition: string): NativeFn
}
interface KoffiNamespace {
  load(path: string): KoffiLibrary
  struct(name: string, def: Record<string, KoffiType>): KoffiType
  array(type: KoffiType, len: number): KoffiType
  proto(convention: string, name: string, result: string, args: string[]): KoffiType
  sizeof(type: KoffiType): number
}

/**
 * 取一个「能解析 node_modules」的 require —— 三种运行形态都要能用：
 * 1) electron-vite 打包后的主进程（CJS 输出）→ 直接用 CJS 的 require；
 * 2) 纯 node 直接跑本 .ts（Node 24 原生类型剥离）→ require 通常也在，否则用 __filename；
 * 3) 上面都没有（纯 ESM）→ 退化成「从工作目录解析」，只有开发/测试脚本会走到。
 */
function resolveRequire(): NodeRequire | null {
  try {
    if (typeof require === 'function') return require
  } catch {
    /* 纯 ESM 下 require 不存在，继续往下退 */
  }
  try {
    if (typeof __filename === 'string' && __filename) return createRequire(__filename)
  } catch {
    /* 同上 */
  }
  try {
    return createRequire(join(process.cwd(), 'index.js'))
  } catch {
    return null
  }
}

function errText(err: unknown): string {
  const m = (err as { message?: string } | null)?.message
  return m ? String(m) : String(err)
}

interface MemoryBasicInformation {
  BaseAddress: bigint | null
  AllocationBase: bigint | null
  AllocationProtect: number
  PartitionId: number
  RegionSize: number
  State: number
  Protect: number
  Type: number
}
interface ProcessEntry32W {
  dwSize: number
  cntUsage: number
  th32ProcessID: number
  th32DefaultHeapID: number
  th32ModuleID: number
  cntThreads: number
  th32ParentProcessID: number
  pcPriClassBase: number
  dwFlags: number
  szExeFile: string
}
interface ModuleEntry32W {
  dwSize: number
  th32ModuleID: number
  th32ProcessID: number
  GlblcntUsage: number
  ProccntUsage: number
  modBaseAddr: bigint | null
  modBaseSize: number
  hModule: bigint | null
  szModule: string
  szExePath: string
}

interface WinApi {
  /** 结构体大小由 koffi 按 ABI 算出来，不写死数字（写死容易和真实布局不一致） */
  mbiSize: number
  processEntrySize: number
  moduleEntrySize: number
  OpenProcess: (access: number, inherit: number, pid: number) => bigint | null
  CloseHandle: (handle: bigint | null) => number
  ReadProcessMemory: (h: bigint | null, addr: bigint, buf: Buffer, size: number, out: number[]) => number
  VirtualQueryEx: (h: bigint | null, addr: bigint, mbi: MemoryBasicInformation, size: number) => number
  CreateToolhelp32Snapshot: (flags: number, pid: number) => bigint | null
  Process32FirstW: (snap: bigint | null, entry: ProcessEntry32W) => number
  Process32NextW: (snap: bigint | null, entry: ProcessEntry32W) => number
  Module32FirstW: (snap: bigint | null, entry: ModuleEntry32W) => number
  Module32NextW: (snap: bigint | null, entry: ModuleEntry32W) => number
  EnumWindows: (cb: (hwnd: bigint, lParam: number) => boolean, lParam: number) => number
  GetWindowThreadProcessId: (hwnd: bigint, out: number[]) => number
  IsWindowVisible: (hwnd: bigint) => number
  GetWindowTextW: (hwnd: bigint, buf: Buffer, max: number) => number
  GetLastError: () => number
}

let api: WinApi | null = null
let initTried = false
let unavailableReasonText = '内存识别组件未就绪'

// 结构体在 koffi 里按名字全局登记，加前缀避免和别处撞车
const MBI_TYPE = 'SAKANA_MBI'
const PROCESSENTRY_TYPE = 'SAKANA_PROCESSENTRY32W'
const MODULEENTRY_TYPE = 'SAKANA_MODULEENTRY32W'
const ENUMWINDOWSPROC_TYPE = 'SAKANA_ENUMWINDOWSPROC'

/**
 * 本模块绑定过的全部系统函数 —— 这就是完整白名单，一个不多。
 * 导出出来是为了让 scripts/test-galmem.js 能断言「绑定的 API 集合没有变宽」，
 * 而不是只靠人去读代码确认。
 */
export const BOUND_API_NAMES: readonly string[] = Object.freeze([
  'OpenProcess',
  'CloseHandle',
  'ReadProcessMemory',
  'VirtualQueryEx',
  'CreateToolhelp32Snapshot',
  'Process32FirstW',
  'Process32NextW',
  'Module32FirstW',
  'Module32NextW',
  'EnumWindows',
  'GetWindowThreadProcessId',
  'IsWindowVisible',
  'GetWindowTextW',
  'GetLastError'
])

function newMbi(): MemoryBasicInformation {
  return {
    BaseAddress: 0n,
    AllocationBase: 0n,
    AllocationProtect: 0,
    PartitionId: 0,
    RegionSize: 0,
    State: 0,
    Protect: 0,
    Type: 0
  }
}

function newProcessEntry(dwSize: number): ProcessEntry32W {
  return {
    dwSize,
    cntUsage: 0,
    th32ProcessID: 0,
    th32DefaultHeapID: 0,
    th32ModuleID: 0,
    cntThreads: 0,
    th32ParentProcessID: 0,
    pcPriClassBase: 0,
    dwFlags: 0,
    szExeFile: ''
  }
}

function newModuleEntry(dwSize: number): ModuleEntry32W {
  return {
    dwSize,
    th32ModuleID: 0,
    th32ProcessID: 0,
    GlblcntUsage: 0,
    ProccntUsage: 0,
    modBaseAddr: 0n,
    modBaseSize: 0,
    hModule: 0n,
    szModule: '',
    szExePath: ''
  }
}

/**
 * 首次使用时才绑定 kernel32/user32 的函数原型。
 * 任何一步失败都只是「功能不可用 + 中文原因」，不抛异常、不崩主进程。
 */
function init(): WinApi | null {
  if (api) return api
  if (initTried) return null
  initTried = true

  if (process.platform !== 'win32') {
    unavailableReasonText = '内存识别组件未就绪：当前系统不是 Windows，无法只读扫描游戏内存'
    return null
  }
  const req = resolveRequire()
  if (!req) {
    unavailableReasonText = '内存识别组件未就绪：当前运行环境无法解析模块加载器'
    return null
  }

  let k: KoffiNamespace
  try {
    k = req('koffi') as KoffiNamespace
  } catch (err) {
    // 打包漏了 koffi 的原生文件时就会走到这里 → 界面要显示真实原因，而不是静默失败
    unavailableReasonText = `内存识别组件未就绪：koffi 加载失败（${errText(err)}）`
    return null
  }

  try {
    const k32 = k.load('kernel32.dll')
    const user32 = k.load('user32.dll')

    // —— 64 位安全：所有指针/句柄都是 koffi 的 void*（JS 侧是 bigint），
    //    绝不用 JS number 拼地址（超过 2^53 会丢精度、算错地址）。
    const MBI = k.struct(MBI_TYPE, {
      BaseAddress: 'void *',
      AllocationBase: 'void *',
      AllocationProtect: 'uint32',
      PartitionId: 'uint16',
      RegionSize: 'size_t',
      State: 'uint32',
      Protect: 'uint32',
      Type: 'uint32'
    })
    const mbiSize = k.sizeof(MBI)
    const PE = k.struct(PROCESSENTRY_TYPE, {
      dwSize: 'uint32',
      cntUsage: 'uint32',
      th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr_t',
      th32ModuleID: 'uint32',
      cntThreads: 'uint32',
      th32ParentProcessID: 'uint32',
      pcPriClassBase: 'int32',
      dwFlags: 'uint32',
      szExeFile: k.array('char16_t', 260)
    })
    const processEntrySize = k.sizeof(PE)
    const ME = k.struct(MODULEENTRY_TYPE, {
      dwSize: 'uint32',
      th32ModuleID: 'uint32',
      th32ProcessID: 'uint32',
      GlblcntUsage: 'uint32',
      ProccntUsage: 'uint32',
      modBaseAddr: 'void *',
      modBaseSize: 'uint32',
      hModule: 'void *',
      szModule: k.array('char16_t', 256),
      szExePath: k.array('char16_t', 260)
    })
    const moduleEntrySize = k.sizeof(ME)

    k.proto('__stdcall', ENUMWINDOWSPROC_TYPE, 'bool', ['void *', 'intptr_t'])

    api = {
      mbiSize,
      processEntrySize,
      moduleEntrySize,
      OpenProcess: k32.func(
        'void * __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)'
      ),
      CloseHandle: k32.func('int __stdcall CloseHandle(void *hObject)'),
      ReadProcessMemory: k32.func(
        'int __stdcall ReadProcessMemory(void *hProcess, void *lpBaseAddress, void *lpBuffer, size_t nSize, _Out_ size_t *lpNumberOfBytesRead)'
      ),
      VirtualQueryEx: k32.func(
        `size_t __stdcall VirtualQueryEx(void *hProcess, void *lpAddress, _Inout_ ${MBI_TYPE} *lpBuffer, size_t dwLength)`
      ),
      CreateToolhelp32Snapshot: k32.func(
        'void * __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)'
      ),
      Process32FirstW: k32.func(
        `int __stdcall Process32FirstW(void *hSnapshot, _Inout_ ${PROCESSENTRY_TYPE} *lppe)`
      ),
      Process32NextW: k32.func(`int __stdcall Process32NextW(void *hSnapshot, _Inout_ ${PROCESSENTRY_TYPE} *lppe)`),
      Module32FirstW: k32.func(`int __stdcall Module32FirstW(void *hSnapshot, _Inout_ ${MODULEENTRY_TYPE} *lpme)`),
      Module32NextW: k32.func(`int __stdcall Module32NextW(void *hSnapshot, _Inout_ ${MODULEENTRY_TYPE} *lpme)`),
      // EnumWindows / 窗口相关都在 user32，不在 kernel32
      EnumWindows: user32.func(`int __stdcall EnumWindows(${ENUMWINDOWSPROC_TYPE} *lpEnumFunc, intptr_t lParam)`),
      GetWindowThreadProcessId: user32.func(
        'uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32 *lpdwProcessId)'
      ),
      IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void *hWnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ char16_t *lpString, int nMaxCount)'),
      GetLastError: k32.func('uint32 __stdcall GetLastError()')
    }
    return api
  } catch (err) {
    unavailableReasonText = `内存识别组件未就绪：Windows API 绑定失败（${errText(err)}）`
    api = null
    return null
  }
}

/** 后端是否可用；不可用时 reason 是可以直接显示给用户的中文原因 */
export function winMemStatus(): { available: boolean; reason: string } {
  const ok = init() !== null
  return { available: ok, reason: ok ? '' : unavailableReasonText }
}

/** 仅供测试/诊断：重置可用性判断，下次调用会重新尝试加载 koffi */
export function winMemReset(): void {
  api = null
  initTried = false
}

// ---------------- 常量（沿用原 native 实现的上限，另补时间上限） ----------------

const PROCESS_VM_READ = 0x0010
const PROCESS_QUERY_INFORMATION = 0x0400

const TH32CS_SNAPPROCESS = 0x00000002
const TH32CS_SNAPMODULE = 0x00000008
const TH32CS_SNAPMODULE32 = 0x00000010

const MEM_COMMIT = 0x1000
const PAGE_NOACCESS = 0x01
const PAGE_READONLY = 0x02
const PAGE_READWRITE = 0x04
const PAGE_WRITECOPY = 0x08
const PAGE_EXECUTE_READ = 0x20
const PAGE_EXECUTE_READWRITE = 0x40
const PAGE_EXECUTE_WRITECOPY = 0x80
const PAGE_GUARD = 0x100

/** 单次扫描最多读多少字节（256MB，避免把主进程拖死） */
const MAX_TOTAL_READ = 256 * 1024 * 1024
/** 单个内存区域最多读多少字节（有些区域几 GB，闷头读完没意义） */
const MAX_REGION_READ = 32 * 1024 * 1024
/** 每次 ReadProcessMemory 的块大小 */
const CHUNK_SIZE = 2 * 1024 * 1024
/** 候选字符串最大长度（超长只取末尾，扩展名在末尾） */
const MAX_STRING_LEN = 256
/** 脚本候选数量上限（音频的额度见 AUDIO_CAP：按类分桶，BGM 不会被语音挤掉） */
const MAX_SCRIPTS = 150
/**
 * 单次扫描的时间上限（毫秒）。
 * 原 native 实现只有字节上限；但扫描跑在主进程线程上、默认 2 秒一次，
 * 只靠字节上限仍可能长时间卡住 UI，所以这里再加一道时间闸。
 */
const SCAN_TIME_BUDGET_MS = 1200
/** x64 用户态地址上界，超过它不会再有区域 */
const MAX_USER_ADDRESS = 0x7ffffffeffffn
/** 读失败时跳过一页继续（交换页 / 瞬时不可读） */
const PAGE_STEP = 4096n

const INVALID_HANDLE = 0xffffffffffffffffn

// ---------------- 进程 / 模块枚举（只读） ----------------

export interface MemProcess {
  pid: number
  name: string
}

export interface MemModule {
  name: string
  base: bigint
  size: number
}

/** 枚举进程（CreateToolhelp32Snapshot + Process32FirstW/NextW，只读） */
export function listProcesses(): MemProcess[] {
  const a = init()
  if (!a) return []
  const out: MemProcess[] = []
  let snap: bigint | null = null
  try {
    snap = a.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if (snap === null || snap === INVALID_HANDLE) return out
    const entry = newProcessEntry(a.processEntrySize)
    let ok = a.Process32FirstW(snap, entry)
    while (ok) {
      out.push({ pid: entry.th32ProcessID >>> 0, name: entry.szExeFile || '' })
      ok = a.Process32NextW(snap, entry)
    }
  } catch {
    /* 枚举失败就当没有进程，绝不抛给调用方 */
  } finally {
    closeQuietly(a, snap)
  }
  return out
}

/** 枚举某个进程已加载的模块（引擎识别用；只读） */
export function listModules(pid: number): MemModule[] {
  const a = init()
  if (!a || !Number.isFinite(pid) || pid <= 0) return []
  const out: MemModule[] = []
  let snap: bigint | null = null
  try {
    snap = a.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if (snap === null || snap === INVALID_HANDLE) return out
    const entry = newModuleEntry(a.moduleEntrySize)
    let ok = a.Module32FirstW(snap, entry)
    while (ok) {
      out.push({
        name: entry.szModule || '',
        base: entry.modBaseAddr ?? 0n,
        size: entry.modBaseSize >>> 0
      })
      ok = a.Module32NextW(snap, entry)
    }
  } catch {
    /* 同上：模块枚举失败不影响 BGM/章节识别 */
  } finally {
    closeQuietly(a, snap)
  }
  return out
}

/** 句柄一定关掉；关闭失败也不抛（幂等） */
function closeQuietly(a: WinApi, handle: bigint | null): void {
  if (handle === null || handle === INVALID_HANDLE) return
  try {
    a.CloseHandle(handle)
  } catch {
    /* 句柄已失效也无所谓 */
  }
}

// ---------------- 窗口标题（只读，章节名的主来源） ----------------

/**
 * EnumWindows 的回调只做一件事：把 hwnd 收起来。
 *
 * 为什么不在这里读标题：koffi 在 JS 回调上下文里做稍复杂的事（比如解码结构体/字符串）
 * 会让进程直接访问违例崩溃（本机实测），所以回调保持「只 push 一个 bigint」这种最小动作，
 * 真正的读取与解码全部放到回调返回之后。
 */
let enumHwnds: bigint[] = []
const enumCollector = (hwnd: bigint): boolean => {
  enumHwnds.push(hwnd)
  return true // 继续枚举
}

/** 取该进程「最长的可见窗口标题」——很多 galgame 把章节名写在这里 */
function readWindowTitle(a: WinApi, pid: number): string {
  try {
    enumHwnds = []
    a.EnumWindows(enumCollector, 0)
    const hwnds = enumHwnds
    enumHwnds = []
    let best = ''
    const buf = Buffer.alloc(512 * 2) // 512 个 UTF-16 码元
    const pidOut = [0]
    for (const hwnd of hwnds) {
      pidOut[0] = 0
      a.GetWindowThreadProcessId(hwnd, pidOut)
      if ((pidOut[0] >>> 0) !== (pid >>> 0)) continue
      if (!a.IsWindowVisible(hwnd)) continue
      const len = a.GetWindowTextW(hwnd, buf, 511)
      if (len <= 0) continue
      const s = buf.toString('utf16le', 0, Math.min(len, 511) * 2)
      if (s.length > best.length) best = s
    }
    return best
  } catch {
    return ''
  }
}

// ---------------- 只读内存扫描 ----------------

export interface MemScanStats {
  regions: number
  readBytes: number
  elapsedMs: number
  /** 是否因为字节/时间上限提前收工（结果可能不全，但不影响「新出现的名字」判定） */
  truncated: boolean
}

export interface MemScanResult {
  ok: boolean
  /** 空串 = 成功；否则是错误码，由服务层翻成中文 */
  error: string
  windowTitle: string
  /**
   * 全部音频候选，已按「像 BGM 的程度」排序：bgm 类 → 其他 → 音效 → 语音。
   * 真机实测（Siglus 游戏的 hamidashi.exe）：候选里语音文件名有 3000+ 条、
   * BGM 只有几十条，如果只按扫描顺序取前 N 条，BGM 会被语音彻底挤掉（旧实现的真实故障）。
   */
  audio: string[]
  /**
   * 只含「像音乐」的两类（bgm + 其他，已去掉语音/音效）。
   * 服务层用它做候选展示：语音文件每句对话都会新加载，记进来只会把真正的 BGM 淹没。
   */
  audioMusic: string[]
  /**
   * 只含**明确**是 BGM 的那一类（名字里带 bgm/music/ost/theme 等）。
   * 服务层用它判断「刚加载」：真机实测内存里全是截断出来的路径碎片
   * （`sysse/fem_shi_00279.ogg` 这种连 `vo` 段都掉了的语音碎片会落进"其他"类），
   * 只有明确是 BGM 的名字才够格说「游戏刚加载了这首歌」。
   */
  audioBgm: string[]
  /**
   * 每个候选名的「出现签名」：出现次数 + 所有出现地址的异或。
   *
   * 为什么需要：只读内存里没有现成的「当前播放曲目」字段可读，但真机实测发现 ——
   * 游戏播放某首 BGM 时，会把这个代号**再引用/复制一份**到音频管理器里
   * （Siglus 的 hamidashi 实测：播放标题曲时 `bgm\bgm99.ogg` 出现次数 1→2，
   * 并且多出一份正斜杠写法 `bgm/bgm99.ogg`）。所以「签名相对上一轮发生变化」
   * 就是"这首刚被加载/切换"的可观测信号，比重启前那套"只记第一次见到"更能捕捉反复切歌。
   */
  audioSig: Record<string, { n: number; x: string }>
  scripts: string[]
  stats: MemScanStats
}

/** 「出现签名」最多记多少个不同名字（防止内存里噪声把表撑爆） */
const AUDIO_SIG_MAX = 4000

const AUDIO_EXTS = ['.ogg', '.mp3', '.wav', '.opus', '.m4a', '.flac', '.aac', '.adx', '.hca']
const SCRIPT_EXTS = ['.ks', '.txt', '.snb', '.ws2', '.scn', '.csv', '.lua']

/**
 * 音频候选的分类与各自额度。
 *
 * 为什么要分桶：真机上语音名（`sound\vo\...`）数量是 BGM 的几十倍，共用一份额度时
 * BGM 一条都进不来 —— 这正是「BGM 识别没生效」的直接原因。分桶后每类各占自己的额度，
 * BGM 永不被语音挤掉。
 *
 * 额度取值：语音/音效的额度给得宽（只是候选列表里的诊断信息，界面不用它们，代价只是几十 KB），
 * 因为额度太紧时"先扫到哪些"会随机丢掉一部分语音名，让测试和排查结果不稳定；
 * 真正影响界面的只有 bgm + other，它们各自有独立额度。
 */
type AudioClass = 'bgm' | 'voice' | 'se' | 'other'

const AUDIO_CAP: Record<AudioClass, number> = { bgm: 400, other: 200, se: 200, voice: 1000 }

// 判定顺序必须是 voice → bgm → se：`sound\sysse\vo\x.ogg` 既是语音目录又是音效目录，算语音更准
const RE_AUDIO_VOICE = /[\\/]vo[\\/]|[\\/]sysvo[\\/]|voice|_vo_/i
const RE_AUDIO_BGM = /bgm|music|bkm|\bost\b|theme|opening|ending/i
const RE_AUDIO_SE = /[\\/]se[\\/]|[\\/]sysse[\\/]|sound_?effect|[\\/]snd[\\/]/i

function classifyAudio(s: string): AudioClass {
  if (RE_AUDIO_VOICE.test(s)) return 'voice'
  if (RE_AUDIO_BGM.test(s)) return 'bgm'
  if (RE_AUDIO_SE.test(s)) return 'se'
  return 'other'
}

/** 命中扩展名时返回命中的扩展名。
 * 额外要求「扩展名前面至少还有一个字符」：否则内存里到处散落的 ".ogg" 这类碎片会把
 * 候选额度浪费掉（扩展名碎片到处都是，会挤掉真正的文件名）。
 */
function matchExt(s: string, exts: string[]): string | null {
  const lower = s.toLowerCase()
  for (const e of exts) {
    if (lower.endsWith(e) && s.length > e.length) return e
  }
  return null
}

/** 去掉 PAGE_GUARD/NOCACHE 等修饰位后，判断这块内存是否「可读」 */
function isReadableProtect(protect: number): boolean {
  if (protect & PAGE_GUARD) return false // 保护页读它必失败，直接跳过
  switch (protect & 0xff) {
    case PAGE_READONLY:
    case PAGE_READWRITE:
    case PAGE_WRITECOPY:
    case PAGE_EXECUTE_READ:
    case PAGE_EXECUTE_READWRITE:
    case PAGE_EXECUTE_WRITECOPY:
      return true
    case PAGE_NOACCESS:
    default:
      return false
  }
}

/** 一个候选串按扩展名归桶，并累计它的「出现签名」。两遍扫描（ASCII / UTF-16）共用同一套规则。 */
function addCandidate(
  s: string,
  at: bigint,
  audio: Record<AudioClass, Set<string>>,
  scripts: Set<string>,
  sig: Map<string, { n: number; x: bigint }>
): void {
  if (s.includes('://')) return
  if (matchExt(s, AUDIO_EXTS)) {
    const cls = classifyAudio(s)
    if (audio[cls].size < AUDIO_CAP[cls]) audio[cls].add(s)
    // 出现次数 + 地址异或：服务层用它判断"这首刚被引用"（见 MemScanResult.audioSig 的说明）
    const key = s.toLowerCase()
    const cur = sig.get(key)
    if (cur) {
      cur.n++
      cur.x ^= at
    } else if (sig.size < AUDIO_SIG_MAX) {
      sig.set(key, { n: 1, x: at })
    }
  } else if (matchExt(s, SCRIPT_EXTS)) {
    if (scripts.size < MAX_SCRIPTS) scripts.add(s)
  }
}

/**
 * 从一段内存里挑出候选：先扫单字节 ASCII 串，需要时再扫 UTF-16LE 宽串。
 *
 * 为什么要扫两种编码：不同引擎存文件名的编码不一样 —— 真机实测
 *   · Siglus 的 hamidashi.exe：BGM 名是 ASCII（`sound\bgm\bgm01_a.ogg`）；
 *   · KiriKiri 的 少女领域.exe：BGM 名全是 **UTF-16**（`bgm/bgm01.ogg`…`bgm91_ed.ogg`），
 *     只扫 ASCII 时一条都拿不到（这就是该类游戏"识别不到 BGM"的原因）。
 * 宽串那一遍是在**同一块已读进来的内存**上再走一遍，不额外 ReadProcessMemory，
 * 所以字节预算/时间预算不变，代价只是 CPU（实测约慢一倍）。
 *
 * 所以宽串那一遍是**按需**做的（wantUtf16）：本轮到目前为止一条 BGM 类候选都还没扫到时才做。
 * 这样 ASCII 引擎的游戏在扫到第一个 BGM 名之后就不再付这份 CPU，
 * 而 UTF-16 引擎的游戏（永远扫不到 ASCII BGM 名）会一直做，保证能扫到。
 *
 * 规则与原 ASCII 实现一致：长度 ≥3、超长只取末尾 256 字符、跳过带 "://" 的 URL。
 */
function scanBuffer(
  buf: Buffer,
  len: number,
  base: bigint,
  audio: Record<AudioClass, Set<string>>,
  scripts: Set<string>,
  sig: Map<string, { n: number; x: bigint }>,
  wantUtf16: boolean
): void {
  // ---- 第一遍：单字节 ASCII ----
  let i = 0
  while (i < len) {
    const c = buf[i]
    if (c < 0x20 || c > 0x7e) {
      i++
      continue
    }
    const start = i
    while (i < len) {
      const b = buf[i]
      if (b < 0x20 || b > 0x7e) break
      i++
    }
    const runLen = i - start
    if (runLen < 3) continue
    const tailStart = runLen > MAX_STRING_LEN ? i - MAX_STRING_LEN : start
    addCandidate(buf.toString('latin1', tailStart, i), base + BigInt(tailStart), audio, scripts, sig)
  }

  if (!wantUtf16) return

  // ---- 第二遍：UTF-16LE 宽串（低字节是可打印 ASCII、高字节是 0x00） ----
  i = 0
  while (i + 1 < len) {
    const c = buf[i]
    if (c >= 0x20 && c <= 0x7e && buf[i + 1] === 0) {
      const start = i
      while (i + 1 < len && buf[i] >= 0x20 && buf[i] <= 0x7e && buf[i + 1] === 0) i += 2
      const charLen = (i - start) / 2
      if (charLen < 3) continue
      // 与 ASCII 一样取末尾：i 与 start 同奇偶，所以从这个偏移解码仍然是字符边界
      const tailStart = charLen > MAX_STRING_LEN ? i - MAX_STRING_LEN * 2 : start
      addCandidate(buf.toString('utf16le', tailStart, i), base + BigInt(tailStart), audio, scripts, sig)
    } else {
      i++
    }
  }
}

/**
 * 把分桶结果摊平成给服务层的两个数组。
 * 桶内按名字排序：扫描覆盖范围每轮会因时间闸略有抖动，排序后同一批候选的先后顺序稳定，
 * 面板不会每 2 秒跳一次。
 */
function flattenAudio(audio: Record<AudioClass, Set<string>>): {
  audio: string[]
  audioMusic: string[]
  audioBgm: string[]
} {
  const pick = (cls: AudioClass): string[] => [...audio[cls]].sort((x, y) => x.localeCompare(y))
  const bgm = pick('bgm')
  const other = pick('other')
  return { audio: [...bgm, ...other, ...pick('se'), ...pick('voice')], audioMusic: [...bgm, ...other], audioBgm: bgm }
}

function failResult(error: string, started: number): MemScanResult {
  return {
    ok: false,
    error,
    windowTitle: '',
    audio: [],
    audioMusic: [],
    audioBgm: [],
    audioSig: {},
    scripts: [],
    stats: { regions: 0, readBytes: 0, elapsedMs: Date.now() - started, truncated: false }
  }
}

/**
 * 只读扫描一个进程：窗口标题 + 音频文件名候选 + 脚本文件名候选。
 * 不抛异常；权限不足 / 进程不存在都以错误码返回，由服务层翻成中文提示。
 */
export function scanProcessMemory(pid: number): MemScanResult {
  const started = Date.now()
  const a = init()
  if (!a) return failResult('NOT_AVAILABLE', started)
  if (!Number.isFinite(pid) || pid <= 0) return failResult('INVALID_PID', started)

  // ★ 只读：只申请「查询信息 + 读内存」两种权限，不申请任何写权限
  const handle = a.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid)
  if (handle === null || handle === 0n) {
    const code = a.GetLastError()
    if (code === 5) return failResult('ACCESS_DENIED', started)
    if (code === 87 || code === 1168) return failResult('NOT_FOUND', started)
    return failResult(`OPEN_FAIL_${code}`, started)
  }

  const audio: Record<AudioClass, Set<string>> = { bgm: new Set(), voice: new Set(), se: new Set(), other: new Set() }
  const scripts = new Set<string>()
  /** 候选名 → 出现次数 / 地址异或（见 MemScanResult.audioSig） */
  const sig = new Map<string, { n: number; x: bigint }>()
  let regions = 0
  let readBytes = 0
  let truncated = false

  try {
    const windowTitle = readWindowTitle(a, pid)

    // 复用一个 mbi 对象与一个读缓冲，避免每个区域都重新分配
    const mbi = newMbi()
    const chunk = Buffer.allocUnsafe(CHUNK_SIZE)
    const gotOut = [0]
    let addr = 0n

    while (addr < MAX_USER_ADDRESS) {
      if (readBytes >= MAX_TOTAL_READ || Date.now() - started > SCAN_TIME_BUDGET_MS) {
        truncated = true
        break
      }
      if (a.VirtualQueryEx(handle, addr, mbi, a.mbiSize) === 0) break // 走到头（或查不动了）
      const base = mbi.BaseAddress ?? 0n
      const regionSize = BigInt(Math.max(0, Math.floor(mbi.RegionSize)))
      if (regionSize <= 0n) break
      const next = base + regionSize
      if (next <= addr) break // 区域不前进就停，防死循环

      // 跳过 MEM_FREE / MEM_RESERVE，跳过不可读保护属性
      if (mbi.State === MEM_COMMIT && isReadableProtect(mbi.Protect)) {
        regions++
        const limit = regionSize > BigInt(MAX_REGION_READ) ? BigInt(MAX_REGION_READ) : regionSize
        let off = 0n
        while (off < limit) {
          if (readBytes >= MAX_TOTAL_READ || Date.now() - started > SCAN_TIME_BUDGET_MS) {
            truncated = true
            break
          }
          const remain = limit - off
          const want = Number(remain > BigInt(CHUNK_SIZE) ? BigInt(CHUNK_SIZE) : remain)
          gotOut[0] = 0
          const ok = a.ReadProcessMemory(handle, base + off, chunk, want, gotOut)
          const got = ok ? Math.min(gotOut[0], want) : 0
          if (got > 0) {
            readBytes += got
            // 还没扫到任何 BGM 类候选时才做 UTF-16 那一遍（见 scanBuffer 的说明）
            scanBuffer(chunk, got, base + off, audio, scripts, sig, audio.bgm.size === 0)
            off += BigInt(got)
          } else {
            // 读失败（交换页 / 瞬时不可读 / 区域尾部）：跳一页继续，不抛异常
            off += PAGE_STEP
          }
        }
      }
      addr = next
    }

    const flat = flattenAudio(audio)
    return {
      ok: true,
      error: '',
      windowTitle,
      audio: flat.audio,
      audioMusic: flat.audioMusic,
      audioBgm: flat.audioBgm,
      audioSig: Object.fromEntries([...sig].map(([k, v]) => [k, { n: v.n, x: v.x.toString(16) }])),
      scripts: [...scripts],
      stats: { regions, readBytes, elapsedMs: Date.now() - started, truncated }
    }
  } catch (err) {
    return {
      ok: false,
      error: `SCAN_FAIL_${errText(err)}`,
      windowTitle: '',
      audio: [],
      audioMusic: [],
      audioBgm: [],
    audioSig: {},
      scripts: [],
      stats: { regions, readBytes, elapsedMs: Date.now() - started, truncated }
    }
  } finally {
    // 句柄一定关（哪怕上面抛了）
    closeQuietly(a, handle)
  }
}

// ---------------- 只读原语（供测试 / 诊断直接用） ----------------

/**
 * 打开一个只读句柄。调用方**必须**自己调 closeReadHandle。
 * 只申请 PROCESS_VM_READ | PROCESS_QUERY_INFORMATION。
 */
export function openReadHandle(pid: number): bigint | null {
  const a = init()
  if (!a || !Number.isFinite(pid) || pid <= 0) return null
  const h = a.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid)
  return h === null || h === 0n ? null : h
}

/** 关掉 openReadHandle 拿到的句柄（失败不抛） */
export function closeReadHandle(handle: bigint | null): void {
  const a = init()
  if (a) closeQuietly(a, handle)
}

/** 最近一次系统错误码（给错误提示用） */
export function lastErrorCode(): number {
  const a = init()
  return a ? a.GetLastError() : 0
}

/**
 * 只读读一段内存。返回真正读到的字节（0 字节 = 失败或不可读，返回 null）。
 * 一定同时检查返回值与 lpNumberOfBytesRead；失败就是失败，不猜。
 */
export function readBytes(handle: bigint | null, address: bigint, size: number): Buffer | null {
  const a = init()
  if (!a || handle === null || !Number.isFinite(size) || size <= 0) return null
  const buf = Buffer.allocUnsafe(size)
  const out = [0]
  try {
    const ok = a.ReadProcessMemory(handle, address, buf, size, out)
    const got = ok ? Math.min(out[0], size) : 0
    return got > 0 ? buf.subarray(0, got) : null
  } catch {
    return null
  }
}

/** 只读列出一段地址空间的分区（VirtualQueryEx），用于测试与诊断 */
export function queryRegions(
  pid: number,
  max = 4096
): { base: bigint; size: number; state: number; protect: number }[] {
  const a = init()
  const out: { base: bigint; size: number; state: number; protect: number }[] = []
  const handle = a ? openReadHandle(pid) : null
  if (!a || handle === null) return out
  try {
    const mbi = newMbi()
    let addr = 0n
    while (addr < MAX_USER_ADDRESS && out.length < max) {
      if (a.VirtualQueryEx(handle, addr, mbi, a.mbiSize) === 0) break
      const base = mbi.BaseAddress ?? 0n
      const size = Math.max(0, Math.floor(mbi.RegionSize))
      if (size <= 0) break
      const next = base + BigInt(size)
      if (next <= addr) break
      out.push({ base, size, state: mbi.State, protect: mbi.Protect })
      addr = next
    }
  } catch {
    /* 忽略 */
  } finally {
    closeReadHandle(handle)
  }
  return out
}
