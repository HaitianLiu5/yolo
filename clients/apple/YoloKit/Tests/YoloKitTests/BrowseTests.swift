import Foundation
import Testing
@testable import YoloKit

@Suite struct BrowseTests {
  static let api = APIClient(
    address: server, credential: DeviceCredential(token: "ydt_t", deviceId: "tv"),
    transport: StubTransport { request in
      switch request.url?.path {
      case "/v1/history":
        return (200, [[
          "sourceKey": "plex:9919", "source": ["plugin": "plex", "id": "9919"], "title": "Earnings Call",
          "thumbnail": "/v1/library/items/plex%3A9919/artwork", "position": 519, "duration": 4039, "updatedAt": 1_792_570_918_839,
          "watched": false,
        ], [
          "sourceKey": "plex:9920", "source": ["plugin": "plex", "id": "9920"], "title": "Watched Again",
          "position": 2, "duration": 4039, "watched": true,
        ]])
      case "/v1/library/items/plex:9919":
        return (200, [
          "id": "plex:9919", "title": "Earnings Call", "description": "A call.", "genres": ["Business"], "year": 2026, "duration": 4039,
          "people": [["name": "Host", "role": "cast", "character": "Themselves"], ["name": "Maker", "role": "director"]],
          "ratings": [["value": 7.5, "max": 10, "source": "audience"]], "contentRating": "TV-G",
          "progress": ["position": 519, "percent": 13, "watched": false],
        ])
      case "/v1/library":
        return (200, ["libraries": [["id": "plex:1", "title": "Movies", "type": "movie"], ["id": "plex:2", "title": "TV", "type": "show"]]])
      case "/v1/library/plex:2/items":
        return (200, ["items": [["id": "plex:50", "kind": "show", "title": "Show", "episodes": 10, "watchedEpisodes": 10]]])
      case "/v1/library/items/plex:50/children":
        return (200, ["parent": ["title": "Show"], "items": [
          ["id": "plex:51", "kind": "episode", "title": "Show", "episodeTitle": "Pilot", "season": 1, "episode": 1],
          ["id": "plex:52", "kind": "episode", "title": "Show", "episodeTitle": "Two", "season": 1, "episode": 2],
          ["id": "plex:61", "kind": "episode", "title": "Show", "episodeTitle": "Return", "season": 2, "episode": 1, "resumeAt": 600, "duration": 1200],
        ]])
      case "/v1/library/search":
        #expect(request.url?.query == "q=fast%20%26%20furious")
        return (200, ["results": [["id": "plex:70", "type": "movie", "title": "Fast", "year": 2001, "duration": 6360]]])
      default:
        return (404, nil)
      }
    }
  )

  @Test func historyPlaysItsSourceAndResumesWhereItWas() async throws {
    let entry = try #require(try await Self.api.history().first)
    #expect(entry.id == "plex:9919")
    #expect(entry.playReference == ["source": ["plugin": "plex", "id": "9919"]])
    #expect(entry.progress > 0.12 && entry.progress < 0.13)
    #expect(!entry.watched)
    #expect(entry.updatedAt == Date(timeIntervalSince1970: 1_792_570_918.839))
  }

  @Test func librariesShowsAndTheirEpisodesBySeason() async throws {
    let libraries = try await Self.api.libraries()
    #expect(libraries.map(\.type) == ["movie", "show"])
    let show = try #require(try await Self.api.items(in: libraries[1]).first)
    #expect(show.opens)
    #expect(show.watched)
    let (title, episodes) = try await Self.api.children(of: show)
    #expect(title == "Show")
    let seasons = Season.group(episodes)
    #expect(seasons.map(\.number) == [1, 2])
    #expect(seasons[0].episodes.map(\.episodeTitle) == ["Pilot", "Two"])
    #expect(seasons[1].episodes[0].progress == 0.5)
    #expect(seasons[1].episodes[0].playReference == ["itemId": "plex:61"])
  }

  @Test func anItemsDetailsForItsPage() async throws {
    let entry = try #require(try await Self.api.history().first)
    let details = try await Self.api.details(of: entry)
    #expect(details.description == "A call.")
    #expect(details.genres == ["Business"])
    #expect(details.people.map(\.role) == ["cast", "director"])
    #expect(details.people[0].character == "Themselves")
    #expect(details.ratings == [ItemDetails.Rating(value: 7.5, max: 10, source: "audience")])
    #expect(details.position == 519)
    #expect(!details.watched)
  }

  @Test func searchEscapesItsQuery() async throws {
    let results = try await Self.api.search("fast & furious")
    #expect(results.first?.kind == .movie)
    #expect(results.first?.year == 2001)
    #expect(results.first?.opens == false)
  }

  @Test func yoloKeepsTheWatchedMarkThroughAnotherPlay() async throws {
    let again = try #require(try await Self.api.history().last)
    #expect(again.watched)
    #expect(again.progress > 0)
  }

  @Test func anUnmarkedItemAtItsEndCountsAsWatched() {
    #expect(MediaItem.finished(4000, of: 4039))
    #expect(!MediaItem.finished(519, of: 4039))
    #expect(MediaItem.finished(114, of: 120))
    #expect(!MediaItem.finished(100, of: 120))
  }

  @Test func everyPictureComesFromYolosOwnOrigin() throws {
    let library = try #require(Artwork.request(for: "/v1/library/items/plex%3A1/artwork", api: Self.api))
    #expect(library.url?.absoluteString == "https://yolo.example.com/v1/library/items/plex%3A1/artwork")
    #expect(library.value(forHTTPHeaderField: "Authorization") == "Bearer ydt_t")
    let web = try #require(Artwork.request(for: "https://i.ytimg.com/vi/x/hq.jpg", api: Self.api))
    #expect(web.url?.absoluteString == "https://yolo.example.com/v1/thumbnail?url=https://i.ytimg.com/vi/x/hq.jpg")
    let link = try #require(Artwork.request(for: "https://yolo.example.com/i/AQAB", api: Self.api))
    #expect(link.url?.absoluteString == "https://yolo.example.com/i/AQAB")
    #expect(link.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(Artwork.request(for: nil, api: Self.api) == nil)
  }

  @Test func landscapeArtworkAsksForTheLandscapeVariant() {
    #expect(Artwork.landscapeVariant("/v1/library/items/x/artwork") == "/v1/library/items/x/artwork?variant=landscape")
    #expect(Artwork.landscapeVariant("/v1/library/items/x/artwork?variant=poster") == "/v1/library/items/x/artwork?variant=landscape")
    #expect(Artwork.landscapeVariant("https://i.ytimg.com/vi/x/hq.jpg") == "https://i.ytimg.com/vi/x/hq.jpg")
  }
}
