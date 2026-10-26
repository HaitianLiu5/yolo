import Foundation

/// One library the owner's sources offer (`GET /v1/library`).
public struct Library: Sendable, Hashable, Identifiable {
  public let id: String
  public let title: String
  /// `movie`, `show`, or what a source names.
  public let type: String
  /// The source plugin it comes from.
  public let source: String?

  public init?(json: JSONValue) {
    guard let id = json["id"]?.string else { return nil }
    self.id = id
    title = json["title"]?.string ?? id
    type = json["type"]?.string ?? "other"
    source = json["source"]?.string
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

  /// What plays: a `load`'s item, under its Source key, as history names it.
  public init?(playing json: JSONValue) {
    guard let source = json["source"], let plugin = source["plugin"]?.string, let local = source["id"]?.string else { return nil }
    self.init(json: json, id: "\(plugin):\(local)", kind: .video, source: source)
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

  /// Never played: a library item with no place to resume that is not
  /// watched, or a show or season with no episode watched. A history entry
  /// has been played.
  public var unplayed: Bool {
    guard source == nil else { return false }
    if let episodes, kind == .show || kind == .season { return episodes > 0 && (watchedEpisodes ?? 0) == 0 }
    return !watched && (position ?? 0) <= 0
  }

  /// How far through it the owner is, 0 to 1, for its progress line: a
  /// show's or season's episodes watched, else where it resumes. 0 when not
  /// started or finished.
  public var shownProgress: Double {
    guard kind == .show || kind == .season, let episodes, episodes > 0 else { return progress }
    let watched = watchedEpisodes ?? 0
    return watched > 0 && watched < episodes ? Double(watched) / Double(episodes) : 0
  }

  /// The source plugin it plays from, for a history entry.
  public var plugin: String? { source?["plugin"]?.string }

  /// The site a history entry's link is on, by the name people call it:
  /// Bilibili, YouTube; another site by its name without the domain's end,
  /// capitalized. Nil for a library item.
  public var site: String? {
    guard let url = source?["url"]?.string, let host = URL(string: url)?.host()?.lowercased() else { return nil }
    let labels = host.split(separator: ".").map(String.init)
    for (domain, name) in Self.sites where host == domain || host.hasSuffix("." + domain) { return name }
    // The label before the domain's end: "video.example.co.uk" → Example.
    let ends: Set<String> = ["co", "com", "net", "org", "ac", "gov"]
    var index = labels.count - 2
    if index > 0, ends.contains(labels[index]), labels.last?.count == 2 { index -= 1 }
    guard labels.indices.contains(index) else { return host }
    return labels[index].prefix(1).uppercased() + labels[index].dropFirst()
  }

  private static let sites: [(String, String)] = [
    ("bilibili.com", "Bilibili"), ("b23.tv", "Bilibili"), ("youtube.com", "YouTube"), ("youtu.be", "YouTube"),
    ("vimeo.com", "Vimeo"), ("twitch.tv", "Twitch"), ("x.com", "X"), ("twitter.com", "X"),
    ("douyin.com", "Douyin"), ("tiktok.com", "TikTok"), ("instagram.com", "Instagram"), ("facebook.com", "Facebook"),
    ("nicovideo.jp", "Niconico"), ("ixigua.com", "Xigua"), ("weibo.com", "Weibo"), ("dailymotion.com", "Dailymotion"),
  ]

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

/// One item's details for a detail page (`GET /v1/library/items/:id`), in
/// the shape MCP's `get_item` gives: what its source says about it and the
/// owner's progress Yolo records.
public struct ItemDetails: Sendable, Equatable {
  public struct Person: Sendable, Equatable, Hashable {
    public let name: String
    /// `cast`, `director`, `writer`, or `producer`.
    public let role: String
    public let character: String?
  }

  /// For an episode, its show and where it sits in it.
  public struct Series: Sendable, Equatable, Hashable {
    public let title: String?
    public let season: Int?
    public let episode: Int?
    public let episodeTitle: String?
  }

  public struct Rating: Sendable, Equatable, Hashable {
    public let value: Double
    public let max: Double
    /// `critics`, `audience`, or `you`.
    public let source: String?
  }

  public let title: String?
  public let description: String?
  public let genres: [String]
  public let people: [Person]
  public let ratings: [Rating]
  public let contentRating: String?
  public let studio: String?
  public let series: Series?
  public let year: Int?
  public let date: String?
  public let duration: Double?
  /// Where it resumes, and whether it was watched to its end.
  public let position: Double?
  public let watched: Bool
  /// Its audio and subtitle tracks by name, else language.
  public let audio: [String]
  public let subtitles: [String]

  public init(json: JSONValue) {
    title = json["title"]?.string
    description = json["description"]?.string
    genres = (json["genres"]?.array ?? []).compactMap(\.string)
    people = (json["people"]?.array ?? []).compactMap { person in
      person["name"]?.string.map { Person(name: $0, role: person["role"]?.string ?? "cast", character: person["character"]?.string) }
    }
    ratings = (json["ratings"]?.array ?? []).compactMap { rating in
      rating["value"]?.number.map { Rating(value: $0, max: rating["max"]?.number ?? 10, source: rating["source"]?.string) }
    }
    contentRating = json["contentRating"]?.string
    studio = json["studio"]?.string
    series = json["series"].flatMap { value in
      value.object == nil ? nil : Series(title: value["title"]?.string, season: value["season"]?.int,
                                         episode: value["episode"]?.int, episodeTitle: value["episodeTitle"]?.string)
    }
    year = json["year"]?.int
    date = json["date"]?.string
    duration = json["duration"]?.number
    position = json["progress"]?["position"]?.number
    watched = json["progress"]?["watched"]?.bool ?? false
    let label = { (track: JSONValue) -> String? in
      [track["name"]?.string, track["language"]?.string].compactMap { $0 }.first { !$0.isEmpty }
    }
    audio = (json["tracks"]?["audio"]?.array ?? []).compactMap(label)
    subtitles = (json["tracks"]?["subtitles"]?.array ?? []).compactMap(label)
  }
}

extension APIClient {
  /// One item's details for its detail page. A web video from history is
  /// asked for by its link, which the route takes as well as an item id.
  public func details(of item: MediaItem) async throws -> ItemDetails {
    let ref = item.source?["url"]?.string ?? item.id
    return ItemDetails(json: try await request("/v1/library/items/\(Self.segment(ref))"))
  }

  /// What plays after an item: its run (a show's episodes, a video's
  /// parts) from the item on, each playing its Source, and the run's title.
  /// An item in no run, or an older server, has none.
  public func sequence(of item: MediaItem) async throws -> (title: String?, items: [MediaItem]) {
    let answer = try await request("/v1/library/items/\(Self.segment(item.id))/sequence")
    return (answer["title"]?.string, answer["items"]?.array?.compactMap(MediaItem.init(history:)) ?? [])
  }

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
