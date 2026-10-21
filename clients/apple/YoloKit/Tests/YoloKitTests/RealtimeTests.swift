import Foundation
import Synchronization
import Testing
@testable import YoloKit

@Suite struct ReconnectPolicyTests {
  @Test func backsOffExponentiallyToThirtySecondsAndStartsOverAfterAWelcome() {
    var policy = ReconnectPolicy()
    let delays = (0..<7).map { _ in policy.delay(after: .closed(code: 1006)) }
    #expect(delays == [1, 2, 4, 8, 16, 30, 30].map { Duration.seconds($0) })
    policy.welcomed()
    #expect(policy.delay(after: .ticketFailed(rateLimited: false)) == .seconds(1))
  }

  @Test func waitsThirtySecondsAfterARateLimitAndAMinuteAfterAnUpgrade() {
    var policy = ReconnectPolicy()
    #expect(policy.delay(after: .closed(code: 1008)) == .seconds(30))
    #expect(policy.delay(after: .ticketFailed(rateLimited: true)) == .seconds(30))
    #expect(policy.delay(after: .upgrade) == .seconds(60))
  }

  @Test func stopsForARevokedDevice() {
    var policy = ReconnectPolicy()
    #expect(policy.delay(after: .closed(code: 4003)) == nil)
    #expect(policy.delay(after: .revoked) == nil)
  }
}

@Suite struct RealtimeConnectionTests {
  static let capabilities = Capabilities.appleTV(maxHeight: 2160, decodesHEVC: true)

  struct Harness {
    let connector = FakeConnector()
    let sleeper: RecordingSleeper
    let transport: StubTransport
    let connection: RealtimeConnection
    let events: Locked<[RealtimeEvent]>

    init(ticketStatus: Int = 200, sleeperLimit: Int = .max, heartbeat: Duration = .seconds(25)) {
      let sleeper = RecordingSleeper(limit: sleeperLimit)
      let transport = StubTransport { _ in
        ticketStatus == 200 ? (200, ["ticket": "hub.secret"]) : (ticketStatus, ["error": ["code": ticketStatus == 429 ? "rate_limited" : "internal", "message": "no"]])
      }
      let api = APIClient(address: server, credential: DeviceCredential(token: "ydt_t", deviceId: "dev-1"), transport: transport)
      self.sleeper = sleeper
      self.transport = transport
      self.connection = RealtimeConnection(
        api: api, connector: connector,
        hello: { Hello(name: "Living Room", capabilities: RealtimeConnectionTests.capabilities) },
        sleep: sleeper.sleeper, heartbeatInterval: heartbeat
      )
      let events = Locked<[RealtimeEvent]>([])
      self.events = events
      let stream = connection.events
      Task { for await event in stream { events.withLock { $0.append(event) } } }
    }

    func socket(_ index: Int = 0) async -> FakeSocket? {
      _ = await eventually { connector.sockets.count > index && !connector.sockets[index].sent.isEmpty }
      return connector.sockets.count > index ? connector.sockets[index] : nil
    }

    var messages: [RealtimeMessage] {
      events.withLock { $0.compactMap { if case .message(let message, _) = $0 { message } else { nil } } }
    }
  }

  @Test func helloComesFirstWithTheProtocolTheDeviceAndItsCapabilities() async throws {
    let harness = Harness()
    await harness.connection.start()
    let socket = try #require(await harness.socket())
    #expect(socket.url.absoluteString == "wss://yolo.example.com/v1/realtime?ticket=hub.secret")
    let hello = try JSONValue.parse(try #require(socket.sent.first))
    #expect(hello["type"] == "hello")
    #expect(hello["v"] == 1)
    #expect(hello["protocol"] == .number(Double(ClientProtocol.version)))
    #expect(hello["deviceId"] == "dev-1")
    #expect(hello["kind"] == "tv")
    #expect(hello["capabilities"]?["renderer"] == "native")
    #expect(hello["capabilities"]?["video"] == ["avc1", "hvc1"])
    #expect(hello["capabilities"]?["maxHeight"] == 2160)
    await harness.connection.stop()
  }

  @Test func acknowledgesCommandsAndNeverAnswersBroadcasts() async throws {
    let harness = Harness()
    await harness.connection.start()
    let socket = try #require(await harness.socket())
    socket.push(["v": 1, "type": "welcome", "deviceId": "dev-1", "state": ["status": "idle"]])
    socket.push(["v": 1, "type": "state", "state": ["status": "idle"]])
    socket.push(["v": 1, "type": "pause", "id": "cmd-1", "sessionId": "s1"])
    #expect(await eventually { harness.messages.count == 3 })
    #expect(await harness.connection.isReady)
    #expect(socket.sent.dropFirst().map { try? JSONValue.parse($0) } == [["v": 1, "type": "ack", "id": "cmd-1"]])
    let welcomedFlags = harness.events.withLock { $0.compactMap { if case .message(_, let welcomed) = $0 { welcomed } else { nil } } }
    #expect(welcomedFlags == [false, true, true])
    await harness.connection.stop()
  }

  @Test func confirmPingsOnlyAWelcomedConnectionAndHearsItsPong() async throws {
    let harness = Harness()
    await harness.connection.start()
    let socket = try #require(await harness.socket())
    #expect(await harness.connection.confirm({}) == false)
    socket.push(["v": 1, "type": "welcome", "deviceId": "dev-1"])
    #expect(await eventually { await harness.connection.isReady })
    let heard = Locked(0)
    #expect(await harness.connection.confirm { heard.withLock { $0 += 1 } })
    #expect(socket.sent.last == #"{"v":1,"type":"ping"}"#)
    #expect(heard.withLock { $0 } == 0)
    socket.push(#"{"v":1,"type":"pong"}"#)
    #expect(await eventually { heard.withLock { $0 } == 1 })
    #expect(harness.messages.allSatisfy { $0.type != "pong" })
    await harness.connection.stop()
  }

  @Test func sendsTheHeartbeatExactlyAsTheHubExpects() async throws {
    let harness = Harness(heartbeat: .milliseconds(20))
    await harness.connection.start()
    let socket = try #require(await harness.socket())
    #expect(await eventually { socket.sent.count >= 3 })
    #expect(socket.sent.dropFirst().allSatisfy { $0 == #"{"v":1,"type":"ping"}"# })
    await harness.connection.stop()
  }

  @Test func waitsThirtySecondsAfterTheHubClosesForARateLimit() async throws {
    let harness = Harness()
    await harness.connection.start()
    let first = try #require(await harness.socket())
    first.close(code: 1008, reason: "rate_limited")
    #expect(await harness.socket(1) != nil)
    #expect(harness.sleeper.recorded == [.seconds(30)])
    await harness.connection.stop()
  }

  @Test func anUpgradeWelcomeAsksForAnUpdateAndWaitsAMinute() async throws {
    let harness = Harness()
    await harness.connection.start()
    let socket = try #require(await harness.socket())
    socket.push(["v": 1, "type": "welcome", "upgrade": true, "clientProtocols": [2, 3]])
    #expect(await eventually { harness.events.withLock { $0.contains(.upgradeRequired(clientProtocols: [2, 3])) } })
    #expect(await harness.connection.isReady == false)
    socket.close(code: 1000, reason: "")
    #expect(await harness.socket(1) != nil)
    #expect(harness.sleeper.recorded == [.seconds(60)])
    await harness.connection.stop()
  }

  @Test func aRemovedDeviceStopsAndSaysSo() async throws {
    let harness = Harness(ticketStatus: 401)
    await harness.connection.start()
    #expect(await eventually { harness.events.withLock { $0.contains(.revoked) } })
    #expect(harness.connector.sockets.isEmpty)
    #expect(harness.sleeper.recorded.isEmpty)
  }

  @Test func aRateLimitedTicketWaitsThirtySeconds() async throws {
    let harness = Harness(ticketStatus: 429, sleeperLimit: 1)
    await harness.connection.start()
    #expect(await eventually { harness.sleeper.recorded.count == 2 })
    #expect(harness.sleeper.recorded == [.seconds(30), .seconds(30)])
  }
}
