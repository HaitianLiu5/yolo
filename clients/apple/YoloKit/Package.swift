// swift-tools-version: 6.0
import PackageDescription

// Yolo's client protocol in Swift (Agent Note 2026-10-19-client-protocol):
// discovery, pairing, /v1, the realtime channel, and media paths, apart from
// any UI, so the tvOS app and the iPhone and iPad app share it.
let package = Package(
  name: "YoloKit",
  platforms: [.tvOS(.v18), .iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "YoloKit", targets: ["YoloKit"]),
  ],
  targets: [
    .target(name: "YoloKit"),
  ]
)
