#if DEBUG
import Foundation
import YoloKit

/// The conformance kit's hook into a debug build (Agent Note
/// 2026-10-19-client-protocol, Deferred): launched with
/// `-YoloConformanceURL <kit>`, the app pairs with the kit's scripted server
/// at that address, keeps its pairing in memory, and keeps a WebSocket open
/// to the kit's `/debug`, apart from the realtime channel, so the kit can ask
/// what the screen shows before pairing and after a 4003. The kit sends
/// `{ "v": 1, "type": "debug_state" }`; the app answers
/// `{ v: 1, type: "debug_state", screen, sessionId, paused, position,
/// subtitles, active, shown }`. A release build has none of this.
enum Conformance {
  /// The kit's address, when this launch is a conformance run.
  static var url: String? {
    UserDefaults.standard.string(forKey: "YoloConformanceURL")
  }
}

@MainActor
final class DebugChannel {
  private let url: URL
  private let snapshot: @MainActor () -> JSONValue
  private var task: URLSessionWebSocketTask?

  init?(kit: String, snapshot: @escaping @MainActor () -> JSONValue) {
    guard var components = URLComponents(string: kit) else { return nil }
    components.scheme = components.scheme == "https" ? "wss" : "ws"
    components.path = "/debug"
    guard let url = components.url else { return nil }
    self.url = url
    self.snapshot = snapshot
  }

  func start() {
    Task { await run() }
  }

  private func run() async {
    while !Task.isCancelled {
      let task = URLSession.shared.webSocketTask(with: url)
      self.task = task
      task.resume()
      while true {
        guard let message = try? await task.receive() else { break }
        guard case .string(let text) = message, let request = RealtimeMessage(text: text), request.type == "debug_state" else { continue }
        var answer = snapshot().object ?? [:]
        answer["v"] = 1
        answer["type"] = "debug_state"
        try? await task.send(.string(JSONValue.object(answer).encodedString()))
      }
      try? await Task.sleep(for: .seconds(1))
    }
  }
}
#endif
