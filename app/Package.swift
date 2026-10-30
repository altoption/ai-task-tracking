// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Tracker",
    platforms: [.macOS(.v13)],
    products: [
        /// The app's executable (Contents/MacOS/AITaskTracking in "AI Task Tracking.app"; see app/build.sh).
        .executable(name: "AITaskTracking", targets: ["Tracker"]),
    ],
    targets: [
        /// Pure, testable helpers (no AppKit): status text, notification rules, deep links, SSE parsing.
        .target(name: "TrackerCore"),
        .executableTarget(name: "Tracker", dependencies: ["TrackerCore"],
                          linkerSettings: [.linkedFramework("Carbon"), .linkedFramework("WebKit")]),
        .testTarget(name: "TrackerCoreTests", dependencies: ["TrackerCore"]),
    ]
)
