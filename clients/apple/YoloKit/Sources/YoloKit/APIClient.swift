import Foundation

/// The device credential the owner's approval gave this screen
/// (Agent Note 2026-10-07-device-code-pairing): `ydt_…`, never expiring,
/// revoked only by removing the device.
public struct DeviceCredential: Sendable, Equatable, Codable {
  public let token: String
  public let deviceId: String?

  public init(token: String, deviceId: String?) {
    self.token = token
    self.deviceId = deviceId
  }
}

/// The client's side of /v1 (Agent Note 2026-10-07-v1-http-api), as the
/// player's `api.js`: every call carries the device credential and names the
/// client protocol; a 401 means the owner removed the device.
public struct APIClient: Sendable {
  public let address: ServerAddress
  public let credential: DeviceCredential
  public let transport: any HTTPTransport
  public var timeout: TimeInterval = 15

  public init(address: ServerAddress, credential: DeviceCredential, transport: any HTTPTransport = URLSessionTransport()) {
    self.address = address
    self.credential = credential
    self.transport = transport
  }

  /// JSON in, JSON out. Throws YoloAPIError with the server's code.
  @discardableResult
  public func request(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> JSONValue {
    var request = URLRequest(url: address.url(path), timeoutInterval: timeout)
    request.httpMethod = method
    request.setValue(String(ClientProtocol.version), forHTTPHeaderField: ClientProtocol.header)
    request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if let body {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = body.encoded()
    }
    let (data, response) = try await transport.data(for: request)
    guard (200..<300).contains(response.statusCode) else {
      throw YoloAPIError.from(status: response.statusCode, body: data.json, label: "\(method) \(path)")
    }
    return data.json ?? .null
  }

  /// A one-time realtime ticket, valid for 30 seconds
  /// (Agent Note 2026-10-07-oauth-authorization-server).
  public func realtimeTicket() async throws -> String {
    let answer = try await request("/v1/realtime/ticket", method: "POST")
    guard let ticket = answer["ticket"]?.string, !ticket.isEmpty else {
      throw YoloAPIError(code: "internal", message: "Yolo answered without a realtime ticket", status: 200)
    }
    return ticket
  }

  /// Forgets this device on the server (`DELETE /v1/devices/self`).
  public func forgetSelf() async throws {
    try await request("/v1/devices/self", method: "DELETE")
  }
}
