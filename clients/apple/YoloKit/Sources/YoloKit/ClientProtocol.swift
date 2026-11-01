// The constants of Yolo's client protocol that this client speaks
// (Agent Note 2026-10-19-client-protocol). They mirror
// `service/core/src/protocol.js` and `service/core/src/realtime.js`: the
// number goes up only when the Hub raises CLIENT_PROTOCOL, and the heartbeat
// must stay byte for byte the Hub's HEARTBEAT_PING, which the Durable
// Object's auto-response answers without waking the Hub
// (Agent Note 2026-10-07-hub-and-realtime-channel).
public enum ClientProtocol {
  /// The client protocol number sent in `hello` and on every /v1 request:
  /// 2, every screen's own session (Agent Note 2026-10-31-screen-sessions).
  public static let version = 2
  /// The number a server older than the protocol serves: one whose
  /// `/.well-known/yolo` has no `clientProtocols`.
  public static let first = 1
  /// The /v1 request header that names `version`.
  public static let header = "yolo-protocol"

  /// Exactly the Hub's HEARTBEAT_PING.
  public static let heartbeatPing = #"{"v":1,"type":"ping"}"#
  /// Cloudflare closes a WebSocket after 100 seconds without traffic.
  public static let heartbeatInterval: Duration = .seconds(25)
}

/// Which Apple client pairs: the OAuth client id it pairs with and the
/// device kind the approval page starts from and `hello` names
/// (Agent Note 2026-10-23-iphone-and-ipad-client).
public struct ClientIdentity: Sendable, Equatable {
  public let clientID: String
  public let kind: String

  public init(clientID: String, kind: String) {
    self.clientID = clientID
    self.kind = kind
  }

  public static let appleTV = ClientIdentity(clientID: "yolo-apple-tv", kind: "tv")
  /// iPhone and iPad alike.
  public static let iPhone = ClientIdentity(clientID: "yolo-apple-ios", kind: "phone")
}
