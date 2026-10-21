import Foundation

/// The socket closed; `code` is its close code, 1006 when it just died.
public struct WebSocketClosed: Error, Sendable, Equatable {
  public let code: Int

  public init(code: Int) {
    self.code = code
  }
}

/// One WebSocket, text frames only.
public protocol WebSocketConnection: Sendable {
  func send(_ text: String) async throws
  /// The next text frame. Throws WebSocketClosed once the socket closed.
  func receive() async throws -> String
  func close(code: Int, reason: String)
}

public protocol WebSocketConnector: Sendable {
  func connect(to url: URL) -> any WebSocketConnection
}

public struct URLSessionWebSocketConnector: WebSocketConnector {
  public let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func connect(to url: URL) -> any WebSocketConnection {
    let task = session.webSocketTask(with: url)
    task.resume()
    return URLSessionWebSocket(task: task)
  }
}

/// URLSessionWebSocketTask reports only the close codes its enum knows, so a
/// Hub's 4003 arrives as 1006 here; the revoked device then learns it from
/// the 401 on its next ticket request.
final class URLSessionWebSocket: WebSocketConnection {
  let task: URLSessionWebSocketTask

  init(task: URLSessionWebSocketTask) {
    self.task = task
  }

  func send(_ text: String) async throws {
    try await task.send(.string(text))
  }

  func receive() async throws -> String {
    while true {
      let message: URLSessionWebSocketTask.Message
      do {
        message = try await task.receive()
      } catch {
        throw WebSocketClosed(code: task.closeCode == .invalid ? 1006 : task.closeCode.rawValue)
      }
      if case .string(let text) = message { return text }
    }
  }

  func close(code: Int, reason: String) {
    task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: Data(reason.utf8))
  }
}
