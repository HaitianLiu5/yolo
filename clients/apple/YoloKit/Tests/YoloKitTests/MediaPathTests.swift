import Foundation
import Testing
@testable import YoloKit

@Suite struct MediaPathTests {
  static let media = MediaInfo(json: [
    "paths": [
      ["path": "lan", "origin": "https://lan.example.com:8443", "notAfter": 1_900_000_000_000],
      ["path": "wan", "origin": "https://203.0.113.7:8443", "notAfter": 1_900_000_000_000, "home": true],
    ],
    "relayMode": "auto",
  ])

  private func choose(lan: (Int, JSONValue?)?, wan: (Int, JSONValue?)?, media: MediaInfo = media, lanEnabled: Bool = true) async -> (MediaPathChoice, StubTransport) {
    let transport = StubTransport { request in
      let answer = request.url?.host == "lan.example.com" ? lan : wan
      guard let answer else { throw URLError(.timedOut) }
      return answer
    }
    let choice = await MediaPathProber(server: server, transport: transport).choose(media, lanEnabled: lanEnabled)
    return (choice, transport)
  }

  @Test func readsTheWelcomesMedia() {
    let media = Self.media
    #expect(media.lan?.origin == "https://lan.example.com:8443")
    #expect(media.wan?.home == true)
    #expect(media.lan?.notAfter == Date(timeIntervalSince1970: 1_900_000_000))
    #expect(media.relayMode == .auto)
    #expect(media.domain)
    #expect(MediaInfo(json: ["paths": [], "relayMode": "sideways", "domain": false]).relayMode == .auto)
  }

  @Test func probesWithTheServersOriginAndTakesTheLANFirst() async {
    let (choice, transport) = await choose(lan: (200, ["ok": true]), wan: (200, ["ok": true]))
    #expect(choice.path == .lan)
    #expect(transport.requests.count == 2)
    for request in transport.requests {
      #expect(request.url?.path == "/edge/probe")
      #expect(request.value(forHTTPHeaderField: "Origin") == "https://yolo.example.com")
    }
    #expect(transport.requests.first { $0.url?.host == "lan.example.com" }?.timeoutInterval == 2)
  }

  @Test func fallsToTheRemotePathThenTheRelay() async {
    let (remote, _) = await choose(lan: nil, wan: (200, ["ok": true]))
    #expect(remote.path == .wan)
    #expect(remote.probes == [.lan: .timeout, .wan: .ok])
    #expect(remote.hairpin == "ok")

    let (relay, _) = await choose(lan: (404, nil), wan: nil)
    #expect(relay.path == .relay)
    #expect(relay.hairpin == "failed")
  }

  @Test func noPathAtAllWhenTheOwnerTurnedTheRelayOff() async {
    let off = MediaInfo(json: ["paths": [["path": "lan", "origin": "https://lan.example.com:8443"]], "relayMode": "off"])
    let (choice, _) = await choose(lan: nil, wan: nil, media: off)
    #expect(choice.path == nil)
  }

  @Test func theOwnersLANSwitchSkipsTheLANProbe() async {
    let (choice, transport) = await choose(lan: (200, ["ok": true]), wan: (200, ["ok": true]), lanEnabled: false)
    #expect(choice.path == .wan)
    #expect(choice.probes[.lan] == .off)
    #expect(transport.requests.allSatisfy { $0.url?.host != "lan.example.com" })
  }

  @Test func theNetworkReportNamesThePathAndEachProbe() {
    let choice = MediaPathChoice(path: .wan, probes: [.lan: .timeout, .wan: .ok], hairpin: "ok")
    #expect(JSONValue.object(choice.networkFields(reason: "probe")) == [
      "path": "wan", "reason": "probe", "probes": ["lan": "timeout", "wan": "ok"], "hairpin": "ok",
    ])
    let none = MediaPathChoice(path: nil, probes: [:], hairpin: nil)
    #expect(none.networkFields(reason: "probe")["path"] == .null)
  }
}
