import Foundation
import Testing
@testable import YoloKit

@Suite struct SubtitlesTests {
  static let tracks = StreamTracks(json: [
    "subtitles": [
      ["id": "en", "delivery": "vtt", "url": "/m/t/sub/0.vtt", "language": "en"],
      ["id": "zh", "delivery": "vtt", "url": "/m/t/sub/1.vtt", "language": "zh"],
      ["id": "pgs", "delivery": "burn"],
    ],
    "selected": ["subtitles": ["en"], "audio": nil],
  ])

  @Test func readsTheStreamsTracksAndTheSelection() {
    #expect(Self.tracks.subtitles.map(\.id) == ["en", "zh", "pgs"])
    #expect(Self.tracks.selected == ["en"])
    #expect(Self.tracks.subtitle("en")?.inPlace == true)
    #expect(Self.tracks.subtitle("pgs")?.inPlace == false)
  }

  @Test func aTracksMessageChangesTheSelectionOrTheWholeList() {
    let selection = Self.tracks.applying(tracks: nil, selected: ["subtitles": ["en", "zh"], "audio": nil])
    #expect(selection.selected == ["en", "zh"])
    #expect(selection.subtitles.count == 3)
    let replaced = Self.tracks.applying(tracks: ["subtitles": [["id": "fr", "delivery": "vtt", "url": "/f.vtt"]]], selected: ["subtitles": ["fr"]])
    #expect(replaced.subtitles.map(\.id) == ["fr"])
    #expect(replaced.selected == ["fr"])
  }

  @Test func aWelcomeSwitchesSubtitlesOnlyWhenTheyChangeInPlace() {
    func state(_ ids: [String]) -> JSONValue {
      ["deviceId": "tv", "sessionId": "s1", "tracks": ["subtitles": .array(ids.map { .string($0) }), "audio": nil]]
    }
    #expect(Self.tracks.toFollow(state(["zh"]), deviceId: "tv", sessionId: "s1") == ["zh"])
    #expect(Self.tracks.toFollow(state([]), deviceId: "tv", sessionId: "s1") == [])
    #expect(Self.tracks.toFollow(state(["en"]), deviceId: "tv", sessionId: "s1") == nil)
    #expect(Self.tracks.toFollow(state(["pgs"]), deviceId: "tv", sessionId: "s1") == nil)
    #expect(Self.tracks.toFollow(state(["zh"]), deviceId: "tv", sessionId: "s2") == nil)
  }

  @Test func parsesWebVTTCuesWithoutTheirTags() {
    let cues = WebVTT.parse("""
    WEBVTT

    1
    00:00:01.000 --> 00:00:03.500 align:center
    <i>Hello</i> &amp; welcome

    00:01:02.250 --> 00:01:04.000
    Line one
    Line two
    """)
    #expect(cues == [Cue(start: 1, end: 3.5, text: "Hello & welcome"), Cue(start: 62.25, end: 64, text: "Line one\nLine two")])
    #expect(WebVTT.text(at: 2, in: cues) == "Hello & welcome")
    #expect(WebVTT.text(at: 3.5, in: cues) == nil)
  }

  @Test func aGrowingTrackIsReadForAWindowThatReachesAhead() {
    #expect(GrowingSubtitles.window(at: 5) == 0...95)
    #expect(GrowingSubtitles.window(at: 100) == 90...190)
    let url = GrowingSubtitles.url(URL(string: "https://lan.example.com/m/t/sub/0.vtt?start=1&end=2")!, window: 90...190)
    #expect(url.absoluteString == "https://lan.example.com/m/t/sub/0.vtt?start=90.0&end=190.0")
  }

  @Test func freshCuesReplaceWhatTheirWindowCoversAndTheRestStay() {
    let old = [Cue(start: 1, end: 2, text: "old early"), Cue(start: 95, end: 96, text: "old inside"), Cue(start: 300, end: 301, text: "old late")]
    let fresh = [Cue(start: 95, end: 97, text: "new inside"), Cue(start: 150, end: 151, text: "new")]
    let merged = GrowingSubtitles.merge(old, fresh: fresh, window: 90...190)
    #expect(merged.map(\.text) == ["old early", "new inside", "new", "old late"])
  }
}
