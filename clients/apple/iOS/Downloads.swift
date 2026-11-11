import Foundation
import Observation
import OSLog
import UIKit
import YoloKit

/// The items this iPhone or iPad keeps to play without a network
/// (Agent Note 2026-11-11-offline-downloads): each a folder under
/// Application Support/Offline with the stream's files, its cover, and
/// `downloads.json` listing them. One copy is made at a time, while the app
/// is open; a copy left part way goes on from the files it has.
@MainActor
@Observable
final class Downloads {
  enum State: String, Codable { case queued, copying, done, failed }

  /// The quality a copy asks for: what plays best here, or a smaller file.
  enum Size: String, Codable, CaseIterable {
    case best, smaller
    var maxVideoKbps: Int? { self == .best ? nil : 2000 }
  }

  /// A text subtitle track kept beside the video.
  struct Subtitle: Codable, Equatable, Identifiable {
    let id: String
    let label: String
    let file: String
  }

  struct Entry: Codable, Identifiable, Equatable {
    let id: String
    /// The library item id or Source key, as `MediaItem.id`.
    let itemId: String
    var title: String
    var episode: String?
    var reference: [String: JSONValue]
    var size: Size
    /// The share link the copy's streams come from, kept only here.
    var shareURL: URL?
    var delivery: String?
    var duration: Double?
    var state: State
    var progress: Double
    var message: String?
    var position: Double
    var bytes: Int64?
    var hasCover: Bool
    let created: Date
    var subtitles: [Subtitle]? = nil
    /// The subtitle shown, or nil for none.
    var subtitle: String? = nil
  }

  private static let log = Logger(subsystem: ThisDevice.logSubsystem, category: "offline")

  private(set) var entries: [Entry] = []
  let root: URL
  private let server: LocalMediaServer
  private var api: APIClient?
  private var network: MediaPath?
  private var running: Task<Void, Never>?
  private var background: UIBackgroundTaskIdentifier = .invalid

  init() {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    root = support.appendingPathComponent("Offline", isDirectory: true)
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    var excluded = root
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? excluded.setResourceValues(values)
    server = LocalMediaServer(root: root)
    entries = (try? JSONDecoder().decode([Entry].self, from: Data(contentsOf: indexFile))) ?? []
    // A copy the app left when it closed goes on when it is asked to.
    for index in entries.indices where entries[index].state == .copying { entries[index].state = .queued }
  }

  private var indexFile: URL { root.appendingPathComponent("downloads.json") }

  func entry(for item: MediaItem) -> Entry? { entries.first { $0.itemId == item.id } }

  func folder(of entry: Entry) -> URL { root.appendingPathComponent(entry.id, isDirectory: true) }

  func cover(of entry: Entry) -> URL? { entry.hasCover ? folder(of: entry).appendingPathComponent("cover.jpg") : nil }

  /// The server and media path copies are asked through: the paired
  /// server's, and the remote path when it works from here, else the relay.
  func connect(api: APIClient?, network: MediaPath?) {
    self.api = api
    self.network = network
    if api != nil { run() }
  }

  /// Keeps `item` on this device.
  func download(_ item: MediaItem, size: Size) {
    guard entry(for: item) == nil else { return }
    entries.append(Entry(
      id: UUID().uuidString, itemId: item.id, title: item.title,
      episode: item.kind == .episode ? episodeLine(item) : nil,
      reference: item.playReference, size: size, shareURL: nil, delivery: nil, duration: item.duration,
      state: .queued, progress: 0, message: nil, position: 0, bytes: nil, hasCover: false, created: .now
    ))
    save()
    if let id = entries.last?.id { Task { await keepCover(of: item, for: id) } }
    run()
  }

  func retry(_ id: String) {
    update(id) {
      $0.state = .queued
      $0.message = nil
    }
    run()
  }

  /// Copies that stopped for want of a network go on.
  func resumeStopped() {
    var any = false
    for index in entries.indices where entries[index].state == .failed && entries[index].message == nil {
      entries[index].state = .queued
      any = true
    }
    if any { save() }
    run()
  }

  func remove(_ id: String) {
    guard let entry = entries.first(where: { $0.id == id }) else { return }
    if entry.state == .copying { running?.cancel() }
    entries.removeAll { $0.id == id }
    try? FileManager.default.removeItem(at: folder(of: entry))
    save()
  }

  func remember(position: Double, of id: String) {
    update(id) { $0.position = position }
  }

  /// The URL AVPlayer plays a finished copy from.
  func playURL(_ entry: Entry) async -> URL? {
    guard entry.state == .done, let delivery = entry.delivery else { return nil }
    let file = OfflineCopier.entry(delivery: delivery)
    if delivery == "mp4" { return folder(of: entry).appendingPathComponent(file) }
    do {
      _ = try await server.start()
    } catch {
      Self.log.error("offline server: \(String(describing: error), privacy: .public)")
      return nil
    }
    return server.url(for: "\(entry.id)/\(file)")
  }

  // MARK: Copying

  private func run() {
    guard running == nil, api != nil, entries.contains(where: { $0.state == .queued }) else { return }
    running = Task { [weak self] in
      while let self, !Task.isCancelled, let next = self.entries.first(where: { $0.state == .queued }), let api = self.api {
        await self.copy(next.id, api: api)
      }
      self?.finished()
    }
  }

  private func finished() {
    running = nil
    // A copy removed while it ran stopped this run; the rest go on.
    if api != nil, entries.contains(where: { $0.state == .queued }) { return run() }
    UIApplication.shared.isIdleTimerDisabled = false
    if background != .invalid {
      UIApplication.shared.endBackgroundTask(background)
      background = .invalid
    }
  }

  private func copy(_ id: String, api: APIClient) async {
    guard let entry = entries.first(where: { $0.id == id }) else { return }
    // A copy runs while the app is open: the screen stays on, and the app
    // asks for time to finish a file when it is left.
    UIApplication.shared.isIdleTimerDisabled = true
    if background == .invalid {
      background = UIApplication.shared.beginBackgroundTask(withName: "offline copy") { [weak self] in
        MainActor.assumeIsolated {
          guard let self else { return }
          UIApplication.shared.endBackgroundTask(self.background)
          self.background = .invalid
        }
      }
    }
    update(id) { $0.state = .copying }
    var network = self.network
    var attempts = 0
    while true {
      attempts += 1
      do {
        let (stream, link) = try await api.offlineStream(
          entry.reference, shareURL: entries.first { $0.id == id }?.shareURL,
          capabilities: ThisDevice.capabilities, viewport: ThisDevice.viewport,
          network: network, maxVideoKbps: entry.size.maxVideoKbps
        )
        update(id) {
          $0.shareURL = link
          $0.delivery = stream.deliveryType
          if let duration = stream.duration, duration > 0 { $0.duration = duration }
        }
        if stream.isLive { throw OfflineError(.live, "A live stream cannot be kept offline") }
        guard let url = stream.mediaURL(server: api.address) else {
          throw OfflineError(.unsupported, "This video's delivery (\(stream.deliveryType)) cannot be kept offline")
        }
        if entries.first(where: { $0.id == id })?.subtitles == nil {
          await keepSubtitles(of: stream, server: api.address, for: id)
        }
        Self.log.info("copying \(id, privacy: .public) from \(stream.network ?? "?", privacy: .public) as \(stream.deliveryType, privacy: .public)")
        try await OfflineCopier().copy(url, delivery: stream.deliveryType, duration: stream.duration, into: folder(of: entry)) { fraction in
          await MainActor.run { self.update(id, save: false) { $0.progress = fraction } }
        }
        update(id) {
          $0.state = .done
          $0.progress = 1
          $0.bytes = Self.size(of: self.folder(of: entry))
        }
        return
      } catch is CancellationError {
        return
      } catch let error as OfflineError where (error.code == .expired || error.code == .network) && attempts < 3 {
        // A new stream, by the relay when the remote path failed.
        Self.log.info("copy \(id, privacy: .public) again: \(error.description, privacy: .public)")
        if error.code == .network, network == .wan { network = nil }
        continue
      } catch let error as OfflineError where error.code == .expired || error.code == .network {
        stop(id, message: nil)
        return
      } catch let error as OfflineError {
        stop(id, message: Self.words(error))
        return
      } catch let error as YoloAPIError {
        stop(id, message: error.retryable || error.code == "node_offline" ? nil : error.message)
        return
      } catch {
        if Task.isCancelled { return }
        stop(id, message: nil)
        return
      }
    }
  }

  /// A copy that stopped: with no message it stopped for want of the
  /// network or of Yolo, and goes on by itself when the app comes back.
  private func stop(_ id: String, message: String?) {
    Self.log.info("copy \(id, privacy: .public) stopped: \(message ?? "network", privacy: .public)")
    update(id) {
      $0.state = .failed
      $0.message = message
    }
  }

  private static func words(_ error: OfflineError) -> String {
    switch error.code {
    case .live: t("A live stream cannot be downloaded.")
    case .protected: t("This video is protected and cannot be downloaded.")
    case .unsupported: t("This video cannot be downloaded.")
    case .expired, .network: t("Yolo could not send this video.")
    }
  }

  /// Shows `subtitle` (nil for none) when the copy plays.
  func choose(subtitle: String?, of id: String) {
    update(id) { $0.subtitle = subtitle }
  }

  /// The cues of the subtitle a copy shows, in seconds of the item.
  func cues(of entry: Entry) -> [Cue] {
    guard let chosen = entry.subtitle, let track = entry.subtitles?.first(where: { $0.id == chosen }),
          let text = try? String(contentsOf: folder(of: entry).appendingPathComponent(track.file), encoding: .utf8)
    else { return [] }
    return WebVTT.parse(text)
  }

  /// The stream's text subtitles, kept as WebVTT files beside the video
  /// (a track still being made is left). The one Yolo chose shows, else
  /// one in Chinese.
  private func keepSubtitles(of stream: StreamDescriptor, server: ServerAddress, for id: String) async {
    guard let entry = entries.first(where: { $0.id == id }) else { return }
    let tracks = StreamTracks(json: stream.tracks)
    let folder = folder(of: entry)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var kept: [Subtitle] = []
    for (index, track) in tracks.subtitles.enumerated() where track.inPlace && !track.growing {
      guard let path = track.url, let url = stream.resolve(path, server: server),
            let (data, response) = try? await URLSession.shared.data(for: URLRequest(url: url, timeoutInterval: 60)),
            (response as? HTTPURLResponse)?.statusCode == 200,
            let text = String(data: data, encoding: .utf8), text.contains("-->")
      else { continue }
      let file = "sub-\(index).vtt"
      guard (try? Data(text.utf8).write(to: folder.appendingPathComponent(file))) != nil else { continue }
      let label = [track.name, track.language].compactMap { $0?.isEmpty == false ? $0 : nil }.first ?? track.id
      kept.append(Subtitle(id: track.id, label: label, file: file))
    }
    let language = { (sub: Subtitle) in tracks.subtitle(sub.id)?.language?.lowercased() ?? "" }
    let shown = kept.first { tracks.selected.contains($0.id) }
      ?? kept.first { language($0).hasPrefix("zh") || language($0).hasPrefix("chi") || language($0).hasPrefix("chs") }
    update(id) {
      $0.subtitles = kept
      $0.subtitle = shown?.id
    }
  }

  private func keepCover(of item: MediaItem, for id: String) async {
    guard let api, let request = Artwork.request(for: item.thumbnail, landscape: true, api: api),
          let (data, response) = try? await URLSession.shared.data(for: request),
          (response as? HTTPURLResponse)?.statusCode == 200, UIImage(data: data) != nil,
          let entry = entries.first(where: { $0.id == id })
    else { return }
    let folder = folder(of: entry)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    guard (try? data.write(to: folder.appendingPathComponent("cover.jpg"))) != nil else { return }
    update(id) { $0.hasCover = true }
  }

  private func episodeLine(_ item: MediaItem) -> String? {
    let number = [item.season.map { "S\($0)" }, item.episode.map { "E\($0)" }].compactMap { $0 }.joined(separator: " • ")
    let line = [number.isEmpty ? nil : number, item.episodeTitle].compactMap { $0 }.joined(separator: " - ")
    return line.isEmpty ? nil : line
  }

  private func update(_ id: String, save: Bool = true, _ change: (inout Entry) -> Void) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    change(&entries[index])
    if save { self.save() }
  }

  private func save() {
    try? JSONEncoder().encode(entries).write(to: indexFile, options: .atomic)
  }

  private static func size(of folder: URL) -> Int64 {
    let files = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.fileSizeKey])
    var total: Int64 = 0
    while let file = files?.nextObject() as? URL {
      total += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }
    return total
  }
}
