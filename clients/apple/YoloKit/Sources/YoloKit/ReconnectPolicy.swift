/// Why a realtime connection ended, or never started.
public enum RealtimeDisconnect: Sendable, Equatable {
  /// The socket closed with this code (1006 when it just died).
  case closed(code: Int)
  /// The ticket request failed; `rateLimited` when Yolo said `rate_limited`.
  case ticketFailed(rateLimited: Bool)
  /// A welcome with `upgrade: true`: the Hub no longer serves this client.
  case upgrade
  /// The device was removed: close code 4003, or a 401 for its credential.
  case revoked
}

/// When to connect again, as the player's `realtime.js` decides it
/// (Agent Note 2026-10-07-hub-and-realtime-channel): exponential backoff to
/// 30 seconds, at least 30 seconds after a rate limit (close 1008 or a 429),
/// a minute after an upgrade welcome, and never after a revocation. A
/// welcome starts over.
public struct ReconnectPolicy: Sendable, Equatable {
  public static let maxBackoff: Duration = .seconds(30)
  public static let rateLimitedBackoff: Duration = .seconds(30)
  public static let upgradeRetry: Duration = .seconds(60)
  public static let revokedClose = 4003
  public static let rateLimitedClose = 1008

  public private(set) var attempts = 0

  public init() {}

  public mutating func welcomed() {
    attempts = 0
  }

  /// The wait before the next connection, or nil to stop.
  public mutating func delay(after disconnect: RealtimeDisconnect) -> Duration? {
    switch disconnect {
    case .revoked:
      return nil
    case .closed(let code) where code == Self.revokedClose:
      return nil
    case .upgrade:
      return Self.upgradeRetry
    case .closed(let code):
      return backoff(minimum: code == Self.rateLimitedClose ? Self.rateLimitedBackoff : .zero)
    case .ticketFailed(let rateLimited):
      return backoff(minimum: rateLimited ? Self.rateLimitedBackoff : .zero)
    }
  }

  private mutating func backoff(minimum: Duration) -> Duration {
    attempts += 1
    let exponential = Duration.seconds(1 << min(attempts - 1, 5))
    return max(minimum, min(Self.maxBackoff, exponential))
  }
}
