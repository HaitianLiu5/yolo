import Foundation

/// One library the owner's sources offer (`GET /v1/library`).
public struct Library: Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  /// `movie`, `show`, or what a source names.
  public let type: String

  public init?(json: JSONValue) {
    guard let id = json["id"]?.string else { return nil }
    self.id = id
    title = json["title"]?.string ?? id
    type = json["type"]?.string ?? "other"
  }
}

/// Something the home screen shows: a history entry, a library item, a
/// search result, or an episode (Agent Note 2026-10-07-v1-http-api). Every
/// title and picture comes from the owner's server.
public struct MediaItem: Sendable, Hashable, Identifiable {
  public enum Kind: String, Sendable { case movie, show, season, episode, video }

  /// The library item id (`<source>:<id>`), or a history entry's source key.
  public let id: String
  public let kind: Kind
  public let title: String
  public let episodeTitle: String?
  public let thumbnail: String?
  public let duration: Double?
  /// Where it resumes: a history entry's position or a library item's
  /// `resumeAt`.
  public let position: Double?
  public let watched: Bool
  public let year: Int?
  public let season: Int?
  public let episode: Int?
  public let episodes: Int?
  public let watchedEpisodes: Int?
  public let updatedAt: Date?
  /// A history entry's Source; library items play by id.
  public let source: JSONValue?

  /// A `GET /v1/history` entry: it plays its Source.
  public init?(history json: JSONValue) {
    guard let source = json["source"], let key = json["sourceKey"]?.string ?? source["id"]?.string else { return nil }
    self.init(json: json, id: key, kind: .video, source: source)
    // History counts the item's progress as `position`.
  }

  /// A library item, search result, or child.
  public init?(library json: JSONValue) {
    guard let id = json["id"]?.string else { return nil }
    let kind = (json["kind"]?.string ?? json["type"]?.string).flatMap(Kind.init(rawValue:)) ?? .video
    self.init(json: json, id: id, kind: kind, source: nil)
  }

  private init(json: JSONValue, id: String, kind: Kind, source: JSONValue?) {
    self.id = id
    self.kind = kind
    self.source = source
    title = json["title"]?.string ?? ""
    episodeTitle = json["episodeTitle"]?.string
    thumbnail = json["thumbnail"]?.string
    duration = json["duration"]?.number
    position = json["position"]?.number ?? json["resumeAt"]?.number
    year = json["year"]?.int
    season = json["season"]?.int
    episode = json["episode"]?.int
    episodes = json["episodes"]?.int
    watchedEpisodes = json["watchedEpisodes"]?.int
    updatedAt = json["updatedAt"]?.number.map { Date(timeIntervalSince1970: $0 / 1000) }
    if let watched = json["watched"]?.bool {
      self.watched = watched
    } else if let episodes, episodes > 0, let watchedEpisodes {
      self.watched = watchedEpisodes >= episodes
    } else {
      self.watched = Self.finished(position, of: duration)
    }
  }

  /// A show or a season opens its episodes; everything else plays.
  public var opens: Bool { kind == .show || kind == .season }

  /// What `POST /v1/playback/play` takes for it: its Source or its item id.
  public var playReference: [String: JSONValue] {
    if let source { return ["source": source] }
    return ["itemId": .string(id)]
  }

  /// How far it plays, 0 to 1, or 0 at its end or not started. A watched
  /// item played again shows how far, beside its mark.
  public var progress: Double {
    guard let position, let duration, duration > 0, position > 0, !Self.finished(position, of: duration) else { return 0 }
    return min(1, position / duration)
  }

  /// At its end: within the last minute (or 5%), Yolo's rule. Only an item
  /// Yolo does not mark (an older server's history) is watched by it.
  static func finished(_ position: Double?, of duration: Double?) -> Bool {
    guard let position, let duration, duration > 0 else { return false }
    return position >= duration - min(60, duration * 0.05)
  }
}

/// Episodes grouped by season, in order.
public struct Season: Sendable, Hashable, Identifiable {
  public let number: Int
  public let episodes: [MediaItem]
  public var id: Int { number }

  public static func group(_ items: [MediaItem]) -> [Season] {
    var order: [Int] = []
    var bySeason: [Int: [MediaItem]] = [:]
    for item in items {
      let number = item.season ?? 1
      if bySeason[number] == nil { order.append(number) }
      bySeason[number, default: []].append(item)
    }
    return order.map { Season(number: $0, episodes: bySeason[$0]!) }
  }
}

/// Where the screen loads a picture: every image comes from Yolo's own
/// origin with the device credential, as the player's `artwork.js` loads
/// them. Library artwork is `/v1/library/items/<id>/artwork`, an image link
/// on Yolo's origin (`/i/…`) opens as it is, and a picture on another host
/// goes through `/v1/thumbnail`, which the node fetches, so no image server
/// sees the screen's address.
public enum Artwork {
  public static func request(for thumbnail: String?, landscape: Bool = false, api: APIClient) -> URLRequest? {
    guard var url = thumbnail, !url.isEmpty else { return nil }
    if landscape { url = landscapeVariant(url) }
    let target: URL?
    if url.hasPrefix("/v1/") || url.hasPrefix("/i/") {
      target = URL(string: api.address.origin + url)
    } else if url.hasPrefix(api.address.origin + "/i/") {
      target = URL(string: url)
    } else if url.lowercased().hasPrefix("https://") || url.lowercased().hasPrefix("http://") {
      target = api.address.url("/v1/thumbnail", query: [URLQueryItem(name: "url", value: url)])
    } else {
      target = nil
    }
    guard let target else { return nil }
    var request = URLRequest(url: target, timeoutInterval: 20)
    if target.path.hasPrefix("/v1/") {
      request.setValue("Bearer \(api.credential.token)", forHTTPHeaderField: "Authorization")
      request.setValue(String(ClientProtocol.version), forHTTPHeaderField: ClientProtocol.header)
    }
    return request
  }

  /// The same library artwork as a landscape image (a movie's background,
  /// an episode's still), for rows of 16:9 cards; other URLs stay.
  public static func landscapeVariant(_ url: String) -> String {
    guard url.hasPrefix("/v1/"), url.range(of: #"/artwork(\?|$)"#, options: .regularExpression) != nil else { return url }
    if let range = url.range(of: #"([?&]variant=)[^&]*"#, options: .regularExpression) {
      let prefix = url[range].hasPrefix("?") ? "?variant=" : "&variant="
      return url.replacingCharacters(in: range, with: prefix + "landscape")
    }
    return url + (url.contains("?") ? "&" : "?") + "variant=landscape"
  }
}

extension APIClient {
  /// Recently played, newest first, with resume positions.
  public func history(limit: Int = 30) async throws -> [MediaItem] {
    let answer = try await request("/v1/history?limit=\(limit)")
    return (answer.array ?? answer["items"]?.array ?? []).compactMap(MediaItem.init(history:))
  }

  public func libraries() async throws -> [Library] {
    try await request("/v1/library")["libraries"]?.array?.compactMap(Library.init(json:)) ?? []
  }

  public func items(in library: Library, limit: Int = 200) async throws -> [MediaItem] {
    let path = "/v1/library/\(Self.segment(library.id))/items?limit=\(limit)"
    return try await request(path)["items"]?.array?.compactMap(MediaItem.init(library:)) ?? []
  }

  /// A show's episodes (or another item's children), with the parent's title.
  public func children(of item: MediaItem) async throws -> (title: String?, items: [MediaItem]) {
    let answer = try await request("/v1/library/items/\(Self.segment(item.id))/children")
    return (answer["parent"]?["title"]?.string, answer["items"]?.array?.compactMap(MediaItem.init(library:)) ?? [])
  }

  public func search(_ text: String) async throws -> [MediaItem] {
    var allowed = CharacterSet.urlQueryAllowed
    allowed.remove(charactersIn: "&+=?#")
    let query = text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
    return try await request("/v1/library/search?q=\(query)")["results"]?.array?.compactMap(MediaItem.init(library:)) ?? []
  }

  /// Plays on this screen: the `load` arrives on the realtime channel.
  /// `network` is the media path this screen takes now.
  public func playHere(_ reference: [String: JSONValue], deviceId: String?, network: MediaPath?) async throws {
    var body = reference
    if let deviceId { body["deviceId"] = .string(deviceId) }
    body["network"] = network.map { .string($0.rawValue) } ?? .null
    try await play(.object(body))
  }

  /// Chooses this stream's tracks (`PUT /v1/playback/tracks`): a text
  /// subtitle switches in place with a `tracks` message, anything else
  /// rebuilds the stream with a `load`.
  public func setTracks(subtitles: [String]) async throws {
    var client = self
    client.timeout = 60
    try await client.request("/v1/playback/tracks", method: "PUT", body: ["subtitles": .array(subtitles.map { .string($0) })])
  }

  /// Chooses the audio track: always a new stream, a `load` with reason
  /// `tracks` under the same session id.
  public func setAudio(_ id: String) async throws {
    var client = self
    client.timeout = 60
    try await client.request("/v1/playback/tracks", method: "PUT", body: ["audio": .string(id)])
  }

  /// A share link that plays `reference` in a friend's browser for 7 days
  /// (`POST /v1/shares`, Agent Note 2026-10-20-share-links); this is the only
  /// time the link is shown.
  public func share(_ reference: [String: JSONValue]) async throws -> URL {
    let answer = try await request("/v1/shares", method: "POST", body: .object(reference))
    guard let link = answer["url"]?.string, let url = URL(string: link) else {
      throw YoloAPIError(code: "internal", message: "Yolo answered without a share link", status: 200)
    }
    return url
  }

  static func segment(_ id: String) -> String {
    var allowed = CharacterSet.urlPathAllowed
    allowed.remove(charactersIn: "/?#")
    return id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id
  }
}
