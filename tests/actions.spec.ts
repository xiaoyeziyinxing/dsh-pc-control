import { describe, expect, it } from 'vitest'
import {
  HIGH_RISK_KEYS, TOOL_CLASS, describeAction, isHighRisk, normalizeKeyCombo,
} from '../src/actions.js'
import { PS_BALL_SCRIPT, PS_INPUT_SCRIPT, PS_SCREEN_SCRIPT } from '../src/scripts.js'

describe('normalizeKeyCombo', () => {
  it('单普通键', () => {
    expect(normalizeKeyCombo('enter')).toEqual(['enter'])
  })
  it('组合键保序 + 修饰键 canonical 化（control→ctrl / meta→win）', () => {
    expect(normalizeKeyCombo('ctrl+shift+t')).toEqual(['ctrl', 'shift', 't'])
    expect(normalizeKeyCombo('control+s')).toEqual(['ctrl', 's'])
    expect(normalizeKeyCombo('meta+d')).toEqual(['win', 'd'])
    expect(normalizeKeyCombo('lwin+L')).toEqual(['win', 'l'])
  })
  it('大小写与空格容错', () => {
    expect(normalizeKeyCombo(' Ctrl + S ')).toEqual(['ctrl', 's'])
  })
  it('非法输入抛错', () => {
    expect(() => normalizeKeyCombo('')).toThrow()
    expect(() => normalizeKeyCombo('ctrl++s')).toThrow()
    expect(() => normalizeKeyCombo('ctrl')).toThrow()          // 只有修饰键
    expect(() => normalizeKeyCombo('ctrl+shift')).toThrow()
    expect(() => normalizeKeyCombo('ctrl+f13')).toThrow()      // 未知键
    expect(() => normalizeKeyCombo('enter+esc')).toThrow()     // 两个普通键
    expect(() => normalizeKeyCombo('ctrl+ctrl+s')).toThrow()   // 修饰键重复
  })
})

describe('isHighRisk', () => {
  it('高危集合覆盖项目约定键', () => {
    expect(HIGH_RISK_KEYS.has('alt+f4')).toBe(true)
    expect(HIGH_RISK_KEYS.has('ctrl+alt+del')).toBe(true)
    expect(HIGH_RISK_KEYS.has('win+d')).toBe(true)
  })
  it('alt+f4 / win+d / win+l / ctrl+shift+esc 判高危（canonical 化后比对）', () => {
    expect(isHighRisk(normalizeKeyCombo('alt+F4'))).toBe(true)
    expect(isHighRisk(normalizeKeyCombo('win+d'))).toBe(true)
    expect(isHighRisk(normalizeKeyCombo('meta+l'))).toBe(true)
    expect(isHighRisk(normalizeKeyCombo('ctrl+shift+esc'))).toBe(true)
  })
  it('普通组合键不判高危', () => {
    expect(isHighRisk(normalizeKeyCombo('ctrl+s'))).toBe(false)
    expect(isHighRisk(normalizeKeyCombo('alt+tab'))).toBe(false)
    expect(isHighRisk(normalizeKeyCombo('enter'))).toBe(false)
  })
})

describe('TOOL_CLASS 分级', () => {
  it('screenshot 是 read，其余全是 write', () => {
    expect(TOOL_CLASS.pc_screenshot).toBe('read')
    expect(TOOL_CLASS.pc_click).toBe('write')
    expect(TOOL_CLASS.pc_type).toBe('write')
    expect(TOOL_CLASS.pc_key).toBe('write')
    expect(TOOL_CLASS.pc_scroll).toBe('write')
    expect(TOOL_CLASS.pc_ball).toBe('write')
  })
})

describe('describeAction', () => {
  it('各工具生成人话描述', () => {
    expect(describeAction('pc_click', { x: 100, y: 200 })).toContain('(100, 200)')
    expect(describeAction('pc_click', { x: 1, y: 2, button: 'right', double: true })).toContain('双击')
    expect(describeAction('pc_type', { text: 'x'.repeat(50) })).toContain('…')
    expect(describeAction('pc_key', { keys: 'ctrl+s' })).toContain('ctrl+s')
    expect(describeAction('pc_scroll', { dy: -300 })).toContain('向上')
  })
})

describe('PowerShell 脚本静态契约（历史坑位防御）', () => {
  it('公共：stdin JSON 参数 + UTF8 无 BOM 输出 + 错误信封', () => {
    for (const s of [PS_SCREEN_SCRIPT, PS_INPUT_SCRIPT]) {
      expect(s).toContain('Get-Content -Raw -Path $argsFile -Encoding UTF8 | ConvertFrom-Json')
      expect(s).toContain('OutputEncoding = New-Object System.Text.UTF8Encoding($false)')
      expect(s).toContain('\'{"ok":false,"error":\'')
    }
  })
  it('FailSafe：鼠标在左上角保护区即中止（两个脚本都有）', () => {
    for (const s of [PS_SCREEN_SCRIPT, PS_INPUT_SCRIPT]) {
      expect(s).toContain("error = 'failsafe'")
      expect(s).toContain('Cursor]::Position')
    }
  })
  it('OCR：WinRT 逐类型加载 + Bgra8 强转 + 词级坐标 + 超限缩放', () => {
    expect(PS_SCREEN_SCRIPT).toContain('ContentType = WindowsRuntime')
    expect(PS_SCREEN_SCRIPT).toContain('BitmapPixelFormat]::Bgra8')
    expect(PS_SCREEN_SCRIPT).toContain('$w.BoundingRect')          // 词级（OcrLine.BoundingRect 在 PS5.1 恒 null）
    expect(PS_SCREEN_SCRIPT).not.toContain('$line.BoundingRect')
    expect(PS_SCREEN_SCRIPT).toContain('MaxImageDimension')
    expect(PS_SCREEN_SCRIPT).toContain('TryCreateFromUserProfileLanguages')  // 语言回退
  })
  it('输入：C# 内组装 SendInput（规避 PS 值类型拷贝坑）+ 中文剪贴板粘贴', () => {
    expect(PS_INPUT_SCRIPT).toContain('namespace DshPc')
    expect(PS_INPUT_SCRIPT).toContain('Set-Clipboard -Value $text')
    expect(PS_INPUT_SCRIPT).toContain('KeyUnicode')
    expect(PS_INPUT_SCRIPT).toContain('0x0800')                    // WHEEL
  })
  it('脚本自含（单文件发布）：screen 用 IAsyncOperation 泛型转义不破坏 TS 模板', () => {
    expect(PS_SCREEN_SCRIPT).toContain('IAsyncOperation`1')
  })
})

describe('悬浮球脚本静态契约', () => {
  it('圆窗 Region 挖圆 + TopMost + 无任务栏图标', () => {
    expect(PS_BALL_SCRIPT).toContain('AddEllipse')
    expect(PS_BALL_SCRIPT).toContain('TopMost = $true')
    expect(PS_BALL_SCRIPT).toContain('ShowInTaskbar = $false')
  })
  it('拖动与点击区分（位移 < 6px 视为点击）+ 位置持久化', () => {
    expect(PS_BALL_SCRIPT).toContain('-lt 6')
    expect(PS_BALL_SCRIPT).toContain('Start-Process $p.Url')
    expect(PS_BALL_SCRIPT).toContain('PosFile')
  })
  it('右键菜单含打开与退出', () => {
    expect(PS_BALL_SCRIPT).toContain('打开 AI 对话')
    expect(PS_BALL_SCRIPT).toContain('退出悬浮球')
  })
  it('无 JSON 信封依赖（常驻 GUI 进程，消息循环阻塞）', () => {
    expect(PS_BALL_SCRIPT).not.toContain('Write-Result')
    expect(PS_BALL_SCRIPT).toContain('ShowDialog()')
  })
})
