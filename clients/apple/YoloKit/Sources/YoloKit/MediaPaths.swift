import Foundation

/// The paths media takes from the node to this screen, best first
/// (Agent Note 2026-10-13-media-off-the-worker).
public enum MediaPath: String, Sendable, CaseIterable, Comparable {
  case lan
  case wan
  case relay

  public static func < (lhs: MediaPath, rhs: MediaPath) -> Bool {
    allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
  }
}

/// The owner's mode for the Worker's relay: `auto` and `on` allow it as the
/// last path, `off` never.
public enum RelayMode: String, Sendable {
  case auto
  case on
  case off
}

/// One of the node's media listeners a welcome lists.
public struct MediaListener: Sendable, Equatable {
  public let path: MediaPath
  public let origin: String
  public let notAfter: Date?
  /// On `wan`: this screen connected from the home's own public address.
  public let home: Bool
}

/// A welcome's or a `media` message's `media`:
/// `{ paths: [{ path, origin, notAfter, home? }], relayMode, domain? }`.
public struct MediaInfo: Sendable, Equatable {
  public let lan: MediaListener?
  public let wan: MediaListener?
  public let relayMode: RelayMode
  /// False on an instance without a domain.
  public let domain: Bool

  public var relay: Bool { relayMode != .off }

  public init(json: JSONValue) {
    var lan: MediaListener?
    var wan: MediaListener?
    for entry in json["paths"]?.array ?? [] {
      guard let path = entry["path"]?.string.flatMap(MediaPath.init(rawValue:)), path != .relay,
            let origin = entry["origin"]?.string
      else { continue }
      let notAfter = entry["notAfter"]?.number.map { Date(timeIntervalSince1970: $0 / 1000) }
      let listener = MediaListener(path: path, origin: origin, notAfter: notAfter, home: path == .wan && entry["home"]?.bool == true)
      if path == .lan { lan = listener } else { wan = listener }
    }
    self.lan = lan
    self.wan = wan
    // A mode missing or unknown is `auto`, as the Hub takes it.
    relayMode = json["relayMode"]?.string.flatMap(RelayMode.init(rawValue:)) ?? .auto
    domain = json["domain"]?.bool != false
  }

  public func listener(_ path: MediaPath) -> MediaListener? {
    switch path {
    case .lan: lan
    case .wan: wan
    case .relay: nil
    }
  }
}

/// How one probe went, in the words `network` reports carry.
public enum ProbeOutcome: Sendable, Equatable {
  case ok
  case timeout
  case failed
  case certificate
  /// The owner turned "Play over the home network" off on this screen.
  case off
  case http(Int)

  public var wireValue: String {
    switch self {
    case .ok: "ok"
    case .timeout: "timeout"
    case .failed: "failed"
    case .certificate: "certificate"
    case .off: "off"
    case .http(let status): "http_\(status)"
    }
  }
}

/// The path a round of probes chose.
public struct MediaPathChoice: Sendable, Equatable {
  /// Nil when no path works and the relay is off.
  public let path: MediaPath?
  public let probes: [MediaPath: ProbeOutcome]
  /// From a screen the welcome placed at home: whether the router loops
  /// back to the home's public address (`ok` or `failed`).
  public let hairpin: String?

  /// The path below `path` that the last probes found working, else the
  /// relay when it is allowed: where a stream that failed on `path` goes.
  public func below(_ path: MediaPath, relay: Bool) -> MediaPath? {
    for next in MediaPath.allCases where next > path {
      if next == .relay { return relay ? .relay : nil }
      if probes[next] == .ok { return next }
    }
    return nil
  }

  /// The same probes with the stream's path moved down to `path`.
  public func movedDown(to path: MediaPath?) -> MediaPathChoice {
    MediaPathChoice(path: path, probes: probes, hairpin: hairpin)
  }

  /// The `network` report for this choice.
  public func networkFields(reason: String) -> [String: JSONValue] {
    var fields: [String: JSONValue] = [
      "path": path.map { .string($0.rawValue) } ?? .null,
      "reason": .string(reason),
      "probes": .object(Dictionary(uniqueKeysWithValues: probes.map { ($0.key.rawValue, JSONValue.string($0.value.wireValue)) })),
    ]
    if let hairpin { fields["hairpin"] = .string(hairpin) }
    return fields
  }
}

/// Probes the node's media listeners as the player's `media-paths.js` does:
/// every listener at once, each with its timeout, and the first that
/// answers in the order lan, wan, relay wins. A native client sets the
/// probe's `Origin` itself, the server's origin, since a media origin known
/// by its IP address answers the probe only to that origin
/// (Agent Note 2026-10-19-client-protocol, Media).
public struct MediaPathProber: Sendable {
  public static let timeouts: [MediaPath: TimeInterval] = [.lan: 2, .wan: 5]

  public let server: ServerAddress
  public let transport: any HTTPTransport
  public let now: @Sendable () -> Date

  public init(server: ServerAddress, transport: any HTTPTransport = URLSessionTransport(), now: @escaping @Sendable () -> Date = { Date() }) {
    self.server = server
    self.transport = transport
    self.now = now
  }

  public func probe(_ listener: MediaListener, timeout: TimeInterval? = nil) async -> ProbeOutcome {
    guard let url = URL(string: listener.origin + "/edge/probe") else { return .failed }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout ?? Self.timeouts[listener.path] ?? 5)
    request.setValue(server.origin, forHTTPHeaderField: "Origin")
    do {
      let (data, response) = try await transport.data(for: request)
      guard response.statusCode == 200 else { return .http(response.statusCode) }
      return data.json?["ok"]?.bool == true ? .ok : .http(response.statusCode)
    } catch let error as URLError {
      if error.code == .timedOut { return .timeout }
      if let notAfter = listener.notAfter, notAfter <= now() { return .certificate }
      switch error.code {
      case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
           .serverCertificateHasUnknownRoot, .secureConnectionFailed:
        return .certificate
      default:
        return .failed
      }
    } catch {
      return .failed
    }
  }

  /// One round. `lanEnabled` is the owner's "Play over the home network"
  /// switch for this screen; `lanTimeout` replaces the LAN probe's 2 seconds,
  /// as for a first probe the system's local network prompt may hold.
  public func choose(_ media: MediaInfo, lanEnabled: Bool = true, lanTimeout: TimeInterval? = nil) async -> MediaPathChoice {
    var probes: [MediaPath: ProbeOutcome] = [:]
    await withTaskGroup(of: (MediaPath, ProbeOutcome).self) { group in
      for listener in [media.lan, media.wan].compactMap({ $0 }) {
        if listener.path == .lan && !lanEnabled {
          probes[.lan] = .off
          continue
        }
        group.addTask { (listener.path, await probe(listener, timeout: listener.path == .lan ? lanTimeout : nil)) }
      }
      for await (path, outcome) in group { probes[path] = outcome }
    }
    let hairpin: String? = media.wan?.home == true ? Self.hairpin(probes[.wan]) : nil
    return MediaPathChoice(path: Self.pick(probes, relay: media.relay), probes: probes, hairpin: hairpin)
  }

  /// The first path in order whose probe answered, else the relay when it
  /// is allowed.
  public static func pick(_ probes: [MediaPath: ProbeOutcome], relay: Bool) -> MediaPath? {
    if probes[.lan] == .ok { return .lan }
    if probes[.wan] == .ok { return .wan }
    return relay ? .relay : nil
  }

  static func hairpin(_ outcome: ProbeOutcome?) -> String? {
    switch outcome {
    case .ok: "ok"
    case .timeout, .failed: "failed"
    default: nil
    }
  }
}
