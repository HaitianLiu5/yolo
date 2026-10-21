import Foundation
import Network

/// A Yolo server found on the home network.
public struct DiscoveredServer: Sendable, Hashable, Identifiable {
  public let name: String
  public let address: ServerAddress

  public var id: String { address.origin }
}

/// Finds Yolo on the home network (Agent Note 2026-10-19-client-protocol,
/// Discovery): the media node advertises `_yolo._tcp` with one TXT key,
/// `origin`, the control plane's origin. Anyone on the network can
/// advertise, so the app starts pairing only after the owner confirms the
/// host, and checks it with `/.well-known/yolo` as it checks a typed one.
public enum Bonjour {
  public static let serviceType = "_yolo._tcp"

  /// The servers found so far, each time the list changes, until the stream
  /// is dropped.
  public static func servers() -> AsyncStream<[DiscoveredServer]> {
    AsyncStream { continuation in
      let browser = NWBrowser(for: .bonjourWithTXTRecord(type: serviceType, domain: nil), using: .tcp)
      browser.browseResultsChangedHandler = { results, _ in
        continuation.yield(servers(in: results))
      }
      browser.stateUpdateHandler = { state in
        if case .failed = state { continuation.finish() }
      }
      let box = BrowserBox(browser)
      continuation.onTermination = { _ in box.browser.cancel() }
      browser.start(queue: .main)
    }
  }

  static func servers(in results: Set<NWBrowser.Result>) -> [DiscoveredServer] {
    var byOrigin: [String: DiscoveredServer] = [:]
    for result in results {
      guard case .bonjour(let txt) = result.metadata, let origin = txt["origin"], let address = ServerAddress(origin) else { continue }
      var name = address.host
      if case .service(let service, _, _, _) = result.endpoint { name = service }
      // One server answers once per interface and address family.
      if byOrigin[address.origin] == nil { byOrigin[address.origin] = DiscoveredServer(name: name, address: address) }
    }
    return byOrigin.values.sorted { $0.address.origin < $1.address.origin }
  }
}

private final class BrowserBox: @unchecked Sendable {
  let browser: NWBrowser

  init(_ browser: NWBrowser) {
    self.browser = browser
  }
}
