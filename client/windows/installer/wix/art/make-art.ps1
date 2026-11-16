# Generates the installer artwork: a banner strip and a dialog background.
#
#   .\make-art.ps1
#
# Both images are deliberately light: Windows Installer draws its own black text over them, and
# a dark background would make the wizard unreadable. The brand lives in a navy wordmark and a
# faint star chart rather than a dark theme.
#
# Output: banner.bmp (493x58), dialog.bmp (493x312), 24-bit BMP as WiX requires.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    return @{ Bitmap = $bmp; Graphics = $g }
}

function Add-Stars($graphics, [int]$w, [int]$h, [int]$count, [int]$seed, [int]$maxSize) {
    $rnd = New-Object System.Random $seed
    for ($i = 0; $i -lt $count; $i++) {
        $x = $rnd.Next(0, $w)
        $y = $rnd.Next(0, $h)
        $size = 1 + $rnd.Next(0, $maxSize)
        $alpha = 40 + $rnd.Next(0, 90)
        $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($alpha, 43, 108, 176))
        $graphics.FillEllipse($brush, [float]$x, [float]$y, [float]$size, [float]$size)
        $brush.Dispose()
    }
}

function Add-Sparkle($graphics, [float]$x, [float]$y, [float]$size, $color) {
    $brush = New-Object System.Drawing.SolidBrush $color
    $graphics.FillEllipse($brush, $x - ($size / 6), $y - ($size / 6), $size / 3, $size / 3)
    $pen = New-Object System.Drawing.Pen $color, 1.2
    $graphics.DrawLine($pen, $x - $size, $y, $x + $size, $y)
    $graphics.DrawLine($pen, $x, $y - $size, $x, $y + $size)
    $pen.Dispose()
    $brush.Dispose()
}

# ---- banner: 493x58, sits behind the dialog title --------------------------------
$banner = New-Canvas 493 58
$bw = 493; $bh = 58
$rect = New-Object System.Drawing.Rectangle 0, 0, $bw, $bh
$light = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$tint = [System.Drawing.Color]::FromArgb(255, 224, 235, 250)
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $light, $tint, 0.0
$banner.Graphics.FillRectangle($gradient, $rect)
$gradient.Dispose()
Add-Stars $banner.Graphics $bw $bh 55 17 2

$navy = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 11, 27, 58))
$accent = [System.Drawing.Color]::FromArgb(255, 43, 108, 176)
Add-Sparkle $banner.Graphics 300 29 7 $accent

$font = New-Object System.Drawing.Font 'Segoe UI Semibold', 14, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Point)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Far
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = New-Object System.Drawing.RectangleF 316, 0, 156, 58
$banner.Graphics.DrawString('STELLARDNS', $font, $navy, $textRect, $format)

$banner.Bitmap.Save((Join-Path $here 'banner.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$font.Dispose(); $navy.Dispose(); $format.Dispose()
$banner.Graphics.Dispose(); $banner.Bitmap.Dispose()

# ---- dialog background: 493x312 --------------------------------------------------
$dlg = New-Canvas 493 312
$dw = 493; $dh = 312
$rect = New-Object System.Drawing.Rectangle 0, 0, $dw, $dh
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
$wash = [System.Drawing.Color]::FromArgb(255, 240, 245, 253)
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $white, $wash, 45.0
$dlg.Graphics.FillRectangle($gradient, $rect)
$gradient.Dispose()

Add-Stars $dlg.Graphics $dw $dh 220 91 2

# Faint orbits in the lower left, so the panel reads as a star chart rather than a flat colour.
$orbit = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(38, 43, 108, 176)), 1.0
$dlg.Graphics.DrawEllipse($orbit, -140, 150, 380, 380)
$dlg.Graphics.DrawEllipse($orbit, -60, 200, 260, 240)
$orbit.Dispose()

$mark = [System.Drawing.Color]::FromArgb(150, 43, 108, 176)
Add-Sparkle $dlg.Graphics 40 262 9 $mark

$dlg.Bitmap.Save((Join-Path $here 'dialog.bmp'), [System.Drawing.Imaging.ImageFormat]::Bmp)
$dlg.Graphics.Dispose(); $dlg.Bitmap.Dispose()

Write-Host ("banner.bmp: {0:N0} bytes" -f (Get-Item (Join-Path $here 'banner.bmp')).Length)
Write-Host ("dialog.bmp: {0:N0} bytes" -f (Get-Item (Join-Path $here 'dialog.bmp')).Length)
