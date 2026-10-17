// dsh-pc-control 宿主入口（函数型插件）：让 LLM 操控 Windows 电脑。
//
// 工具面（5 个，OCR 方案遵循项目约定：本地 Windows 内置 OCR，不用视觉模型）：
// - pc_screenshot：截屏（虚拟屏/指定区域）+ 可选 WinRT OCR（行文本 + 词级坐标，屏幕绝对坐标）
// - pc_click    ：鼠标单击/双击/右键
// - pc_type     ：输入文本（非 ASCII 走剪贴板粘贴——中文兼容性约定；ASCII 直发 UNICODE 事件）
// - pc_key      ：组合键（SendInput VK 序列；高危键见 actions.ts HIGH_RISK_KEYS）
// - pc_scroll   ：滚轮（垂直/水平）
//
// 安全模型（项目分级权限约定）：
// - 读类（pc_screenshot）自动放行
// - 写类（click/type/key/scroll）默认每次 ask 确认（config.confirmActions，可关）
// - 高危组合键（Alt+F4、Ctrl+Alt+Del、Win+D/M/L、Ctrl+Shift+Esc）即使关确认也强制 ask
// - FailSafe 保命：任一写动作执行前，鼠标若在屏幕左上角 failSafePx 方格内，PS 脚本直接中止
//
// 实现形态：Node 侧 spawn powershell.exe（系统内置，零依赖），参数走 stdin 端临时 JSON 文件
// （UTF-8 BOM，规避命令行转义/中文编码坑），stdout 单行 JSON 回传。
// helper 由 vendor.ts 内联（npm dsh 包滞后/受限，同 dsh-emotion/dsh-reboot）。

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sz from '@deepseek-ai/schemastery'
import { defineTool } from './vendor.js'
import { PS_BALL_SCRIPT, PS_CHAT_SCRIPT, PS_INPUT_SCRIPT, PS_SCREEN_SCRIPT } from './scripts.js'
import {
  TOOL_CLASS, describeAction, isHighRisk, normalizeKeyCombo,
} from './actions.js'

export const name = 'pc-control'
export const inject = ['tools']
export const removable = true

/** 插件配置（cordis.patch.yml insert.config；缺省字段由宿主按 Config schema 填默认值） */
export interface PcControlConfig {
  /** 写类操作（点击/输入/按键/滚动）是否每次向用户确认，默认 true；高危键不受此项影响 */
  confirmActions?: boolean
  /** FailSafe 保护区边长（像素）：鼠标进入屏幕左上角该方格即中止操作，默认 10 */
  failSafePx?: number
  /** OCR 识别语言（BCP-47），默认 zh-Hans-CN；系统未装该语言包时回退用户语言 */
  ocrLang?: string
  /** 单次 OCR 返回的最大行数，默认 300（防撑爆上下文；配合 region 局部截屏使用） */
  maxOcrLines?: number
  /** Trae 风格悬浮球：宿主有 webServer 时自动显示（点击打开 AI 对话页），默认 true */
  ballEnabled?: boolean
  /** 悬浮球直径（像素，28~160），默认 64 */
  ballSize?: number
  /** 悬浮球主题色（#RRGGBB），默认 #0A84FF */
  ballColor?: string
}

export const Config: sz<PcControlConfig> = sz.object({
  confirmActions: sz.boolean().default(true),
  failSafePx: sz.number().default(10),
  ocrLang: sz.string().default('zh-Hans-CN'),
  maxOcrLines: sz.number().default(300),
  ballEnabled: sz.boolean().default(true),
  ballSize: sz.number().default(64),
  ballColor: sz.string().default('#0A84FF'),
})

// ---- 宿主服务的最小结构类型（不依赖 cordis 类型包，保持零宿主依赖）----
interface HostCtx {
  on(event: string, listener: (...args: any[]) => unknown): void
  effect(fn: () => unknown, name?: string): void
  get(service: string): unknown
  inject?(deps: string[], cb: (svcCtx: any) => void): void
  tools: { register(tool: unknown): unknown }
}

// ---- PowerShell runner ----
const PS_DIR = join(tmpdir(), 'dsh-pc-control')

/** 写 stdin JSON 参数文件：UTF-8 BOM 前缀（PS Get-Content -Encoding UTF8 依赖 BOM 判码） */
function writeJsonArgs(args: Record<string, unknown>): string {
  mkdirSync(PS_DIR, { recursive: true })
  const path = join(PS_DIR, `args-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`)
  const bom = Buffer.from([0xef, 0xbb, 0xbf])
  writeFileSync(path, Buffer.concat([bom, Buffer.from(JSON.stringify(args), 'utf8')]))
  return path
}

interface PsResult { ok: boolean; error?: string; note?: string; [k: string]: unknown }

/** 运行 PowerShell 脚本：stdout 最后一行必须是 JSON 信封（args 为 stdin 参数文件路径） */
function runPs(scriptPath: string, argPath: string, timeoutMs: number): Promise<PsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-argsFile', argPath],
      { stdio: 'pipe', windowsHide: true },
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* noop */ }
      reject(new Error(`PowerShell 执行超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`PowerShell 启动失败：${e.message}`)) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      try {
        resolve(JSON.parse(line) as PsResult)
      } catch {
        reject(new Error(`PowerShell 输出无法解析（exit=${String(code)}）：${(err || out || '(空)').slice(0, 300)}`))
      }
    })
  })
}

export function apply(ctx: HostCtx, config: PcControlConfig = {}): void {
  const confirmActions = config.confirmActions !== false
  const failSafePx = Math.max(1, config.failSafePx ?? 10)
  const ocrLang = config.ocrLang ?? 'zh-Hans-CN'
  const maxOcrLines = Math.max(10, config.maxOcrLines ?? 300)

  // 脚本落盘（每次插件加载写一次；内容为常量）。
  // 必须 UTF-8 BOM：PS5.1 -File 读无 BOM 文件按 ANSI/GBK 解码，脚本内中文会把字符串撑破。
  const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
  const screenScriptPath = join(PS_DIR, 'pc-screen.ps1')
  const inputScriptPath = join(PS_DIR, 'pc-input.ps1')
  const ballScriptPath = join(PS_DIR, 'pc-ball.ps1')
  const chatScriptPath = join(PS_DIR, 'pc-chat.ps1')
  try {
    mkdirSync(PS_DIR, { recursive: true })
    writeFileSync(screenScriptPath, Buffer.concat([UTF8_BOM, Buffer.from(PS_SCREEN_SCRIPT, 'utf8')]))
    writeFileSync(inputScriptPath, Buffer.concat([UTF8_BOM, Buffer.from(PS_INPUT_SCRIPT, 'utf8')]))
    writeFileSync(ballScriptPath, Buffer.concat([UTF8_BOM, Buffer.from(PS_BALL_SCRIPT, 'utf8')]))
    writeFileSync(chatScriptPath, Buffer.concat([UTF8_BOM, Buffer.from(PS_CHAT_SCRIPT, 'utf8')]))
  } catch (e) {
    console.log('[pc-control] script write failed:', (e as Error)?.message)
  }

  /** 统一执行：runPs + failsafe/错误语义归一 */
  const execAction = async (script: string, args: Record<string, unknown>, timeoutMs: number): Promise<PsResult> => {
    const argPath = writeJsonArgs(args)
    const r = await runPs(script, argPath, timeoutMs)
    if (!r.ok && r.error === 'failsafe') {
      return { ok: false, failsafe: true, note: '鼠标位于屏幕左上角保护区（FailSafe），操作已中止。' }
    }
    return r
  }

  // ①' Trae 风格悬浮球：独立 PS WinForms 分离进程（TopMost 圆球，点击弹出独立悬浮对话窗）。
  // 生命周期与宿主对齐：dispose 时杀球（dsh-reboot 强杀进程树也会连带）；宿主重启后插件重载自动再起。
  // 悬浮对话窗：点球 → pc-chat.ps1（WinForms 无边框 + WebView2 承载对话页，非浏览器窗口）。
  // WebView2 托管三件套 vendor 在插件内（Evergreen Runtime 是 Win11 系统组件），路径透传给球 → 窗。
  const vendorDir = fileURLToPath(new URL('../vendor/webview2', import.meta.url))
  const ballPidFile = join(PS_DIR, 'ball-pid.json')
  const chatPidFile = join(PS_DIR, 'chat-pid.json')
  const ballPosFile = join(PS_DIR, 'ball-pos.json')
  let ballUrl: string | undefined
  let ballRunning = false

  /** 杀掉现存悬浮球进程 + 常驻对话窗（幂等；spawnSync 确保杀完再返回，防 show 竞态双球）。
   *  pid 文件由球/窗进程自写（PS Set-Content -Encoding UTF8 带 BOM），解析前必须剥 BOM。
   *  对话窗常驻（关闭=隐藏），球被 taskkill 强杀时无法自清理，必须在此连带杀 */
  const killByPidFile = (file: string): void => {
    try {
      const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      const pid = Number((JSON.parse(raw) as { pid?: unknown }).pid)
      if (Number.isInteger(pid) && pid > 0) {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 })
      }
    } catch { /* 无 pid 文件 = 无进程 */ }
  }
  const killBall = (): void => {
    killByPidFile(ballPidFile)
    killByPidFile(chatPidFile)
  }

  /**
   * 拉起悬浮球进程（先杀旧球防双开）。
   * 实测坑：node 直接 detached spawn powershell.exe 会让 PS 控制台主机秒退（exit 0，
   * 脚本根本不执行）——DETACHED_PROCESS 下 PS 无法初始化。故走「中继」：spawn 一个
   * 立即退出的 PS，由它 Start-Process -WindowStyle Hidden 拉起真正的球进程；
   * 球进程启动后自报 pid 写入 ball-pid.json（宿主拿不到间接子进程的 pid）。
   */
  const spawnBall = (): boolean => {
    if (!ballUrl) return false
    killBall()
    try {
      const argPath = writeJsonArgs({
        Url: ballUrl,
        Size: Math.min(160, Math.max(28, config.ballSize ?? 64)),
        Color: /^#[0-9a-fA-F]{6}$/.test(config.ballColor ?? '') ? config.ballColor : '#0A84FF',
        PosFile: ballPosFile,
        PidFile: ballPidFile,
        DllDir: vendorDir,
      })
      const relay = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          `Start-Process -WindowStyle Hidden -FilePath powershell.exe -ArgumentList `
          + `'-NoProfile','-ExecutionPolicy','Bypass','-File','${ballScriptPath}','-argsFile','${argPath}'`],
        { stdio: 'ignore', windowsHide: true },
      )
      relay.unref()
      console.log(`[pc-control] floating ball relay spawned (relay pid=${String(relay.pid)})`)
      return (relay.pid ?? 0) > 0
    } catch (e) {
      console.log('[pc-control] ball spawn failed:', (e as Error)?.message)
      return false
    }
  }

  // 宿主有 webServer + connection（web/desktop）→ 自动起球；headless 纯 CLI 无此服务则跳过。
  // 回调收到的是上下文，服务用 svcCtx.get(name) 取（同 dsh-emotion mountUiApi 实测模式）。
  // 实测坑：插件侧拿到的 webServer 是白名单门面，只有 port/host/register 等成员，
  // 没有 getOrigin（getOrigin 仅 web-app 内部可用）——origin 用 port getter 自拼。
  if (config.ballEnabled !== false && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer', 'connection'], (svcCtx: { get(name: string): unknown }) => {
        try {
          const webServer = svcCtx.get('webServer') as { getOrigin?: () => string; port?: number; protocol?: string } | undefined
          const connection = svcCtx.get('connection') as { authenticatedUrl?: (base: string) => string } | undefined
          if (!webServer?.port) return
          const origin = `${webServer.protocol ?? 'http:'}//127.0.0.1:${webServer.port}`
          ballUrl = typeof connection?.authenticatedUrl === 'function' ? connection.authenticatedUrl(origin) : origin
          console.log(`[pc-control] floating ball url ready (auth=${String(ballUrl.includes('token'))})`)
          if (spawnBall()) ballRunning = true
        } catch (e) {
          console.log('[pc-control] ball auto-start skipped:', (e as Error)?.message)
        }
      })
    } catch (e) { console.log('[pc-control] ball inject failed:', (e as Error)?.message) }
  }

  // 宿主 dispose（退出/卸载/重载）→ 球一起退
  try {
    ctx.effect(() => () => {
      killBall()
      ballRunning = false
    }, 'pc-control.ball.dispose')
  } catch { /* dispose 挂不上时球随宿主进程树结束 */ }

  // ① LLM 工具 ×6
  try {
    ctx.effect(function* () {
      yield ctx.tools.register(defineTool({
        name: 'pc_screenshot',
        description: '截取 Windows 屏幕（全部显示器虚拟屏，或指定区域），可选 OCR 识别屏幕文字。'
          + 'OCR 返回行文本与每个词的屏幕绝对坐标（x,y 左上角，w,h 尺寸）——用词坐标可定位要点击的按钮/链接，'
          + '配合 pc_click 操控。截屏图片另存本地（返回 path）。这是本插件的"眼睛"：操控前先截屏看屏幕。',
        parameters: {
          ocr: { type: 'boolean', description: '是否 OCR 识别文字（默认 true）' },
          region: { type: 'json', description: '可选局部区域 {x,y,w,h}（屏幕绝对坐标），只截该区域；全屏时不传' },
        },
        output: { type: 'json' },
        execute: async (args) => {
          const shotPath = join(PS_DIR, `screen-${Date.now()}.png`)
          const payload: Record<string, unknown> = {
            OutPath: shotPath,
            Ocr: args.ocr !== false,
            Lang: ocrLang,
            FailSafePx: failSafePx,
            MaxLines: maxOcrLines,
          }
          if (args.region && typeof args.region === 'object') {
            const rg = args.region as Record<string, unknown>
            payload.Region = { x: Number(rg.x) || 0, y: Number(rg.y) || 0, w: Number(rg.w) || 100, h: Number(rg.h) || 100 }
          }
          const r = await execAction(screenScriptPath, payload, 20000)
          if (!r.ok) return r
          const ocr = r.ocr as { lines?: Array<Record<string, unknown>> } | undefined
          return {
            ok: true,
            path: r.path, width: r.width, height: r.height, offsetX: r.offsetX, offsetY: r.offsetY,
            ocrLang: ocr ? (r.ocr as { lang?: string }).lang : undefined,
            lines: ocr?.lines ?? undefined,
            hint: '点击文字目标：取该词的 x+w/2, y+h/2 传给 pc_click',
          }
        },
      }))

      yield ctx.tools.register(defineTool({
        name: 'pc_click',
        description: '移动鼠标到屏幕绝对坐标并点击。坐标来自 pc_screenshot 的 OCR 词坐标（中心 = x+w/2, y+h/2）。'
          + '操控前请先截屏确认目标位置。',
        parameters: {
          x: { type: 'number', required: true, description: '屏幕绝对 X 坐标' },
          y: { type: 'number', required: true, description: '屏幕绝对 Y 坐标' },
          button: { type: 'string', description: 'left（默认）/ right' },
          double: { type: 'boolean', description: '是否双击（默认 false）' },
        },
        output: { type: 'json' },
        execute: async (args) => execAction(inputScriptPath, {
          Action: 'click', x: args.x, y: args.y,
          button: args.button === 'right' ? 'right' : 'left',
          double: args.double === true,
          FailSafePx: failSafePx,
        }, 10000),
      }))

      yield ctx.tools.register(defineTool({
        name: 'pc_type',
        description: '向当前焦点窗口/输入框输入文本（先点击目标输入框获得焦点）。'
          + '含中文等非 ASCII 字符时自动走剪贴板粘贴（会覆盖用户剪贴板），纯 ASCII 直发键盘事件。',
        parameters: {
          text: { type: 'string', required: true, description: '要输入的文本（可含换行）' },
        },
        output: { type: 'json' },
        execute: async (args) => execAction(inputScriptPath, {
          Action: 'type', text: String(args.text ?? ''),
          FailSafePx: failSafePx,
        }, 10000),
      }))

      yield ctx.tools.register(defineTool({
        name: 'pc_key',
        description: '按下组合键，如 "ctrl+s"、"enter"、"alt+tab"、"win"、"ctrl+shift+t"。'
          + '高危键（alt+f4/win+d/win+l 等）会强制向用户确认。',
        parameters: {
          keys: { type: 'string', required: true, description: '组合键，+ 连接；单键直接写名（enter/esc/f5/up/s…）' },
        },
        output: { type: 'json' },
        execute: async (args) => {
          const normalized = normalizeKeyCombo(String(args.keys ?? ''))
          return execAction(inputScriptPath, {
            Action: 'key', keys: normalized.join(','),
            FailSafePx: failSafePx,
          }, 10000)
        },
      }))

      yield ctx.tools.register(defineTool({
        name: 'pc_scroll',
        description: '滚轮滚动。dy 正=向下看，负=向上；dx 正=向右，负=向左（格数≈像素/120）。',
        parameters: {
          dy: { type: 'number', description: '垂直滚动量（默认 0）' },
          dx: { type: 'number', description: '水平滚动量（默认 0）' },
        },
        output: { type: 'json' },
        execute: async (args) => execAction(inputScriptPath, {
          Action: 'scroll', dx: Number(args.dx) || 0, dy: Number(args.dy) || 0,
          FailSafePx: failSafePx,
        }, 10000),
      }))

      yield ctx.tools.register(defineTool({
        name: 'pc_ball',
        description: '控制 Trae 风格桌面悬浮球（屏幕上的置顶小圆球，点击即打开 AI 对话页）。'
          + 'action: show=显示 / hide=隐藏 / status=查询状态。',
        parameters: {
          action: { type: 'string', required: true, description: 'show / hide / status' },
        },
        output: { type: 'json' },
        execute: async (args) => {
          const action = String(args.action ?? 'status').toLowerCase()
          if (action === 'hide') {
            killBall()
            ballRunning = false
            return { ok: true, ball: 'hidden' }
          }
          if (action === 'show') {
            if (!ballUrl) return { ok: false, note: '宿主无 webServer（纯 CLI headless），悬浮球不可用' }
            const started = spawnBall()
            ballRunning = started
            return { ok: started, ball: started ? 'shown' : 'spawn-failed' }
          }
          return { ok: true, ball: ballRunning ? 'running' : 'stopped', url: ballUrl ?? undefined }
        },
      }))
    }, 'pc-control.tools')
  } catch (e) { console.log('[pc-control] tools effect failed:', (e as Error)?.message) }

  // ② 守卫：读类放行；写类按 confirmActions ask；高危键无条件 ask（approval 缺席 fail-closed）
  try {
    ctx.on('tools/pre-execute', async (exec: unknown, next: () => unknown): Promise<unknown> => {
      const e = exec as { name?: string; tool?: string; args?: Record<string, unknown> } | undefined
      const toolName = String(e?.name ?? e?.tool ?? '')
      const cls = TOOL_CLASS[toolName]
      if (cls !== 'write') return next()

      let highRisk = false
      if (toolName === 'pc_key') {
        try {
          highRisk = isHighRisk(normalizeKeyCombo(String(e?.args?.keys ?? '')))
        } catch { /* 参数非法由 execute 阶段报错；此处按非高危处理 */ }
      }

      if (!confirmActions && !highRisk) return next()

      const desc = describeAction(toolName, e?.args ?? {})
      const risk = highRisk ? '【高危操作】' : ''
      return {
        kind: 'ask',
        reason: `${risk}[dsh-pc-control] 即将${desc}，确认执行？`,
        displayReason: {
          en: `dsh-pc-control is about to: ${desc}. Allow?`,
          zh: `${risk}电脑操控插件即将${desc}，允许执行？`,
        },
      }
    })
  } catch (e) { console.log('[pc-control] guard failed:', (e as Error)?.message) }

  console.log(`[pc-control] mounted (6 tools, confirm=${String(confirmActions)}, failsafe=${String(failSafePx)}px, ocr=${ocrLang}, ball=${config.ballEnabled !== false ? 'on' : 'off'})`)
}
