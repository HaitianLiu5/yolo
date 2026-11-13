import Foundation
import Network

/// Serves offline copies to AVPlayer on the loopback address: AVPlayer plays
/// HLS only over HTTP, not from files. GET and HEAD of a file under `root`,
/// with byte ranges, one request per connection; nothing leaves the device
/// (Agent Note 2026-11-11-offline-downloads).
public final class LocalMediaServer: @unchecked Sendable {
  public let root: URL
  private let queue = DispatchQueue(label: "yolo.offline.server")
  private var listener: NWListener?
  private var ready: CheckedContinuation<UInt16, any Error>?
  private(set) public var port: UInt16?

  public init(root: URL) {
    self.root = root.standardizedFileURL
  }

  /// Starts listening on 127.0.0.1 on a free port, once; returns the port.
  public func start() async throws -> UInt16 {
    if let port = queue.sync(execute: { self.port }) { return port }
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
    parameters.allowLocalEndpointReuse = true
    let listener = try NWListener(using: parameters)
    return try await withCheckedThrowingContinuation { continuation in
      queue.async {
        self.listener = listener
        self.ready = continuation
        listener.stateUpdateHandler = { [weak self] state in self?.changed(state) }
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.start(queue: self.queue)
      }
    }
  }

  public func stop() {
    queue.async {
      self.listener?.cancel()
      self.listener = nil
      self.port = nil
    }
  }

  /// The URL a file under `root` plays at, once started.
  public func url(for path: String) -> URL? {
    guard let port = queue.sync(execute: { self.port }) else { return nil }
    let encoded = path.split(separator: "/").map {
      String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0)
    }.joined(separator: "/")
    return URL(string: "http://127.0.0.1:\(port)/\(encoded)")
  }

  private func changed(_ state: NWListener.State) {
    switch state {
    case .ready:
      port = listener?.port?.rawValue
      if let port { ready?.resume(returning: port) }
      ready = nil
    case .failed(let error):
      ready?.resume(throwing: error)
      ready = nil
      listener?.cancel()
      listener = nil
      port = nil
    case .cancelled:
      ready?.resume(throwing: CancellationError())
      ready = nil
    default:
      break
    }
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    read(connection, buffer: Data())
  }

  private func read(_ connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, complete, error in
      guard let self else { return connection.cancel() }
      var buffer = buffer
      if let data { buffer.append(data) }
      if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
        self.answer(head, on: connection)
      } else if complete || error != nil || buffer.count > 64 * 1024 {
        connection.cancel()
      } else {
        self.read(connection, buffer: buffer)
      }
    }
  }

  private func answer(_ head: String, on connection: NWConnection) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else {
      return send(status: "405 Method Not Allowed", headers: [:], body: nil, on: connection)
    }
    let headOnly = parts[0] == "HEAD"
    let rawPath = String(parts[1]).split(separator: "?").first.map(String.init) ?? ""
    let path = rawPath.removingPercentEncoding ?? rawPath
    let file = root.appendingPathComponent(path).standardizedFileURL
    guard file.path.hasPrefix(root.path + "/"),
          let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
          (attributes[.type] as? FileAttributeType) == .typeRegular,
          let size = (attributes[.size] as? NSNumber)?.intValue
    else {
      return send(status: "404 Not Found", headers: [:], body: nil, on: connection)
    }
    var headers = ["Content-Type": Self.contentType(file.pathExtension), "Accept-Ranges": "bytes"]
    var start = 0
    var end = size - 1
    var status = "200 OK"
    let range = lines.dropFirst().first { $0.lowercased().hasPrefix("range:") }
    if let range, let spec = range.split(separator: "=", maxSplits: 1).last {
      let bounds = spec.split(separator: "-", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
      if bounds.count == 2 {
        if bounds[0].isEmpty, let suffix = Int(bounds[1]) {
          start = max(0, size - suffix)
        } else if let first = Int(bounds[0]) {
          start = first
          if let last = Int(bounds[1]) { end = min(last, size - 1) }
        }
      }
      guard start <= end, start < size else {
        return send(status: "416 Range Not Satisfiable", headers: ["Content-Range": "bytes */\(size)"], body: nil, on: connection)
      }
      status = "206 Partial Content"
      headers["Content-Range"] = "bytes \(start)-\(end)/\(size)"
    }
    headers["Content-Length"] = String(size == 0 ? 0 : end - start + 1)
    if headOnly || size == 0 { return send(status: status, headers: headers, body: nil, on: connection) }
    guard let handle = try? FileHandle(forReadingFrom: file) else {
      return send(status: "404 Not Found", headers: [:], body: nil, on: connection)
    }
    sendHead(status: status, headers: headers, on: connection)
    stream(handle, from: start, through: end, on: connection)
  }

  /// The body in pieces, each sent once the last one went.
  private func stream(_ handle: FileHandle, from offset: Int, through end: Int, on connection: NWConnection) {
    let length = min(1 << 20, end - offset + 1)
    guard length > 0 else {
      try? handle.close()
      return connection.send(content: nil, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
    }
    let data: Data
    do {
      try handle.seek(toOffset: UInt64(offset))
      data = try handle.read(upToCount: length) ?? Data()
    } catch {
      try? handle.close()
      return connection.cancel()
    }
    if data.isEmpty {
      try? handle.close()
      return connection.cancel()
    }
    connection.send(content: data, completion: .contentProcessed { [weak self] error in
      guard error == nil, let self else {
        try? handle.close()
        return connection.cancel()
      }
      self.stream(handle, from: offset + data.count, through: end, on: connection)
    })
  }

  private func sendHead(status: String, headers: [String: String], on connection: NWConnection) {
    var text = "HTTP/1.1 \(status)\r\nConnection: close\r\nCache-Control: no-store\r\n"
    for (name, value) in headers { text += "\(name): \(value)\r\n" }
    text += "\r\n"
    connection.send(content: Data(text.utf8), completion: .idempotent)
  }

  private func send(status: String, headers: [String: String], body: Data?, on connection: NWConnection) {
    var headers = headers
    if headers["Content-Length"] == nil { headers["Content-Length"] = String(body?.count ?? 0) }
    sendHead(status: status, headers: headers, on: connection)
    connection.send(content: body, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
  }

  static func contentType(_ ext: String) -> String {
    switch ext.lowercased() {
    case "m3u8": "application/vnd.apple.mpegurl"
    case "ts": "video/mp2t"
    case "mp4", "m4s", "m4v", "cmfv": "video/mp4"
    case "m4a", "cmfa": "audio/mp4"
    case "aac": "audio/aac"
    case "vtt", "webvtt": "text/vtt"
    case "jpg", "jpeg": "image/jpeg"
    default: "application/octet-stream"
    }
  }
}
