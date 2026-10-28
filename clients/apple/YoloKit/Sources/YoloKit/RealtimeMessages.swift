import Foundation

/// One message on the realtime channel: the envelope `{ v: 1, type, id?, … }`
/// (Agent Note 2026-10-07-hub-and-realtime-channel), with every field kept.
public struct RealtimeMessage: Sendable, Equatable {
  public let type: String
  public let id: String?
  public let fields: JSONValue

  /// Parses a text frame. Nil for anything that is not a version 1 message.
  public init?(text: String) {
    guard let value = try? JSONValue.parse(text), value["v"]?.int == 1, let type = value["type"]?.string else { return nil }
    self.type = type
    self.id = value["id"]?.string
    self.fields = value
  }

  public subscript(key: String) -> JSONValue? { fields[key] }

  /// The Hub's broadcasts, which a screen never answers.
  public static let broadcasts: Set<String> = ["state", "queue", "playlists", "devices"]

  public var isBroadcast: Bool { Self.broadcasts.contains(type) }
}

/// The screen's `hello`, its first message on every connection.
public struct Hello: Sendable, Equatable {
  public var deviceId: String?
  public var name: String
  public var kind: String
  public var capabilities: Capabilities

  public init(deviceId: String? = nil, name: String, kind: String = ClientProtocol.deviceKind, capabilities: Capabilities) {
    self.deviceId = deviceId
    self.name = name
    self.kind = kind
    self.capabilities = capabilities
  }

  public func encoded() -> String {
    struct Wire: Encodable {
      let v = 1
      let type = "hello"
      let `protocol` = ClientProtocol.version
      let deviceId: String?
      let name: String
      let kind: String
      let capabilities: Capabilities
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    let data = try! encoder.encode(Wire(deviceId: deviceId, name: name, kind: kind, capabilities: capabilities))
    return String(decoding: data, as: UTF8.self)
  }
}

/// What the Hub's `welcome` says. A welcome with `upgrade: true` carries only
/// `clientProtocols`: the Hub no longer serves this client
/// (Agent Note 2026-10-19-client-protocol, Versions).
public struct Welcome: Sendable, Equatable {
  public let deviceId: String?
  public let upgrade: Bool
  public let clientProtocols: [Int]
  public let state: JSONValue?
  public let queue: JSONValue?
  public let playlists: JSONValue?
  /// The last pause or resume and seek the Hub sent for `state`'s stream
  /// (Agent Note 2026-10-07-hub-and-realtime-channel, What a dead
  /// connection takes).
  public let commands: JSONValue?
  public let media: MediaInfo?
  /// This screen's agent canvas, `{ rev, objects }`, when it declared one
  /// (Agent Note 2026-10-21-agent-canvas).
  public let canvas: JSONValue?

  public init?(_ message: RealtimeMessage) {
    guard message.type == "welcome" else { return nil }
    let fields = message.fields
    deviceId = fields["deviceId"]?.string
    upgrade = fields["upgrade"]?.bool ?? false
    clientProtocols = fields["clientProtocols"]?.array?.compactMap(\.int) ?? []
    state = fields["state"]
    queue = fields["queue"]
    playlists = fields["playlists"]
    commands = fields["commands"]
    media = fields["media"].map(MediaInfo.init(json:))
    canvas = fields["canvas"]
  }
}
