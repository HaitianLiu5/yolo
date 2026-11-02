import Foundation

/// One pairing code (RFC 8628's device authorization response).
public struct DeviceCode: Sendable, Equatable {
  public let deviceCode: String
  /// `XXXX-XXXX`, shown beside the QR code for typing at `/device`.
  public let userCode: String
  public let verificationURI: String
  /// What the QR code holds: `/device?code=…` on the owner's server.
  public let verificationURIComplete: String
  public let expiresIn: Duration
  public let interval: Duration
}

/// What one poll of the token endpoint says.
public enum PairingPoll: Sendable, Equatable {
  case pending
  case slowDown
  case denied
  /// The code expired or was already used: start a new one.
  case expired
  case approved(DeviceCredential)
}

/// What the pairing screen shows while `PairingClient.pair` runs.
public enum PairingEvent: Sendable, Equatable {
  /// A new code to show; replaces any earlier one.
  case code(DeviceCode)
  /// The server could not be reached; a new try follows.
  case unreachable(String)
  /// The server refused to start pairing (no owner passkey yet, say).
  case refused(String)
  /// The owner pressed Deny; a new code follows shortly.
  case denied
}

/// Pairing this screen with the owner's Yolo by the OAuth device grant
/// (Agent Note 2026-10-07-device-code-pairing), as the player's
/// `pairing.js`: show `verification_uri_complete` as a QR code and the short
/// code, poll at the server's interval, and replace an expired or denied
/// code with a new one.
public struct PairingClient: Sendable {
  public static let grantType = "urn:ietf:params:oauth:grant-type:device_code"

  public let address: ServerAddress
  public let deviceName: String
  public let identity: ClientIdentity
  public let transport: any HTTPTransport
  public let sleep: Sleeper
  public let now: @Sendable () -> ContinuousClock.Instant

  public init(
    address: ServerAddress,
    deviceName: String,
    identity: ClientIdentity = .appleTV,
    transport: any HTTPTransport = URLSessionTransport(),
    sleep: @escaping Sleeper = taskSleeper,
    now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }
  ) {
    self.address = address
    self.deviceName = deviceName
    self.identity = identity
    self.transport = transport
    self.sleep = sleep
    self.now = now
  }

  private func post(_ path: String, _ fields: KeyValuePairs<String, String>) async throws -> (Int, JSONValue?) {
    var request = URLRequest(url: address.url(path), timeoutInterval: 15)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = FormBody.encode(fields)
    let (data, response) = try await transport.data(for: request)
    return (response.statusCode, data.json)
  }

  /// Asks for a new code. Throws YoloAPIError when the server refuses.
  public func start() async throws -> DeviceCode {
    let (status, body) = try await post("/oauth/device_authorization", [
      "client_id": identity.clientID,
      "device_name": deviceName,
      "device_kind": identity.kind,
    ])
    guard (200..<300).contains(status),
          let deviceCode = body?["device_code"]?.string,
          let userCode = body?["user_code"]?.string,
          let uri = body?["verification_uri"]?.string,
          let complete = body?["verification_uri_complete"]?.string
    else {
      throw YoloAPIError(
        code: body?["error"]?.string ?? "internal",
        message: body?["error_description"]?.string ?? "Yolo cannot pair devices right now",
        status: status
      )
    }
    return DeviceCode(
      deviceCode: deviceCode,
      userCode: userCode,
      verificationURI: uri,
      verificationURIComplete: complete,
      expiresIn: .seconds(body?["expires_in"]?.int ?? 600),
      interval: .seconds(max(5, body?["interval"]?.int ?? 5))
    )
  }

  /// One poll of the token endpoint.
  public func poll(_ code: DeviceCode) async throws -> PairingPoll {
    let (status, body) = try await post("/oauth/token", [
      "grant_type": Self.grantType,
      "device_code": code.deviceCode,
      "client_id": identity.clientID,
    ])
    if (200..<300).contains(status), let token = body?["access_token"]?.string {
      return .approved(DeviceCredential(token: token, deviceId: body?["device_id"]?.string))
    }
    switch body?["error"]?.string {
    case "slow_down": return .slowDown
    case "access_denied": return .denied
    case "expired_token", "invalid_grant": return .expired
    default: return .pending
    }
  }

  /// Runs until the owner approves this screen, with new codes as they
  /// expire or are denied. Cancel the task to stop.
  public func pair(onEvent: @escaping @Sendable (PairingEvent) async -> Void) async throws -> DeviceCredential {
    while true {
      try Task.checkCancellation()
      let code: DeviceCode
      do {
        code = try await start()
      } catch let error as YoloAPIError {
        await onEvent(.refused(error.message))
        try await sleep(.seconds(15))
        continue
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        await onEvent(.unreachable(error.localizedDescription))
        try await sleep(.seconds(10))
        continue
      }
      await onEvent(.code(code))
      let expiresAt = now() + code.expiresIn
      var interval = code.interval
      polling: while now() < expiresAt {
        try await sleep(interval)
        let result: PairingPoll
        do {
          result = try await poll(code)
        } catch is CancellationError {
          throw CancellationError()
        } catch {
          continue // The connection dropped for a moment.
        }
        switch result {
        case .approved(let credential): return credential
        case .pending: continue
        case .slowDown: interval += .seconds(5)
        case .denied:
          await onEvent(.denied)
          try await sleep(.seconds(5))
          break polling
        case .expired: break polling
        }
      }
    }
  }
}
