import Foundation

/// What `/.well-known/yolo` says about a server.
public struct ServerInfo: Sendable, Equatable {
  public let address: ServerAddress
  public let version: String?
  /// Every client protocol number the Hub serves.
  public let clientProtocols: [Int]
}

/// Whether this client can pair with and play from a server
/// (Agent Note 2026-10-19-client-protocol, Versions and Discovery).
public enum ServerCheck: Sendable, Equatable {
  /// It is Yolo and serves this client's protocol.
  case ready(ServerInfo)
  /// The server serves only newer protocols: the owner updates this app.
  case updateClient(ServerInfo)
  /// The server serves only older protocols: the owner upgrades Yolo.
  case updateServer(ServerInfo)
  /// The address answered, but not as Yolo.
  case notYolo

  /// What a server serving `served` means for a client speaking `client`.
  public static func verdict(served: [Int], client: Int = ClientProtocol.version) -> Verdict {
    if served.contains(client) { return .ready }
    guard let newest = served.max() else { return .updateServer }
    return newest < client ? .updateServer : .updateClient
  }

  public enum Verdict: Sendable, Equatable { case ready, updateClient, updateServer }
}

public enum Discovery {
  /// Reads `https://<address>/.well-known/yolo` and checks that it is Yolo
  /// and serves this client's protocol. A server older than the protocol
  /// lists no `clientProtocols` and counts as serving the first number.
  /// Throws only when the address cannot be reached.
  public static func check(_ address: ServerAddress, transport: any HTTPTransport = URLSessionTransport()) async throws -> ServerCheck {
    var request = URLRequest(url: address.url("/.well-known/yolo"), timeoutInterval: 10)
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data, response) = try await transport.data(for: request)
    guard response.statusCode == 200, let body = data.json, body["name"]?.string == "Yolo" else { return .notYolo }
    let served = body["clientProtocols"]?.array?.compactMap(\.int) ?? [ClientProtocol.first]
    let info = ServerInfo(address: address, version: body["version"]?.string, clientProtocols: served)
    switch ServerCheck.verdict(served: served) {
    case .ready: return .ready(info)
    case .updateClient: return .updateClient(info)
    case .updateServer: return .updateServer(info)
    }
  }
}
