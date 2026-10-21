import Foundation

public enum RealtimeStatus: Sendable, Equatable {
  case connecting
  case online
  case offline
}

public enum RealtimeEvent: Sendable, Equatable {
  case status(RealtimeStatus)
  /// A message from the Hub. `welcomed` is whether this connection was
  /// welcomed before it: what comes ahead of a welcome may be for a stream
  /// whose `load` went with the connection before.
  case message(RealtimeMessage, welcomed: Bool)
  /// The Hub no longer serves this client's protocol: show the update
  /// prompt (Agent Note 2026-10-19-client-protocol, Versions).
  case upgradeRequired(clientProtocols: [Int])
  /// The owner removed this device: forget the credential and pair again.
  case revoked
}

/// The screen's side of the realtime channel, as the player's `realtime.js`
/// (Agent Note 2026-10-07-hub-and-realtime-channel):
///
/// - a one-time ticket from /v1, then one WebSocket whose first message is
///   `hello` with the client protocol and capabilities;
/// - the heartbeat every 25 seconds, exactly ClientProtocol.heartbeatPing,
///   and a connection with no traffic for 70 seconds is replaced;
/// - broadcasts are never answered, commands with an `id` are acknowledged;
/// - reconnects follow ReconnectPolicy, so a rate limit waits 30 seconds and
///   a revoked device stops.
public actor RealtimeConnection {
  public nonisolated let events: AsyncStream<RealtimeEvent>
  private let continuation: AsyncStream<RealtimeEvent>.Continuation

  private let api: APIClient
  private let connector: any WebSocketConnector
  private let hello: @Sendable () async -> Hello
  private let sleep: Sleeper
  private let heartbeatInterval: Duration
  private let staleAfter: Duration
  private let connectTimeout: Duration
  private let now: @Sendable () -> ContinuousClock.Instant

  private var runner: Task<Void, Never>?
  private var socket: (any WebSocketConnection)?
  /// Counts connections, so a late frame or heartbeat of an old one is
  /// told apart from the current one's.
  private var generation = 0
  private var welcomed = false
  private var lastActivity: ContinuousClock.Instant
  private var policy = ReconnectPolicy()
  /// Pings sent and pongs received on the current connection, in order (the
  /// runtime answers each ping once), and who waits for the pong of which
  /// ping (confirm). A new connection starts over.
  private var pings = 0
  private var pongs = 0
  private var awaitingPong: [(generation: Int, ping: Int, heard: @Sendable () -> Void)] = []
  public private(set) var deviceId: String?

  /// `sleep` paces reconnects only; the heartbeat and the connect timeout
  /// run on the real clock.
  public init(
    api: APIClient,
    connector: any WebSocketConnector = URLSessionWebSocketConnector(),
    hello: @escaping @Sendable () async -> Hello,
    sleep: @escaping Sleeper = taskSleeper,
    heartbeatInterval: Duration = ClientProtocol.heartbeatInterval,
    staleAfter: Duration = .seconds(70),
    connectTimeout: Duration = .seconds(15),
    now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }
  ) {
    (events, continuation) = AsyncStream.makeStream(of: RealtimeEvent.self)
    self.api = api
    self.connector = connector
    self.hello = hello
    self.sleep = sleep
    self.heartbeatInterval = heartbeatInterval
    self.staleAfter = staleAfter
    self.connectTimeout = connectTimeout
    self.now = now
    self.lastActivity = now()
    self.deviceId = api.credential.deviceId
  }

  /// Open, and welcomed by the Hub.
  public var isReady: Bool { socket != nil && welcomed }

  public func start() {
    guard runner == nil else { return }
    runner = Task { await self.run() }
  }

  public func stop() {
    runner?.cancel()
    runner = nil
    generation += 1
    socket?.close(code: 1000, reason: "stopped")
    socket = nil
    welcomed = false
    continuation.yield(.status(.offline))
  }

  /// Sends `{ v: 1, type, …fields }`. False when there is no open socket.
  @discardableResult
  public func send(_ type: String, _ fields: [String: JSONValue] = [:]) async -> Bool {
    guard let socket else { return false }
    var object = fields
    object["v"] = 1
    object["type"] = .string(type)
    do {
      try await socket.send(JSONValue.object(object).encodedString())
      return true
    } catch {
      return false
    }
  }

  /// Pings over the welcomed connection now and calls `heard` when its pong
  /// comes back: the socket delivers in order, so whatever the Hub sends
  /// after that pong, or sent and the screen has not received, was sent
  /// after this call. Only a welcomed connection counts: until a new
  /// connection's hello binds it, the Hub still sends to the old one. False,
  /// and `heard` is never called, without a welcomed connection; never called
  /// either when the connection goes before the pong.
  public func confirm(_ heard: @escaping @Sendable () -> Void) async -> Bool {
    guard let socket, welcomed else { return false }
    let ping = sendPing()
    awaitingPong.append((generation, ping, heard))
    do {
      try await socket.send(ClientProtocol.heartbeatPing)
      return true
    } catch {
      return false
    }
  }

  /// Counts a ping about to go on the current connection.
  private func sendPing() -> Int {
    pings += 1
    return pings
  }

  private func ponged() {
    pongs += 1
    let answered = awaitingPong.filter { $0.generation == generation && $0.ping <= pongs }
    awaitingPong.removeAll { $0.generation != generation || $0.ping <= pongs }
    answered.forEach { $0.heard() }
  }

  private func run() async {
    while !Task.isCancelled {
      let disconnect = await connectOnce()
      if Task.isCancelled { return }
      guard let delay = policy.delay(after: disconnect) else {
        continuation.yield(.revoked)
        runner = nil
        return
      }
      continuation.yield(.status(.offline))
      do {
        try await sleep(delay)
      } catch {
        return
      }
    }
  }

  private func connectOnce() async -> RealtimeDisconnect {
    continuation.yield(.status(.connecting))
    let ticket: String
    do {
      ticket = try await api.realtimeTicket()
    } catch let error as YoloAPIError {
      if error.isUnauthorized { return .revoked }
      return .ticketFailed(rateLimited: error.code == "rate_limited" || error.status == 429)
    } catch {
      return .ticketFailed(rateLimited: false)
    }
    if Task.isCancelled { return .closed(code: 1000) }

    let ws = connector.connect(to: api.address.realtimeURL(ticket: ticket))
    generation += 1
    let current = generation
    socket = ws
    welcomed = false
    lastActivity = now()
    pings = 0
    pongs = 0
    awaitingPong.removeAll()

    var greeting = await hello()
    greeting.deviceId = deviceId
    let text = greeting.encoded()
    do {
      try await withTimeout(connectTimeout) { try await ws.send(text) }
    } catch {
      ws.close(code: 4000, reason: "connect_timeout")
      forget(current)
      return .closed(code: 1006)
    }

    let heartbeat = Task { await self.beat(ws, current) }
    defer { heartbeat.cancel() }
    var upgrade = false
    while true {
      let frame: String
      do {
        frame = try await ws.receive()
      } catch {
        forget(current)
        if upgrade { return .upgrade }
        return .closed(code: (error as? WebSocketClosed)?.code ?? 1006)
      }
      guard current == generation else { return .closed(code: 1000) }
      lastActivity = now()
      guard let message = RealtimeMessage(text: frame) else { continue }
      if message.type == "pong" {
        ponged()
        continue
      }
      let wasWelcomed = welcomed
      if let welcome = Welcome(message) {
        if welcome.upgrade {
          // Not a welcome: no device, no reset backoff, a minute to wait.
          upgrade = true
          continuation.yield(.upgradeRequired(clientProtocols: welcome.clientProtocols))
          continue
        }
        deviceId = welcome.deviceId ?? deviceId
        welcomed = true
        policy.welcomed()
        continuation.yield(.status(.online))
      }
      continuation.yield(.message(message, welcomed: wasWelcomed))
      if let id = message.id, message.type != "welcome" {
        await send("ack", ["id": .string(id)])
      }
    }
  }

  private func forget(_ current: Int) {
    guard current == generation else { return }
    socket = nil
    welcomed = false
  }

  private func beat(_ ws: any WebSocketConnection, _ current: Int) async {
    while !Task.isCancelled {
      do {
        try await Task.sleep(for: heartbeatInterval)
      } catch {
        return
      }
      guard current == generation else { return }
      if now() - lastActivity > staleAfter {
        ws.close(code: 4000, reason: "stale")
        return
      }
      _ = sendPing()
      try? await ws.send(ClientProtocol.heartbeatPing)
    }
  }
}

struct TimeoutError: Error {}

/// Runs `operation`, or throws TimeoutError after `duration`.
func withTimeout<T: Sendable>(_ duration: Duration, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
  try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask { try await operation() }
    group.addTask {
      try await Task.sleep(for: duration)
      throw TimeoutError()
    }
    defer { group.cancelAll() }
    return try await group.next()!
  }
}
