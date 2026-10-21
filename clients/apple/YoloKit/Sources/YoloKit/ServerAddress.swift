import Foundation

/// The owner's Yolo server: an origin and nothing else
/// (Agent Note 2026-10-19-client-protocol, Discovery). The owner types a
/// domain or a workers.dev host, or Bonjour hands over the node's `origin`;
/// either way the client keeps `https://host[:port]`, without a path.
public struct ServerAddress: Sendable, Hashable, Codable, CustomStringConvertible {
  /// `https://host[:port]`, lowercased, with no trailing slash.
  public let origin: String

  /// Reads what the owner typed or Bonjour advertised. A bare host means
  /// https. Plain http is accepted only for this machine (`localhost`,
  /// `127.0.0.1`, `[::1]`), where `wrangler dev` serves; anything with a
  /// path, query, fragment, or user is refused.
  public init?(_ input: String) {
    var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !text.contains(where: \.isWhitespace) else { return nil }
    if !text.contains("://") { text = "https://" + text }
    guard let components = URLComponents(string: text),
          let scheme = components.scheme?.lowercased(),
          let host = components.host?.lowercased(), !host.isEmpty,
          components.user == nil, components.password == nil,
          components.query == nil, components.fragment == nil,
          components.path.isEmpty || components.path == "/"
    else { return nil }
    let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
    guard scheme == "https" || (scheme == "http" && local) else { return nil }
    let shownHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
    let port = components.port.map { ":\($0)" } ?? ""
    let defaultPort = (scheme == "https" && port == ":443") || (scheme == "http" && port == ":80")
    origin = "\(scheme)://\(shownHost)\(defaultPort ? "" : port)"
  }

  /// The host, shown in full when the owner confirms a server found by
  /// Bonjour and again beside the pairing code.
  public var host: String {
    URLComponents(string: origin)?.host ?? origin
  }

  public var description: String { origin }

  /// A URL on this server. `path` starts with "/".
  public func url(_ path: String, query: [URLQueryItem] = []) -> URL {
    var components = URLComponents(string: origin + path)!
    if !query.isEmpty { components.queryItems = query }
    return components.url!
  }

  /// The realtime channel's address for a ticket.
  public func realtimeURL(ticket: String) -> URL {
    var components = URLComponents(string: origin + "/v1/realtime")!
    components.scheme = components.scheme == "http" ? "ws" : "wss"
    components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
    return components.url!
  }
}
