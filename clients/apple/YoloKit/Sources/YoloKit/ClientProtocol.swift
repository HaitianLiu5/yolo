// The constants of Yolo's client protocol that this client speaks
// (Agent Note 2026-10-19-client-protocol). They mirror
// `service/core/src/protocol.js` and `service/core/src/realtime.js`: the
// number goes up only when the Hub raises CLIENT_PROTOCOL, and the heartbeat
// must stay byte for byte the Hub's HEARTBEAT_PING, which the Durable
// Object's auto-response answers without waking the Hub
// (Agent Note 2026-10-07-hub-and-realtime-channel).
public enum ClientProtocol {
  /// The client protocol number sent in `hello` and on every /v1 request.
  public static let version = 1
  /// The number a server older than the protocol serves: one whose
  /// `/.well-known/yolo` has no `clientProtocols`.
  public static let first = 1
  /// The /v1 request header that names `version`.
  public static let header = "yolo-protocol"
  /// The OAuth client id this app pairs with.
  public static let clientID = "yolo-apple-tv"
  /// The device kind the approval page starts from.
  public static let deviceKind = "tv"

  /// Exactly the Hub's HEARTBEAT_PING.
  public static let heartbeatPing = #"{"v":1,"type":"ping"}"#
  /// Cloudflare closes a WebSocket after 100 seconds without traffic.
  public static let heartbeatInterval: Duration = .seconds(25)
}
