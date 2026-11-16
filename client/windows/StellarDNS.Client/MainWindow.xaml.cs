using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Forms = System.Windows.Forms;

namespace StellarDNS.Client;

/* Starts the shared Node core, waits for the loopback GUI to answer, then loads it.
 * The shell owns three things: process lifetime, the window, and the tray icon. What the user
 * sees inside the window is the same page the AppImage and the macOS build render.
 *
 * Closing the window hides to the tray instead of stopping. That is not a convenience: if this
 * machine's DNS points at the client, killing the core would leave Windows resolving against a
 * port nothing answers on. Quit is explicit, and it restores the previous resolvers first.
 */
public partial class MainWindow : Window
{
    private const int GuiPort = 5381;
    private static readonly string Url = $"http://127.0.0.1:{GuiPort}";
    private static readonly string LogPath = Path.Combine(Path.GetTempPath(), "stellardns-client.log");

    private Process? _core;
    private readonly StringBuilder _tail = new();
    private Forms.NotifyIcon? _tray;
    private Icon? _trayIcon;
    private Forms.ToolStripMenuItem? _blockingItem;
    private Forms.ToolStripMenuItem? _restoreItem;
    private bool _exiting;
    private bool _trayHintShown;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) =>
        {
            await StartAsync();
            // After the core rewrites its log, so 'tray icon ready' is not truncated by it.
            CreateTray();
            await RefreshTrayMenuAsync();
        };
        Closing += OnClosing;
        Closed += (_, _) => { if (!_exiting) StopCore(); };
        StateChanged += OnStateChanged;
    }

    /// Bundled layout first (<exe>/core/src/cli.js), then a developer checkout.
    private static string? FindCli()
    {
        var baseDir = AppContext.BaseDirectory;
        var candidates = new[]
        {
            Path.Combine(baseDir, "core", "src", "cli.js"),
            Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "src", "cli.js"))
        };
        foreach (var candidate in candidates)
        {
            try { if (File.Exists(candidate)) return candidate; } catch { }
        }
        return null;
    }

    /// Prefer a node bundled next to the core, then PATH.
    private static string FindNode()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "core", "node.exe");
        return File.Exists(bundled) ? bundled : "node";
    }

    private void Append(string? line)
    {
        if (string.IsNullOrEmpty(line)) return;
        try { File.AppendAllText(LogPath, line + Environment.NewLine); } catch { }
        _tail.AppendLine(line);
        if (_tail.Length > 4000) _tail.Remove(0, _tail.Length - 4000);
    }

    private bool StartCore()
    {
        var cli = FindCli();
        if (cli is null)
        {
            Splash.Text = "The resolver core is missing.\n\nExpected: core\\src\\cli.js next to StellarDNS.Client.exe";
            return false;
        }
        try
        {
            File.WriteAllText(LogPath, $"--- {DateTime.Now:u} starting core ---{Environment.NewLine}");
            // --parent-pid: the core exits when this window dies, including a hard kill, so it
            // cannot be left holding :5381 and make the next launch look broken.
            var psi = new ProcessStartInfo(FindNode(), $"\"{cli}\" run --no-dns --parent-pid {Environment.ProcessId}")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // The core logs UTF-8 (em dashes included). Without this the redirected stream
                // is decoded as the OEM code page and the splash shows mojibake instead of the
                // error that actually stopped it.
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
                WorkingDirectory = AppContext.BaseDirectory
            };
            psi.Environment["STELLARDNS_CLIENT_HOME"] = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "StellarDNS");

            _core = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _core.OutputDataReceived += (_, e) => Append(e.Data);
            _core.ErrorDataReceived += (_, e) => Append(e.Data);
            _core.Start();
            _core.BeginOutputReadLine();
            _core.BeginErrorReadLine();
            return true;
        }
        catch (Exception ex)
        {
            Splash.Text = "Could not start the resolver core.\n\n" + ex.Message +
                          "\n\nThe installer ships node.exe in core\\. If it is missing, the build was made " +
                          "without it; reinstalling is the fix.";
            return false;
        }
    }

    private static async Task<bool> WaitForGuiAsync(TimeSpan timeout)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var res = await http.GetAsync(Url + "/api/state");
                if (res.IsSuccessStatusCode) return true;
            }
            catch { /* not listening yet */ }
            await Task.Delay(300);
        }
        return false;
    }

    /// The version this build ships, read from the core that sits next to the exe.
    private static string? ReadCoreVersion()
    {
        try
        {
            var pkg = System.IO.Path.Combine(AppContext.BaseDirectory, "core", "package.json");
            using var doc = System.Text.Json.JsonDocument.Parse(File.ReadAllText(pkg));
            return doc.RootElement.GetProperty("version").GetString();
        }
        catch { return null; }
    }

    private static async Task<string?> LiveVersionAsync()
    {
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(await GetAsync("/api/state", 3));
            return doc.RootElement.GetProperty("version").GetString();
        }
        catch { return null; }
    }

    private async Task StartAsync()
    {
        if (!StartCore()) return;

        var ready = await WaitForGuiAsync(TimeSpan.FromSeconds(20));
        if (!ready)
        {
            Splash.Text = "The resolver core did not answer on " + Url + ".\n\n" +
                          (_tail.Length > 0 ? _tail.ToString().Trim() : "No output.") +
                          "\n\nLog: " + LogPath;
            return;
        }

        // An orphaned core from an earlier install can hold :5381 and answer /api/state. Its
        // page then appears inside this window, running the old code, while this build's core
        // never bound the port. Compare versions and say so instead of showing it.
        var expected = ReadCoreVersion();
        var live = await LiveVersionAsync();
        if (expected is not null && live is not null && live != expected)
        {
            Splash.Text = $"A different StellarDNS core is already running on {Url} (v{live}; " +
                          $"this build is v{expected}).\n\nExit the running copy from its tray icon " +
                          "(right-click, Exit), then open StellarDNS again.";
            return;
        }

        try
        {
            // WebView2 defaults its user data folder next to the executable. Installed under
            // Program Files that folder is read-only to a standard user, so creating it fails
            // with E_ACCESSDENIED and the window looks like a missing runtime. Keep it per-user.
            var dataDir = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "StellarDNS", "WebView2");
            System.IO.Directory.CreateDirectory(dataDir);
            var webViewEnv = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await Browser.EnsureCoreWebView2Async(webViewEnv);
            Browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
            Browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
            Browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        }
        catch (Exception ex)
        {
            Splash.Text = ex is WebView2RuntimeNotFoundException
                ? "WebView2 runtime is missing.\nInstall the Evergreen runtime, then reopen.\n\n" + ex.Message
                : "WebView2 could not start.\n" + ex.Message + "\n\nBrowser data: %LOCALAPPDATA%\\StellarDNS\\WebView2";
            return;
        }

        Splash.Visibility = Visibility.Collapsed;
        Browser.Source = new Uri(Url);
    }

    // ---- tray -------------------------------------------------------------------------

    private static Icon LoadAppIcon()
    {
        try
        {
            var res = System.Windows.Application.GetResourceStream(new Uri("pack://application:,,,/Assets/app.ico"));
            if (res is not null) return new Icon(res.Stream);
        }
        catch { }
        return SystemIcons.Application;
    }

    private void CreateTray()
    {
        try
        {
            _trayIcon = LoadAppIcon();

            _blockingItem = new Forms.ToolStripMenuItem("Blocking: …");
            _blockingItem.Click += async (_, _) => await ToggleBlockingAsync();

            _restoreItem = new Forms.ToolStripMenuItem("Restore system DNS") { Enabled = false };
            _restoreItem.Click += async (_, _) => await RestoreDnsAsync();

            var open = new Forms.ToolStripMenuItem("Open StellarDNS")
            {
                // Qualified: System.Windows also defines SystemFonts and FontStyle.
                Font = new Font(System.Drawing.SystemFonts.MenuFont!, System.Drawing.FontStyle.Bold)
            };
            open.Click += (_, _) => ShowFromTray();

            var menu = new Forms.ContextMenuStrip();
            menu.Items.Add(open);
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add(_blockingItem);
            menu.Items.Add(_restoreItem);
            menu.Items.Add(new Forms.ToolStripSeparator());
            menu.Items.Add("Exit", null, (_, _) => ExitApp());
            // Refresh on open, so the labels describe the core as it is now rather than at launch.
            menu.Opening += (_, _) => { _ = RefreshTrayMenuAsync(); };

            _tray = new Forms.NotifyIcon
            {
                Icon = _trayIcon,
                Text = "StellarDNS",
                Visible = true,
                ContextMenuStrip = menu
            };
            _tray.DoubleClick += (_, _) => ShowFromTray();
            Append("tray icon ready");
        }
        catch (Exception ex)
        {
            // A missing tray must never stop the resolver from starting, but it should be visible
            // in the log rather than silently falling back to a window-only app.
            _tray = null;
            Append("tray icon unavailable: " + ex.Message);
        }
    }

    private void ShowFromTray()
    {
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Topmost = true;   // brings the window to the front...
        Topmost = false;  // ...without leaving it above everything
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_exiting) return;
        if (_tray is null)
        {
            // No tray means there is no way back to the window after hiding. Use the exit path
            // that restores DNS before stopping the core instead of closing past it.
            e.Cancel = true;
            ExitApp();
            return;
        }
        e.Cancel = true;
        Hide();
        if (!_trayHintShown)
        {
            _trayHintShown = true;
            try
            {
                _tray.ShowBalloonTip(4000, "StellarDNS is still running",
                    "DNS filtering continues while the window is closed. Right-click the tray icon to open it or exit.",
                    Forms.ToolTipIcon.Info);
            }
            catch { }
        }
    }

    private void OnStateChanged(object? sender, EventArgs e)
    {
        if (WindowState == WindowState.Minimized && _tray is not null) Hide();
    }

    private static async Task<string> GetAsync(string path, int timeoutSeconds = 2)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        return await http.GetStringAsync(Url + path).ConfigureAwait(false);
    }

    private static async Task<bool> PostAsync(string path, string json)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(4) };
        // The core refuses writes that are not application/json — that is the guard which stops
        // a web page from driving this API, so the shell has to send JSON like everyone else.
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using var res = await http.PostAsync(Url + path, content).ConfigureAwait(false);
        return res.IsSuccessStatusCode;
    }

    private static async Task<bool> DnsManagedAsync()
    {
        try { return (await GetAsync("/api/state")).Contains("\"managed\":true"); }
        catch { return false; }
    }

    private static async Task<bool> BlockingOnAsync()
    {
        try { return (await GetAsync("/api/state")).Contains("\"blocking\":true"); }
        catch { return true; }
    }

    private async Task ToggleBlockingAsync()
    {
        try
        {
            var on = await BlockingOnAsync();
            await PostAsync("/api/toggle", on ? "{\"blocking\":false}" : "{\"blocking\":true}");
        }
        catch { }
        await RefreshTrayMenuAsync();
    }

    private async Task RestoreDnsAsync()
    {
        try { await PostAsync("/api/dns/restore", "{}"); } catch { }
        await RefreshTrayMenuAsync();
    }

    private async Task RefreshTrayMenuAsync()
    {
        if (_tray is null) return;
        try
        {
            var state = await GetAsync("/api/state");
            if (_blockingItem is not null)
                _blockingItem.Text = state.Contains("\"blocking\":true") ? "Blocking: on" : "Blocking: paused";
            if (_restoreItem is not null)
                _restoreItem.Enabled = state.Contains("\"managed\":true");
        }
        catch
        {
            if (_blockingItem is not null) _blockingItem.Text = "Blocking: unknown";
            if (_restoreItem is not null) _restoreItem.Enabled = false;
        }
    }

    private async void ExitApp()
    {
        if (_exiting) return;
        _exiting = true;

        // Put the machine's own resolvers back before the core disappears: a takeover that
        // outlives the process would leave Windows pointing at nothing. If the restore fails,
        // stay running rather than turning a DNS problem into a disconnected machine.
        try
        {
            if (await DnsManagedAsync() && !await PostAsync("/api/dns/restore", "{}"))
            {
                _exiting = false;
                MessageBox.Show(
                    "StellarDNS could not restore your previous DNS settings, so it is still running.\n\n" +
                    "Use the tray menu to restore DNS, then exit.",
                    "StellarDNS", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
        }
        catch (Exception ex)
        {
            _exiting = false;
            MessageBox.Show(
                "StellarDNS could not restore your previous DNS settings, so it is still running.\n\n" +
                ex.Message + "\n\nUse the tray menu to restore DNS, then exit.",
                "StellarDNS", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        if (_tray is not null)
        {
            _tray.Visible = false;
            _tray.Dispose();
            _tray = null;
        }
        _trayIcon?.Dispose();
        _trayIcon = null;
        StopCore();
        System.Windows.Application.Current.Shutdown();
    }

    private void StopCore()
    {
        try
        {
            if (_core is { HasExited: false })
            {
                _core.Kill(entireProcessTree: true);
                _core.WaitForExit(4000);
            }
        }
        catch { }
        _core?.Dispose();
        _core = null;
    }
}
