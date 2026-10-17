// dsh-pc-control PowerShell 脚本源码：截屏+WinRT OCR、鼠标/键盘/滚轮/剪贴板输入。
// 全部走 stdin JSON 参数 + stdout 单行 JSON 结果（UTF-8 BOM 文件传递，规避命令行转义/编码坑）。
//
// 历史坑位对齐（来自旧 PySide6 项目实测，勿删）：
// - PS5.1 必须逐类型显式加载 WinRT 类型，否则类型找不到静默崩溃
// - GDI 截屏位图非 Bgra8 会导致 OCR 返回空，必须 SoftwareBitmap.Convert 强转
// - OcrLine.BoundingRect 在 PS5.1 投影恒为 null，只用 OcrWord.BoundingRect 词级坐标
// - stdout 必须 [Console]::OutputEncoding=UTF8（无 BOM），否则中文 GBK 乱码
// - PS 结构体嵌套字段赋值是值拷贝（写入丢失），SendInput 全部在 C# helper 内组装
// - FailSafe：鼠标进入屏幕左上角 failSafePx 方格 → 直接返回 {"ok":false,"error":"failsafe"}

/** stdin JSON 读取 + UTF8 输出 + try/catch 信封（两个脚本共用的前导/收尾） */
const PS_PREAMBLE = `$ErrorActionPreference = 'Stop'
function Write-Result($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 8 -Compress))
}
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $p = Get-Content -Raw -Path $argsFile -Encoding UTF8 | ConvertFrom-Json
`

const PS_EPILOGUE = `  exit 0
} catch {
  $msg = ($_.Exception.Message -replace "\\r?\\n", ' ')
  [Console]::Out.WriteLine(('{"ok":false,"error":' + ($msg | ConvertTo-Json -Compress) + '}'))
  exit 1
}
`

/** FailSafe 检查片段：鼠标在左上角 $p.FailSafePx 方格内 → 中止 */
const PS_FAILSAFE = `  Add-Type -AssemblyName System.Windows.Forms
  $cur = [System.Windows.Forms.Cursor]::Position
  if ($cur.X -lt $p.FailSafePx -and $cur.Y -lt $p.FailSafePx) {
    Write-Result @{ ok = $false; error = 'failsafe'; note = '鼠标位于屏幕左上角保护区，已中止操作' }
    exit 0
  }
`

/**
 * 截屏 + 可选 OCR。参数（stdin JSON）：OutPath / Ocr(bool) / Lang / FailSafePx / Region?{x,y,w,h}
 * 输出：{ok, path, width, height, offsetX, offsetY, ocr?{lang, lines:[{text, words:[{text,x,y,w,h}]}]}}
 * 坐标一律为屏幕绝对坐标（词坐标已加虚拟屏偏移、除回缩放比）。
 */
export const PS_SCREEN_SCRIPT = `
param([string]$argsFile)
${PS_PREAMBLE}
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
${PS_FAILSAFE}
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $rx = 0; $ry = 0; $rw = $vs.Width; $rh = $vs.Height
  if ($null -ne $p.Region) {
    $rx = $p.Region.x; $ry = $p.Region.y; $rw = $p.Region.w; $rh = $p.Region.h
  }
  $bmp = New-Object System.Drawing.Bitmap $rw, $rh
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size $rw, $rh))
    $g.Dispose()
    $bmp.Save($p.OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }

  $result = @{ ok = $true; path = $p.OutPath; width = $rw; height = $rh; offsetX = $rx; offsetY = $ry }

  if ($p.Ocr) {
    # WinRT 逐类型显式加载（PS5.1 静默崩坑）
    $null = [Windows.Foundation.IAsyncOperation\`1, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapInterpolationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

    if (-not ('WinRtAwait.Helper' -as [type])) {
      # PS5.1 经典 WinRT await：反射取 WindowsRuntimeSystemExtensions.AsTask(IAsyncOperation<T>)
      # （Add-Type 写 C# 需手工解析 GAC 引用，多一层脆点，弃用）
      Add-Type -AssemblyName System.Runtime.WindowsRuntime
      $script:AsTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
      })[0]
      function Await-Op($op, $resultType) {
        $t = $script:AsTaskOp.MakeGenericMethod($resultType).Invoke($null, @($op))
        $null = $t.Wait(-1)   # Wait 返回 bool，须吞掉——否则混入函数输出污染返回值
        return $t.Result
      }
    }

    $file  = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p.OutPath)) ([Windows.Storage.StorageFile])
    $stream  = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

    # 超 OcrEngine.MaxImageDimension 需等比缩小（4K+ 全屏），OCR 坐标后除回缩放比
    $maxDim = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $scale = 1.0
    if ($decoder.OrientedPixelWidth -gt $maxDim -or $decoder.OrientedPixelHeight -gt $maxDim) {
      $scale = $maxDim / [math]::Max($decoder.OrientedPixelWidth, $decoder.OrientedPixelHeight)
    }
    $soft = $null
    if ($scale -lt 1.0) {
      $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
      $tf.ScaledWidth = [int]($decoder.OrientedPixelWidth * $scale)
      $tf.ScaledHeight = [int]($decoder.OrientedPixelHeight * $scale)
      $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Linear
      $soft = Await-Op ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $tf,
        [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    } else {
      # GDI 截屏位图非 Bgra8 → 强制转换（否则 OCR 返回空，历史坑）
      $soft = Await-Op ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
    }

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($p.Lang)))
    if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if ($null -eq $engine) { throw "OCR 引擎不可用：系统未安装语言 $($p.Lang) 对应的语言包" }

    $ocrResult = Await-Op ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])

    $inv = 1.0 / $scale
    $lines = @()
    foreach ($line in $ocrResult.Lines) {
      $words = @()
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect   # 词级坐标（OcrLine.BoundingRect 在 PS5.1 恒 null，勿用）
        $words += @{
          text = $w.Text
          x = [int][math]::Round($r.X * $inv) + $rx
          y = [int][math]::Round($r.Y * $inv) + $ry
          w = [int][math]::Round($r.Width * $inv)
          h = [int][math]::Round($r.Height * $inv)
        }
      }
      $lines += @{ text = $line.Text; words = $words }
    }
    $maxLines = 300
    if ($null -ne $p.MaxLines) { $maxLines = [int]$p.MaxLines }
    if ($lines.Count -gt $maxLines) { $lines = @($lines[0..($maxLines - 1)]) }
    $result.ocr = @{ lang = $engine.RecognizerLanguage.LanguageTag; lines = $lines }
  }

  Write-Result $result
${PS_EPILOGUE}
`

/**
 * 鼠标/键盘/滚轮/剪贴板输入。参数（stdin JSON）：
 * Action=click {x,y,button,double} / type {text} / key {keys:"ctrl,shift,t"} / scroll {dx,dy}
 * 输出：{ok, action, ...明细}
 */
export const PS_INPUT_SCRIPT = `
param([string]$argsFile)
${PS_PREAMBLE}
${PS_FAILSAFE}
  if (-not ('DshPc.In' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace DshPc {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  public static class In {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    private static uint Send(INPUT[] a) { return SendInput(1, a, Marshal.SizeOf(typeof(INPUT))); }
    // flags/data 用 int：PS 传负数（滚轮向下）不因 uint 转换报错
    public static uint Mouse(int flags, int data) {
      var a = new INPUT[1]; a[0].type = 0; a[0].U.mi.dwFlags = (uint)flags; a[0].U.mi.mouseData = (uint)data;
      return Send(a);
    }
    public static uint Key(int vk, bool up) {
      var a = new INPUT[1]; a[0].type = 1; a[0].U.ki.wVk = (ushort)vk; if (up) a[0].U.ki.dwFlags = 2;
      return Send(a);
    }
    public static uint KeyUnicode(int ch, bool up) {
      var a = new INPUT[1]; a[0].type = 1; a[0].U.ki.wScan = (ushort)ch; a[0].U.ki.dwFlags = 4 | (up ? 2u : 0u);
      return Send(a);
    }
  }
}
"@
  }

  $VK = @{ ctrl = 0x11; alt = 0x12; shift = 0x10; win = 0x5B;
    enter = 0x0D; return = 0x0D; tab = 0x09; esc = 0x1B; escape = 0x1B; space = 0x20;
    backspace = 0x08; bs = 0x08; delete = 0x2E; del = 0x2E; insert = 0x2D; ins = 0x2D;
    home = 0x24; end = 0x23; pageup = 0x21; pagedown = 0x22; up = 0x26; down = 0x28; left = 0x25; right = 0x27;
    capslock = 0x14; numlock = 0x90; scrolllock = 0x91; printscreen = 0x2C; menu = 0x5D; apps = 0x5D; pause = 0x13 }
  for ($i = 1; $i -le 12; $i++) { $VK[("f{0}" -f $i)] = 0x6F + $i }
  for ($i = 0; $i -lt 26; $i++) { $VK[[string][char](0x61 + $i)] = 0x41 + $i }
  for ($i = 0; $i -lt 10; $i++) { $VK[[string]$i] = 0x30 + $i }

  if ($p.Action -eq 'click') {
    [void][DshPc.In]::SetCursorPos([int]$p.x, [int]$p.y)
    Start-Sleep -Milliseconds 40
    $dn = 0x02; $up = 0x04
    if ($p.button -eq 'right') { $dn = 0x08; $up = 0x10 }
    $rounds = 1; if ($p.double) { $rounds = 2 }
    for ($i = 0; $i -lt $rounds; $i++) {
      [void][DshPc.In]::Mouse($dn, 0); Start-Sleep -Milliseconds 30
      [void][DshPc.In]::Mouse($up, 0)
      if ($i -lt $rounds - 1) { Start-Sleep -Milliseconds 80 }
    }
    Write-Result @{ ok = $true; action = 'click'; x = [int]$p.x; y = [int]$p.y; button = $p.button; double = [bool]$p.double }
  }
  elseif ($p.Action -eq 'type') {
    # 中文/非 ASCII → 剪贴板粘贴（项目约定，兼容输入法）；纯 ASCII → KEYEVENTF_UNICODE 直发
    $text = [string]$p.text
    $needsClipboard = $text -match '[^\\x00-\\x7F]'
    if ($needsClipboard) {
      Set-Clipboard -Value $text -WarningAction SilentlyContinue
      Start-Sleep -Milliseconds 150
      [void][DshPc.In]::Key(0x11, $false)   # ctrl down
      Start-Sleep -Milliseconds 20
      [void][DshPc.In]::Key(0x56, $false)   # V down
      Start-Sleep -Milliseconds 30
      [void][DshPc.In]::Key(0x56, $true)
      [void][DshPc.In]::Key(0x11, $true)
    } else {
      foreach ($ch in $text.ToCharArray()) {
        [void][DshPc.In]::KeyUnicode([int]$ch, $false)
        [void][DshPc.In]::KeyUnicode([int]$ch, $true)
      }
    }
    Write-Result @{ ok = $true; action = 'type'; length = $text.Length; viaClipboard = $needsClipboard }
  }
  elseif ($p.Action -eq 'key') {
    # keys 形如 "ctrl,shift,t"（Node 侧 normalizeKeyCombo 产出，逗号分隔）
    $seq = [string]$p.keys -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ -ne '' }
    $mods = @(); $normal = ''
    foreach ($k in $seq) {
      if ($k -in @('ctrl', 'alt', 'shift', 'win')) { $mods += $k } else { $normal = $k }
    }
    if (-not $VK.ContainsKey($normal)) { throw "未知键名 $normal" }
    foreach ($m in $mods) {
      if (-not $VK.ContainsKey($m)) { throw "未知键名 $m" }
      [void][DshPc.In]::Key([int]$VK[$m], $false)
      Start-Sleep -Milliseconds 20
    }
    [void][DshPc.In]::Key([int]$VK[$normal], $false)
    Start-Sleep -Milliseconds 40
    [void][DshPc.In]::Key([int]$VK[$normal], $true)
    for ($i = $mods.Count - 1; $i -ge 0; $i--) { [void][DshPc.In]::Key([int]$VK[$mods[$i]], $true) }
    Write-Result @{ ok = $true; action = 'key'; keys = ($seq -join '+') }
  }
  elseif ($p.Action -eq 'scroll') {
    # WHEEL 0x0800：delta 正 = 滚轮向前（内容向上）→ dy>0（向下看）传负
    # HWHEEL 0x1000：delta 正 = 向右
    if ([int]$p.dy -ne 0) { [void][DshPc.In]::Mouse(0x0800, -([int]$p.dy) * 120) }
    if ([int]$p.dx -ne 0) { [void][DshPc.In]::Mouse(0x1000, [int]$p.dx * 120) }
    Start-Sleep -Milliseconds 60
    Write-Result @{ ok = $true; action = 'scroll'; dx = [int]$p.dx; dy = [int]$p.dy }
  }
  else {
    throw "未知 Action $($p.Action)"
  }
${PS_EPILOGUE}
`

/**
 * Trae 风格悬浮球（常驻 GUI 分离进程，不走 JSON 信封——Application.Run 阻塞消息循环）。
 * 参数（stdin JSON argsFile）：Url（点击打开的带 token web 地址）/ Size / Color / PosFile / ShowTerminal?
 * 交互：左键拖动改位置；松开时位移 < 6px 视为点击 → 打开默认浏览器进 AI 对话；
 *      右键菜单：打开对话 / 退出悬浮球。退出时把位置写回 PosFile（跨次启动记忆）。
 */
export const PS_BALL_SCRIPT = `
param([string]$argsFile)
$ErrorActionPreference = 'Stop'
try {
  # 注意：本进程经 PS 中继 Start-Process -WindowStyle Hidden 拉起（有隐藏控制台），
  # 但不要依赖控制台输出，诊断一律走 ball-error.log
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $p = Get-Content -Raw -Path $argsFile -Encoding UTF8 | ConvertFrom-Json

  # 越早越好：把自身 pid 写给宿主（宿主经 PS 中继 Start-Process 拉起本进程，
  # 拿不到直接 pid，只能靠本进程自报家门供 killBall 使用）
  if ($p.PidFile) {
    try { @{ pid = $PID } | ConvertTo-Json -Compress | Set-Content -Path $p.PidFile -Encoding UTF8 } catch { }
  }

  $size = [int]$p.Size
  if ($size -lt 28) { $size = 28 }
  if ($size -gt 160) { $size = 160 }

  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.TopMost = $true
  $form.ShowInTaskbar = $false
  $form.Size = New-Object System.Drawing.Size($size, $size)
  # WinForms 顶层窗体不支持透明 BackColor（实测异常）；Region 挖圆已保证圆外不渲染不命中，背景用球色即可
  $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml($p.Color)

  # 圆形窗口：Region 挖圆（窗口外完全穿透，不挡点击）
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse(0, 0, $size, $size)
  $form.Region = New-Object System.Drawing.Region($path)
  $form.Opacity = 0.92

  # 球面绘制：主题色圆 + 高光，中心画对话气泡
  $form.Add_Paint({
    param($sender, $e)
    $g = $e.Graphics
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $main = [System.Drawing.ColorTranslator]::FromHtml($p.Color)
    $brush = [System.Drawing.SolidBrush]::new($main)
    $g.FillEllipse($brush, 2, 2, $size - 4, $size - 4)
    # 高光
    $hl = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(90, 255, 255, 255))
    $g.FillEllipse($hl, [int]($size * 0.18), [int]($size * 0.12), [int]($size * 0.42), [int]($size * 0.3))
    # 气泡轮廓（对话）
    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 3)
    $g.DrawEllipse($pen, [int]($size * 0.28), [int]($size * 0.26), [int]($size * 0.44), [int]($size * 0.4))
    $g.FillPie([System.Drawing.Brushes]::White, [int]($size * 0.34), [int]($size * 0.52), [int]($size * 0.2), [int]($size * 0.24), 90, 180)
  })

  # 位置恢复 / 默认右上角
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $form.Location = New-Object System.Drawing.Point(($vs.X + $vs.Width - $size - 24), ($vs.Y + 120))
  if (Test-Path $p.PosFile) {
    try {
      $saved = Get-Content -Raw -Path $p.PosFile -Encoding UTF8 | ConvertFrom-Json
      $form.Location = New-Object System.Drawing.Point([int]$saved.x, [int]$saved.y)
    } catch { }
  }
  # 位置夹回可见屏幕（分辨率变更后位置可能出界）
  if ($form.Left -gt $vs.X + $vs.Width - 40) { $form.Left = $vs.X + $vs.Width - $size - 24 }
  if ($form.Top -gt $vs.Y + $vs.Height - 40) { $form.Top = $vs.Y + 120 }

  $script:dragOffset = $null
  $script:moveStart = $null

  $form.Add_MouseDown({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $script:dragOffset = $e.Location
      $script:moveStart = $form.Location
    }
  })
  $form.Add_MouseMove({
    param($sender, $e)
    if ($null -ne $script:dragOffset -and $e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      $pt = [System.Windows.Forms.Cursor]::Position
      $form.Location = New-Object System.Drawing.Point(($pt.X - $script:dragOffset.X), ($pt.Y - $script:dragOffset.Y))
    }
  })
  $form.Add_MouseUp({
    param($sender, $e)
    $start = $script:moveStart
    $script:dragOffset = $null
    $script:moveStart = $null
    if ($null -eq $start) { return }
    $dx = [Math]::Abs($form.Left - $start.X) + [Math]::Abs($form.Top - $start.Y)
    if ($dx -lt 6 -and $e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      Start-Process $p.Url
    }
  })

  # 右键菜单
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $itemOpen = $menu.Items.Add('打开 AI 对话')
  $itemOpen.Add_Click({ Start-Process $p.Url })
  $itemExit = $menu.Items.Add('退出悬浮球')
  $itemExit.Add_Click({ $form.Close() })
  $form.ContextMenuStrip = $menu

  # 退出时保存位置
  $form.Add_FormClosing({
    try {
      @{ x = $form.Left; y = $form.Top } | ConvertTo-Json -Compress |
        Set-Content -Path $p.PosFile -Encoding UTF8
    } catch { }
  })

  [void]$form.ShowDialog()
  exit 0
} catch {
  # 无控制台可输出 → 错误落日志（与 argsFile 同目录），供宿主侧排查
  try {
    $log = Join-Path (Split-Path -Parent $argsFile) 'ball-error.log'
    ("[{0}] {1}\`r\`n" -f (Get-Date -Format s), $_.Exception.Message) |
      Add-Content -Path $log -Encoding UTF8
  } catch { }
  exit 1
}
`
