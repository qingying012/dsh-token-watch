<#
  notify.ps1 — token-watch 的桌面通知

  主样式：鲸鱼娘气泡（参照客户端右下角 whale-widget 的白底 + 深藏青描边 + DSniang1 头像）。
  兜底：WinRT Toast（借用 PowerShell 的 AUMID）；再兜底托盘气泡。

  由 token-watch.mjs 启动，参数走环境变量，避免命令行中文乱码：
    TW_TITLE   标题（默认 token-watch 告警）
    TW_MSG     正文（必填，为空直接退出）
    TW_LOG     日志文件路径（点击气泡时用记事本打开）

  依赖同目录的 whale.png（来自 dsh-whale-widget/assets/DSniang1.png）。

  手工测试：
    $env:TW_MSG='测试'; powershell -NoProfile -ExecutionPolicy Bypass -File .\notify.ps1
#>
$ErrorActionPreference = 'Stop'

$title = if ($env:TW_TITLE) { $env:TW_TITLE } else { 'token-watch 告警' }
$message = $env:TW_MSG
$logPath = $env:TW_LOG
if (-not $message) { exit 0 }

$whalePath = Join-Path $PSScriptRoot 'whale.png'

# ---------- 1) 鲸鱼娘气泡 ----------
$shown = $false
if (Test-Path $whalePath) {
    try {
        Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms, System.Drawing

        $xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ShowActivated="False"
        SizeToContent="WidthAndHeight" ResizeMode="NoResize" WindowStartupLocation="Manual">
  <Grid Margin="20">
    <Border x:Name="Card" Background="#FFFFFF" BorderBrush="#2A3A6B" BorderThickness="3"
            CornerRadius="20" Padding="20,14,98,16" MaxWidth="400">
      <Border.Effect>
        <DropShadowEffect BlurRadius="18" ShadowDepth="0" Opacity="0.16" Color="#2A3A6B"/>
      </Border.Effect>
      <StackPanel>
        <TextBlock x:Name="Head" FontFamily="Microsoft YaHei UI" FontSize="15" FontWeight="Bold" Foreground="#2A3A6B"/>
        <TextBlock x:Name="Body" FontFamily="Microsoft YaHei UI" FontSize="13" Foreground="#3B466E"
                   TextWrapping="Wrap" Margin="0,7,0,0" MaxWidth="244" LineHeight="20"/>
        <TextBlock x:Name="Hint" FontFamily="Microsoft YaHei UI" FontSize="11" Foreground="#9AA3C2" Margin="0,9,0,0"/>
      </StackPanel>
    </Border>
    <Grid HorizontalAlignment="Right" VerticalAlignment="Bottom" Margin="0,0,-4,-10" Width="104" Height="104">
      <Ellipse Width="104" Height="104" Fill="#FFFFFF" Stroke="#2A3A6B" StrokeThickness="3"/>
      <Image x:Name="Avatar" Width="88" Height="88" Stretch="UniformToFill">
        <Image.Clip>
          <EllipseGeometry Center="44,44" RadiusX="44" RadiusY="44"/>
        </Image.Clip>
      </Image>
    </Grid>
  </Grid>
</Window>
"@

        $window = [Windows.Markup.XamlReader]::Parse($xaml)
        $window.FindName('Head').Text = $title
        $window.FindName('Body').Text = $message
        $window.FindName('Hint').Text = if ($logPath) { '点击打开日志 · 约 10 秒后自动关闭' } else { '约 10 秒后自动关闭' }

        $bmp = New-Object System.Windows.Media.Imaging.BitmapImage
        $bmp.BeginInit()
        $bmp.UriSource = [Uri]$whalePath
        $bmp.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
        $bmp.EndInit()
        $window.FindName('Avatar').Source = $bmp

        # 先放屏幕外再定位，避免左上角闪一下
        $window.Left = -20000
        $window.Top = -20000
        $window.Opacity = 0

        $window.Add_Loaded({
                $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
                $window.Left = $wa.Right - $window.ActualWidth - 20
                $window.Top = $wa.Bottom - $window.ActualHeight - 16
                $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(0, 1, [TimeSpan]::FromMilliseconds(220))
                $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
            })

        $window.Add_MouseLeftButtonDown({
                try {
                    if ($logPath -and (Test-Path $logPath)) { Start-Process -FilePath 'notepad.exe' -ArgumentList $logPath }
                }
                catch { }
                $window.Close()
            })

        $timer = New-Object System.Windows.Threading.DispatcherTimer
        $timer.Interval = [TimeSpan]::FromMilliseconds(10000)
        $timer.Add_Tick({
                $timer.Stop()
                $window.Close()
            })
        $timer.Start()

        [void]$window.ShowDialog()
        $shown = $true
    }
    catch {
        $shown = $false
    }
}

if ($shown) { exit 0 }

# ---------- 2) WinRT Toast ----------
function Escape-Xml([string] $s) {
    if ($null -eq $s) { return '' }
    return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;')
}

$toastOk = $false
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null

    $body = Escape-Xml $message
    if ($logPath) { $body = $body + "`n" + (Escape-Xml ('日志: ' + $logPath)) }

    $xmlText = @"
<toast duration="long">
  <visual><binding template="ToastGeneric">
    <text>$(Escape-Xml $title)</text>
    <text>$body</text>
  </binding></visual>
</toast>
"@

    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml($xmlText)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    $toastOk = $true
}
catch {
    $toastOk = $false
}

if ($toastOk) { exit 0 }

# ---------- 3) 托盘气泡 ----------
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Warning
    $ni.Text = 'token-watch'
    $ni.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
    $ni.BalloonTipTitle = $title
    $ni.BalloonTipText = $message
    $ni.Visible = $true
    $ni.ShowBalloonTip(10000)
    Start-Sleep -Milliseconds 12000
    $ni.Visible = $false
    $ni.Dispose()
}
catch {
    exit 1
}

exit 0
