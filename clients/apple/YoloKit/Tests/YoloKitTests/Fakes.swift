import Foundation
import Synchronization
@testable import YoloKit

/// Answers HTTP requests from a handler and keeps every request it saw.
final class StubTransport: HTTPTransport {
  typealias Handler = @Sendable (URLRequest) throws -> (Int, JSONValue?)
  private let handler: Handler
  private let seen = Mutex<[URLRequest]>([])

  init(_ handler: @escaping Handler) {
    self.handler = handler
  }

  var requests: [URLRequest] { seen.withLock { $0 } }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    seen.withLock { $0.append(request) }
    let (status, body) = try handler(request)
    let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
    return (body.map { $0.encoded() } ?? Data(), response)
  }
}

extension URLRequest {
  /// The form fields of an x-www-form-urlencoded body.
  var formFields: [String: String] {
    let text = String(decoding: httpBody ?? Data(), as: UTF8.self)
    var fields: [String: String] = [:]
    for pair in text.split(separator: "&") {
      let parts = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? String($0) }
      fields[parts[0]] = parts.count > 1 ? parts[1] : ""
    }
    return fields
  }

  var jsonBody: JSONValue? { httpBody.flatMap { try? JSONValue.parse($0) } }
}

/// Records every wait and returns at once; throws once `limit` waits passed,
/// which ends the loop under test.
final class RecordingSleeper: Sendable {
  private let waits = Mutex<[Duration]>([])
  let limit: Int

  init(limit: Int = .max) {
    self.limit = limit
  }

  var recorded: [Duration] { waits.withLock { $0 } }

  var sleeper: Sleeper {
    { duration in
      let count = self.waits.withLock { waits in
        waits.append(duration)
        return waits.count
      }
      if count > self.limit { throw CancellationError() }
      await Task.yield()
    }
  }
}

/// A WebSocket driven by the test: frames it pushes arrive at receive(),
/// and close(code:) ends the socket with that code.
final class FakeSocket: WebSocketConnection {
  private struct State {
    var sent: [String] = []
    var inbox: [String] = []
    var closedWith: Int?
    var waiting: CheckedContinuation<String, Error>?
  }

  private let state = Mutex(State())
  let url: URL

  init(url: URL) {
    self.url = url
  }

  var sent: [String] { state.withLock { $0.sent } }
  var closedWith: Int? { state.withLock { $0.closedWith } }

  func send(_ text: String) async throws {
    try state.withLock { state in
      if let code = state.closedWith { throw WebSocketClosed(code: code) }
      state.sent.append(text)
    }
  }

  func receive() async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      state.withLock { state in
        if !state.inbox.isEmpty {
          continuation.resume(returning: state.inbox.removeFirst())
        } else if let code = state.closedWith {
          continuation.resume(throwing: WebSocketClosed(code: code))
        } else {
          state.waiting = continuation
        }
      }
    }
  }

  /// A frame from the Hub.
  func push(_ text: String) {
    state.withLock { state in
      if let waiting = state.waiting {
        state.waiting = nil
        waiting.resume(returning: text)
      } else {
        state.inbox.append(text)
      }
    }
  }

  func push(_ value: JSONValue) {
    push(value.encodedString())
  }

  func close(code: Int, reason: String) {
    state.withLock { state in
      guard state.closedWith == nil else { return }
      state.closedWith = code
      if let waiting = state.waiting {
        state.waiting = nil
        waiting.resume(throwing: WebSocketClosed(code: code))
      }
    }
  }
}

final class FakeConnector: WebSocketConnector {
  private let made = Mutex<[FakeSocket]>([])

  var sockets: [FakeSocket] { made.withLock { $0 } }

  func connect(to url: URL) -> any WebSocketConnection {
    let socket = FakeSocket(url: url)
    made.withLock { $0.append(socket) }
    return socket
  }
}

/// Polls until `condition` holds, for up to two seconds.
func eventually(_ condition: @Sendable () async -> Bool) async -> Bool {
  for _ in 0..<400 {
    if await condition() { return true }
    try? await Task.sleep(for: .milliseconds(5))
  }
  return await condition()
}

let server = ServerAddress("yolo.example.com")!

/// Shared mutable test state that closures can capture.
final class Locked<Value: Sendable>: Sendable {
  private let mutex: Mutex<Value>

  init(_ value: Value) {
    mutex = Mutex(value)
  }

  func withLock<T: Sendable>(_ body: (inout sending Value) throws -> sending T) rethrows -> T {
    try mutex.withLock(body)
  }
}
