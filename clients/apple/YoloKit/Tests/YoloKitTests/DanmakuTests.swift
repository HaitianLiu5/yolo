import Foundation
import Testing
@testable import YoloKit

@Suite struct DanmakuTests {
  static let geometry = DanmakuGeometry(width: 1920, height: 1080, settings: DanmakuSettings(), subtitles: false) { $0 * 1.05 }

  static func layout(density: String = "normal") -> DanmakuLayout {
    let layout = DanmakuLayout { comment, fontSize in Double(comment.text.count) * fontSize * comment.size + 2 }
    layout.setGeometry(geometry)
    layout.setDensity(density)
    return layout
  }

  /// Updates every frame from 0 to `end`, as the draw loop does.
  static func run(_ layout: DanmakuLayout, to end: Double) -> [(comment: PlacedComment, x: Double, y: Double)] {
    var placed: [(comment: PlacedComment, x: Double, y: Double)] = []
    for frame in 0...Int(end * 30) { placed = layout.update(Double(frame) / 30) }
    return placed
  }

  @Test func theHashMatchesThePlayers() {
    // Values from clients/player/src/danmaku-layout.js's hashOf, in Node.
    #expect(DanmakuLayout.hash(DanmakuComment(t: 1.5, text: "hi"), seed: 0) == 723_970_031)
    #expect(DanmakuLayout.hash(DanmakuComment(t: 12.345, text: "弹幕"), seed: 0x5bd1e995) == 219_995_614)
  }

  @Test func crossingTimesFollowThePicturesWidth() {
    #expect(DanmakuLayout.scrollSeconds(500) == 4.5)
    #expect(DanmakuLayout.scrollSeconds(800) == 7.1)
    #expect(DanmakuLayout.scrollSeconds(1920) == 13.1)
    #expect(DanmakuLayout.scrollSeconds(3840) == 18.1)
  }

  @Test func theQuarterAreaHoldsLanesOfTheTVsTextSize() {
    let geometry = Self.geometry
    #expect(geometry.fontSize == 36)
    #expect(geometry.laneHeight == 41)
    #expect(geometry.height == 270 - DanmakuGeometry.topInset)
    let full = DanmakuGeometry(width: 1920, height: 1080, settings: { var s = DanmakuSettings(); s.area = "full"; return s }(), subtitles: true) { $0 * 1.05 }
    #expect(full.height == 864 - DanmakuGeometry.topInset)
  }

  @Test func aPhonesPictureHasLanesAtTheHandheldTextSize() {
    // A 16:9 picture across an iPhone held upright, the default top quarter.
    let phone = { (base: Double) in
      let layout = DanmakuLayout { _, _ in 100 }
      layout.setGeometry(DanmakuGeometry(width: 402, height: 226, settings: DanmakuSettings(), subtitles: false, baseFontSize: base) { $0 * 1.25 })
      return layout.laneCount
    }
    #expect(phone(DanmakuGeometry.tvFontSize) == 0)
    #expect(phone(DanmakuGeometry.handheldFontSize) == 1)
  }

  @Test func commentsTakeTheFirstFreeLaneAndNeverOverlap() {
    let layout = Self.layout()
    layout.restart(at: 0)
    layout.setComments((0..<6).map { DanmakuComment(t: 1 + Double($0) * 0.01, text: "comment \($0)") })
    let placed = Self.run(layout, to: 3)
    #expect(placed.count == 6)
    #expect(Set(placed.map(\.comment.lane)).count == 6)
    let pinned = Self.layout()
    pinned.restart(at: 0)
    pinned.setComments([DanmakuComment(t: 1, text: "top", mode: "top"), DanmakuComment(t: 1, text: "bottom", mode: "bottom")])
    let fixed = Self.run(pinned, to: 2)
    #expect(fixed.first { $0.comment.mode == "top" }?.comment.lane == 0)
    #expect(fixed.first { $0.comment.mode == "bottom" }?.comment.lane == pinned.laneCount - 1)
  }

  @Test func aScrollingCommentCrossesFromTheRightEdge() throws {
    let layout = Self.layout()
    layout.setComments([DanmakuComment(t: 1, text: "hello")])
    let entering = try #require(layout.update(1).first)
    #expect(entering.x == 1920)
    let later = try #require(layout.update(2).first)
    #expect(later.x < 1920)
    #expect(layout.update(1 + 13.2).isEmpty)
  }

  @Test func densityHidesLowWeightCommentsExceptAtHigh() {
    let light = DanmakuComment(t: 1, text: "meh", weight: 1)
    let unranked = DanmakuComment(t: 1, text: "unranked")
    #expect(!Self.layout().shows(light))
    #expect(Self.layout().shows(unranked))
    #expect(Self.layout(density: "high").shows(light))
  }

  @Test func settingsPatchesKeepOnlyValidFields() {
    let patch = DanmakuSettings.patch(["enabled": false, "density": "dense", "opacity": 0.33, "area": "half", "extra": 1])
    #expect(patch == ["enabled": false, "opacity": 0.35, "area": "half"])
    var settings = DanmakuSettings()
    settings.apply(patch)
    #expect(!settings.enabled && settings.area == "half" && settings.opacity == 0.35)
  }

  @Test func aChangeSentAgainSkipsWhatWasAppliedOrChangedHereUnheard() throws {
    let message = try #require(RealtimeMessage(text: #"{"v":1,"type":"danmaku","id":"c1","again":true,"settings":{"enabled":false,"area":"full","density":"high"}}"#))
    let apply = DanmakuSettings.toApply(message, heard: ["enabled": "c1"], own: ["area"])
    #expect(apply == ["density": "high"])
    let live = try #require(RealtimeMessage(text: #"{"v":1,"type":"danmaku","id":"c2","settings":{"enabled":false}}"#))
    #expect(DanmakuSettings.toApply(live, heard: ["enabled": "c2"], own: ["enabled"]) == ["enabled": false])
  }

  @Test func windowsAreFetchedAroundThePositionAndTheNextAhead() {
    #expect(DanmakuWindows.needed(at: 10) == [0])
    #expect(DanmakuWindows.needed(at: 340) == [0, 1])
    #expect(DanmakuWindows.needed(at: 400) == [1])
    let url = DanmakuWindows.url(URL(string: "https://lan.example.com/m/tok/comments")!, index: 1)
    #expect(url.absoluteString == "https://lan.example.com/m/tok/comments?start=360&end=720")
  }
}
