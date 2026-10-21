import Foundation
import Security

/// The two things a client keeps (Agent Note 2026-10-19-client-protocol,
/// Discovery): the server's address and its device credential.
public struct PairedServer: Sendable, Equatable, Codable {
  public let address: ServerAddress
  public let credential: DeviceCredential

  public init(address: ServerAddress, credential: DeviceCredential) {
    self.address = address
    self.credential = credential
  }
}

public protocol PairingStore: Sendable {
  func load() -> PairedServer?
  func save(_ paired: PairedServer) throws
  func clear()
}

public struct KeychainError: Error, Sendable, Equatable {
  public let status: OSStatus
}

/// The paired server in the Keychain, as one generic password item.
public struct KeychainPairingStore: PairingStore {
  public let service: String
  public let account: String

  public init(service: String = "yolo.device", account: String = "paired-server") {
    self.service = service
    self.account = account
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  public func load() -> PairedServer? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
    return try? JSONDecoder().decode(PairedServer.self, from: data)
  }

  public func save(_ paired: PairedServer) throws {
    let data = try JSONEncoder().encode(paired)
    let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update == errSecSuccess { return }
    guard update == errSecItemNotFound else { throw KeychainError(status: update) }
    var item = query
    item[kSecValueData as String] = data
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError(status: status) }
  }

  public func clear() {
    SecItemDelete(query as CFDictionary)
  }
}
