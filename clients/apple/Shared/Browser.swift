import Foundation
import Observation
import UIKit
import YoloKit

/// What the home screen shows, from the owner's server: history first, then
/// the movie library and the show libraries, as the player's home does.
/// History splits in two: what came from a library, and every other video
/// (web links and the like), in a row of its own.
@MainActor @Observable
final class Browser {
  let api: APIClient
  private(set) var history: [MediaItem] = []
  private(set) var videos: [MediaItem] = []
  private(set) var movies: [MediaItem] = []
  private(set) var shows: [MediaItem] = []
  private(set) var loaded = false
  private(set) var error: String?

  init(api: APIClient) {
    self.api = api
  }

  func load() async {
    async let historyResult = Self.attempt { try await self.api.history() }
    async let librariesResult = Self.attempt { try await self.api.libraries() }
    let (history, libraries) = await (historyResult, librariesResult)
    if case .success(let items) = history {
      let fromLibraries = Set((try? libraries.get())?.compactMap(\.source) ?? [])
      if fromLibraries.isEmpty {
        self.history = items
        videos = []
      } else {
        self.history = items.filter { $0.plugin.map(fromLibraries.contains) ?? true }
        videos = items.filter { !($0.plugin.map(fromLibraries.contains) ?? true) }
      }
    }

    var failure: Error?
    if case .failure(let error) = history { failure = error }
    if case .success(let libraries) = libraries {
      if let movieLibrary = libraries.first(where: { $0.type == "movie" }) {
        switch await Self.attempt({ try await self.api.items(in: movieLibrary) }) {
        case .success(let items): movies = items
        case .failure(let error): failure = error
        }
      }
      var shows: [MediaItem] = []
      var seen = Set<String>()
      for library in libraries where library.type == "show" {
        switch await Self.attempt({ try await self.api.items(in: library) }) {
        case .success(let items): shows += items.filter { seen.insert($0.id).inserted }
        case .failure(let error): failure = error
        }
      }
      self.shows = shows
    } else if case .failure(let error) = libraries {
      failure = error
    }
    // A load the view cancelled (it was built again, as after pairing) is
    // not a failure; the next load shows the rows.
    if let failure, !Self.cancelled(failure) { self.error = Self.describe(failure) } else if failure == nil { self.error = nil }
    loaded = true
  }

  static func cancelled(_ error: Error) -> Bool {
    error is CancellationError || (error as? URLError)?.code == .cancelled
  }

  /// What failed to load, for the sentence the owner reads.
  enum Loading { case library, episodes, details, search }

  /// One sentence for the owner, never a raw NSError.
  static func describe(_ error: Error, loading: Loading = .library) -> String {
    let reason = (error as? YoloAPIError).map { "\($0.message)." } ?? (error as? URLError)?.localizedDescription
    return switch (loading, reason) {
    case (.library, let reason?): t("Cannot load your library: \(reason)")
    case (.library, nil): t("Cannot load your library right now.")
    case (.episodes, let reason?): t("Cannot load the episodes: \(reason)")
    case (.episodes, nil): t("Cannot load the episodes right now.")
    case (.details, let reason?): t("Cannot load the details: \(reason)")
    case (.details, nil): t("Cannot load the details right now.")
    case (.search, let reason?): t("Search failed: \(reason)")
    case (.search, nil): t("Search failed right now.")
    }
  }

  private static func attempt<T: Sendable>(_ work: @escaping @Sendable () async throws -> T) async -> Result<T, Error> {
    do {
      return .success(try await work())
    } catch {
      return .failure(error)
    }
  }
}

/// Pictures from Yolo's origin with the device credential (Artwork), kept
/// for reuse, the oldest let go.
actor ArtworkLoader {
  private static let kept = 300

  let api: APIClient
  private var images: [String: UIImage] = [:]
  private var order: [String] = []
  private var loading: [String: Task<UIImage?, Never>] = [:]

  init(api: APIClient) {
    self.api = api
  }

  /// Loads a row's pictures ahead, four at a time, so cards scrolled into
  /// view already have theirs.
  func prefetch(_ thumbnails: [String?], landscape: Bool) async {
    await withTaskGroup(of: Void.self) { group in
      for (index, thumbnail) in thumbnails.enumerated() {
        if index >= 4 { await group.next() }
        group.addTask { _ = await self.image(for: thumbnail, landscape: landscape) }
      }
    }
  }

  func image(for thumbnail: String?, landscape: Bool) async -> UIImage? {
    guard let request = Artwork.request(for: thumbnail, landscape: landscape, api: api), let key = request.url?.absoluteString else { return nil }
    if let image = images[key] { return image }
    if let task = loading[key] { return await task.value }
    let transport = api.transport
    let task = Task<UIImage?, Never> {
      guard let (data, response) = try? await transport.data(for: request), response.statusCode == 200 else { return nil }
      return UIImage(data: data)
    }
    loading[key] = task
    let image = await task.value
    loading[key] = nil
    if let image {
      images[key] = image
      order.append(key)
      if order.count > Self.kept { images[order.removeFirst()] = nil }
    }
    return image
  }
}
