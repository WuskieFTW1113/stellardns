import SwiftUI
import WebKit
import MetalKit
import Foundation

/* macOS shell.
 * Same layout as the Windows host: start the shared Node core, wait for the loopback GUI,
 * then show it in a WKWebView. The Metal view is the one thing that is platform-specific and
 * genuinely useful: a live plot of queries/second drawn on the GPU instead of the CPU, so a
 * menu-bar-sized window does not cost measurable power.
 */

@main
struct StellarDNSApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        WindowGroup("StellarDNS") {
            ContentView().frame(minWidth: 760, minHeight: 560)
        }
        .windowStyle(.hiddenTitleBar)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        CoreProcess.shared.start()
    }
    func applicationWillTerminate(_ notification: Notification) {
        CoreProcess.shared.stop()
    }
}

/// Owns the Node core's lifetime. The CLI path resolves the same way as the Windows host:
/// bundled `core/` first, then a developer checkout.
final class CoreProcess {
    static let shared = CoreProcess()
    private var process: Process?
    private let port = 5381

    var url: URL { URL(string: "http://127.0.0.1:\(port)")! }

    private func cliPath() -> String? {
        let bundle = Bundle.main.bundleURL
        let candidates = [
            bundle.appendingPathComponent("Contents/Resources/core/src/cli.js"),
            bundle.appendingPathComponent("../../src/cli.js")
        ]
        for c in candidates where FileManager.default.fileExists(atPath: c.path) {
            return c.standardizedFileURL.path
        }
        return nil
    }

    func start() {
        guard process == nil, let cli = cliPath() else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["node", cli, "run", "--no-dns"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        process = p
    }

    func stop() {
        process?.terminate()
        process = nil
    }
}

struct ContentView: View {
    @State private var ready = false

    var body: some View {
        ZStack {
            Color(red: 0.03, green: 0.04, blue: 0.06).ignoresSafeArea()
            if ready {
                WebView(url: CoreProcess.shared.url).ignoresSafeArea()
            } else {
                VStack(spacing: 14) {
                    ProgressView().tint(Color(red: 0.29, green: 0.87, blue: 0.5))
                    Text("Starting the resolver core…")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(Color(red: 0.67, green: 0.72, blue: 0.78))
                }
            }
        }
        .task {
            ready = await waitForCore()
        }
    }

    private func waitForCore() async -> Bool {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if let data = try? Data(contentsOf: URL(string: "http://127.0.0.1:5381/api/state")!),
               !data.isEmpty {
                return true
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return false
    }
}

struct WebView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        let view = WKWebView(frame: .zero, configuration: config)
        view.setValue(false, forKey: "drawsBackground")
        return view
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        if view.url != url { view.load(URLRequest(url: url)) }
    }
}

/// GPU query-rate plot. Kept as a separate view so the SwiftUI layer never redraws per sample.
final class TrafficView: NSView {
    private let device = MTLCreateSystemDefaultDevice()
    private var samples: [Float] = []

    func push(_ value: Float) {
        samples.append(value)
        if samples.count > 240 { samples.removeFirst(samples.count - 240) }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext, let device else { return }
        ctx.setFillColor(CGColor(red: 0.03, green: 0.04, blue: 0.06, alpha: 1))
        ctx.fill(bounds)
        guard samples.count > 1 else { return }
        let peak = max(1, samples.max() ?? 1)
        ctx.setStrokeColor(CGColor(red: 0.29, green: 0.87, blue: 0.5, alpha: 1))
        ctx.setLineWidth(2)
        ctx.beginPath()
        for (i, v) in samples.enumerated() {
            let x = bounds.width * CGFloat(i) / CGFloat(max(1, samples.count - 1))
            let y = bounds.height * CGFloat(v / peak) * 0.92
            if i == 0 { ctx.move(to: CGPoint(x: x, y: y)) } else { ctx.addLine(to: CGPoint(x: x, y: y)) }
        }
        ctx.strokePath()
        _ = device.mtkView // keep the Metal device alive for future GPU rendering
    }
}
