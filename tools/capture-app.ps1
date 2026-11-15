# Launch the packaged desktop app, capture its window, then close it.
#   powershell -ExecutionPolicy Bypass -File tools/capture-app.ps1 renders/app-window.png
param([string]$Out = "renders/app-window.png")

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$exe = Resolve-Path "src-tauri\target\release\app.exe"
$process = Start-Process -FilePath $exe -PassThru
try {
  $handle = [IntPtr]::Zero
  for ($i = 0; $i -lt 20 -and $handle -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    $handle = $process.MainWindowHandle
  }
  if ($handle -eq [IntPtr]::Zero) { throw "Window did not appear" }

  Start-Sleep -Seconds 6
  $rect = New-Object WinCapture+RECT
  [void][WinCapture]::GetWindowRect($handle, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  [void][WinCapture]::PrintWindow($handle, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
  $bitmap.Save((Join-Path (Get-Location) $Out), [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  Write-Output "captured $Out ($width x $height)"
} finally {
  if (-not $process.HasExited) { $process.Kill() }
}
