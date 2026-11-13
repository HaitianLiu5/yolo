import Foundation
import Synchronization
import Testing
@testable import YoloKit

/// Serves files from a dictionary of paths, with byte ranges, and counts
/// requests per path; a playlist may grow between reads.
final class FileTransport: HTTPTransport {
  private let files: Mutex<[String: Data]>
  private let reads = Mutex<[String: Int]>([:])
  let grow: @Sendable (_ path: String, _ read: Int) -> Data?

  init(_ files: [String: Data], grow: @escaping @Sendable (String, Int) -> Data? = { _, _ in nil }) {
    self.files = Mutex(files)
    self.grow = grow
  }

  func count(_ path: String) -> Int { reads.withLock { $0[path] ?? 0 } }

  func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    let path = request.url!.path
    let read = reads.withLock { reads in
      reads[path, default: 0] += 1
      return reads[path]!
    }
    if let grown = grow(path, read) { files.withLock { $0[path] = grown } }
    guard let body = files.withLock({ $0[path] }) else {
      return (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
    }
    if let range = request.value(forHTTPHeaderField: "Range"), range.hasPrefix("bytes=") {
      let bounds = range.dropFirst(6).split(separator: "-").compactMap { Int($0) }
      let start = bounds[0]
      let end = min(bounds.count > 1 ? bounds[1] : body.count - 1, body.count - 1)
      let slice = start <= end ? body.subdata(in: start..<(end + 1)) : Data()
      let headers = ["Content-Range": "bytes \(start)-\(end)/\(body.count)"]
      return (slice, HTTPURLResponse(url: request.url!, statusCode: 206, httpVersion: nil, headerFields: headers)!)
    }
    return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
  }
}

private func folder() -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("yolo-offline-\(UUID().uuidString)")
  try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

private func read(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }

@Suite struct OfflinePlaylistTests {
  @Test func keepsTheHighestVariantAndItsDefaultAudio() throws {
    let master = """
    #EXTM3U
    #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=NO,URI="audio/en.m3u8"
    #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="audio/main.m3u8"
    #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="subs/en.m3u8"
    #EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a",SUBTITLES="s"
    low/index.m3u8
    #EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="a",SUBTITLES="s"
    high/index.m3u8
    #EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"
    """
    let base = URL(string: "https://media.example.com/m/tok/master.m3u8")!
    let result = try OfflinePlaylist.master(master, base: base)
    #expect(result.playlists == [
      OfflineResource(url: URL(string: "https://media.example.com/m/tok/audio/main.m3u8")!, name: "audio.m3u8"),
      OfflineResource(url: URL(string: "https://media.example.com/m/tok/high/index.m3u8")!, name: "video.m3u8"),
    ])
    #expect(result.text.contains(#"NAME="Main",DEFAULT=YES,URI="audio.m3u8""#))
    #expect(!result.text.contains("English"))
    #expect(!result.text.contains("SUBTITLES"))
    #expect(!result.text.contains("low/"))
    #expect(!result.text.contains("I-FRAME"))
    #expect(result.text.contains(#"#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="a""#))
    #expect(result.text.contains("\nvideo.m3u8"))
  }

  @Test func namesSegmentsMapsAndKeysWithoutTheMediaToken() throws {
    let text = """
    #EXTM3U
    #EXT-X-TARGETDURATION:6
    #EXT-X-MAP:URI="init.mp4"
    #EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1",IV=0x1
    #EXTINF:6,
    seg0.m4s?sig=1
    #EXT-X-BYTERANGE:100@0
    #EXTINF:6,
    whole.ts
    #EXT-X-BYTERANGE:100@100
    #EXTINF:6,
    whole.ts
    #EXT-X-ENDLIST
    """
    var names: [String: String] = [:]
    let result = try OfflinePlaylist.media(text, base: URL(string: "https://media.example.com/m/tok1/v/index.m3u8")!, prefix: "v", names: &names)
    #expect(result.resources.map(\.name) == ["v0.mp4", "v1.bin", "v2.m4s", "v3.ts"])
    #expect(result.text.contains(#"#EXT-X-MAP:URI="v0.mp4""#))
    #expect(result.text.contains(#"URI="v1.bin",IV=0x1"#))
    #expect(result.text.components(separatedBy: "v3.ts").count == 3)
    #expect(names["/v/seg0.m4s"] == "v2.m4s")
    // A new stream of the same item names its files alike.
    var again = names
    let next = try OfflinePlaylist.media(text, base: URL(string: "https://relay.example.com/m/tok2/v/index.m3u8")!, prefix: "v", names: &again)
    #expect(next.resources.map(\.name) == ["v0.mp4", "v1.bin", "v2.m4s", "v3.ts"])
    #expect(again == names)
  }

  @Test func refusesFairPlay() {
    var names: [String: String] = [:]
    let text = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://key\"\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST"
    #expect(throws: OfflineError(.protected, "This video is protected and cannot be kept offline")) {
      try OfflinePlaylist.media(text, base: URL(string: "https://x.example.com/p.m3u8")!, prefix: "v", names: &names)
    }
  }
}

@Suite struct OfflineCopierTests {
  @Test func copiesAGrowingPlaylistUntilItEnds() async throws {
    let start = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:6,\nseg0.m4s\n"
    let more = start + "#EXTINF:6,\nseg1.m4s\n#EXT-X-ENDLIST\n"
    let transport = FileTransport([
      "/m/tok/playlist.m3u8": Data(start.utf8),
      "/m/tok/init.mp4": Data("init".utf8),
      "/m/tok/seg0.m4s": Data("zero".utf8),
      "/m/tok/seg1.m4s": Data("one".utf8),
    ]) { path, read in path == "/m/tok/playlist.m3u8" && read >= 2 ? Data(more.utf8) : nil }
    let sleeper = RecordingSleeper()
    let copier = OfflineCopier(transport: transport, sleep: sleeper.sleeper)
    let dir = folder()
    let fractions = Mutex<[Double]>([])
    try await copier.copy(URL(string: "https://lan.example.com/m/tok/playlist.m3u8")!, delivery: "hls", duration: 12, into: dir) { fraction in
      fractions.withLock { $0.append(fraction) }
    }
    let playlist = read(dir.appendingPathComponent("index.m3u8"))
    #expect(playlist.contains("#EXT-X-MAP:URI=\"v0.mp4\""))
    #expect(playlist.contains("\nv1.m4s\n"))
    #expect(playlist.contains("\nv2.m4s\n"))
    #expect(playlist.contains("#EXT-X-ENDLIST"))
    #expect(read(dir.appendingPathComponent("v2.m4s")) == "one")
    #expect(transport.count("/m/tok/seg0.m4s") == 1)
    #expect(fractions.withLock { $0.last } == 1)
    #expect(sleeper.recorded == [.seconds(2)])
  }

  @Test func goesOnFromTheFilesItHas() async throws {
    let text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n#EXT-X-ENDLIST\n"
    let transport = FileTransport(["/m/t2/p.m3u8": Data(text.utf8), "/m/t2/a.ts": Data("a".utf8), "/m/t2/b.ts": Data("b".utf8)])
    let dir = folder()
    try JSONEncoder().encode(["/a.ts": "v0.ts"]).write(to: dir.appendingPathComponent("names.json"))
    try Data("kept".utf8).write(to: dir.appendingPathComponent("v0.ts"))
    try await OfflineCopier(transport: transport).copy(URL(string: "https://x.example.com/m/t2/p.m3u8")!, delivery: "hls", duration: 12, into: dir) { _ in }
    #expect(transport.count("/m/t2/a.ts") == 0)
    #expect(read(dir.appendingPathComponent("v0.ts")) == "kept")
    #expect(read(dir.appendingPathComponent("v1.ts")) == "b")
  }

  @Test func saysAStreamNoLongerServedHasExpired() async throws {
    let transport = FileTransport([:])
    await #expect(throws: OfflineError(.expired, "The stream is no longer served (404)")) {
      try await OfflineCopier(transport: transport).copy(URL(string: "https://x.example.com/m/t/p.m3u8")!, delivery: "hls", duration: nil, into: folder()) { _ in }
    }
  }

  @Test func copiesAnMP4InRanges() async throws {
    let body = Data((0..<1000).map { UInt8($0 % 251) })
    let transport = FileTransport(["/m/t/video.mp4": body])
    var copier = OfflineCopier(transport: transport)
    copier.chunk = 300
    let dir = folder()
    try await copier.copy(URL(string: "https://x.example.com/m/t/video.mp4")!, delivery: "mp4", duration: nil, into: dir) { _ in }
    #expect(try Data(contentsOf: dir.appendingPathComponent("video.mp4")) == body)
    #expect(transport.count("/m/t/video.mp4") == 4)
  }
}

@Suite struct LocalMediaServerTests {
  @Test func servesFilesWithRangesAndNothingOutsideItsRoot() async throws {
    let root = folder()
    try FileManager.default.createDirectory(at: root.appendingPathComponent("item one"), withIntermediateDirectories: true)
    try Data("#EXTM3U\n".utf8).write(to: root.appendingPathComponent("item one/index.m3u8"))
    try Data("0123456789".utf8).write(to: root.appendingPathComponent("item one/v0.ts"))
    let server = LocalMediaServer(root: root)
    _ = try await server.start()
    defer { server.stop() }

    let playlist = try #require(server.url(for: "item one/index.m3u8"))
    #expect(playlist.host == "127.0.0.1")
    let (body, response) = try await URLSession.shared.data(from: playlist)
    #expect(String(decoding: body, as: UTF8.self) == "#EXTM3U\n")
    #expect((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") == "application/vnd.apple.mpegurl")

    var ranged = URLRequest(url: try #require(server.url(for: "item one/v0.ts")))
    ranged.setValue("bytes=2-5", forHTTPHeaderField: "Range")
    let (part, partResponse) = try await URLSession.shared.data(for: ranged)
    #expect(String(decoding: part, as: UTF8.self) == "2345")
    #expect((partResponse as? HTTPURLResponse)?.statusCode == 206)
    #expect((partResponse as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Range") == "bytes 2-5/10")

    let port = try #require(server.port)
    let outside = try #require(URL(string: "http://127.0.0.1:\(port)/..%2F..%2Fetc%2Fhosts"))
    let (_, refused) = try await URLSession.shared.data(from: outside)
    #expect((refused as? HTTPURLResponse)?.statusCode == 404)
  }
}
