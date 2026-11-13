import Foundation

// Offline copies (Agent Note 2026-11-11-offline-downloads): an iPhone or
// iPad keeps a whole stream of an item on the device, to play without a
// network. The copy is of the stream Yolo serves, whatever source is behind
// it, so it knows no source: a share link's stream (`POST /v1/shares`, then
// `POST /v1/share/<token>/stream`), which never reaches the Hub, so making a
// copy changes no screen's session, history, or progress. An HLS stream is
// mirrored file by file with its playlists rewritten to the local names, and
// played back through `LocalMediaServer` on the loopback address; an MP4 is
// one file AVPlayer opens as it is.

/// What went wrong making an offline copy.
public struct OfflineError: Error, Sendable, Equatable, CustomStringConvertible {
  public enum Code: String, Sendable {
    /// The stream is live, or its playlist never ends.
    case live
    /// The stream is encrypted with keys this copy cannot keep (FairPlay).
    case protected
    /// The node no longer serves the stream's media: ask for a new stream.
    case expired
    /// A delivery or a playlist this copy does not read.
    case unsupported
    /// The media could not be fetched.
    case network
  }

  public let code: Code
  public let message: String

  public init(_ code: Code, _ message: String) {
    self.code = code
    self.message = message
  }

  public var description: String { "\(code.rawValue): \(message)" }
}

/// One file an HLS copy fetches: its URL and the name it is kept under.
public struct OfflineResource: Sendable, Equatable, Hashable {
  public let url: URL
  public let name: String
}

/// Rewrites HLS playlists to the names their files are kept under.
public enum OfflinePlaylist {
  public static func isMaster(_ text: String) -> Bool { text.contains("#EXT-X-STREAM-INF") }
  public static func ended(_ text: String) -> Bool {
    text.range(of: #"(?m)^#EXT-X-ENDLIST\s*$"#, options: .regularExpression) != nil
  }

  /// A key for a media URL that stays the same in a new stream of the same
  /// item: its path without the media token (`/m/<token>/…`), so a copy
  /// left part way keeps the files a new stream names alike.
  public static func key(_ url: URL) -> String {
    var parts = url.path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    if parts.count > 2, parts[0].isEmpty, parts[1] == "m" { parts.removeSubrange(1...2) }
    return parts.joined(separator: "/")
  }

  /// A master playlist with one variant, the highest bandwidth, and that
  /// variant's default audio rendition; subtitle renditions and I-frame
  /// playlists go, since the copy draws text subtitles itself. Returns the
  /// rewritten text and the media playlists to copy, as (URL, local name).
  public static func master(_ text: String, base: URL) throws -> (text: String, playlists: [OfflineResource]) {
    let lines = text.components(separatedBy: .newlines)
    struct Variant { let tag: Int; let uri: Int; let bandwidth: Double; let audio: String? }
    var variants: [Variant] = []
    for (index, line) in lines.enumerated() where line.hasPrefix("#EXT-X-STREAM-INF:") {
      guard let uri = lines[(index + 1)...].firstIndex(where: { !$0.isEmpty && !$0.hasPrefix("#") }) else { continue }
      let attributes = attributeList(line)
      variants.append(Variant(tag: index, uri: uri, bandwidth: Double(attributes["BANDWIDTH"] ?? "") ?? 0, audio: attributes["AUDIO"]))
    }
    guard let chosen = variants.max(by: { $0.bandwidth < $1.bandwidth }) else {
      throw OfflineError(.unsupported, "The master playlist has no variant")
    }
    // The audio rendition the variant plays by default.
    var audioLine: Int?
    if let group = chosen.audio {
      let renditions = lines.enumerated().filter { _, line in
        guard line.hasPrefix("#EXT-X-MEDIA:") else { return false }
        let attributes = attributeList(line)
        return attributes["TYPE"] == "AUDIO" && attributes["GROUP-ID"] == group
      }
      audioLine = (renditions.first { attributeList($0.element)["DEFAULT"] == "YES" } ?? renditions.first)?.offset
    }
    var out: [String] = []
    var playlists: [OfflineResource] = []
    for (index, line) in lines.enumerated() {
      if line.hasPrefix("#EXT-X-STREAM-INF:") {
        if index == chosen.tag { out.append(removing("SUBTITLES", from: line)) }
      } else if line.hasPrefix("#EXT-X-MEDIA:") {
        guard index == audioLine else {
          // Closed captions ride in the video; any other rendition goes.
          if attributeList(line)["TYPE"] == "CLOSED-CAPTIONS" { out.append(line) }
          continue
        }
        if let uri = attributeList(line)["URI"] {
          guard let url = URL(string: uri, relativeTo: base)?.absoluteURL else { throw OfflineError(.unsupported, "Bad rendition URI") }
          playlists.append(OfflineResource(url: url, name: "audio.m3u8"))
          out.append(replacingURI(in: line, with: "audio.m3u8"))
        } else {
          out.append(line)
        }
      } else if line.hasPrefix("#EXT-X-I-FRAME-STREAM-INF") || line.hasPrefix("#EXT-X-SESSION-KEY") {
        continue
      } else if !line.isEmpty, !line.hasPrefix("#") {
        if index == chosen.uri {
          guard let url = URL(string: line, relativeTo: base)?.absoluteURL else { throw OfflineError(.unsupported, "Bad variant URI") }
          playlists.append(OfflineResource(url: url, name: "video.m3u8"))
          out.append("video.m3u8")
        }
      } else {
        out.append(line)
      }
    }
    return (out.joined(separator: "\n"), playlists)
  }

  /// A media playlist with every segment, init section, and key named as it
  /// is kept: `names` holds the names given so far (by `key(_:)`), and is
  /// extended with new ones under `prefix`. Returns the text and every file
  /// it names.
  public static func media(
    _ text: String, base: URL, prefix: String, names: inout [String: String]
  ) throws -> (text: String, resources: [OfflineResource]) {
    if isMaster(text) {
      throw OfflineError(.unsupported, "A master playlist where a media playlist belongs")
    }
    var out: [String] = []
    var resources: [OfflineResource] = []
    var seen = Set<String>()
    func local(_ uri: String) throws -> String {
      guard let url = URL(string: uri, relativeTo: base)?.absoluteURL else { throw OfflineError(.unsupported, "Bad URI \(uri)") }
      let key = key(url)
      let name: String
      if let known = names[key] {
        name = known
      } else {
        let ext = url.pathExtension.isEmpty ? "bin" : url.pathExtension.lowercased()
        name = "\(prefix)\(names.count).\(ext)"
        names[key] = name
      }
      if seen.insert(name).inserted { resources.append(OfflineResource(url: url, name: name)) }
      return name
    }
    for line in text.components(separatedBy: .newlines) {
      if line.hasPrefix("#EXT-X-KEY:") {
        let attributes = attributeList(line)
        let method = attributes["METHOD"] ?? "NONE"
        if method == "NONE" {
          out.append(line)
        } else if method == "AES-128", let uri = attributes["URI"], uri.lowercased().hasPrefix("http") || !uri.contains(":") {
          out.append(replacingURI(in: line, with: try local(uri)))
        } else {
          throw OfflineError(.protected, "This video is protected and cannot be kept offline")
        }
      } else if line.hasPrefix("#EXT-X-MAP:"), let uri = attributeList(line)["URI"] {
        out.append(replacingURI(in: line, with: try local(uri)))
      } else if !line.isEmpty, !line.hasPrefix("#") {
        out.append(try local(line))
      } else {
        out.append(line)
      }
    }
    return (out.joined(separator: "\n"), resources)
  }

  /// An HLS attribute list (`KEY=value,KEY="quoted, value"`).
  static func attributeList(_ line: String) -> [String: String] {
    guard let colon = line.firstIndex(of: ":") else { return [:] }
    var result: [String: String] = [:]
    var rest = line[line.index(after: colon)...]
    while !rest.isEmpty {
      guard let equals = rest.firstIndex(of: "=") else { break }
      let name = rest[..<equals].trimmingCharacters(in: .whitespaces)
      rest = rest[rest.index(after: equals)...]
      var value: Substring
      if rest.first == "\"" {
        rest = rest.dropFirst()
        let close = rest.firstIndex(of: "\"") ?? rest.endIndex
        value = rest[..<close]
        rest = close < rest.endIndex ? rest[rest.index(after: close)...] : rest[close...]
        if rest.first == "," { rest = rest.dropFirst() }
      } else {
        let comma = rest.firstIndex(of: ",") ?? rest.endIndex
        value = rest[..<comma]
        rest = comma < rest.endIndex ? rest[rest.index(after: comma)...] : rest[comma...]
      }
      result[name] = String(value)
    }
    return result
  }

  static func replacingURI(in line: String, with uri: String) -> String {
    guard let range = line.range(of: #"URI="[^"]*""#, options: .regularExpression) else { return line }
    return line.replacingCharacters(in: range, with: "URI=\"\(uri)\"")
  }

  static func removing(_ attribute: String, from line: String) -> String {
    line.replacingOccurrences(of: #",\#(attribute)="[^"]*""#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"(?<=:)\#(attribute)="[^"]*",?"#, with: "", options: .regularExpression)
  }
}

/// Progress of a copy, from 0 to 1.
public typealias OfflineProgress = @Sendable (Double) async -> Void

/// Copies one stream into a folder: an HLS stream as `index.m3u8` with its
/// playlists and files beside it, an MP4 as `video.mp4`. A copy left part
/// way goes on from the files it has.
public struct OfflineCopier: Sendable {
  public let transport: any HTTPTransport
  public let sleep: Sleeper
  /// Files fetched at once.
  public var parallel = 4
  /// How long a growing playlist (a transcode still being made) may go
  /// without a new segment.
  public var growthTimeout: Duration = .seconds(180)
  public var pollInterval: Duration = .seconds(2)
  /// An MP4's request size.
  public var chunk = 8 << 20

  public init(transport: any HTTPTransport = URLSessionTransport(), sleep: @escaping Sleeper = taskSleeper) {
    self.transport = transport
    self.sleep = sleep
  }

  /// The file the copy plays, relative to `folder`.
  public static func entry(delivery: String) -> String { delivery == "mp4" ? "video.mp4" : "index.m3u8" }

  public func copy(_ url: URL, delivery: String, duration: Double?, into folder: URL, progress: OfflineProgress) async throws {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    switch delivery {
    case "mp4": try await copyFile(url, to: folder.appendingPathComponent("video.mp4"), progress: progress)
    case "hls": try await copyHLS(url, duration: duration, into: folder, progress: progress)
    default: throw OfflineError(.unsupported, "This video's delivery (\(delivery)) cannot be kept offline")
    }
  }

  // MARK: HLS

  private func copyHLS(_ url: URL, duration: Double?, into folder: URL, progress: OfflineProgress) async throws {
    let namesFile = folder.appendingPathComponent("names.json")
    var names = (try? JSONDecoder().decode([String: String].self, from: Data(contentsOf: namesFile))) ?? [:]
    let top = try await text(url)
    var playlists: [OfflineResource]
    if OfflinePlaylist.isMaster(top) {
      let master = try OfflinePlaylist.master(top, base: url)
      try Data(master.text.utf8).write(to: folder.appendingPathComponent("index.m3u8"), options: .atomic)
      playlists = master.playlists
    } else {
      playlists = [OfflineResource(url: url, name: "index.m3u8")]
    }
    let count = Double(playlists.count)
    for (index, playlist) in playlists.enumerated() {
      let prefix = playlist.name == "audio.m3u8" ? "a" : "v"
      let first = playlist.url == url ? top : nil
      try await copyMedia(playlist, first: first, prefix: prefix, duration: duration, folder: folder, names: &names, namesFile: namesFile) { fraction in
        await progress((Double(index) + fraction) / count)
      }
    }
    await progress(1)
  }

  /// One media playlist, read again while it grows, until it ends.
  private func copyMedia(
    _ playlist: OfflineResource, first: String?, prefix: String, duration: Double?, folder: URL,
    names: inout [String: String], namesFile: URL, progress: OfflineProgress
  ) async throws {
    var fetched = Set<String>()
    var lastGrowth = ContinuousClock.now
    var body: String
    if let first { body = first } else { body = try await text(playlist.url) }
    while true {
      if body.contains("#EXT-X-PLAYLIST-TYPE:EVENT") == false, !OfflinePlaylist.ended(body), body.contains("#EXT-X-MEDIA-SEQUENCE:"),
         sequence(body) > 0 {
        // A sliding window: a live stream.
        throw OfflineError(.live, "A live stream cannot be kept offline")
      }
      let media = try OfflinePlaylist.media(body, base: playlist.url, prefix: prefix, names: &names)
      try? JSONEncoder().encode(names).write(to: namesFile, options: .atomic)
      let fresh = media.resources.filter { !fetched.contains($0.name) }
      if !fresh.isEmpty { lastGrowth = .now }
      let total = Double(media.resources.count)
      let known = playlistDuration(body)
      let done = fetched.count
      let ended = OfflinePlaylist.ended(body)
      try await fetchAll(fresh, into: folder) { finished in
        let fraction: Double
        if ended || duration == nil || duration! <= 0 {
          fraction = total > 0 ? Double(done + finished) / total : 0
        } else {
          // Still growing: how much of the item the files so far cover.
          fraction = min(0.99, known / duration! * Double(done + finished) / max(total, 1))
        }
        await progress(fraction)
      }
      fetched.formUnion(fresh.map(\.name))
      if OfflinePlaylist.ended(body) {
        try Data(media.text.utf8).write(to: folder.appendingPathComponent(playlist.name), options: .atomic)
        return
      }
      if ContinuousClock.now - lastGrowth > growthTimeout {
        throw OfflineError(.live, "The stream stopped growing before it ended")
      }
      try await sleep(pollInterval)
      body = try await text(playlist.url)
    }
  }

  private func fetchAll(_ resources: [OfflineResource], into folder: URL, finished: (Int) async -> Void) async throws {
    let pending = resources.filter { !FileManager.default.fileExists(atPath: folder.appendingPathComponent($0.name).path) }
    var count = resources.count - pending.count
    if count > 0 { await finished(count) }
    try await withThrowingTaskGroup(of: Void.self) { group in
      var queue = pending[...]
      for _ in 0..<min(parallel, queue.count) {
        let next = queue.removeFirst()
        group.addTask { try await self.fetchFile(next, into: folder) }
      }
      while try await group.next() != nil {
        count += 1
        await finished(count)
        if let next = queue.popFirst() {
          group.addTask { try await self.fetchFile(next, into: folder) }
        }
      }
    }
  }

  private func fetchFile(_ resource: OfflineResource, into folder: URL) async throws {
    let data = try await fetch(URLRequest(url: resource.url, timeoutInterval: 60))
    let target = folder.appendingPathComponent(resource.name)
    let partial = target.appendingPathExtension("part")
    try data.write(to: partial, options: .atomic)
    try? FileManager.default.removeItem(at: target)
    try FileManager.default.moveItem(at: partial, to: target)
  }

  private func text(_ url: URL) async throws -> String {
    let data = try await fetch(URLRequest(url: url, timeoutInterval: 60))
    guard let text = String(data: data, encoding: .utf8), text.hasPrefix("#EXTM3U") else {
      throw OfflineError(.unsupported, "The stream's playlist is not HLS")
    }
    return text
  }

  /// A request, tried again on a network failure or a server error.
  private func fetch(_ request: URLRequest, accept: Set<Int> = [200]) async throws -> Data {
    var attempt = 0
    while true {
      do {
        let (data, response) = try await transport.data(for: request)
        if accept.contains(response.statusCode) { return data }
        if [401, 403, 404, 410].contains(response.statusCode) {
          throw OfflineError(.expired, "The stream is no longer served (\(response.statusCode))")
        }
        throw OfflineError(.network, "The media server answered \(response.statusCode)")
      } catch let error as OfflineError where error.code == .expired {
        throw error
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        attempt += 1
        if attempt >= 4 {
          throw (error as? OfflineError) ?? OfflineError(.network, error.localizedDescription)
        }
        try await sleep(.seconds(2 << attempt))
      }
    }
  }

  private func sequence(_ text: String) -> Int {
    guard let range = text.range(of: #"(?m)^#EXT-X-MEDIA-SEQUENCE:(\d+)"#, options: .regularExpression) else { return 0 }
    return Int(text[range].split(separator: ":").last ?? "") ?? 0
  }

  private func playlistDuration(_ text: String) -> Double {
    text.components(separatedBy: .newlines).reduce(0) { sum, line in
      guard line.hasPrefix("#EXTINF:") else { return sum }
      return sum + (Double(line.dropFirst(8).split(separator: ",").first ?? "") ?? 0)
    }
  }

  // MARK: MP4

  /// An MP4 in ranges, appended to a partial file, so a copy left part way
  /// goes on where it stopped.
  private func copyFile(_ url: URL, to target: URL, progress: OfflineProgress) async throws {
    if FileManager.default.fileExists(atPath: target.path) { return await progress(1) }
    let partial = target.appendingPathExtension("part")
    if !FileManager.default.fileExists(atPath: partial.path) {
      FileManager.default.createFile(atPath: partial.path, contents: nil)
    }
    let handle = try FileHandle(forWritingTo: partial)
    defer { try? handle.close() }
    var offset = Int(try handle.seekToEnd())
    var total: Int?
    while total == nil || offset < total! {
      var request = URLRequest(url: url, timeoutInterval: 120)
      request.setValue("bytes=\(offset)-\(offset + chunk - 1)", forHTTPHeaderField: "Range")
      let (data, response) = try await ranged(request)
      if response.statusCode == 200 {
        // No ranges: the whole file at once.
        try handle.truncate(atOffset: 0)
        try handle.write(contentsOf: data)
        offset = data.count
        total = data.count
      } else {
        guard response.statusCode == 206 else { throw OfflineError(.network, "The media server answered \(response.statusCode)") }
        let range = response.value(forHTTPHeaderField: "Content-Range") ?? ""
        if let size = range.split(separator: "/").last.flatMap({ Int($0) }) { total = size }
        try handle.write(contentsOf: data)
        offset += data.count
        if data.isEmpty { break }
      }
      if let total, total > 0 { await progress(Double(offset) / Double(total)) }
    }
    try handle.close()
    try FileManager.default.moveItem(at: partial, to: target)
    await progress(1)
  }

  private func ranged(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    var attempt = 0
    while true {
      do {
        let (data, response) = try await transport.data(for: request)
        if [401, 403, 404, 410].contains(response.statusCode) {
          throw OfflineError(.expired, "The stream is no longer served (\(response.statusCode))")
        }
        if response.statusCode >= 500 { throw OfflineError(.network, "The media server answered \(response.statusCode)") }
        return (data, response)
      } catch let error as OfflineError where error.code == .expired {
        throw error
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        attempt += 1
        if attempt >= 4 { throw (error as? OfflineError) ?? OfflineError(.network, error.localizedDescription) }
        try await sleep(.seconds(2 << attempt))
      }
    }
  }
}

extension APIClient {
  /// A stream of `reference` for an offline copy, by way of a share link
  /// that only this device keeps: `POST /v1/shares`, then
  /// `POST /v1/share/<token>/stream`. Neither reaches the Hub, so the copy
  /// changes no screen's session, history, or progress. `network` is `wan`
  /// when the remote path works from here, else the relay.
  public func offlineStream(
    _ reference: [String: JSONValue], shareURL: URL? = nil, capabilities: Capabilities, viewport: (width: Int, height: Int),
    network: MediaPath?, maxVideoKbps: Int?
  ) async throws -> (stream: StreamDescriptor, shareURL: URL) {
    let link: URL
    if let shareURL { link = shareURL } else { link = try await share(reference) }
    let token = link.lastPathComponent
    var body: [String: JSONValue] = [
      "capabilities": try JSONValue.parse(JSONEncoder().encode(capabilities)),
      "viewport": ["width": .number(Double(viewport.width)), "height": .number(Double(viewport.height))],
      "startTime": 0,
      "reason": "play",
      "autoplay": false,
    ]
    if network == .wan { body["network"] = "wan" }
    if let maxVideoKbps { body["maxVideoKbps"] = .number(Double(maxVideoKbps)) }
    var client = self
    client.timeout = 90
    let answer = try await client.request("/v1/share/\(Self.segment(token))/stream", method: "POST", body: .object(body))
    guard let stream = StreamDescriptor(json: answer["stream"]) else {
      throw YoloAPIError(code: "internal", message: "Yolo answered without a stream", status: 200)
    }
    return (stream, link)
  }
}
