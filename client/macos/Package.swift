// swift-tools-version:5.9
import PackageDescription

// macOS shell: SwiftUI chrome around the shared GUI, with a Metal-backed traffic view.
// Universal binary — build twice and lipo, or `swift build --arch arm64 --arch x86_64`.
let package = Package(
    name: "StellarDNS",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "StellarDNS", targets: ["StellarDNS"])
    ],
    targets: [
        .executableTarget(
            name: "StellarDNS",
            path: "Sources/StellarDNS",
            linkerSettings: [
                .linkedFramework("Metal"),
                .linkedFramework("WebKit")
            ]
        )
    ]
)
