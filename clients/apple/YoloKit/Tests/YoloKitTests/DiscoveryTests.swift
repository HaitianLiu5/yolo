import Foundation
import Testing
@testable import YoloKit

@Suite struct ServerAddressTests {
  @Test func readsWhatTheOwnerTypesAsAnHTTPSOrigin() {
    #expect(ServerAddress("yolo.example.com")?.origin == "https://yolo.example.com")
    #expect(ServerAddress("  HTTPS://Yolo.Example.com/ ")?.origin == "https://yolo.example.com")
    #expect(ServerAddress("yolo.example.com:8443")?.origin == "https://yolo.example.com:8443")
    #expect(ServerAddress("https://yolo.example.com:443")?.origin == "https://yolo.example.com")
    #expect(ServerAddress("http://localhost:8787")?.origin == "http://localhost:8787")
  }

  @Test func refusesAnythingButAnOrigin() {
    for input in ["", "http://yolo.example.com", "https://yolo.example.com/device", "yolo.example.com?x=1",
                  "https://user@yolo.example.com", "ftp://yolo.example.com", "yolo example.com"] {
      #expect(ServerAddress(input) == nil, "\(input)")
    }
  }

  @Test func buildsTheRealtimeURLForATicket() {
    #expect(server.realtimeURL(ticket: "hub.secret").absoluteString == "wss://yolo.example.com/v1/realtime?ticket=hub.secret")
    #expect(ServerAddress("http://localhost:8787")!.realtimeURL(ticket: "t").absoluteString == "ws://localhost:8787/v1/realtime?ticket=t")
  }
}

@Suite struct DiscoveryTests {
  private func check(_ body: JSONValue?, status: Int = 200) async throws -> ServerCheck {
    let transport = StubTransport { request in
      #expect(request.url?.absoluteString == "https://yolo.example.com/.well-known/yolo")
      return (status, body)
    }
    return try await Discovery.check(server, transport: transport)
  }

  @Test func aServerThatServesThisProtocolIsReady() async throws {
    let result = try await check(["name": "Yolo", "version": "0.13.0", "clientProtocols": [1, 2]])
    #expect(result == .ready(ServerInfo(address: server, version: "0.13.0", clientProtocols: [1, 2])))
  }

  @Test func aServerOlderThanTheProtocolServesTheFirstNumberAndAsksForAnUpgrade() async throws {
    let result = try await check(["name": "Yolo", "version": "0.8.0"])
    #expect(result == .updateServer(ServerInfo(address: server, version: "0.8.0", clientProtocols: [1])))
  }

  @Test func noSharedNumberSaysWhichSideToUpdate() {
    #expect(ServerCheck.verdict(served: [2, 3], client: 1) == .updateClient)
    #expect(ServerCheck.verdict(served: [1, 2], client: 3) == .updateServer)
    #expect(ServerCheck.verdict(served: [], client: 1) == .updateServer)
  }

  @Test func anAddressThatIsNotYoloIsRefused() async throws {
    #expect(try await check(["name": "Something else"]) == .notYolo)
    #expect(try await check(nil, status: 404) == .notYolo)
  }
}
