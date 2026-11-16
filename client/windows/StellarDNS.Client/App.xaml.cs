using System.Threading;
using System.Windows;

namespace StellarDNS.Client;

public partial class App : Application
{
    // Two copies fight over 127.0.0.1:53 and :5381. The loser still loads the winner's page,
    // so the user sees a window that looks current while the old core answers - which is
    // exactly how a successful upgrade reads as "nothing changed".
    private static Mutex? _single;

    protected override void OnStartup(StartupEventArgs e)
    {
        _single = new Mutex(true, @"Local\StellarDNS.Client", out var created);
        if (!created)
        {
            MessageBox.Show(
                "StellarDNS is already running.\n\n" +
                "If you have just installed an update, open the tray icon, choose Exit, then " +
                "start StellarDNS again so the new version can replace the old one.",
                "StellarDNS", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }
        base.OnStartup(e);
    }
}
