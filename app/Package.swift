// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PRAIReviewer",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "PRAIReviewer",
            path: "Sources/PRAIReviewer"
        ),
    ]
)
