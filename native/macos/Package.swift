// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "DSHEdgeCompanion",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "EdgeCompanionCore", targets: ["EdgeCompanionCore"]),
        .executable(name: "DSHEdgeCompanion", targets: ["DSHEdgeCompanion"]),
    ],
    targets: [
        .target(name: "EdgeCompanionCore"),
        .executableTarget(
            name: "DSHEdgeCompanion",
            dependencies: ["EdgeCompanionCore"]
        ),
        .testTarget(
            name: "EdgeCompanionCoreTests",
            dependencies: ["EdgeCompanionCore"]
        ),
    ]
)
