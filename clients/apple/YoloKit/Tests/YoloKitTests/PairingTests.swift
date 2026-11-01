import Foundation
import Synchronization
import Testing
@testable import YoloKit

@Suite struct PairingTests {
  static let authorization: JSONValue = [
    "device_code": "dc-1", "user_code": "BCDF-GHJK",
    "verification_uri": "https://yolo.example.com/device",
    "verification_uri_complete": "https://yolo.example.com/device?code=BCDF-GHJK",
    "expires_in": 600, "interval": 5,
  ]

  @Test func asksForACodeAsTheAppleTVClient() async throws {
    let transport = StubTransport { _ in (200, Self.authorization) }
    let pairing = PairingClient(address: server, deviceName: "Living Room", transport: transport)
    let code = try await pairing.start()
    #expect(code.userCode == "BCDF-GHJK")
    #expect(code.verificationURIComplete == "https://yolo.example.com/device?code=BCDF-GHJK")
    let request = try #require(transport.requests.first)
    #expect(request.url?.path == "/oauth/device_authorization")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded")
    #expect(request.formFields == ["client_id": "yolo-apple-tv", "device_name": "Living Room", "device_kind": "tv"])
  }

  @Test func anIPhonePairsAsAPhoneWithItsOwnClientId() async throws {
    let transport = StubTransport { _ in (200, Self.authorization) }
    let pairing = PairingClient(address: server, deviceName: "Pocket", identity: .iPhone, transport: transport)
    _ = try await pairing.start()
    let request = try #require(transport.requests.first)
    #expect(request.formFields == ["client_id": "yolo-apple-ios", "device_name": "Pocket", "device_kind": "phone"])
  }

  @Test func pollsAtTheIntervalSlowsDownWhenToldAndKeepsTheCredential() async throws {
    let answers = Locked<[JSONValue]>([["error": "authorization_pending"], ["error": "slow_down"], ["access_token": "ydt_secret", "token_type": "Bearer", "device_id": "dev-1"]])
    let transport = StubTransport { request in
      if request.url?.path == "/oauth/device_authorization" { return (200, Self.authorization) }
      #expect(request.formFields == ["grant_type": PairingClient.grantType, "device_code": "dc-1", "client_id": "yolo-apple-tv"])
      let answer = answers.withLock { $0.removeFirst() }
      return (answer["access_token"] == nil ? 400 : 200, answer)
    }
    let sleeper = RecordingSleeper()
    let events = Locked<[PairingEvent]>([])
    let pairing = PairingClient(address: server, deviceName: "TV", transport: transport, sleep: sleeper.sleeper)
    let credential = try await pairing.pair { event in events.withLock { $0.append(event) } }
    #expect(credential == DeviceCredential(token: "ydt_secret", deviceId: "dev-1"))
    #expect(sleeper.recorded == [.seconds(5), .seconds(5), .seconds(10)])
    #expect(events.withLock { $0.count } == 1)
  }

  @Test func anExpiredOrDeniedCodeIsReplacedByANewOne() async throws {
    let starts = Locked(0)
    let polls = Locked<[JSONValue]>([["error": "access_denied"], ["error": "expired_token"], ["access_token": "ydt_x", "device_id": "d"]])
    let transport = StubTransport { request in
      if request.url?.path == "/oauth/device_authorization" {
        starts.withLock { $0 += 1 }
        return (200, Self.authorization)
      }
      let answer = polls.withLock { $0.removeFirst() }
      return (answer["access_token"] == nil ? 400 : 200, answer)
    }
    let events = Locked<[PairingEvent]>([])
    let pairing = PairingClient(address: server, deviceName: "TV", transport: transport, sleep: RecordingSleeper().sleeper)
    _ = try await pairing.pair { event in events.withLock { $0.append(event) } }
    #expect(starts.withLock { $0 } == 3)
    #expect(events.withLock { $0.filter { $0 == .denied }.count } == 1)
  }

  @Test func aRefusalIsShownAndTriedAgain() async throws {
    let transport = StubTransport { _ in (400, ["error": "invalid_request", "error_description": "Register a passkey first"]) }
    let sleeper = RecordingSleeper(limit: 1)
    let events = Locked<[PairingEvent]>([])
    let pairing = PairingClient(address: server, deviceName: "TV", transport: transport, sleep: sleeper.sleeper)
    await #expect(throws: CancellationError.self) {
      _ = try await pairing.pair { event in events.withLock { $0.append(event) } }
    }
    #expect(events.withLock { $0 } == [.refused("Register a passkey first"), .refused("Register a passkey first")])
    #expect(sleeper.recorded == [.seconds(15), .seconds(15)])
  }
}

@Suite struct APIClientTests {
  @Test func everyCallCarriesTheCredentialAndTheClientProtocol() async throws {
    let transport = StubTransport { _ in (200, ["ticket": "hub.secret"]) }
    let api = APIClient(address: server, credential: DeviceCredential(token: "ydt_t", deviceId: "d"), transport: transport)
    #expect(try await api.realtimeTicket() == "hub.secret")
    let request = try #require(transport.requests.first)
    #expect(request.httpMethod == "POST")
    #expect(request.url?.absoluteString == "https://yolo.example.com/v1/realtime/ticket")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ydt_t")
    #expect(request.value(forHTTPHeaderField: "yolo-protocol") == "2")
  }

  @Test func refusalsCarryTheServersCodeAndA401MeansUnpaired() async throws {
    let status = Locked(400)
    let transport = StubTransport { _ in
      (status.withLock { $0 }, ["error": ["code": "invalid_request", "message": "No such item", "retryable": false]])
    }
    let api = APIClient(address: server, credential: DeviceCredential(token: "t", deviceId: nil), transport: transport)
    await #expect(throws: YoloAPIError(code: "invalid_request", message: "No such item", status: 400)) {
      try await api.request("/v1/items/x")
    }
    status.withLock { $0 = 401 }
    do {
      try await api.request("/v1/items/x")
      Issue.record("expected a refusal")
    } catch let error as YoloAPIError {
      #expect(error.isUnauthorized)
    }
  }
}
