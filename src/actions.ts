// dsh-pc-control 纯逻辑：键名规范化、高危组合键判定、操作分级（读/写）。
// 独立成模块便于 vitest 覆盖（不触碰真实进程 / 不发键）。

/** 操作分级：read 自动放行；write 走确认守卫（confirmActions 可关，高危键例外） */
export type ActionClass = 'read' | 'write'

export const TOOL_CLASS: Record<string, ActionClass> = {
  pc_screenshot: 'read',
  pc_click: 'write',
  pc_type: 'write',
  pc_key: 'write',
  pc_scroll: 'write',
  pc_ball: 'write',
}

/**
 * 高危组合键（规范形：修饰键在前，按 normalizeKeyCombo 排序后 join('+')）：
 * 即使用户在配置里关闭了 confirmActions，这些键也强制走确认（项目安全约定）。
 * - alt+f4            关闭当前窗口
 * - ctrl+alt+del      系统安全屏（SAS 实际不可由 SendInput 注入，防御性列出）
 * - win+d / win+m     显示桌面/最小化全部
 * - win+l             锁屏
 * - ctrl+shift+esc    任务管理器
 */
export const HIGH_RISK_KEYS: ReadonlySet<string> = new Set([
  'alt+f4',
  'ctrl+alt+del',
  'win+d',
  'win+m',
  'win+l',
  'ctrl+shift+esc',
])

const MODIFIERS = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'lwin', 'rwin', 'meta'])

/** 修饰键 canonical 化：control→ctrl、meta/lwin/rwin→win */
function canonicalModifier(k: string): string {
  if (k === 'control') return 'ctrl'
  if (k === 'meta' || k === 'lwin' || k === 'rwin') return 'win'
  return k
}

/**
 * 解析组合键字符串 "ctrl+shift+t" → 规范键序列（修饰键 canonical 化，保序）。
 * 非法输入（空串、空段、未知键名）抛 Error——工具参数校验用。
 * 普通键允许：命名键（enter/tab/esc/f1..f12/箭头等）+ 单个字母/数字。
 */
export function normalizeKeyCombo(input: string): string[] {
  const parts = String(input ?? '')
    .split('+')
    .map((p) => p.trim().toLowerCase())
  if (parts.length === 0 || parts.some((p) => p === '')) throw new Error(`非法组合键 "${input}"`)
  const out: string[] = []
  for (const p of parts) {
    if (MODIFIERS.has(p)) {
      const c = canonicalModifier(p)
      if (out.includes(c)) throw new Error(`组合键 "${input}" 中修饰键 ${c} 重复`)
      out.push(c)
      continue
    }
    if (/^[a-z]$/.test(p) || /^[0-9]$/.test(p) || NAMED_KEYS.has(p)) {
      if (out.some((k) => MODIFIERS.has(k) === false)) throw new Error(`组合键 "${input}" 只能有一个普通键`)
      out.push(p)
      continue
    }
    throw new Error(`组合键 "${input}" 含未知键名 "${p}"`)
  }
  if (!out.some((k) => !MODIFIERS.has(k))) throw new Error(`组合键 "${input}" 缺少普通键`)
  return out
}

/** SendInput 支持的命名键（字母/数字单独处理） */
export const NAMED_KEYS: ReadonlySet<string> = new Set([
  'enter', 'return', 'tab', 'esc', 'escape', 'space', 'backspace', 'bs',
  'delete', 'del', 'insert', 'ins', 'home', 'end', 'pageup', 'pagedown',
  'up', 'down', 'left', 'right', 'capslock', 'numlock', 'scrolllock',
  'printscreen', 'menu', 'apps', 'pause',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
])

/** 组合键是否高危：normalize 后 join 与 HIGH_RISK_KEYS 比对（'+' 连接符号按字面处理） */
export function isHighRisk(normalized: string[]): boolean {
  // '+' 键本身不允许作为普通键（normalizeKeyCombo 未收录），此处 join 无歧义
  return HIGH_RISK_KEYS.has(normalized.join('+'))
}

/** 守卫 reason 文案：按工具名 + 参数生成一句话动作描述 */
export function describeAction(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'pc_click': {
      const btn = args.button === 'right' ? '右键' : '左键'
      const dbl = args.double === true ? '双击' : '单击'
      return `鼠标${dbl}（${btn}）坐标 (${String(args.x)}, ${String(args.y)})`
    }
    case 'pc_type': {
      const t = String(args.text ?? '')
      const shown = t.length > 40 ? `${t.slice(0, 40)}…` : t
      return `在当前焦点输入文本：${shown || '(空)'}`
    }
    case 'pc_key':
      return `按下组合键：${String(args.keys ?? '')}`
    case 'pc_scroll': {
      const dx = Number(args.dx ?? 0)
      const dy = Number(args.dy ?? 0)
      const dir = dy > 0 ? '向下' : dy < 0 ? '向上' : dx > 0 ? '向右' : '向左'
      return `滚轮${dir}滚动 (dx=${String(dx)}, dy=${String(dy)})`
    }
    case 'pc_ball': {
      const a = String(args.action ?? '')
      return a === 'hide' ? '隐藏桌面悬浮球'
        : a === 'show' ? '显示桌面悬浮球'
          : '查询悬浮球状态'
    }
    default:
      return toolName
  }
}
