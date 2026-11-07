import Foundation
import Testing
@testable import YoloKit

@Suite struct ScrubPreviewsTests {
  @Test func momentsLieOnAGridThatFitsTheVideo() {
    #expect(PreviewSchedule(duration: 7200).step == 10)
    #expect(PreviewSchedule(duration: 1500).step == 5)
    #expect(PreviewSchedule(duration: 180).step == 2)
    let schedule = PreviewSchedule(duration: 7200)
    #expect(schedule.moment(at: 0) == 0)
    #expect(schedule.moment(at: 129.9) == 120)
    #expect(schedule.moment(at: 99_999) == 7190)
    #expect(schedule.moment(at: -3) == 0)
    #expect(PreviewSchedule.url(URL(string: "https://lan.test/m/t/preview")!, time: 120).absoluteString == "https://lan.test/m/t/preview/120.jpg")
  }

  @Test func atMostTwoReadsRunAndAFastScrubSkipsWhatItPassed() {
    var schedule = PreviewSchedule(duration: 7200)
    #expect(schedule.scrubbed(to: 100) == [100, 110])
    #expect(schedule.scrubbed(to: 500).isEmpty)
    #expect(schedule.scrubbed(to: 3000).isEmpty)
    // The owner is at 3000 by the time a read ends; 500 is never read.
    #expect(schedule.finished(100, .loaded) == [3000])
    #expect(schedule.finished(110, .loaded) == [3010])
    #expect(schedule.finished(3000, .loaded).isEmpty)
    #expect(schedule.finished(3010, .loaded).isEmpty)
  }

  @Test func theReadAheadFollowsTheScrubsDirection() {
    var schedule = PreviewSchedule(duration: 7200)
    _ = schedule.scrubbed(to: 1000)
    _ = schedule.finished(1000, .loaded)
    _ = schedule.finished(1010, .loaded)
    #expect(schedule.scrubbed(to: 900) == [900, 890])
  }

  @Test func theNearestPictureShowsUntilTheExactOneArrives() {
    var schedule = PreviewSchedule(duration: 7200)
    #expect(schedule.nearest(to: 100) == nil)
    _ = schedule.scrubbed(to: 100)
    _ = schedule.finished(100, .loaded)
    #expect(schedule.nearest(to: 105) == 100)
    #expect(schedule.nearest(to: 130) == 100)
    #expect(schedule.nearest(to: 500) == nil)
    _ = schedule.finished(110, .loaded)
    #expect(schedule.nearest(to: 112) == 110)
    schedule.forget(110)
    #expect(schedule.nearest(to: 112) == 100)
  }

  @Test func failuresEndTheReadingUntilTheNextScrub() {
    var schedule = PreviewSchedule(duration: 7200)
    _ = schedule.scrubbed(to: 100)
    #expect(schedule.finished(100, .failed) == [])
    _ = schedule.finished(110, .failed)
    #expect(schedule.scrubbed(to: 200) == [200, 210])
    _ = schedule.finished(200, .failed)
    #expect(schedule.scrubbed(to: 300).isEmpty)
    schedule.began()
    // 210 still reads; the other read is free.
    #expect(schedule.scrubbed(to: 300) == [300])
  }

  @Test func aBusyNodeIsAskedAgainWhenTheOwnerMoves() {
    var schedule = PreviewSchedule(duration: 7200)
    _ = schedule.scrubbed(to: 100)
    #expect(schedule.finished(100, .busy).isEmpty)
    #expect(schedule.scrubbed(to: 101) == [100])
    schedule.ended()
    #expect(schedule.finished(110, .loaded).isEmpty)
  }

  @Test func aSwipeCoversAQuarterOfTheVideoWithinLimits() {
    #expect(RemoteScrub(end: 7200).span == 1200)
    #expect(RemoteScrub(end: 2400).span == 600)
    #expect(RemoteScrub(end: 300).span == 120)
    #expect(RemoteScrub(end: 60).span == 60)
    let scrub = RemoteScrub(end: 2400)
    #expect(scrub.position(from: 1000, translation: 960) == 1300)
    #expect(scrub.position(from: 100, translation: -1920) == 0)
    #expect(scrub.position(from: 2300, translation: 1920) == 2400)
  }

  @Test func aStreamSaysWhereItsPreviewsAre() {
    let stream = StreamDescriptor(json: .object(["sessionId": "ses", "previews": "/m/t/preview"]))
    #expect(stream?.previews == "/m/t/preview")
    #expect(StreamDescriptor(json: .object(["sessionId": "ses"]))?.previews == nil)
  }
}
