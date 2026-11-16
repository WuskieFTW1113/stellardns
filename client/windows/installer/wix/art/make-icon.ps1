# Generates the application icon: StellarDNS.Client\Assets\app.ico.
#
#   .\make-icon.ps1
#
# The same four-point spark the UI header uses, on a rounded navy tile. Every size is rendered
# at its own resolution — a 16 px icon is not a downscaled 256 px one, the sparkle would turn
# into a smudge — and each frame is PNG-compressed. System.Drawing cannot write an ICO, so the
# container is assembled here: ICONDIR, one 16-byte entry per frame, then the PNG payloads.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# art -> wix -> installer -> windows, then the project folder that owns the resource.
$windows = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$outDir = Join-Path $windows 'StellarDNS.Client\Assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$out = Join-Path $outDir 'app.ico'

# 20/24/40 are there because Windows asks for them at 125% and 150% scaling.
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256

function New-Frame([int]$s) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded tile, dark enough to sit on a light or dark taskbar.
    $r = [Math]::Max(2.0, $s * 0.22)
    $d = $r * 2
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $tile.AddArc(0, 0, $d, $d, 180, 90)
    $tile.AddArc($s - $d, 0, $d, $d, 270, 90)
    $tile.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
    $tile.AddArc(0, $s - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF 0, 0),
        (New-Object System.Drawing.PointF $s, $s),
        [System.Drawing.Color]::FromArgb(255, 22, 34, 58),
        [System.Drawing.Color]::FromArgb(255, 8, 12, 21))
    $g.FillPath($fill, $tile)
    $fill.Dispose()

    # Hairline edge so the tile keeps its shape against a black tray background.
    $edge = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(70, 255, 138, 76)), ([Math]::Max(1.0, $s / 64))
    $g.DrawPath($edge, $tile)
    $edge.Dispose()
    $tile.Dispose()

    # Four-point spark: outer points on the axes, sides pinched toward the centre. Repeating a
    # control point is a legal cubic, which is what makes the inward curve.
    $cx = $s / 2.0; $cy = $s / 2.0
    $R = $s * 0.30
    $k = $R * 0.10
    $spark = New-Object System.Drawing.Drawing2D.GraphicsPath
    $spark.StartFigure()
    $spark.AddBezier($cx, $cy - $R, $cx + $k, $cy - $k, $cx + $k, $cy - $k, $cx + $R, $cy)
    $spark.AddBezier($cx + $R, $cy, $cx + $k, $cy + $k, $cx + $k, $cy + $k, $cx, $cy + $R)
    $spark.AddBezier($cx, $cy + $R, $cx - $k, $cy + $k, $cx - $k, $cy + $k, $cx - $R, $cy)
    $spark.AddBezier($cx - $R, $cy, $cx - $k, $cy - $k, $cx - $k, $cy - $k, $cx, $cy - $R)
    $spark.CloseFigure()
    $sparkBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF $cx, ($cy - $R)),
        (New-Object System.Drawing.PointF $cx, ($cy + $R)),
        [System.Drawing.Color]::FromArgb(255, 255, 158, 92),
        [System.Drawing.Color]::FromArgb(255, 255, 92, 53))
    $g.FillPath($sparkBrush, $spark)
    $sparkBrush.Dispose()
    $spark.Dispose()
    $g.Dispose()
    return $bmp
}

$frames = @()
foreach ($s in $sizes) {
    $bmp = New-Frame $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $frames += [pscustomobject]@{ Size = $s; Bytes = $ms.ToArray() }
    $ms.Dispose()
    $bmp.Dispose()
}

$fs = [System.IO.File]::Create($out)
$bw = New-Object System.IO.BinaryWriter $fs
try {
    $bw.Write([UInt16]0)                  # reserved
    $bw.Write([UInt16]1)                  # 1 = icon
    $bw.Write([UInt16]$frames.Count)
    $offset = 6 + (16 * $frames.Count)
    foreach ($f in $frames) {
        # 0 means 256 in this field; it is a byte.
        $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }
        $bw.Write([Byte]$dim)             # width
        $bw.Write([Byte]$dim)             # height
        $bw.Write([Byte]0)                # palette colours
        $bw.Write([Byte]0)                # reserved
        $bw.Write([UInt16]1)              # planes
        $bw.Write([UInt16]32)             # bits per pixel
        $bw.Write([UInt32]$f.Bytes.Length)
        $bw.Write([UInt32]$offset)
        $offset += $f.Bytes.Length
    }
    foreach ($f in $frames) { $bw.Write($f.Bytes) }
} finally {
    $bw.Dispose()
    $fs.Dispose()
}

# Read it back. A wrong header still writes a file and only fails when Windows tries to load it.
$icon = New-Object System.Drawing.Icon $out
Write-Host ("app.ico: {0:N0} bytes, {1} frames, loads as {2}x{3}" -f (Get-Item $out).Length, $frames.Count, $icon.Width, $icon.Height)
$icon.Dispose()
