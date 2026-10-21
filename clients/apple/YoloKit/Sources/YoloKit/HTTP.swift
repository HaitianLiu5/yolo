import Foundation

/// How YoloKit reaches the network. The app uses URLSession; tests answer
/// requests themselves.
public protocol HTTPTransport: Sendable {
  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
  public let session: URLSession

  public init(session: URLSession = .shared) {
    self.session = session
  }

  public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return (data, http)
  }
}

/// How YoloKit waits: `Task.sleep` in the app, instant in tests. Throws
/// CancellationError when the task is cancelled.
public typealias Sleeper = @Sendable (Duration) async throws -> Void

public let taskSleeper: Sleeper = { duration in try await Task.sleep(for: duration) }

/// A refusal from Yolo, in /v1's error shape
/// `{ error: { code, message, retryable, details? } }`
/// (Agent Note 2026-10-07-v1-http-api).
public struct YoloAPIError: Error, Sendable, Equatable, CustomStringConvertible {
  public let code: String
  public let message: String
  public let status: Int
  public let retryable: Bool
  public let details: JSONValue?

  public init(code: String, message: String, status: Int, retryable: Bool = false, details: JSONValue? = nil) {
    self.code = code
    self.message = message
    self.status = status
    self.retryable = retryable
    self.details = details
  }

  /// The device was removed: its credential is gone, so it pairs again.
  public var isUnauthorized: Bool { code == "unauthorized" }

  public var description: String { "\(code): \(message)" }

  static func from(status: Int, body: JSONValue?, label: String) -> YoloAPIError {
    if status == 401 {
      return YoloAPIError(code: "unauthorized", message: "This device is no longer paired", status: 401)
    }
    let error = body?["error"]
    return YoloAPIError(
      code: error?["code"]?.string ?? (status == 429 ? "rate_limited" : "internal"),
      message: error?["message"]?.string ?? "\(label) failed with \(status)",
      status: status,
      retryable: error?["retryable"]?.bool ?? false,
      details: error?["details"].flatMap { $0.isNull ? nil : $0 }
    )
  }
}

enum FormBody {
  // RFC 3986 unreserved characters; everything else is percent-encoded.
  private static let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

  static func encode(_ fields: KeyValuePairs<String, String>) -> Data {
    let pairs = fields.map { key, value in
      "\(key.addingPercentEncoding(withAllowedCharacters: allowed)!)=\(value.addingPercentEncoding(withAllowedCharacters: allowed)!)"
    }
    return Data(pairs.joined(separator: "&").utf8)
  }
}

extension Data {
  /// The body as JSON, or nil when it is empty or not JSON.
  var json: JSONValue? { isEmpty ? nil : try? JSONValue.parse(self) }
}
